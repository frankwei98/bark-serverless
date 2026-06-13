import { describe, expect, it } from "vitest";

import { createBasicAuthHeader, createHarness } from "./helpers/fakes";

describe("basic auth compatibility", () => {
  it("allows root without auth even when auth is enabled", async () => {
    const { app } = createHarness({
      config: {
        basicAuthUser: "demo",
        basicAuthPassword: "secret",
      },
    });

    const response = await app.request("http://example.com/");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("allows auth-free endpoints without credentials", async () => {
    const { app } = createHarness({
      config: {
        basicAuthUser: "demo",
        basicAuthPassword: "secret",
      },
    });

    await expect(app.request("http://example.com/ping")).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("http://example.com/healthz"),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request("http://example.com/register?devicetoken=abc"),
    ).resolves.toMatchObject({ status: 200 });
    await expect(app.request("http://example.com/register/demo-key")).resolves.toMatchObject({
      status: 400,
    });
  });

  it("blocks auth-free path prefixes that fall through to push routes", async () => {
    const { app, sender } = createHarness({
      config: {
        basicAuthUser: "demo",
        basicAuthPassword: "secret",
      },
      registrySeed: {
        ping: "token-ping",
        healthz: "token-healthz",
        register: "token-register",
      },
    });

    await expect(app.request("http://example.com/ping", { method: "POST" })).resolves.toMatchObject({
      status: 418,
    });
    await expect(
      app.request("http://example.com/healthz", { method: "POST" }),
    ).resolves.toMatchObject({ status: 418 });
    await expect(
      app.request("http://example.com/register/demo-key", { method: "POST" }),
    ).resolves.toMatchObject({ status: 418 });
    await expect(app.request("http://example.com/register/a/b")).resolves.toMatchObject({
      status: 418,
    });
    await expect(app.request("http://example.com/register/a/b/c")).resolves.toMatchObject({
      status: 418,
    });
    expect(sender.messages).toHaveLength(0);
  });

  it("returns teapot for protected routes without credentials", async () => {
    const { app } = createHarness({
      config: {
        basicAuthUser: "demo",
        basicAuthPassword: "secret",
      },
      registrySeed: {
        dev: "token-a",
      },
    });

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_key: "dev",
        body: "hello",
      }),
    });

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("I'm a teapot");
  });

  it("allows protected routes with valid credentials", async () => {
    const { app } = createHarness({
      config: {
        basicAuthUser: "demo",
        basicAuthPassword: "secret",
      },
      registrySeed: {
        dev: "token-a",
      },
    });

    const response = await app.request("http://example.com/push", {
      method: "POST",
      headers: {
        authorization: createBasicAuthHeader("demo", "secret"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_key: "dev",
        body: "hello",
      }),
    });

    expect(response.status).toBe(200);
  });
});
