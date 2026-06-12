import type { ApnsSendError, PushMessage, PushSender } from "@/types";

export interface CloudflareApnsConfig {
  privateKey?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
}

export class CloudflareApnsClient implements PushSender {
  constructor(private readonly config: CloudflareApnsConfig) {}

  async send(message: PushMessage): Promise<void> {
    void message;
    void this.config;

    const error = new Error(
      "APNs production sender is not implemented yet. Finish worker/src/cloudflare-apns-client.ts.",
    ) as ApnsSendError;
    error.statusCode = 501;
    error.reason = "NotImplemented";
    throw error;
  }
}
