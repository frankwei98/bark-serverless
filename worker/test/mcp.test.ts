import { describe, expect, it } from "vitest";

import { createApnsError, createHarness } from "./helpers/fakes";

interface McpResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo?: { name: string; version: string };
    tools?: Array<{
      name: string;
      description: string;
      inputSchema: {
        properties: Record<string, unknown>;
        required: string[];
      };
    }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function jsonRpcRequest(
  app: ReturnType<typeof createHarness>["app"],
  url: string,
  method: string,
  params?: Record<string, unknown>,
  id: number | string | null | undefined = 1,
  extraHeaders?: Record<string, string>,
) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (id !== undefined) {
    body.id = id;
  }

  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function jsonRpcNotification(
  app: ReturnType<typeof createHarness>["app"],
  url: string,
  method: string,
  params?: Record<string, unknown>,
) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params) {
    body.params = params;
  }

  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function parseMcpResponse(res: Response): Promise<McpResponse> {
  return (await res.json()) as McpResponse;
}

describe("mcp compatibility", () => {
  it("initialize returns server info and capabilities", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result!.protocolVersion).toBe("2025-06-18");
    expect(body.result!.capabilities).toBeDefined();
    expect(body.result!.serverInfo!.name).toBe("Bark MCP Server");
    expect(body.result!.serverInfo!.version).toBe("test-version");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
  });

  it("tools/list returns the notify tool", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "tools/list");

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.tools).toHaveLength(1);
    expect(body.result!.tools![0].name).toBe("notify");
    expect(body.result!.tools![0].inputSchema.properties).toHaveProperty("title");
    expect(body.result!.tools![0].inputSchema.properties).toHaveProperty("body");
    expect(body.result!.tools![0].inputSchema.properties).toHaveProperty("device_key");
    expect(body.result!.tools![0].inputSchema.properties).toHaveProperty("volume");
    expect(body.result!.tools![0].inputSchema.required).toContain("device_key");
  });

  it("tools/list on /mcp/:device_key does not require device_key", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp/some-key", "tools/list");

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.tools![0].inputSchema.required).not.toContain("device_key");
  });

  it("supports /mcp with device_key supplied in tool arguments", async () => {
    const harness = createHarness({
      registrySeed: { "test-key": "test-token" },
    });

    const res = await jsonRpcRequest(harness.app, "/mcp", "tools/call", {
      name: "notify",
      arguments: { device_key: "test-key", title: "Hello", body: "World" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.content![0].text).toBe("Notification sent successfully");
    expect(body.result!.isError).toBeUndefined();
    expect(harness.sender.messages).toHaveLength(1);
    expect(harness.sender.messages[0].deviceKey).toBe("test-key");
    expect(harness.sender.messages[0].title).toBe("Hello");
    expect(harness.sender.messages[0].body).toBe("World");
  });

  it("supports /mcp/:device_key with path-injected device_key", async () => {
    const harness = createHarness({
      registrySeed: { "path-key": "path-token" },
    });

    const res = await jsonRpcRequest(harness.app, "/mcp/path-key", "tools/call", {
      name: "notify",
      arguments: { title: "Path Test", body: "Body" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.content![0].text).toBe("Notification sent successfully");
    expect(harness.sender.messages).toHaveLength(1);
    expect(harness.sender.messages[0].deviceKey).toBe("path-key");
  });

  it("path device_key overrides tool args device_key", async () => {
    const harness = createHarness({
      registrySeed: { "path-key": "path-token", "arg-key": "arg-token" },
    });

    const res = await jsonRpcRequest(harness.app, "/mcp/path-key", "tools/call", {
      name: "notify",
      arguments: { device_key: "arg-key", title: "Override", body: "Test" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.content![0].text).toBe("Notification sent successfully");
    expect(harness.sender.messages[0].deviceKey).toBe("path-key");
  });

  it("missing device_key on /mcp returns error", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "tools/call", {
      name: "notify",
      arguments: { body: "no key" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content![0].text).toContain("device_key is required");
  });

  it("handles push failure", async () => {
    const harness = createHarness({
      registrySeed: { "bad-key": "bad-token" },
    });
    harness.sender.failForDeviceToken(
      "bad-token",
      createApnsError("BadDeviceToken", 400),
    );

    const res = await jsonRpcRequest(harness.app, "/mcp", "tools/call", {
      name: "notify",
      arguments: { device_key: "bad-key", body: "will fail" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content![0].text).toContain("Failed to send notification");
    expect(body.result!.content![0].text).toContain("BadDeviceToken");
  });

  it("notifications/initialized returns 202 with no body", async () => {
    const { app } = createHarness();

    const res = await jsonRpcNotification(app, "/mcp", "notifications/initialized");

    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("malformed JSON returns 400 with parse error", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json",
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error!.code).toBe(-32700);
    expect(body.error!.message).toBe("Parse error");
  });

  it("oversized JSON returns 400 with parse error", async () => {
    const { app } = createHarness({
      config: { maxRequestBodyBytes: 64 * 1024 },
    });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        padding: "x".repeat(70 * 1024),
      }),
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error!.code).toBe(-32700);
    expect(body.error!.message).toBe("Parse error");
  });

  it("JSON-RPC batch arrays return invalid request instead of 202", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
      ]),
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.code).toBe(-32600);
    expect(body.error!.message).toContain("batch");
  });

  it("non-object JSON-RPC bodies return invalid request", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(1),
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.code).toBe(-32600);
    expect(body.error!.message).toBe("Invalid Request");
  });

  it("objects missing JSON-RPC version return invalid request", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tools/list" }),
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.code).toBe(-32600);
    expect(body.error!.message).toBe("Invalid Request");
  });

  it("accepts custom path device_key characters for Go compatibility", async () => {
    const harness = createHarness({
      registrySeed: { "bad$key": "bad-key-token" },
    });

    const res = await jsonRpcRequest(harness.app, "/mcp/bad$key", "tools/call", {
      name: "notify",
      arguments: { body: "hello" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.isError).toBeUndefined();
    expect(harness.sender.messages[0].deviceKey).toBe("bad$key");
  });

  it("unknown method returns method not found error", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "unknown/method");

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.error!.code).toBe(-32601);
    expect(body.error!.message).toContain("Method not found");
  });

  it("normalizes non-standard ids to null in MCP error responses", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: true, method: "unknown/method" }),
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error!.code).toBe(-32601);
  });

  it("unknown tool name returns method not found instead of sending a push", async () => {
    const harness = createHarness({
      registrySeed: { "test-key": "test-token" },
    });

    const res = await jsonRpcRequest(harness.app, "/mcp", "tools/call", {
      name: "not-notify",
      arguments: { device_key: "test-key", body: "hello" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.error!.code).toBe(-32601);
    expect(body.error!.message).toContain("unknown tool");
    expect(harness.sender.messages).toHaveLength(0);
  });

  // --- HTTP method dispatch ---

  it("GET /mcp returns 405", async () => {
    const { app } = createHarness();
    const res = await app.request("/mcp", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("GET /mcp/:device_key returns 405", async () => {
    const { app } = createHarness();
    const res = await app.request("/mcp/some-key", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("DELETE /mcp returns 405", async () => {
    const { app } = createHarness();
    const res = await app.request("/mcp", { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("DELETE /mcp/:device_key returns 405", async () => {
    const { app } = createHarness();
    const res = await app.request("/mcp/some-key", { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  // --- Version negotiation ---

  it("initialize with absent protocolVersion returns 2025-11-25", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.protocolVersion).toBe("2025-11-25");
  });

  it("initialize with protocolVersion 2025-03-26 returns 2025-03-26", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.protocolVersion).toBe("2025-03-26");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
  });

  it("initialize can negotiate from MCP-Protocol-Version header when params omit protocolVersion", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.protocolVersion).toBe("2025-03-26");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
  });

  it("initialize with protocolVersion 2025-06-18 returns 2025-06-18", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.protocolVersion).toBe("2025-06-18");
  });

  it("initialize with protocolVersion 2025-11-25 returns 2025-11-25", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.protocolVersion).toBe("2025-11-25");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  it("initialize with legacy protocolVersion 2024-11-05 negotiates to 2025-11-25", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.protocolVersion).toBe("2025-11-25");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  it("initialize with unknown date protocolVersion negotiates to server latest", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2026-01-01",
      capabilities: {},
      clientInfo: { name: "future-client", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.protocolVersion).toBe("2025-11-25");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  it("initialize with invalid protocolVersion returns 400", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "1.0.0",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.code).toBe(-32602);
    expect(body.error!.message).toContain("1.0.0");
  });

  // --- MCP-Protocol-Version header ---

  it("all responses include MCP-Protocol-Version header", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "tools/list");

    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  it("405 responses include MCP-Protocol-Version header", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", { method: "GET" });

    expect(res.status).toBe(405);
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  // --- Notification response status ---

  it("unknown notification returns 202 with empty body", async () => {
    const { app } = createHarness();

    const res = await jsonRpcNotification(app, "/mcp", "notifications/cancelled");

    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("client response payload returns 202 with empty body", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    });

    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  // --- Accept header ---

  it("Accept header not including application/json returns 406", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(406);
  });

  it("Accept header including application/json proceeds normally", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/html",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
  });

  it("unsupported MCP-Protocol-Version header returns 400", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2024-11-05",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.message).toContain("Unsupported protocol version");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  it("supported MCP-Protocol-Version header proceeds normally", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
  });

  it("latest MCP-Protocol-Version header proceeds normally", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  });

  // --- Origin header ---

  it("Origin matching request origin proceeds normally", async () => {
    const { app } = createHarness();

    const res = await app.request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
  });

  it("Origin mismatch returns 403", async () => {
    const { app } = createHarness();

    const res = await app.request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(403);
  });

  // --- Session management ---

  it("initialize with secret returns Mcp-Session-Id header", async () => {
    const { app } = createHarness({
      config: { mcpSessionSecret: "test-secret" },
    });

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();
    expect(sessionId!).toContain(".");
  });

  it("initialize without secret does not return Mcp-Session-Id", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Mcp-Session-Id")).toBeNull();
  });

  it("valid session allows subsequent requests", async () => {
    const { app } = createHarness({
      config: { mcpSessionSecret: "test-secret" },
    });

    const initRes = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    const sessionId = initRes.headers.get("Mcp-Session-Id")!;

    const res = await jsonRpcRequest(
      app,
      "/mcp",
      "tools/list",
      undefined,
      1,
      { "mcp-session-id": sessionId },
    );

    expect(res.status).toBe(200);
  });

  it("secret enabled still allows direct calls without session header", async () => {
    const harness = createHarness({
      config: { mcpSessionSecret: "test-secret" },
      registrySeed: { alpha: "token-alpha" },
    });

    const res = await jsonRpcRequest(harness.app, "/mcp", "tools/call", {
      name: "notify",
      arguments: { device_key: "alpha", body: "hello" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result!.isError).toBeUndefined();
    expect(harness.sender.messages).toHaveLength(1);
  });

  it("/mcp/:device_key session cannot access /mcp", async () => {
    const { app } = createHarness({
      config: { mcpSessionSecret: "test-secret" },
    });

    const initRes = await jsonRpcRequest(app, "/mcp/some-key", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    const sessionId = initRes.headers.get("Mcp-Session-Id")!;

    const res = await jsonRpcRequest(
      app,
      "/mcp",
      "tools/list",
      undefined,
      1,
      { "mcp-session-id": sessionId },
    );

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.message).toContain("scope mismatch");
  });

  it("/mcp/:device_key session cannot access different device_key", async () => {
    const { app } = createHarness({
      config: { mcpSessionSecret: "test-secret" },
    });

    const initRes = await jsonRpcRequest(app, "/mcp/key-a", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    const sessionId = initRes.headers.get("Mcp-Session-Id")!;

    const res = await jsonRpcRequest(
      app,
      "/mcp/key-b",
      "tools/list",
      undefined,
      1,
      { "mcp-session-id": sessionId },
    );

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.message).toContain("device_key mismatch");
  });

  it("expired session returns 404", async () => {
    const secret = "test-secret";
    const baseTime = 1_700_000_000;

    const harness1 = createHarness({
      config: { mcpSessionSecret: secret },
      now: () => baseTime,
    });

    const initRes = await jsonRpcRequest(harness1.app, "/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    const sessionId = initRes.headers.get("Mcp-Session-Id")!;

    const harness2 = createHarness({
      config: { mcpSessionSecret: secret },
      now: () => baseTime + 25 * 60 * 60,
    });

    const res = await jsonRpcRequest(
      harness2.app,
      "/mcp",
      "tools/list",
      undefined,
      1,
      { "mcp-session-id": sessionId },
    );

    expect(res.status).toBe(404);
  });

  it("malformed session returns 400", async () => {
    const { app } = createHarness({
      config: { mcpSessionSecret: "test-secret" },
    });

    const res = await jsonRpcRequest(
      app,
      "/mcp",
      "tools/list",
      undefined,
      1,
      { "mcp-session-id": "not-a-valid-token" },
    );

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.message).toContain("Malformed");
  });

  it("bad signature session returns 400", async () => {
    const { app } = createHarness({
      config: { mcpSessionSecret: "test-secret" },
    });

    const initRes = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    const sessionId = initRes.headers.get("Mcp-Session-Id")!;
    const tampered =
      sessionId.slice(0, -1) + (sessionId.slice(-1) === "A" ? "B" : "A");

    const res = await jsonRpcRequest(
      app,
      "/mcp",
      "tools/list",
      undefined,
      1,
      { "mcp-session-id": tampered },
    );

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.message).toContain("Invalid session signature");
  });

  it("no secret configured but client sends Mcp-Session-Id returns 400", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(
      app,
      "/mcp",
      "tools/list",
      undefined,
      1,
      { "mcp-session-id": "anything" },
    );

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.message).toContain("not enabled");
  });

  it("initialize rejects mismatched protocol header and params", async () => {
    const { app } = createHarness();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await parseMcpResponse(res);
    expect(body.error!.message).toContain("Protocol version mismatch");
  });
});
