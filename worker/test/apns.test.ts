import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudflareApnsClient } from "@/services/cloudflare-apns-client";
import type { PushMessage } from "@/types";

const TEST_PKCS8_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
AA==
-----END PRIVATE KEY-----`;
const TEST_PKCS8_PRIVATE_KEY_SINGLE_LINE = "-----BEGIN PRIVATE KEY-----AA==-----END PRIVATE KEY-----";
const TEST_PKCS8_PRIVATE_KEY_ESCAPED = "-----BEGIN PRIVATE KEY-----\\nAA==\\n-----END PRIVATE KEY-----";

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

function makeRawSignature(): ArrayBuffer {
  return Uint8Array.from({ length: 64 }, (_, index) => index + 1).buffer;
}

function installCryptoStub(signature: ArrayBuffer = makeRawSignature()) {
  const importKey = vi.fn(async () => ({ type: "private" } as CryptoKey));
  const sign = vi.fn(async () => signature);

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
  vi.restoreAllMocks();
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

  it("keeps the generated aps dictionary when custom fields include aps", async () => {
    installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(
      createMessage({
        extParams: {
          aps: "CLOBBERED",
          customField: "x",
        },
      }),
    );

    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const init = calls[0]![1];
    const payload = JSON.parse(String(init.body)) as {
      aps: Record<string, unknown>;
      customfield: string;
    };

    expect(payload.aps).toMatchObject({
      alert: {
        title: "Title",
        subtitle: "Subtitle",
        body: "Body",
      },
      sound: "minuet.caf",
    });
    expect(payload.customfield).toBe("x");
  });

  it("serializes object custom fields as JSON strings", async () => {
    installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(
      createMessage({
        extParams: {
          metadata: { nested: true },
        },
      }),
    );

    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const init = calls[0]![1];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(payload.metadata).toBe('{"nested":true}');
  });

  it("falls back to String(value) when JSON.stringify returns undefined", async () => {
    installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(
      createMessage({
        extParams: {
          customSymbol: Symbol("custom"),
        },
      }),
    );

    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const init = calls[0]![1];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(payload.customsymbol).toBe("Symbol(custom)");
  });

  it("encodes device tokens before appending them to the APNs path", async () => {
    installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(
      createMessage({
        deviceToken: "abc/../../../../foo?x=y#z",
      }),
    );

    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const url = String(calls[0]![0]);

    expect(url).toBe(
      "https://api.push.apple.com/3/device/abc%2F..%2F..%2F..%2F..%2Ffoo%3Fx%3Dy%23z",
    );
  });

  it("emits a JOSE raw ECDSA signature in the JWT", async () => {
    const { sign } = installCryptoStub(makeRawSignature());

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

  it("reuses APNs provider JWTs within the refresh window", async () => {
    const { sign } = installCryptoStub(makeRawSignature());
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_700_000_000_000);

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(createMessage());
    now.mockReturnValue(1_700_000_000_000 + 29 * 60 * 1000);
    await client.send(createMessage());
    now.mockReturnValue(1_700_000_000_000 + 30 * 60 * 1000);
    await client.send(createMessage());

    expect(sign).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const firstAuth = (calls[0]![1].headers as Record<string, string>).authorization;
    const secondAuth = (calls[1]![1].headers as Record<string, string>).authorization;
    const thirdAuth = (calls[2]![1].headers as Record<string, string>).authorization;

    expect(secondAuth).toBe(firstAuth);
    expect(thirdAuth).not.toBe(firstAuth);
  });

  it("also accepts DER ECDSA signatures from runtimes that return ASN.1", async () => {
    installCryptoStub(makeDerSignature());

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(createMessage());

    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const init = calls[0]![1];
    const authHeader = (init.headers as Record<string, string>).authorization;
    const token = authHeader.slice("bearer ".length);
    const signature = token.split(".")[2];
    const binary = atob(signature.replace(/-/g, "+").replace(/_/g, "/"));

    expect(binary.length).toBe(64);
  });

  it("accepts single-line PEM values from flattened deploy variables", async () => {
    const { importKey } = installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY_SINGLE_LINE,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

    await client.send(createMessage());

    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("accepts PEM values with escaped newlines", async () => {
    const { importKey } = installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY_ESCAPED,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

    await client.send(createMessage());

    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("treats numeric delete=1 as a background push", async () => {
    installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client.send(
      createMessage({
        extParams: {
          delete: 1,
        },
      }),
    );

    const calls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>;
    const init = calls[0]![1];
    const headers = init.headers as Record<string, string>;
    const payload = JSON.parse(String(init.body)) as {
      aps: Record<string, unknown>;
      delete: string;
    };

    expect(headers["apns-push-type"]).toBe("background");
    expect(payload.aps["content-available"]).toBe(1);
    expect(payload.aps.alert).toBeUndefined();
    expect(payload.delete).toBe("1");
  });

  it("maps APNs network failures to statusCode 500 errors", async () => {
    installCryptoStub();

    const client = new CloudflareApnsClient({
      privateKey: TEST_PKCS8_PRIVATE_KEY,
      keyId: "KEYID123",
      teamId: "TEAMID123",
      topic: "me.fin.bark",
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("socket hang up");
    }));

    await expect(client.send(createMessage())).rejects.toMatchObject({
      message: "APNs network error: socket hang up",
      statusCode: 500,
      reason: "NetworkError",
    });
  });
});
