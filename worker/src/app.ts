import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { createBasicAuthMiddleware } from "@/auth";
import { normalizeUrlPrefix } from "@/config";
import { registerMcpRoutes } from "@/mcp";
import { registerPushRoutes } from "@/push";
import { getErrorMessage, failed } from "@/responses";
import { registerRegisterRoutes } from "@/register";
import type { AppConfig, RuntimeDeps } from "@/types";

export interface CreateAppOptions {
  config: AppConfig;
  deps: RuntimeDeps;
}

function createRouteGroup(options: CreateAppOptions): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    c.header("content-type", "text/plain; charset=UTF-8");
    return c.body("ok");
  });

  app.get("/ping", (c) =>
    c.json(
      {
        code: 200,
        message: "pong",
        timestamp: options.deps.now(),
      },
      200,
    ),
  );

  app.get("/healthz", (c) => {
    c.header("content-type", "text/plain; charset=UTF-8");
    return c.body("ok");
  });

  app.get("/info", async (c) => {
    const devices = await options.deps.registry.countAll();
    return c.json(
      {
        version: options.deps.buildInfo.version,
        build: options.deps.buildInfo.build,
        arch: options.deps.buildInfo.arch,
        commit: options.deps.buildInfo.commit,
        devices,
      },
      200,
    );
  });

  registerRegisterRoutes(app, { deps: options.deps });
  registerMcpRoutes(app, { config: options.config, deps: options.deps });
  registerPushRoutes(app, { config: options.config, deps: options.deps });

  return app;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const prefix = normalizeUrlPrefix(options.config.urlPrefix);

  app.use("*", async (c, next) => {
    await next();
    c.header("server", "Bark");
  });

  app.use("*", createBasicAuthMiddleware(options.config));

  if (prefix === "/") {
    const rootRoutes = createRouteGroup(options);
    app.route("/", rootRoutes);
  } else {
    app.route(prefix, createRouteGroup(options));
  }

  app.notFound((c) => c.text("404 Not Found", 404));
  app.onError((error, c) => {
    const status = error instanceof HTTPException ? error.status : 500;
    return c.json(failed(options.deps.now(), status, getErrorMessage(error)), status);
  });

  return app;
}
