import { describe, expect, it, vi } from "vitest";

import { KVDeviceRegistry } from "@/services/kv-device-registry";

function createNamespace() {
  return {
    list: vi.fn(async () => ({
      keys: [{ name: "device:alpha" }, { name: "device:beta" }],
      list_complete: true,
      cursor: "",
    })),
    get: vi.fn(),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as unknown as KVNamespace;
}

describe("KVDeviceRegistry count caching", () => {
  it("reuses a recent cached device count", async () => {
    const namespace = createNamespace();
    let now = 1_000;
    const registry = new KVDeviceRegistry(namespace, () => now);

    await expect(registry.countAll()).resolves.toBe(2);
    await expect(registry.countAll()).resolves.toBe(2);

    expect(namespace.list).toHaveBeenCalledTimes(1);

    now += 60_001;
    await expect(registry.countAll()).resolves.toBe(2);

    expect(namespace.list).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cached count after writes", async () => {
    const namespace = createNamespace();
    const registry = new KVDeviceRegistry(namespace, () => 1_000);

    await registry.countAll();
    await registry.saveDeviceTokenByKey("alpha", "token-alpha");
    await registry.countAll();
    await registry.deleteDeviceByKey("alpha");
    await registry.countAll();

    expect(namespace.list).toHaveBeenCalledTimes(3);
  });
});
