import { describe, expect, it, vi } from "vitest";

import { createHarness } from "./helpers/fakes";

describe("register routes", () => {
  it("registers a device through the GET compatibility endpoint", async () => {
    const { app, registry } = createHarness();
    registry.setGeneratedKeys(["generated-a"]);

    const response = await app.request(
      "http://example.com/register?devicetoken=device-token-1",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: 200,
      message: "success",
      timestamp: 1_717_900_000,
      data: {
        key: "generated-a",
        device_key: "generated-a",
        device_token: "device-token-1",
      },
    });
  });

  it("registers a device through the POST endpoint", async () => {
    const { app, registry } = createHarness();
    registry.setGeneratedKeys(["generated-b"]);

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_token: "device-token-2",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: 200,
      message: "success",
      timestamp: 1_717_900_000,
      data: {
        key: "generated-b",
        device_key: "generated-b",
        device_token: "device-token-2",
      },
    });
  });

  it("supports legacy key aliases", async () => {
    const { app } = createHarness();

    const response = await app.request(
      "http://example.com/register?key=legacy-key&devicetoken=legacy-token",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: 200,
      message: "success",
      timestamp: 1_717_900_000,
      data: {
        key: "legacy-key",
        device_key: "legacy-key",
        device_token: "legacy-token",
      },
    });
  });

  it("checks whether a key exists", async () => {
    const { app } = createHarness({
      registrySeed: {
        alpha: "token-alpha",
      },
    });

    const response = await app.request("http://example.com/register/alpha");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: 200,
      message: "success",
      timestamp: 1_717_900_000,
    });
  });

  it("returns 400 when the device token is missing", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/register");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: "device token is empty",
    });
  });

  it("returns 400 when the device token is too long", async () => {
    const { app } = createHarness();
    const deviceToken = "a".repeat(161);

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_token: deviceToken,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: "device token is invalid",
    });
  });

  it("accepts non-hex device tokens for Go compatibility", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_token: "not-a-token",
      }),
    });

    expect(response.status).toBe(200);
  });

  it("accepts custom device keys for Go compatibility", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_key: "bad/key",
        device_token: "aabbcc",
      }),
    });

    expect(response.status).toBe(200);
  });

  it("returns 400 when the register body is too large", async () => {
    const { app } = createHarness({
      config: { maxRequestBodyBytes: 64 * 1024 },
    });

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_token: "device-token",
        padding: "x".repeat(70 * 1024),
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: expect.stringContaining("request body is too large"),
    });
  });

  it("returns 400 when the form register body is too large", async () => {
    const { app } = createHarness({
      config: { maxRequestBodyBytes: 64 * 1024 },
    });

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        device_token: "device-token",
        padding: "x".repeat(70 * 1024),
      }).toString(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: expect.stringContaining("request body is too large"),
    });
  });

  it("returns 400 when a checked device key does not exist", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/register/missing");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: "key not found",
    });
  });

  it("returns 403 when registration is closed (POST)", async () => {
    const { app } = createHarness({ config: { closeRegister: true } });

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_token: "device-token",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: 403,
      message: "registration is closed",
      timestamp: 1_717_900_000,
    });
  });

  it("returns 403 when registration is closed (GET compat)", async () => {
    const { app } = createHarness({ config: { closeRegister: true } });

    const response = await app.request(
      "http://example.com/register?devicetoken=device-token-1",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 403,
      message: "registration is closed",
    });
  });

  it("still allows device key checks when registration is closed", async () => {
    const { app } = createHarness({
      config: { closeRegister: true },
      registrySeed: { alpha: "token-alpha" },
    });

    const response = await app.request("http://example.com/register/alpha");

    expect(response.status).toBe(200);
  });

  it("does not expose internal storage errors during registration", async () => {
    const { app, registry } = createHarness();
    registry.saveDeviceTokenByKey = vi.fn(async () => {
      throw new Error("kv write failed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("http://example.com/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_token: "device-token",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 500,
      message: "internal server error",
    });
  });
});
