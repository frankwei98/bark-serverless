import { createApp } from "@/app";
import { createBuildInfoFromEnv, createConfigFromEnv } from "@/config";
import { CloudflareApnsClient } from "@/services/cloudflare-apns-client";
import { HuaweiPushSender } from "@/services/huawei-push-sender";
import { ProviderPushSender } from "@/services/provider-push-sender";
import { KVDeviceRegistry } from "@/services/kv-device-registry";
import type { BarkBindings } from "@/types";

export { DeviceRegistryCoordinator } from "@/services/device-registry-coordinator";

const appCache = new WeakMap<BarkBindings, ReturnType<typeof createApp>>();

function buildApp(env: BarkBindings) {
  const cached = appCache.get(env);
  if (cached) {
    return cached;
  }

  const config = createConfigFromEnv(env);
  const app = createApp({
    config,
    deps: {
      registry: new KVDeviceRegistry(
        env.DEVICE_REGISTRY,
        (key) => env.DEVICE_REGISTRY_COORDINATOR.getByName(key),
      ),
      pushSender: new ProviderPushSender(new CloudflareApnsClient({
        privateKey: env.APNS_PRIVATE_KEY,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        topic: env.APNS_TOPIC,
        timeoutMs: config.apnsRequestTimeoutMs,
      }), new HuaweiPushSender({
        projectId: env.HUAWEI_PROJECT_ID,
        keyId: env.HUAWEI_KEY_ID,
        subAccount: env.HUAWEI_SUB_ACCOUNT,
        privateKey: env.HUAWEI_PRIVATE_KEY,
        timeoutMs: config.huaweiRequestTimeoutMs,
      })),
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
