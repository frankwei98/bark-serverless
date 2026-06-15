import type { Context, Hono } from "hono";

import { failed, getErrorMessage, success, withData } from "@/utils/responses";
import type { AppConfig, ApnsSendError, ParamMap, PushMessage, RuntimeDeps } from "@/types";
import { assertBodyWithinLimit, readLimitedText } from "@/utils/validation";
import { isRecord } from "@/utils/objects";

export interface PushRouteOptions {
  config: AppConfig;
  deps: RuntimeDeps;
}

export interface PushAttempt {
  code: number;
  error?: Error;
}

const BATCH_PUSH_CONCURRENCY = 50;

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("application/json");
}

type PathParamResult =
  | { ok: true; params: ParamMap }
  | { ok: false; message: string };

function extractPathParams(c: Context): PathParamResult {
  const params: ParamMap = {};
  const keys = ["device_key", "subtitle", "title", "body"] as const;

  for (const key of keys) {
    const value = c.req.param(key);
    if (value) {
      try {
        params[key] = decodeURIComponent(value);
      } catch (error) {
        return {
          ok: false,
          message: `url path parse failed: ${getErrorMessage(error)}`,
        };
      }
    }
  }

  return { ok: true, params };
}

function lowerCaseEntryMap(source: Iterable<[string, string]>): ParamMap {
  const params: ParamMap = {};
  for (const [key, value] of source) {
    params[key.toLowerCase()] = value;
  }
  return params;
}

async function parseFormData(request: Request, maxBodyBytes: number): Promise<ParamMap> {
  await assertBodyWithinLimit(request, maxBodyBytes);

  try {
    const formData = await request.formData();
    const params: ParamMap = {};

    formData.forEach((value, key) => {
      if (typeof value === "string") {
        params[key.toLowerCase()] = value;
      }
    });

    return params;
  } catch {
    return {};
  }
}

async function parseJsonBody(request: Request, maxBodyBytes: number): Promise<ParamMap> {
  const raw = await readLimitedText(request, maxBodyBytes);
  if (raw.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? { ...parsed } : {};
}

function normalizePushError(error: unknown): ApnsSendError {
  if (error instanceof Error) {
    return error as ApnsSendError;
  }

  const normalized = new Error(String(error)) as ApnsSendError;
  return normalized;
}

function isEmptyAlert(message: Pick<PushMessage, "title" | "subtitle" | "body">): boolean {
  return message.title.length === 0 && message.subtitle.length === 0 && message.body.length === 0;
}

function isBadDeviceTokenError(error: ApnsSendError): boolean {
  if (error.statusCode === 410) {
    return true;
  }

  return error.statusCode === 400 && error.message.includes("BadDeviceToken");
}

export function buildPushMessage(params: ParamMap): Omit<PushMessage, "deviceToken"> {
  const message = {
    deviceKey: "",
    title: "",
    subtitle: "",
    body: "",
    sound: "1107",
    extParams: {} as Record<string, unknown>,
    id: undefined as string | undefined,
  };

  for (const [rawKey, rawValue] of Object.entries(params)) {
    if (typeof rawValue === "string") {
      switch (rawKey.toLowerCase()) {
        case "id":
          message.id = rawValue;
          message.extParams.id = rawValue;
          break;
        case "device_key":
          message.deviceKey = rawValue;
          break;
        case "subtitle":
          message.subtitle = rawValue;
          break;
        case "title":
          message.title = rawValue;
          break;
        case "body":
          message.body = rawValue;
          break;
        case "sound":
          message.sound = rawValue.endsWith(".caf") ? rawValue : `${rawValue}.caf`;
          break;
        default:
          message.extParams[rawKey.toLowerCase()] = rawValue;
          break;
      }
      continue;
    }

    if (isRecord(rawValue)) {
      for (const [key, value] of Object.entries(rawValue)) {
        message.extParams[key] = value;
      }
      continue;
    }

    message.extParams[rawKey] = rawValue;
  }

  if (isEmptyAlert(message)) {
    message.body = "Empty Message";
  }

  return message;
}

export async function pushOne(params: ParamMap, options: PushRouteOptions): Promise<PushAttempt> {
  const message = buildPushMessage(params);

  if (message.deviceKey.length === 0) {
    return { code: 400, error: new Error("device key is empty") };
  }

  let deviceToken: string;
  try {
    deviceToken = await options.deps.registry.deviceTokenByKey(message.deviceKey);
  } catch (error) {
    const normalized = normalizePushError(error);

    return {
      code: 400,
      error: new Error(`failed to get device token: ${normalized.message}`),
    };
  }

  try {
    await options.deps.pushSender.send({
      ...message,
      deviceToken,
    });
    return { code: 200 };
  } catch (error) {
    const normalized = normalizePushError(error);

    // APNs rejected the token — clean it up so future pushes fail fast.
    if (isBadDeviceTokenError(normalized)) {
      await options.deps.registry.saveDeviceTokenByKey(message.deviceKey, "");
    }

    return {
      code: 500,
      error: new Error(`push failed: ${normalized.message}`),
    };
  }
}

async function routeDoPushV1(c: Context, options: PushRouteOptions) {
  const params: ParamMap = {};

  Object.assign(params, lowerCaseEntryMap(new URL(c.req.url).searchParams.entries()));
  try {
    Object.assign(params, await parseFormData(c.req.raw, options.config.maxRequestBodyBytes));
  } catch (error) {
    return c.json(
      failed(options.deps.now(), 400, `request bind failed: ${getErrorMessage(error)}`),
      400,
    );
  }
  const pathParams = extractPathParams(c);
  if (!pathParams.ok) {
    return c.json(failed(options.deps.now(), 400, pathParams.message), 400);
  }
  Object.assign(params, pathParams.params);

  const result = await pushOne(params, options);
  if (result.error) {
    c.status(result.code as 400 | 500);
    return c.json(failed(options.deps.now(), result.code, result.error.message));
  }

  return c.json(success(options.deps.now()), 200);
}

function readDeviceKeys(value: unknown): string[] | null {
  if (typeof value === "string") {
    return value.split(",");
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  return null;
}

async function pushBatch(
  deviceKeys: string[],
  params: ParamMap,
  options: PushRouteOptions,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];

  for (let i = 0; i < deviceKeys.length; i += BATCH_PUSH_CONCURRENCY) {
    const chunk = deviceKeys.slice(i, i + BATCH_PUSH_CONCURRENCY);
    const chunkRows = await Promise.all(
      chunk.map(async (deviceKey) => {
        const nextParams = { ...params, device_key: deviceKey };
        const attempt = await pushOne(nextParams, options);

        const row: Record<string, unknown> = {
          code: attempt.code,
          device_key: deviceKey,
        };

        if (attempt.error) {
          row.message = attempt.error.message;
        }

        return row;
      }),
    );

    rows.push(...chunkRows);
  }

  return rows;
}

async function routeDoPushV2(c: Context, options: PushRouteOptions) {
  let params: ParamMap = {};

  try {
    params = await parseJsonBody(c.req.raw, options.config.maxRequestBodyBytes);
  } catch (error) {
    return c.json(
      failed(options.deps.now(), 400, `request bind failed: ${getErrorMessage(error)}`),
      400,
    );
  }

  Object.assign(params, lowerCaseEntryMap(new URL(c.req.url).searchParams.entries()));
  const pathParams = extractPathParams(c);
  if (!pathParams.ok) {
    return c.json(failed(options.deps.now(), 400, pathParams.message), 400);
  }
  Object.assign(params, pathParams.params);

  let deviceKeys: string[] = [];
  if ("device_keys" in params) {
    const parsed = readDeviceKeys(params.device_keys);
    if (parsed === null) {
      return c.json(failed(options.deps.now(), 400, "invalid type for device_keys"), 400);
    }

    deviceKeys = parsed;
    delete params.device_keys;
  }

  if (deviceKeys.length === 0) {
    const result = await pushOne(params, options);
    if (result.error) {
      c.status(result.code as 400 | 500);
      return c.json(failed(options.deps.now(), result.code, result.error.message));
    }

    return c.json(success(options.deps.now()), 200);
  }

  if (
    options.config.maxBatchPushCount !== -1 &&
    deviceKeys.length > options.config.maxBatchPushCount
  ) {
    return c.json(
      failed(
        options.deps.now(),
        400,
        `batch push count exceeds the maximum limit: ${options.config.maxBatchPushCount}`,
      ),
      400,
    );
  }

  const result = await pushBatch(deviceKeys, params, options);

  return c.json(withData(options.deps.now(), result), 200);
}

async function routeDoPush(c: Context, options: PushRouteOptions) {
  const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (isJsonContentType(contentType)) {
    return routeDoPushV2(c, options);
  }

  return routeDoPushV1(c, options);
}

export function registerPushRoutes(app: Hono, options: PushRouteOptions): void {
  app.post("/push", (c) => routeDoPush(c, options));

  const handlers = [
    "/:device_key",
    "/:device_key/:body",
    "/:device_key/:title/:body",
    "/:device_key/:title/:subtitle/:body",
  ];

  for (const path of handlers) {
    app.get(path, (c) => routeDoPush(c, options));
    app.post(path, (c) => routeDoPush(c, options));
  }
}
