import { createApp } from "@/app";
import { createBuildInfoFromEnv, createConfigFromEnv } from "@/config";
import { CloudflareApnsClient } from "@/services/cloudflare-apns-client";
import { KVDeviceRegistry } from "@/services/kv-device-registry";
import type { BarkBindings } from "@/types";

const appCache = new WeakMap<BarkBindings, ReturnType<typeof createApp>>();

function buildApp(env: BarkBindings) {
  const cached = appCache.get(env);
  if (cached) {
    return cached;
  }

  const app = createApp({
    config: createConfigFromEnv(env),
    deps: {
      registry: new KVDeviceRegistry(env.DEVICE_REGISTRY),
      pushSender: new CloudflareApnsClient({
        privateKey: env.APNS_PRIVATE_KEY,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        topic: env.APNS_TOPIC,
      }),
      now: () => Math.floor(Date.now() / 1000),
      buildInfo: createBuildInfoFromEnv(env),
    },
  });

  appCache.set(env, app);
  return app;
}

export default {
  fetch(request: Request, env: BarkBindings, executionContext: ExecutionContext) {
    return buildApp(env).fetch(request, env, executionContext);
  },
};
