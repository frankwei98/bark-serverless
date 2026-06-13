import type { MiddlewareHandler } from "hono";

import { normalizeUrlPrefix } from "@/config";
import { timingSafeStringEqual } from "@/timing-safe";
import type { AppConfig } from "@/types";

const AUTH_FREE_ROUTES = ["/ping", "/register", "/healthz"];

function decodeBasicAuth(header: string | undefined): string | null {
  if (!header || !header.startsWith("Basic ")) {
    return null;
  }

  try {
    return atob(header.slice("Basic ".length));
  } catch {
    return null;
  }
}

function stripPrefix(pathname: string, prefix: string): string {
  const normalizedPrefix = normalizeUrlPrefix(prefix);
  if (normalizedPrefix === "/") {
    return pathname || "/";
  }

  if (!pathname.startsWith(normalizedPrefix)) {
    return pathname || "/";
  }

  const relative = pathname.slice(normalizedPrefix.length);
  return relative.length === 0 ? "/" : relative;
}

function isAuthFreePath(relativePath: string): boolean {
  if (relativePath === "/") {
    return true;
  }

  return AUTH_FREE_ROUTES.some((item) => {
    return relativePath === item || relativePath.startsWith(`${item}/`);
  });
}

export function createBasicAuthMiddleware(config: AppConfig): MiddlewareHandler {
  const hasAuth = Boolean(config.basicAuthUser || config.basicAuthPassword);

  return async (c, next) => {
    if (!hasAuth) {
      await next();
      return;
    }

    const pathname = new URL(c.req.url).pathname;
    const relativePath = stripPrefix(pathname, config.urlPrefix);

    if (isAuthFreePath(relativePath)) {
      await next();
      return;
    }

    const decoded = decodeBasicAuth(c.req.header("authorization"));
    const expected = `${config.basicAuthUser ?? ""}:${config.basicAuthPassword ?? ""}`;

    if (!timingSafeStringEqual(decoded, expected)) {
      c.status(418);
      c.header("content-type", "text/plain; charset=UTF-8");
      return c.body("I'm a teapot");
    }

    await next();
  };
}
