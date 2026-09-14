import { constants, generateKeyPairSync, verify } from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildHuaweiRequest,
  HuaweiPushError,
  HuaweiPushSender,
} from "@/services/huawei-push-sender";
import type { PushMessage } from "@/types";
import { buildPushMessage } from "@/routes/push";

let testPrivateKey = "";
let testPublicKey = "";

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  testPrivateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  testPublicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function message(overrides: Partial<PushMessage> = {}): PushMessage {
  return {
    deviceKey: "device-key",
    deviceToken: "shark-token",
    title: "Title",
    subtitle: "Subtitle",
    body: "Body",
    sound: "minuet.caf",
    rawSound: "minuet",
    extParams: {},
    ...overrides,
  };
}

function sender(fetcher: NonNullable<ConstructorParameters<typeof HuaweiPushSender>[0]["fetcher"]>, now = 1_700_000_000_000) {
  return new HuaweiPushSender({
    projectId: "project-id",
    keyId: "key-id",
    subAccount: "sub-account",
    privateKey: testPrivateKey,
    fetcher,
    now: () => now,
  });
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("Huawei diagnostic logs", () => {
  let records: Record<string, unknown>[];
  beforeEach(() => {
    records = [];
    const capture = (line: unknown) => { records.push(JSON.parse(String(line))); };
    vi.spyOn(console, "info").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
  });

  it("correlates successful sends and records cache use without leaking data", async () => {
    const client = sender(async () => Response.json({ code: "80000000" }));
    await client.send(message());
    await client.send(message());
    const ids = new Set(records.map(row => row.attemptId));
    expect(ids.size).toBe(2);
    for (const id of ids) {
      expect(records.filter(row => row.attemptId === id).map(row => row.event)).toEqual([
        "huawei.push.start", "huawei.push.configuration", "huawei.push.payload_ready",
        "huawei.push.jwt_ready", "huawei.push.http_start", "huawei.push.http_response",
        "huawei.push.body_read", "huawei.push.business_response", "huawei.push.success",
      ]);
    }
    expect(records.filter(row => row.event === "huawei.push.jwt_ready").map(row => row.jwtCache)).toEqual(["miss", "hit"]);
    const output = JSON.stringify(records);
    for (const value of [testPrivateKey, "shark-token", "device-key", "project-id", "sub-account", "Title", "Body", "minuet"]) {
      expect(output).not.toContain(value);
    }
  });

  it("logs fetch failures before normalization without echoing arbitrary error text", async () => {
    let auth = "";
    const client = sender(async (_input, init) => {
      auth = new Headers(init?.headers).get("authorization")!;
      throw new TypeError(`fetch failed ${auth} shark-token secret-body`, {
        cause: new Error("getaddrinfo ENOTFOUND sensitive-host"),
      });
    });
    await expect(client.send(message())).rejects.toThrow("Huawei push network request failed");
    expect(records.at(-1)).toMatchObject({ event: "huawei.push.failure", stage: "fetch", errorType: "TypeError", errorCategory: "dns", timedOut: false });
    for (const value of [auth, "shark-token", "secret-body", "sensitive-host"]) {
      expect(JSON.stringify(records)).not.toContain(value);
    }
  });

  it("distinguishes body stream failures from failures to obtain HTTP headers", async () => {
    const client = sender(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("Network connection lost with secret-token")); },
    }), { status: 200 }));
    await expect(client.send(message())).rejects.toThrow("Huawei push network request failed");
    expect(records.at(-1)).toMatchObject({ stage: "response_body", httpStatus: 200, errorCategory: "connection_lost", timedOut: false });
    expect(JSON.stringify(records)).not.toContain("secret-token");
  });

  it("logs real timeout expiration separately from other network failures", async () => {
    const client = new HuaweiPushSender({
      projectId: "test", keyId: "test", subAccount: "test", privateKey: testPrivateKey,
      timeoutMs: 5, fetcher: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
    });
    await expect(client.send(message())).rejects.toThrow("Huawei push network request failed");
    expect(records.at(-1)).toMatchObject({ stage: "response_body", httpStatus: 200, timedOut: true, errorCategory: "timeout" });
  });

  it("logs safe business codes but never provider diagnostics", async () => {
    const client = sender(async () => Response.json({ code: "80200001", msg: "secret-account", requestId: "secret-token" }, { status: 401 }));
    await expect(client.send(message())).rejects.toThrow("80200001");
    expect(records.at(-1)).toMatchObject({ stage: "response_parse", httpStatus: 401, businessCode: "80200001", retryable: false });
    expect(JSON.stringify(records)).not.toContain("secret-account");
    expect(JSON.stringify(records)).not.toContain("secret-token");
  });

  it("identifies missing configuration and signing failures", async () => {
    await expect(new HuaweiPushSender({}).send(message())).rejects.toThrow("not configured");
    expect(records[1]).toMatchObject({ privateKeyConfigured: false, projectConfigured: false });
    expect(records.at(-1)).toMatchObject({ stage: "configuration" });
    const client = new HuaweiPushSender({ projectId: "test", keyId: "test", subAccount: "test", privateKey: "secret-invalid-pem" });
    await expect(client.send(message())).rejects.toThrow("authentication failed");
    expect(records.at(-1)).toMatchObject({ stage: "jwt", errorType: "Error" });
    expect(JSON.stringify(records)).not.toContain("secret-invalid-pem");
  });

  it("keeps simultaneous sends in independent log contexts", async () => {
    const client = sender(async () => Response.json({ code: "80000000" }));
    await Promise.all([client.send(message()), client.send(message())]);
    const starts = records.filter(row => row.event === "huawei.push.start");
    expect(new Set(starts.map(row => row.attemptId)).size).toBe(2);
    for (const start of starts) {
      expect(records.filter(row => row.attemptId === start.attemptId).at(-1)?.event).toBe("huawei.push.success");
    }
  });
});

describe("Huawei push payload", () => {
  it("maps the supported alert subset without leaking unrelated Bark fields", () => {
    const request = buildHuaweiRequest(message({
      extParams: {
        category: "WORK",
        badge: 0,
        ttl: "3600",
        url: "https://example.com",
        ciphertext: "not-supported",
      },
    }));

    expect(request).toEqual({
      pushType: 0,
      body: {
        payload: {
          notification: {
            category: "WORK",
            title: "Title",
            body: "Body",
            clickAction: { actionType: 0 },
            badge: { setNum: 0 },
            sound: "minuet.mp3",
          },
        },
        target: { token: ["shark-token"] },
        pushOptions: { ttl: 3600 },
      },
    });
  });

  it("omits default sound, invalid badge, and out-of-range ttl", () => {
    const request = buildHuaweiRequest(message({
      rawSound: undefined,
      extParams: { badge: 100, ttl: 1_296_001 },
    }));
    expect(JSON.stringify(request)).not.toContain("sound");
    expect(JSON.stringify(request)).not.toContain("badge");
    expect(request.body.pushOptions).toBeUndefined();
  });

  it("uses push-type 6 and JSON extraData for delete messages", () => {
    const request = buildHuaweiRequest(message({
      extParams: { delete: "1", group: "archive" },
    }));
    expect(request.pushType).toBe(6);
    expect(request.body.payload).toEqual({
      extraData: '{"delete":"1","group":"archive","sound":"minuet"}',
    });
  });

  it("maps route-normalized badge aliases, inbox, image and foreground flags", () => {
    const request = buildHuaweiRequest({
      ...buildPushMessage({
        device_key: "test", body: "hello", badge: { setNum: 0, addNum: 5 },
        inboxContent: "first|second", image: "https://example.com/image.png",
        foreground_show: "0",
      }),
      deviceToken: "test-token",
    });
    expect(request.body.payload).toEqual({ notification: {
      category: "WORK", title: "", body: "hello", clickAction: { actionType: 0 },
      badge: { setNum: 0 }, style: 3, inboxContent: ["first", "second"],
      image: "https://example.com/image.png", foregroundShow: false,
    } });
  });

  it("supports additive badges and fills required large-text fields", () => {
    const request = buildHuaweiRequest(message({ extParams: { badge_add: "3", style: "1" } }));
    expect(request.body.payload).toMatchObject({ notification: {
      badge: { addNum: 3 }, style: 1, bigTitle: "Title", bigBody: "Body",
    } });
  });
});

describe("HuaweiPushSender", () => {
  it("creates a verifiable PS256 JWT with the documented claims", async () => {
    let authorization = "";
    const client = sender(async (_input, init) => {
      authorization = (init?.headers as Record<string, string>).authorization;
      return Response.json({ code: "80000000", msg: "Success." });
    });

    await client.send(message());
    const token = authorization.slice("Bearer ".length);
    const [header, claims, signature] = token.split(".") as [string, string, string];
    expect(decodeJwtPart(header)).toEqual({ alg: "PS256", kid: "key-id", typ: "JWT" });
    expect(decodeJwtPart(claims)).toEqual({
      aud: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
      iss: "sub-account",
      exp: 1_700_003_600,
      iat: 1_700_000_000,
    });
    expect(verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      {
        key: testPublicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  it("uses the fixed v3 endpoint, headers, timeout, and no redirects", async () => {
    const fetcher = vi.fn(async () => Response.json({ code: 80000000 }));
    const client = new HuaweiPushSender({
      projectId: "project/id",
      keyId: "key-id",
      subAccount: "sub-account",
      privateKey: testPrivateKey,
      timeoutMs: 1234,
      fetcher,
    });
    await client.send(message());

    expect(fetcher).toHaveBeenCalledTimes(1);
    const calls = fetcher.mock.calls as unknown as Array<[
      RequestInfo | URL,
      RequestInit,
    ]>;
    const [url, init] = calls[0]!;
    expect(url).toBe("https://push-api.cloud.huawei.com/v3/project%2Fid/messages:send");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init.headers).get("push-type")).toBe("0");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reuses a JWT and coalesces concurrent first use", async () => {
    const sign = vi.spyOn(crypto.subtle, "sign");
    const fetcher = vi.fn(async () => Response.json({ code: "80000000" }));
    const client = sender(fetcher);
    await Promise.all([client.send(message()), client.send(message()), client.send(message())]);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])("rejects HTTP %i without following or exposing Location", async (status) => {
    const fetcher = vi.fn(async () => new Response(null, {
      status, headers: { location: "https://example.invalid/private-redirect-target" },
    }));
    await expect(sender(fetcher).send(message())).rejects.toMatchObject({
      message: "Huawei push redirect rejected", statusCode: status, retryable: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refreshes the JWT at the 30-second expiry boundary", async () => {
    let now = 1_700_000_000_000;
    const sign = vi.spyOn(crypto.subtle, "sign");
    const fetcher = vi.fn(async () => Response.json({ code: "80000000" }));
    const client = new HuaweiPushSender({
      projectId: "project-id",
      keyId: "key-id",
      subAccount: "sub-account",
      privateKey: testPrivateKey,
      fetcher,
      now: () => now,
    });
    await client.send(message());
    now += (60 * 60 - 31) * 1000;
    await client.send(message());
    now += 1000;
    await client.send(message());
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it.each(["80100000", "80300007", "80200001"])(
    "rejects HTTP 200 business failure %s without exposing provider detail",
    async (code) => {
      const client = sender(async () => Response.json({
        code,
        msg: "sensitive token diagnostic",
      }));
      await expect(client.send(message())).rejects.toMatchObject({
        businessCode: code,
        message: `Huawei push failed with business code ${code}`,
      });
    },
  );

  it("classifies retryable HTTP failures without echoing their body", async () => {
    const client = sender(async () => new Response("credential and token detail", { status: 503 }));
    await expect(client.send(message())).rejects.toEqual(
      new HuaweiPushError("Huawei push HTTP 503", 503, undefined, true),
    );
  });

  it("parses a safe business code from a non-2xx response", async () => {
    const client = sender(async () => Response.json(
      { code: "80200001", msg: "credential detail" },
      { status: 401 },
    ));
    await expect(client.send(message())).rejects.toMatchObject({
      statusCode: 401,
      businessCode: "80200001",
      message: "Huawei push failed with business code 80200001",
    });
  });

  it("does not echo malformed provider codes", async () => {
    const client = sender(async () => Response.json({ code: "secret-token-text" }));
    await expect(client.send(message())).rejects.toMatchObject({
      businessCode: undefined,
      message: "Huawei push returned an invalid response",
    });
  });

  it("rejects invalid and oversized provider responses", async () => {
    const invalid = sender(async () => new Response("not json", { status: 200 }));
    await expect(invalid.send(message())).rejects.toMatchObject({
      message: "Huawei push returned an invalid response",
    });

    const oversized = sender(async () => new Response("x".repeat(64 * 1024 + 1)));
    await expect(oversized.send(message())).rejects.toMatchObject({
      message: "Huawei push response is too large",
    });
  });

  it("rejects messages above Huawei's 4096-byte limit before fetch", async () => {
    const fetcher = vi.fn(async () => Response.json({ code: "80000000" }));
    const client = sender(fetcher);
    await expect(client.send(message({ body: "鸿".repeat(1400) }))).rejects.toMatchObject({
      message: "Huawei push message exceeds 4096 bytes",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("excludes the Push Token from the message-size limit", async () => {
    const client = sender(async () => Response.json({ code: "80000000" }));
    await expect(client.send(message({ deviceToken: "x".repeat(4096) }))).resolves.toBeUndefined();
  });

  it("keeps private-key parse failures safe and non-retryable", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new HuaweiPushSender({
      projectId: "test", keyId: "test", subAccount: "test", privateKey: "invalid-test-key", fetcher,
    });
    await expect(client.send(message())).rejects.toMatchObject({
      message: "Huawei push authentication failed", retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps network and timeout failures to a safe retryable error", async () => {
    const client = sender(async () => {
      throw new DOMException("request timed out", "AbortError");
    });
    await expect(client.send(message())).rejects.toMatchObject({
      message: "Huawei push network request failed",
      retryable: true,
    });
  });

  it("applies the timeout while reading a stalled response body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel,
    });
    const client = new HuaweiPushSender({
      projectId: "project-id",
      keyId: "key-id",
      subAccount: "sub-account",
      privateKey: testPrivateKey,
      timeoutMs: 5,
      fetcher: async () => new Response(stream),
    });
    await expect(client.send(message())).rejects.toMatchObject({
      message: "Huawei push network request failed",
      retryable: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("fails lazily when Huawei credentials are not configured", async () => {
    const client = new HuaweiPushSender({});
    await expect(client.send(message())).rejects.toMatchObject({
      message: "Huawei push is not configured",
    });
  });
});
