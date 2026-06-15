import type { Context, Hono } from "hono";

import { getErrorMessage, failed, INTERNAL_ERROR_MESSAGE, success, withData } from "@/utils/responses";
import type { AppConfig, RuntimeDeps } from "@/types";
import { assertBodyWithinLimit, readLimitedText } from "@/utils/validation";
import { isRecord } from "@/utils/objects";

interface DeviceInfo {
  device_key?: string;
  device_token?: string;
  key?: string;
  devicetoken?: string;
}

export interface RegisterRouteOptions {
  config: AppConfig;
  deps: RuntimeDeps;
}

async function parseRegisterBody(request: Request, maxBodyBytes: number): Promise<DeviceInfo> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.startsWith("application/json")) {
    const raw = await readLimitedText(request, maxBodyBytes);
    if (raw.trim().length === 0) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? (parsed as DeviceInfo) : {};
  }

  await assertBodyWithinLimit(request, maxBodyBytes);

  try {
    const formData = await request.formData();
    const body: DeviceInfo = {};

    formData.forEach((value, key) => {
      if (typeof value === "string") {
        body[key as keyof DeviceInfo] = value;
      }
    });

    return body;
  } catch {
    return {};
  }
}

async function doRegister(c: Context, options: RegisterRouteOptions, compat: boolean) {
  if (options.config.closeRegister) {
    return c.json(failed(options.deps.now(), 403, "registration is closed"), 403);
  }

  let deviceInfo: DeviceInfo = {};

  try {
    if (compat) {
      const query = c.req.query();
      deviceInfo = query as DeviceInfo;
    } else {
      deviceInfo = await parseRegisterBody(c.req.raw, options.config.maxRequestBodyBytes);
    }
  } catch (error) {
    const now = options.deps.now();
    const prefix = compat ? "request bind failed1" : "request bind failed2";
    return c.json(failed(now, 400, `${prefix}: ${getErrorMessage(error)}`), 400);
  }

  const deviceKey = deviceInfo.device_key || deviceInfo.key || "";
  const deviceToken = deviceInfo.device_token || deviceInfo.devicetoken || "";

  if (deviceToken.length === 0) {
    return c.json(failed(options.deps.now(), 400, "device token is empty"), 400);
  }

  if (deviceToken.length > 160) {
    return c.json(failed(options.deps.now(), 400, "device token is invalid"), 400);
  }

  try {
    const newKey = await options.deps.registry.saveDeviceTokenByKey(deviceKey, deviceToken);
    return c.json(
      withData(options.deps.now(), {
        key: newKey,
        device_key: newKey,
        device_token: deviceToken,
      }),
      200,
    );
  } catch (error) {
    console.error("Device registration failed", error);
    return c.json(failed(options.deps.now(), 500, INTERNAL_ERROR_MESSAGE), 500);
  }
}

async function doRegisterCheck(c: Context, options: RegisterRouteOptions) {
  const deviceKey = c.req.param("device_key");

  if (!deviceKey) {
    return c.json(failed(options.deps.now(), 400, "device key is empty"), 400);
  }

  try {
    await options.deps.registry.deviceTokenByKey(deviceKey);
    return c.json(success(options.deps.now()), 200);
  } catch (error) {
    return c.json(failed(options.deps.now(), 400, getErrorMessage(error)), 400);
  }
}

export function registerRegisterRoutes(app: Hono, options: RegisterRouteOptions): void {
  app.post("/register", (c) => doRegister(c, options, false));
  app.get("/register/:device_key", (c) => doRegisterCheck(c, options));
  app.get("/register", (c) => doRegister(c, options, true));
}
