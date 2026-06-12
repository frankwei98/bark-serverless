import { describe, expect, it } from "vitest";

import { createHarness } from "./helpers/fakes";

describe("misc routes", () => {
  it("returns ok on root", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("server")).toBe("Bark");
  });

  it("returns pong on /ping", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/ping");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      code: 200,
      message: "pong",
      timestamp: 1_717_900_000,
    });
  });

  it("returns ok on /healthz", async () => {
    const { app } = createHarness();

    const response = await app.request("http://example.com/healthz");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("returns build info and device count on /info", async () => {
    const { app } = createHarness({
      registrySeed: {
        alpha: "token-a",
        beta: "token-b",
      },
    });

    const response = await app.request("http://example.com/info");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: "test-version",
      build: "test-build",
      arch: "cloudflare/workerd",
      commit: "test-commit",
      devices: 2,
    });
  });
});
