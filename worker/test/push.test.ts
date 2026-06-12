import { describe, expect, it } from "vitest";

import { createApnsError, createHarness } from "./helpers/fakes";

describe("push routes", () => {
  it("handles a V1 path-based push", async () => {
    const { app, sender } = createHarness({
      registrySeed: {
        alpha: "token-alpha",
      },
    });

    const response = await app.request("http://example.com/alpha/title/subtitle/body");

    expect(response.status).toBe(200);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toMatchObject({
      deviceKey: "alpha",
      deviceToken: "token-alpha",
      title: "title",
      subtitle: "subtitle",
      body: "body",
      sound: "1107",
    });
  });

  it("uses path params as the highest-priority values", async () => {
    const { app, sender } = createHarness({
      registrySeed: {
        alpha: "token-alpha",
      },
    });

    const response = await app.request(
      "http://example.com/alpha/path-title/path-subtitle/path-body?title=query-title&body=query-body",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "title=form-title&subtitle=form-subtitle&body=form-body",
      },
    );

    expect(response.status).toBe(200);
    expect(sender.messages[0]).toMatchObject({
      title: "path-title",
      subtitle: "path-subtitle",
      body: "path-body",
    });
  });

  it("handles a V2 JSON push and normalizes sound values", async () => {
    const { app, sender } = createHarness({
      registrySeed: {
        alpha: "token-alpha",
      },
    });

    const response = await app.request("http://example.com/push?group=query-group", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        device_key: "alpha",
        body: "hello",
        sound: "minuet",
        badge: 1,
      }),
    });

    expect(response.status).toBe(200);
    expect(sender.messages[0]).toMatchObject({
      deviceKey: "alpha",
      body: "hello",
      sound: "minuet.caf",
      extParams: {
        badge: 1,
        group: "query-group",
      },
    });
  });

  it("forces a non-empty body for encrypted notifications", async () => {
    const { app, sender } = createHarness({
      registrySeed: {
        alpha: "token-alpha",
      },
    });

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_key: "alpha",
        ciphertext: "cipher-text",
      }),
    });

    expect(response.status).toBe(200);
    expect(sender.messages[0]).toMatchObject({
      body: "Empty Message",
      extParams: {
        ciphertext: "cipher-text",
      },
    });
  });

  it("returns 400 when the device key is missing", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "hello",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: "device key is empty",
    });
  });

  it("returns 400 when device_keys has the wrong type", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_keys: { invalid: true },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: "invalid type for device_keys",
    });
  });

  it("returns 400 when the JSON body is malformed", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
    });
  });

  it("supports batch push using a JSON array", async () => {
    const { app, sender } = createHarness({
      registrySeed: {
        alpha: "token-alpha",
        beta: "token-beta",
        gamma: "token-gamma",
      },
    });

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "hello",
        body: "world",
        device_keys: ["alpha", "beta", "gamma"],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: 200,
      message: "success",
      data: [
        { code: 200, device_key: "alpha" },
        { code: 200, device_key: "beta" },
        { code: 200, device_key: "gamma" },
      ],
    });
    expect(sender.messages).toHaveLength(3);
  });

  it("supports batch push using a comma-delimited string", async () => {
    const { app, sender } = createHarness({
      registrySeed: {
        alpha: "token-alpha",
        beta: "token-beta",
      },
    });

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "hello",
        device_keys: "alpha,beta",
      }),
    });

    expect(response.status).toBe(200);
    expect(sender.messages).toHaveLength(2);
  });

  it("enforces the max batch push limit", async () => {
    const { app } = createHarness({
      config: {
        maxBatchPushCount: 1,
      },
      registrySeed: {
        alpha: "token-alpha",
        beta: "token-beta",
      },
    });

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "hello",
        device_keys: ["alpha", "beta"],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: "batch push count exceeds the maximum limit: 1",
    });
  });

  it("cleans up invalid tokens after APNs failure", async () => {
    const { app, registry, sender } = createHarness({
      registrySeed: {
        alpha: "bad-token",
      },
    });
    sender.failForDeviceToken("bad-token", createApnsError("BadDeviceToken", 400));

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_key: "alpha",
        body: "hello",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 500,
      message: "push failed: BadDeviceToken",
    });
    expect(registry.snapshot()).toEqual({});
  });
});
