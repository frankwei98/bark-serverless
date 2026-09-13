import type { PushMessage, PushSender } from "@/types";
import { routeDeviceToken, HARMONY_TOKEN_PREFIX } from "@/services/device-token";
import { HuaweiPushError } from "@/services/huawei-push-sender";

/** Selects a transport without changing the stored registration or APNs message. */
export class ProviderPushSender implements PushSender {
  constructor(
    private readonly apns: PushSender,
    private readonly huawei: PushSender,
  ) {}

  async send(message: PushMessage): Promise<void> {
    const target = routeDeviceToken(message.deviceToken);
    if (target.provider === "apns") {
      return this.apns.send(message);
    }
    if (!target.providerToken || target.providerToken.startsWith(HARMONY_TOKEN_PREFIX)) {
      throw new HuaweiPushError("Huawei device token is invalid");
    }
    try {
      await this.huawei.send({ ...message, deviceToken: target.providerToken });
    } catch (error) {
      if (error instanceof HuaweiPushError) throw error;
      // Never expose unexpected provider diagnostics or feed them to APNs cleanup.
      throw new HuaweiPushError("Huawei push failed");
    }
  }
}
