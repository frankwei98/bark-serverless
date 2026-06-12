import type { Hono } from "hono";

import { failed } from "@/responses";
import type { RuntimeDeps } from "@/types";

export interface McpRouteOptions {
  deps: RuntimeDeps;
}

export function registerMcpRoutes(app: Hono, options: McpRouteOptions): void {
  const notImplemented = () =>
    failed(
      options.deps.now(),
      501,
      "mcp route is not implemented yet. Finish worker/src/mcp.ts.",
    );

  app.all("/mcp", (c) => c.json(notImplemented(), 501));
  app.all("/mcp/:device_key", (c) => c.json(notImplemented(), 501));
}
