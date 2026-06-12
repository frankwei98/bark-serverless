import type { AppConfig, BarkBindings, BuildInfo } from "@/types";

export function normalizeUrlPrefix(prefix?: string): string {
  if (!prefix || prefix === "/") {
    return "/";
  }

  const normalized = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
  return normalized.length === 0 ? "/" : normalized;
}

export function parseMaxBatchPushCount(raw?: string): number {
  if (!raw) {
    return -1;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

export function createConfigFromEnv(env: BarkBindings): AppConfig {
  return {
    urlPrefix: normalizeUrlPrefix(env.URL_PREFIX),
    basicAuthUser: env.BASIC_AUTH_USER,
    basicAuthPassword: env.BASIC_AUTH_PASSWORD,
    maxBatchPushCount: parseMaxBatchPushCount(env.MAX_BATCH_PUSH_COUNT),
  };
}

export function createBuildInfoFromEnv(env: BarkBindings): BuildInfo {
  return {
    version: env.APP_VERSION ?? "dev",
    build: env.APP_BUILD ?? "dev",
    commit: env.APP_COMMIT ?? "dev",
    arch: "cloudflare/workerd",
  };
}
