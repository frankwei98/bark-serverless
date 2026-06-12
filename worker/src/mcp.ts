import type { Context, Hono } from "hono";

import { pushOne } from "@/push";
import type { AppConfig, RuntimeDeps } from "@/types";

export interface McpRouteOptions {
  config: AppConfig;
  deps: RuntimeDeps;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

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
): Promise<JsonRpcResponse | null> {
  switch (body.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "Bark MCP Server",
            version: options.deps.buildInfo.version,
          },
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [buildNotifyTool(pathDeviceKey === null)],
        },
      };

    case "tools/call": {
      const params = body.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      if (params?.name !== "notify") {
        return {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32601,
            message: `Method not found: unknown tool ${params?.name ?? "undefined"}`,
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
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "device_key is required" }],
            isError: true,
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
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: `Failed to send notification: ${result.error.message} (code ${result.code})`,
              },
            ],
            isError: true,
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            { type: "text", text: "Notification sent successfully" },
          ],
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32601,
          message: `Method not found: ${body.method}`,
        },
      };
  }
}

export function registerMcpRoutes(app: Hono, options: McpRouteOptions): void {
  async function handleRequest(c: Context, pathDeviceKey: string | null) {
    let body: JsonRpcRequest;
    try {
      body = await c.req.json<JsonRpcRequest>();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        } satisfies JsonRpcErrorResponse,
        400,
      );
    }

    const response = await handleMcpRequest(body, pathDeviceKey, options);
    if (response === null) {
      return c.body(null, 204);
    }
    return c.json(response);
  }

  app.all("/mcp", (c) => handleRequest(c, null));
  app.all("/mcp/:device_key", (c) =>
    handleRequest(c, c.req.param("device_key") ?? null),
  );
}
