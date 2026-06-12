import { describe, expect, it } from "vitest";

import { createApnsError, createHarness } from "./helpers/fakes";

interface McpResponse {
  jsonrpc: string;
  id: number | string;
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
  id: number = 1,
) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function parseMcpResponse(res: Response): Promise<McpResponse> {
  return (await res.json()) as McpResponse;
}

describe("mcp compatibility", () => {
  it("initialize returns server info and capabilities", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result!.protocolVersion).toBe("2024-11-05");
    expect(body.result!.capabilities).toBeDefined();
    expect(body.result!.serverInfo!.name).toBe("Bark MCP Server");
    expect(body.result!.serverInfo!.version).toBe("test-version");
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

  it("notifications/initialized returns 204 with no body", async () => {
    const { app } = createHarness();

    const res = await jsonRpcRequest(app, "/mcp", "notifications/initialized");

    expect(res.status).toBe(204);
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
});
