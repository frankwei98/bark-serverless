import type { PushMessage, PushSender } from "@/types";
import { isRecord } from "@/utils/objects";

const HUAWEI_PUSH_ORIGIN = "https://push-api.cloud.huawei.com";
const DEFAULT_TOKEN_AUDIENCE = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";
const JWT_LIFETIME_SECONDS = 60 * 60;
const JWT_REFRESH_SKEW_SECONDS = 30;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_BODY_BYTES = 4 * 1024;
const MAX_TTL_SECONDS = 1_296_000;
const SUCCESS_CODE = "80000000";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HuaweiPushConfig {
  projectId?: string;
  keyId?: string;
  subAccount?: string;
  privateKey?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
  now?: () => number;
}

export class HuaweiPushError extends Error {
  readonly provider = "huawei";

  constructor(
    message: string,
    readonly statusCode?: number,
    readonly businessCode?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HuaweiPushError";
  }
}

interface HuaweiNotification {
  category: string;
  title: string;
  body: string;
  clickAction: { actionType: 0 };
  badge?: { setNum?: number; addNum?: number };
  sound?: string;
  image?: string;
  foregroundShow?: boolean;
  style?: 0 | 1 | 3;
  bigTitle?: string;
  bigBody?: string;
  inboxContent?: string[];
}

interface HuaweiRequestBody {
  payload:
    | { notification: HuaweiNotification }
    | { extraData: string };
  target: { token: string[] };
  pushOptions?: { ttl: number };
}

export interface HuaweiRequest {
  pushType: 0 | 6;
  body: HuaweiRequestBody;
}

function base64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parsePrivateKey(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\r/g, "\r").replace(/\\n/g, "\n").trim();
  const match = normalized.match(
    /-----BEGIN PRIVATE KEY-----\s*([\s\S]*?)\s*-----END PRIVATE KEY-----/,
  );
  const encoded = match?.[1]?.replace(/\s+/g, "") ?? "";
  if (encoded.length === 0) {
    throw new Error("HUAWEI_PRIVATE_KEY must be a PKCS#8 PEM block");
  }

  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("HUAWEI_PRIVATE_KEY must contain valid base64 PEM data");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function integerParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanParam(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (["true", "t", "1"].includes(value.trim().toLowerCase())) return true;
    if (["false", "f", "0"].includes(value.trim().toLowerCase())) return false;
  }
  return undefined;
}

function firstParam(params: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return params[key];
    }
  }
  return undefined;
}

function buildBadge(params: Record<string, unknown>): HuaweiNotification["badge"] {
  const nested = isRecord(params.badge) ? params.badge : undefined;
  const setNum = integerParam(
    nested?.setNum ??
      nested?.setnum ??
      firstParam(params, ["badge_set", "badgeset", "setnum", "badgeset"]),
  );
  if (setNum !== undefined && setNum >= 0 && setNum <= 99) {
    return { setNum };
  }

  const scalarBadge = integerParam(params.badge);
  if (scalarBadge !== undefined && scalarBadge >= 0 && scalarBadge <= 99) {
    return { setNum: scalarBadge };
  }

  const addNum = integerParam(
    nested?.addNum ??
      nested?.addnum ??
      firstParam(params, ["badge_add", "badgeadd", "addnum", "badgeadd"]),
  );
  return addNum !== undefined && addNum >= 1 && addNum <= 99
    ? { addNum }
    : undefined;
}

function buildInboxContent(params: Record<string, unknown>): string[] | undefined {
  const raw = firstParam(params, ["inbox_content", "inboxcontent"]);
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(raw.includes("|") ? "|" : raw.includes("\n") ? "\n" : ",")
      : [];
  const result = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 1024)
    .slice(0, 3);
  return result.length > 0 ? result : undefined;
}

function isDelete(message: PushMessage): boolean {
  return message.extParams.delete === 1 || message.extParams.delete === "1";
}

export function buildHuaweiRequest(message: PushMessage): HuaweiRequest {
  const ttl = integerParam(message.extParams.ttl);
  const pushOptions =
    ttl !== undefined && ttl > 0 && ttl <= MAX_TTL_SECONDS ? { ttl } : undefined;

  if (isDelete(message)) {
    return {
      pushType: 6,
      body: {
        payload: { extraData: JSON.stringify({
          ...message.extParams,
          ...(message.rawSound !== undefined ? { sound: message.rawSound } : {}),
        }) },
        target: { token: [message.deviceToken] },
        ...(pushOptions ? { pushOptions } : {}),
      },
    };
  }

  const categoryValue = message.extParams.category;
  const category =
    typeof categoryValue === "string" && categoryValue.trim().length > 0
      ? categoryValue.trim()
      : "WORK";
  const notification: HuaweiNotification = {
    category,
    title: message.title,
    body: message.body,
    clickAction: { actionType: 0 },
  };

  const badge = buildBadge(message.extParams);
  if (badge) {
    notification.badge = badge;
  }

  const sound = message.rawSound?.trim();
  if (sound) {
    notification.sound = sound.endsWith(".mp3") ? sound : `${sound}.mp3`;
  }

  const image = message.extParams.image;
  if (typeof image === "string" && image.trim().length > 0) {
    notification.image = image.trim();
  }

  const foregroundShow = booleanParam(
    firstParam(message.extParams, ["foreground_show", "foregroundshow"]),
  );
  if (foregroundShow !== undefined) {
    notification.foregroundShow = foregroundShow;
  }

  const style = integerParam(message.extParams.style);
  const inboxContent = buildInboxContent(message.extParams);
  if (style === 1) {
    notification.style = 1;
    notification.bigTitle = message.title;
    notification.bigBody = message.body;
  } else if (inboxContent && (style === undefined || style === 0 || style === 3)) {
    notification.style = 3;
    notification.inboxContent = inboxContent;
  }

  return {
    pushType: 0,
    body: {
      payload: { notification },
      target: { token: [message.deviceToken] },
      ...(pushOptions ? { pushOptions } : {}),
    },
  };
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BODY_BYTES) {
        cancel();
        throw new HuaweiPushError("Huawei push response is too large", response.status);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class HuaweiPushSender implements PushSender {
  private cryptoKeyPromise?: Promise<CryptoKey>;
  private cachedJwt?: { token: string; expiresAt: number };
  private jwtPromise?: Promise<{ token: string; expiresAt: number }>;

  constructor(private readonly config: HuaweiPushConfig) {}

  private requireConfig(): {
    projectId: string;
    keyId: string;
    subAccount: string;
    privateKey: string;
  } {
    const { projectId, keyId, subAccount, privateKey } = this.config;
    if (!projectId || !keyId || !subAccount || !privateKey) {
      throw new HuaweiPushError("Huawei push is not configured");
    }
    return { projectId, keyId, subAccount, privateKey };
  }

  private getCryptoKey(privateKey: string): Promise<CryptoKey> {
    this.cryptoKeyPromise ??= crypto.subtle.importKey(
      "pkcs8",
      parsePrivateKey(privateKey),
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return this.cryptoKeyPromise;
  }

  private async generateJwt(): Promise<{ token: string; expiresAt: number }> {
    const { keyId, subAccount, privateKey } = this.requireConfig();
    const now = Math.floor((this.config.now?.() ?? Date.now()) / 1000);
    const expiresAt = now + JWT_LIFETIME_SECONDS;
    const header = base64url(JSON.stringify({ alg: "PS256", kid: keyId, typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        aud: DEFAULT_TOKEN_AUDIENCE,
        iss: subAccount,
        exp: expiresAt,
        iat: now,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      await this.getCryptoKey(privateKey),
      new TextEncoder().encode(signingInput),
    );
    return {
      token: `${signingInput}.${base64url(new Uint8Array(signature))}`,
      expiresAt,
    };
  }

  private async getJwt(): Promise<string> {
    const now = Math.floor((this.config.now?.() ?? Date.now()) / 1000);
    if (
      this.cachedJwt &&
      now >= this.cachedJwt.expiresAt - JWT_LIFETIME_SECONDS &&
      now < this.cachedJwt.expiresAt - JWT_REFRESH_SKEW_SECONDS
    ) {
      return this.cachedJwt.token;
    }

    this.jwtPromise ??= this.generateJwt();
    try {
      this.cachedJwt = await this.jwtPromise;
      return this.cachedJwt.token;
    } finally {
      this.jwtPromise = undefined;
    }
  }

  async send(message: PushMessage): Promise<void> {
    const { projectId } = this.requireConfig();
    if (message.deviceToken.length === 0) {
      throw new HuaweiPushError("Huawei device token is empty");
    }

    const request = buildHuaweiRequest(message);
    const messageBody = JSON.stringify({
      payload: request.body.payload,
      ...(request.body.pushOptions
        ? { pushOptions: request.body.pushOptions }
        : {}),
    });
    if (new TextEncoder().encode(messageBody).byteLength > MAX_MESSAGE_BODY_BYTES) {
      throw new HuaweiPushError("Huawei push message exceeds 4096 bytes");
    }
    let jwt: string;
    try {
      jwt = await this.getJwt();
    } catch (error) {
      if (error instanceof HuaweiPushError) {
        throw error;
      }
      throw new HuaweiPushError("Huawei push authentication failed");
    }

    const fetcher = this.config.fetcher ?? fetch;
    const controller = new AbortController();
    const configuredTimeout = this.config.timeoutMs;
    const timeoutMs = configuredTimeout !== undefined && Number.isInteger(configuredTimeout)
      && configuredTimeout > 0 && configuredTimeout <= 60_000
      ? configuredTimeout : DEFAULT_TIMEOUT_MS;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new HuaweiPushError("Huawei push network request failed", undefined, undefined, true));
      }, timeoutMs);
    });

    let response: Response;
    let responseText: string;
    try {
      ({ response, responseText } = await Promise.race([
        (async () => {
          const nextResponse = await fetcher(
            `${HUAWEI_PUSH_ORIGIN}/v3/${encodeURIComponent(projectId)}/messages:send`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${jwt}`,
                "content-type": "application/json; charset=UTF-8",
                "push-type": String(request.pushType),
              },
              body: JSON.stringify(request.body),
              signal: controller.signal,
              redirect: "error",
            },
          );
          return {
            response: nextResponse,
            responseText: await readBoundedText(nextResponse, controller.signal),
          };
        })(),
        timeout,
      ]));
    } catch (error) {
      if (error instanceof HuaweiPushError) {
        throw error;
      }
      throw new HuaweiPushError("Huawei push network request failed", undefined, undefined, true);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      if (!response.ok) {
        throw new HuaweiPushError(
          `Huawei push HTTP ${response.status}`,
          response.status,
          undefined,
          response.status === 429 || response.status >= 500,
        );
      }
      throw new HuaweiPushError("Huawei push returned an invalid response", response.status);
    }
    const code = isRecord(parsed) ? parsed.code : undefined;
    const rawBusinessCode =
      typeof code === "string" || typeof code === "number" ? String(code) : undefined;
    const businessCode = rawBusinessCode && /^\d{8}$/.test(rawBusinessCode)
      ? rawBusinessCode
      : undefined;
    if (businessCode !== SUCCESS_CODE) {
      throw new HuaweiPushError(
        businessCode
          ? `Huawei push failed with business code ${businessCode}`
          : "Huawei push returned an invalid response",
        response.status,
        businessCode,
        response.status === 429 ||
          response.status >= 500 ||
          businessCode === "81000001",
      );
    }

    if (!response.ok) {
      throw new HuaweiPushError(
        `Huawei push HTTP ${response.status}`,
        response.status,
        businessCode,
        response.status === 429 || response.status >= 500,
      );
    }
  }
}
