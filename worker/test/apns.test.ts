import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudflareApnsClient } from "@/cloudflare-apns-client";
import type { PushMessage } from "@/types";

const TEST_PKCS8_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
AA==
-----END PRIVATE KEY-----`;

function derInteger(bytes: number[]): number[] {
  const normalized = [...bytes];
  if ((normalized[0] ?? 0) & 0x80) {
    normalized.unshift(0);
  }
  return [0x02, normalized.length, ...normalized];
}

function makeDerSignature(): ArrayBuffer {
  const r = derInteger([1, 2, 3]);
  const s = derInteger([4, 5, 6]);
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]).buffer;
}

function installCryptoStub() {
  const importKey = vi.fn(async () => ({ type: "private" } as CryptoKey));
  const sign = vi.fn(async () => makeDerSignature());

  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    subtle: {
      importKey,
      sign,
    },
  });

  return { importKey, sign };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMessage(overrides: Partial<PushMessage> = {}): PushMessage {
  return {
    deviceKey: "device-key",
    deviceToken: "device-token",
    title: "Title",
    subtitle: "Subtitle",
    body: "Body",
    sound: "minuet.caf",
    extParams: {
      url: "https://example.com",
      group: "thread-a",
      badge: 1,
    },
    ...overrides,
  };
}

describe("CloudflareApnsClient", () => {
  it("sends Bark custom fields at the top level instead of inside aps", async () => {
    installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(createMessage());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const init = calls[0]![1];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(payload).toHaveProperty("aps");
    expect(payload).toHaveProperty("url", "https://example.com");
    expect(payload).toHaveProperty("badge", "1");
    expect((payload.aps as Record<string, unknown>).url).toBeUndefined();
    expect((payload.aps as Record<string, unknown>).badge).toBeUndefined();
  });

  it("emits a JOSE raw ECDSA signature in the JWT", async () => {
    const { sign } = installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(createMessage());

    expect(sign).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const init = calls[0]![1];
    const authHeader = (init.headers as Record<string, string>).authorization;
    const token = authHeader.slice("bearer ".length);
    const signature = token.split(".")[2];
    const binary = atob(signature.replace(/-/g, "+").replace(/_/g, "/"));

    expect(binary.length).toBe(64);
  });
});
