import type { AppConfig, BarkBindings, BuildInfo } from "@/types";
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from "@/utils/validation";

export const DEFAULT_MAX_BATCH_PUSH_COUNT = 1000;

export function normalizeUrlPrefix(prefix?: string): string {
  if (!prefix || prefix === "/") {
    return "/";
  }

  const normalized = `/${prefix.replace(/^\/+|\/+$/g, "")}`;
  return normalized.length === 0 ? "/" : normalized;
}

export function parseMaxBatchPushCount(raw?: string): number {
  if (!raw) {
    return DEFAULT_MAX_BATCH_PUSH_COUNT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (parsed === -1) {
    return -1;
  }

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_BATCH_PUSH_COUNT;
}

export function parseMaxRequestBodyBytes(raw?: string): number {
  if (!raw) {
    return DEFAULT_MAX_REQUEST_BODY_BYTES;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

export function parseCloseRegister(raw?: string | boolean): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }

  return raw?.trim().toLowerCase() === "true";
}

export function createConfigFromEnv(env: BarkBindings): AppConfig {
  return {
    urlPrefix: normalizeUrlPrefix(env.URL_PREFIX),
    basicAuthUser: env.BASIC_AUTH_USER,
    basicAuthPassword: env.BASIC_AUTH_PASSWORD,
    maxBatchPushCount: parseMaxBatchPushCount(env.MAX_BATCH_PUSH_COUNT),
    maxRequestBodyBytes: parseMaxRequestBodyBytes(env.MAX_REQUEST_BODY_BYTES),
    mcpSessionSecret: env.MCP_SESSION_SECRET,
    closeRegister: parseCloseRegister(env.CLOSE_REGISTER),
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
