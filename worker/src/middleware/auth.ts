import type { MiddlewareHandler } from "hono";

import { normalizeUrlPrefix } from "@/config";
import { timingSafeStringEqual } from "@/utils/timing-safe";
import type { AppConfig } from "@/types";

interface AuthFreeRoute {
  method: string;
  path: string;
}

const AUTH_FREE_ROUTES: AuthFreeRoute[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/ping" },
  { method: "GET", path: "/healthz" },
  { method: "GET", path: "/register" },
  { method: "POST", path: "/register" },
];

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

function isRegisterCheckPath(method: string, relativePath: string): boolean {
  if (method !== "GET") {
    return false;
  }

  const prefix = "/register/";
  if (!relativePath.startsWith(prefix)) {
    return false;
  }

  const rest = relativePath.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

function isAuthFreeRoute(method: string, relativePath: string): boolean {
  if (AUTH_FREE_ROUTES.some((route) => route.method === method && route.path === relativePath)) {
    return true;
  }

  return isRegisterCheckPath(method, relativePath);
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

    if (isAuthFreeRoute(c.req.method, relativePath)) {
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
