import type { ApnsSendError, PushMessage, PushSender } from "@/types";

export interface CloudflareApnsConfig {
  privateKey?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
}

const JWT_REUSE_SECONDS = 30 * 60;
const RESERVED_PAYLOAD_KEYS = new Set(["aps"]);

function trimLeadingZeroes(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }
  return bytes.slice(start);
}

function leftPad(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length > length) {
    throw new Error(`ECDSA coordinate too large: expected <= ${length} bytes`);
  }

  const padded = new Uint8Array(length);
  padded.set(bytes, length - bytes.length);
  return padded;
}

function derLength(bytes: Uint8Array, offset: number): { length: number; next: number } {
  const first = bytes[offset];
  if ((first & 0x80) === 0) {
    return { length: first, next: offset + 1 };
  }

  const octets = first & 0x7f;
  if (octets === 0 || octets > 4) {
    throw new Error("Invalid DER length encoding");
  }

  let length = 0;
  for (let i = 0; i < octets; i++) {
    length = (length << 8) | bytes[offset + 1 + i];
  }

  return { length, next: offset + 1 + octets };
}

function derSignatureToJose(signature: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(signature);
  let offset = 0;

  if (bytes[offset++] !== 0x30) {
    throw new Error("Invalid DER signature: expected SEQUENCE");
  }

  const seq = derLength(bytes, offset);
  offset = seq.next;
  const seqEnd = offset + seq.length;

  if (bytes[offset++] !== 0x02) {
    throw new Error("Invalid DER signature: expected INTEGER for r");
  }
  const rLen = derLength(bytes, offset);
  offset = rLen.next;
  const r = bytes.slice(offset, offset + rLen.length);
  offset += rLen.length;

  if (bytes[offset++] !== 0x02) {
    throw new Error("Invalid DER signature: expected INTEGER for s");
  }
  const sLen = derLength(bytes, offset);
  offset = sLen.next;
  const s = bytes.slice(offset, offset + sLen.length);
  offset += sLen.length;

  if (offset !== seqEnd) {
    throw new Error("Invalid DER signature: trailing bytes");
  }

  const jose = new Uint8Array(64);
  jose.set(leftPad(trimLeadingZeroes(r), 32), 0);
  jose.set(leftPad(trimLeadingZeroes(s), 32), 32);
  return jose;
}

function normalizeEcdsaSignature(signature: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(signature);
  if (bytes.length === 64) {
    return bytes;
  }

  if (bytes[0] === 0x30) {
    return derSignatureToJose(signature);
  }

  throw new Error(`Unsupported ECDSA signature format: ${bytes.length} bytes`);
}

function base64url(data: ArrayBuffer | Uint8Array | string): string {
  let binary: string;
  if (typeof data === "string") {
    binary = data;
  } else {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const chunks: string[] = [];
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
    }
    binary = chunks.join("");
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalizePemText(pem: string): string {
  return pem.replace(/\\r/g, "\r").replace(/\\n/g, "\n").trim();
}

function stringifyCustomField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function parsePemPrivateKey(pem: string): ArrayBuffer {
  const normalizedPem = normalizePemText(pem);
  const match = normalizedPem.match(
    /-----BEGIN [^-]+-----\s*([\s\S]*?)\s*-----END [^-]+-----/,
  );
  const encoded = match?.[1]?.replace(/\s+/g, "") ?? "";
  if (encoded.length === 0) {
    throw new Error("APNS_PRIVATE_KEY must be a PKCS#8 PEM block");
  }

  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("APNS_PRIVATE_KEY must contain valid base64 PEM data");
  }

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
    if (
      this.cachedJwt &&
      iat >= this.cachedJwt.iat &&
      iat - this.cachedJwt.iat < JWT_REUSE_SECONDS
    ) {
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

    const jwt = `${signingInput}.${base64url(normalizeEcdsaSignature(signature))}`;
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
    const deleteFlag = message.extParams.delete;
    const isDelete = deleteFlag === "1" || deleteFlag === 1;

    const aps: Record<string, unknown> = { "mutable-content": 1 };
    const payload: Record<string, unknown> = { aps };

    if (isDelete) {
      aps["content-available"] = 1;
    } else {
      const alert: Record<string, string> = {};
      if (message.title.length > 0) alert.title = message.title;
      if (message.subtitle.length > 0) alert.subtitle = message.subtitle;
      if (message.body.length > 0) alert.body = message.body;
      if (Object.keys(alert).length > 0) {
        aps.alert = alert;
      }
      aps.sound = message.sound;
      aps.category = "myNotificationCategory";
      if (message.extParams.group) {
        aps["thread-id"] = String(message.extParams.group);
      }
    }

    for (const [key, value] of Object.entries(message.extParams)) {
      const normalizedKey = key.toLowerCase();
      if (RESERVED_PAYLOAD_KEYS.has(normalizedKey)) {
        continue;
      }

      payload[normalizedKey] = stringifyCustomField(value);
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

    const url = `https://api.push.apple.com/3/device/${encodeURIComponent(message.deviceToken)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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
