import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Context, Hono } from "hono";

import { pushOne } from "@/routes/push";
import { timingSafeStringEqual } from "@/utils/timing-safe";
import type { AppConfig, RuntimeDeps } from "@/types";
import { readLimitedText } from "@/utils/validation";
import { isRecord } from "@/utils/objects";

export interface McpRouteOptions {
  config: AppConfig;
  deps: RuntimeDeps;
}

const ACCEPTED_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
] as const;
const LEGACY_INITIALIZE_PROTOCOL_VERSIONS = ["2024-11-05"] as const;
const SUPPORTED_PROTOCOL_VERSIONS = new Set<string>(ACCEPTED_PROTOCOL_VERSIONS);
const LEGACY_INITIALIZE_PROTOCOL_VERSION_SET = new Set<string>(
  LEGACY_INITIALIZE_PROTOCOL_VERSIONS,
);
const SERVER_PROTOCOL_VERSION = "2025-11-25";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const PROTOCOL_HEADER = "MCP-Protocol-Version";

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

type McpHandlerResult =
  | { kind: "response"; body: JsonRpcResponse; status?: number }
  | { kind: "notification" }
  | { kind: "client-response" };

interface SessionPayload {
  iat: number;
  exp: number;
  protocolVersion: string;
  scope: string;
  deviceKey?: string;
}

type SessionValidationResult =
  | { valid: true; payload: SessionPayload }
  | { valid: false; status: 400 | 404; message: string };

type ProtocolValidationResult =
  | { valid: true; version: string | null }
  | { valid: false; version: string };

type InitializeNegotiationResult =
  | { valid: true; version: string }
  | { valid: false; version: string };

function normalizeJsonRpcId(id: unknown): JsonRpcId {
  if (typeof id === "number" || typeof id === "string" || id === null) {
    return id;
  }

  return null;
}

function isJsonRpcObject(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === "2.0";
}

function isJsonRpcNotification(body: JsonRpcRequest): boolean {
  return !("id" in body);
}

function isJsonRpcClientResponse(body: JsonRpcRequest): boolean {
  return "id" in body && !("method" in body);
}

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return base64urlEncode(new Uint8Array(sig));
}

async function createSessionToken(
  secret: string,
  protocolVersion: string,
  scope: "global" | "device",
  deviceKey: string | undefined,
  now: number,
): Promise<string> {
  const payload: SessionPayload = {
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    protocolVersion,
    scope,
    ...(deviceKey !== undefined ? { deviceKey } : {}),
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payloadJson));
  const signature = await hmacSign(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

async function validateSessionToken(
  secret: string,
  token: string,
  now: number,
  expectedScope: "global" | "device",
  expectedDeviceKey: string | null,
): Promise<SessionValidationResult> {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex <= 0) {
    return { valid: false, status: 400, message: "Malformed session token" };
  }

  const payloadB64 = token.slice(0, dotIndex);
  const signatureB64 = token.slice(dotIndex + 1);

  const expectedSig = await hmacSign(secret, payloadB64);
  if (!timingSafeStringEqual(signatureB64, expectedSig)) {
    return { valid: false, status: 400, message: "Invalid session signature" };
  }

  let payload: SessionPayload;
  try {
    const payloadBytes = base64urlDecode(payloadB64);
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
  } catch {
    return { valid: false, status: 400, message: "Malformed session payload" };
  }

  if (now >= payload.exp) {
    return { valid: false, status: 404, message: "Session expired" };
  }

  if (payload.scope !== expectedScope) {
    return { valid: false, status: 400, message: "Session scope mismatch" };
  }

  if (expectedScope === "device" && payload.deviceKey !== expectedDeviceKey) {
    return { valid: false, status: 400, message: "Session device_key mismatch" };
  }

  return { valid: true, payload };
}

function setProtocolHeader(c: Context, version = SERVER_PROTOCOL_VERSION): void {
  c.header(PROTOCOL_HEADER, version);
}

function protocolError(
  c: Context,
  message: string,
  status: 400,
  version = SERVER_PROTOCOL_VERSION,
): Response {
  setProtocolHeader(c, version);
  return c.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message },
    } satisfies JsonRpcErrorResponse,
    status,
  );
}

function responseProtocolVersionForHeader(headerValue: string | undefined): string {
  const validation = validateProtocolHeader(headerValue);
  return validation.valid && validation.version !== null
    ? validation.version
    : SERVER_PROTOCOL_VERSION;
}

function validateProtocolHeader(headerValue: string | undefined): ProtocolValidationResult {
  if (headerValue === undefined) {
    return { valid: true, version: null };
  }

  if (SUPPORTED_PROTOCOL_VERSIONS.has(headerValue)) {
    return { valid: true, version: headerValue };
  }

  return { valid: false, version: headerValue };
}

function isProtocolVersionDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function negotiateInitializeProtocolVersion(
  clientVersion: string | undefined,
): InitializeNegotiationResult {
  if (clientVersion === undefined) {
    return { valid: true, version: SERVER_PROTOCOL_VERSION };
  }

  if (SUPPORTED_PROTOCOL_VERSIONS.has(clientVersion)) {
    return { valid: true, version: clientVersion };
  }

  if (LEGACY_INITIALIZE_PROTOCOL_VERSION_SET.has(clientVersion)) {
    return { valid: true, version: SERVER_PROTOCOL_VERSION };
  }

  if (isProtocolVersionDate(clientVersion)) {
    return { valid: true, version: SERVER_PROTOCOL_VERSION };
  }

  return { valid: false, version: clientVersion };
}

function buildNotifyTool(deviceKeyRequired: boolean) {
  const properties: Record<string, unknown> = {
    title: { type: "string", description: "Notification title" },
    subtitle: { type: "string", description: "Notification subtitle" },
    body: { type: "string", description: "Notification content" },
    markdown: {
      type: "string",
      description: "Basic Markdown notification content. Overrides body.",
    },
    level: {
      type: "string",
      description: "Notification level",
      enum: ["critical", "active", "timeSensitive", "passive"],
    },
    volume: {
      type: "number",
      description: "Alert volume for important notification",
      default: 5,
    },
    badge: { type: "number", description: "Badge number" },
    call: {
      type: "string",
      description: "Set to '1' to repeat the notification ringtone",
    },
    sound: { type: "string", description: "Notification sound" },
    icon: { type: "string", description: "Notification icon URL" },
    image: { type: "string", description: "Notification image URL" },
    group: { type: "string", description: "Notification group" },
    isArchive: {
      type: "string",
      description:
        "Set to '1' to save the notification or any other value to skip saving",
    },
    ttl: {
      type: "number",
      description:
        "Time to live in seconds for archived messages; expired items are automatically deleted",
    },
    url: { type: "string", description: "Click action URL" },
    copy: { type: "string", description: "Text to copy on copy action" },
  };

  if (deviceKeyRequired) {
    properties.device_key = { type: "string", description: "Device Key" };
  }

  return {
    name: "notify",
    description: "Send a notification to a device via Bark",
    inputSchema: {
      type: "object" as const,
      properties,
      required: deviceKeyRequired ? ["device_key"] : [],
    },
  };
}

async function handleMcpRequest(
  body: JsonRpcRequest,
  pathDeviceKey: string | null,
  options: McpRouteOptions,
  negotiatedInitializeProtocolVersion?: string,
): Promise<McpHandlerResult> {
  const id = normalizeJsonRpcId(body.id);

  if (isJsonRpcClientResponse(body)) {
    return { kind: "client-response" };
  }

  if (isJsonRpcNotification(body)) {
    return { kind: "notification" };
  }

  switch (body.method) {
    case "initialize": {
      const clientVersion = (body.params as Record<string, unknown> | undefined)
        ?.protocolVersion as string | undefined;
      const negotiation =
        negotiatedInitializeProtocolVersion !== undefined
          ? { valid: true as const, version: negotiatedInitializeProtocolVersion }
          : negotiateInitializeProtocolVersion(clientVersion);

      if (!negotiation.valid) {
        return {
          kind: "response",
          status: 400,
          body: {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Unsupported protocol version: ${negotiation.version}. Supported: ${[...SUPPORTED_PROTOCOL_VERSIONS].join(", ")}`,
            },
          },
        };
      }

      return {
        kind: "response",
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiation.version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "Bark MCP Server",
              version: options.deps.buildInfo.version,
            },
          },
        },
      };
    }

    case "tools/list":
      return {
        kind: "response",
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [buildNotifyTool(pathDeviceKey === null)],
          },
        },
      };

    case "tools/call": {
      const params = body.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      if (params?.name !== "notify") {
        return {
          kind: "response",
          body: {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: unknown tool ${params?.name ?? "undefined"}`,
            },
          },
        };
      }

      const args = { ...(params?.arguments ?? {}) } as Record<string, unknown>;

      let deviceKey: string | undefined;
      if (pathDeviceKey !== null) {
        deviceKey = pathDeviceKey;
      } else {
        deviceKey = args.device_key as string | undefined;
      }

      if (!deviceKey) {
        return {
          kind: "response",
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: "device_key is required" }],
              isError: true,
            },
          },
        };
      }

      args.device_key = deviceKey;
      const result = await pushOne(args, {
        config: options.config,
        deps: options.deps,
      });

      if (result.error) {
        return {
          kind: "response",
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Failed to send notification: ${result.error.message} (code ${result.code})`,
                },
              ],
              isError: true,
            },
          },
        };
      }

      return {
        kind: "response",
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "text", text: "Notification sent successfully" },
            ],
          },
        },
      };
    }

    default:
      return {
        kind: "response",
        body: {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${body.method}`,
          },
        },
      };
  }
}

export function registerMcpRoutes(app: Hono, options: McpRouteOptions): void {
  async function handlePost(c: Context, pathDeviceKey: string | null) {
    const protocolHeader = c.req.header("mcp-protocol-version");
    const protocolValidation = validateProtocolHeader(protocolHeader);
    let responseProtocolVersion =
      protocolValidation.valid && protocolValidation.version !== null
        ? protocolValidation.version
        : SERVER_PROTOCOL_VERSION;
    if (!protocolValidation.valid) {
      return protocolError(
        c,
        `Unsupported protocol version: ${protocolValidation.version}. Supported: ${[...SUPPORTED_PROTOCOL_VERSIONS].join(", ")}`,
        400,
        responseProtocolVersion,
      );
    }

    // Origin check
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const requestUrl = new URL(c.req.url);
      const requestOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
      if (origin !== requestOrigin) {
        setProtocolHeader(c, responseProtocolVersion);
        return c.text("Forbidden: Origin mismatch", 403);
      }
    }

    // Accept header validation
    const accept = c.req.header("accept");
    if (accept !== undefined && !accept.includes("application/json")) {
      setProtocolHeader(c, responseProtocolVersion);
      return c.text("Not Acceptable", 406);
    }

    // Session early check
    const hasSession = Boolean(options.config.mcpSessionSecret);
    const sessionHeader = c.req.header("mcp-session-id");

    if (!hasSession && sessionHeader !== undefined) {
      return protocolError(
        c,
        "Session management is not enabled on this server",
        400,
        responseProtocolVersion,
      );
    }

    // Parse body
    let parsed: unknown;
    let body: JsonRpcRequest;
    try {
      const raw = await readLimitedText(
        c.req.raw,
        options.config.maxRequestBodyBytes,
      );
      parsed = JSON.parse(raw);
    } catch {
      setProtocolHeader(c, responseProtocolVersion);
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        } satisfies JsonRpcErrorResponse,
        400,
      );
    }

    if (Array.isArray(parsed)) {
      setProtocolHeader(c, responseProtocolVersion);
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "JSON-RPC batch requests are not supported",
          },
        } satisfies JsonRpcErrorResponse,
        400,
      );
    }

    if (!isJsonRpcObject(parsed)) {
      setProtocolHeader(c, responseProtocolVersion);
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" },
        } satisfies JsonRpcErrorResponse,
        400,
      );
    }

    body = parsed;

    let negotiatedInitializeProtocolVersion: string | undefined;
    if (body.method === "initialize") {
      const clientVersion = (body.params as Record<string, unknown> | undefined)
        ?.protocolVersion as string | undefined;
      if (clientVersion !== undefined && protocolHeader !== undefined && clientVersion !== protocolHeader) {
        setProtocolHeader(c, responseProtocolVersion);
        return c.json(
          {
            jsonrpc: "2.0",
            id: normalizeJsonRpcId(body.id),
            error: {
              code: -32602,
              message: `Protocol version mismatch between ${PROTOCOL_HEADER} header (${protocolHeader}) and initialize params (${clientVersion})`,
            },
          } satisfies JsonRpcErrorResponse,
          400,
        );
      }

      const negotiation = negotiateInitializeProtocolVersion(
        clientVersion ?? protocolHeader,
      );
      if (negotiation.valid) {
        responseProtocolVersion = negotiation.version;
        negotiatedInitializeProtocolVersion = negotiation.version;
      }
    }

    // Session validation for non-initialize requests stays optional for compatibility.
    if (hasSession && body.method !== "initialize" && sessionHeader) {
      const now = options.deps.now();
      const expectedScope = pathDeviceKey !== null ? "device" : "global";
      const validation = await validateSessionToken(
        options.config.mcpSessionSecret!,
        sessionHeader,
        now,
        expectedScope,
        pathDeviceKey,
      );

      if (!validation.valid) {
        setProtocolHeader(c, responseProtocolVersion);
        return c.json(
          {
            jsonrpc: "2.0",
            id: normalizeJsonRpcId(body.id),
            error: { code: -32600, message: validation.message },
          } satisfies JsonRpcErrorResponse,
          validation.status,
        );
      }
    }

    // Dispatch
    const result = await handleMcpRequest(
      body,
      pathDeviceKey,
      options,
      negotiatedInitializeProtocolVersion,
    );

    if (result.kind === "notification" || result.kind === "client-response") {
      setProtocolHeader(c, responseProtocolVersion);
      return c.body(null, 202);
    }

    // Attach session on successful initialize
    if (
      hasSession &&
      body.method === "initialize" &&
      !("error" in result.body && result.body.error)
    ) {
      const now = options.deps.now();
      const clientVersion = (
        body.params as Record<string, unknown> | undefined
      )?.protocolVersion as string | undefined;
      const fallbackNegotiation = negotiateInitializeProtocolVersion(clientVersion);
      const negotiatedVersion =
        protocolHeader ??
        negotiatedInitializeProtocolVersion ??
        (fallbackNegotiation.valid
          ? fallbackNegotiation.version
          : SERVER_PROTOCOL_VERSION);
      const scope = pathDeviceKey !== null ? "device" : "global";

      const token = await createSessionToken(
        options.config.mcpSessionSecret!,
        negotiatedVersion,
        scope,
        pathDeviceKey ?? undefined,
        now,
      );
      c.header("Mcp-Session-Id", token);
    }

    setProtocolHeader(c, responseProtocolVersion);
    return c.json(result.body, (result.status ?? 200) as ContentfulStatusCode);
  }

  app.post("/mcp", (c) => handlePost(c, null));
  app.post("/mcp/:device_key", (c) =>
    handlePost(c, c.req.param("device_key") ?? null),
  );

  const methodNotAllowed = (c: Context) => {
    setProtocolHeader(
      c,
      responseProtocolVersionForHeader(c.req.header("mcp-protocol-version")),
    );
    return c.text("Method Not Allowed", 405);
  };
  app.get("/mcp", methodNotAllowed);
  app.get("/mcp/:device_key", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
  app.delete("/mcp/:device_key", methodNotAllowed);
}
