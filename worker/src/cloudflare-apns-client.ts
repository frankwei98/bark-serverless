import type { ApnsSendError, PushMessage, PushSender } from "@/types";

export interface CloudflareApnsConfig {
  privateKey?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
}

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  let binary: string;
  if (typeof data === "string") {
    binary = data;
  } else {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    binary = String.fromCharCode(...bytes);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parsePemPrivateKey(pem: string): ArrayBuffer {
  const lines = pem.split("\n");
  const base64Lines: string[] = [];
  let inKey = false;
  for (const line of lines) {
    if (line.startsWith("-----BEGIN")) {
      inKey = true;
      continue;
    }
    if (line.startsWith("-----END")) {
      break;
    }
    if (inKey) {
      base64Lines.push(line.trim());
    }
  }
  const binary = atob(base64Lines.join(""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export class CloudflareApnsClient implements PushSender {
  private cryptoKey: CryptoKey | null = null;
  private cachedJwt: { token: string; iat: number } | null = null;

  constructor(private readonly config: CloudflareApnsConfig) {}

  private async getCryptoKey(): Promise<CryptoKey> {
    if (this.cryptoKey) {
      return this.cryptoKey;
    }
    const keyData = parsePemPrivateKey(this.config.privateKey!);
    this.cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return this.cryptoKey;
  }

  private async getJwt(): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    if (this.cachedJwt && this.cachedJwt.iat === iat) {
      return this.cachedJwt.token;
    }

    const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.config.keyId }));
    const payload = base64url(JSON.stringify({ iss: this.config.teamId, iat }));
    const signingInput = `${header}.${payload}`;

    const cryptoKey = await this.getCryptoKey();
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      new TextEncoder().encode(signingInput),
    );

    const jwt = `${signingInput}.${base64url(signature)}`;
    this.cachedJwt = { token: jwt, iat };
    return jwt;
  }

  async send(message: PushMessage): Promise<void> {
    if (!this.config.privateKey || !this.config.keyId || !this.config.teamId || !this.config.topic) {
      const error = new Error(
        "APNs client requires privateKey, keyId, teamId, and topic",
      ) as ApnsSendError;
      error.statusCode = 500;
      error.reason = "ConfigurationError";
      throw error;
    }

    const jwt = await this.getJwt();
    const isDelete = message.extParams.delete === "1";

    const aps: Record<string, unknown> = { "mutable-content": 1 };

    if (isDelete) {
      aps["content-available"] = 1;
    } else {
      const alert: Record<string, string> = {};
      if (message.title.length > 0) alert.title = message.title;
      if (message.subtitle.length > 0) alert.subtitle = message.subtitle;
      if (message.body.length > 0) alert.body = message.body;
      aps.alert = alert;
      aps.sound = message.sound;
      aps.category = "myNotificationCategory";
      if (message.extParams.group) {
        aps["thread-id"] = String(message.extParams.group);
      }
    }

    for (const [key, value] of Object.entries(message.extParams)) {
      aps[key.toLowerCase()] = String(value);
    }

    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "apns-topic": this.config.topic,
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400),
      "apns-push-type": isDelete ? "background" : "alert",
      "content-type": "application/json",
    };

    if (message.id) {
      headers["apns-collapse-id"] = message.id;
    }

    const url = `https://api.push.apple.com/3/device/${message.deviceToken}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(aps),
      });
    } catch (err) {
      const error = new Error(`APNs network error: ${err instanceof Error ? err.message : String(err)}`) as ApnsSendError;
      error.statusCode = 500;
      error.reason = "NetworkError";
      throw error;
    }

    if (!response.ok) {
      let reason = `APNs error ${response.status}`;
      try {
        const body = (await response.json()) as { reason?: string };
        if (body.reason) {
          reason = body.reason;
        }
      } catch {
        // response body not JSON, use default message
      }
      const error = new Error(reason) as ApnsSendError;
      error.statusCode = response.status;
      error.reason = reason;
      throw error;
    }
  }
}
