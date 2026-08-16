import { describe, expect, it, vi } from "vitest";

import type {
  DeviceRegistryCoordinatorStub,
} from "@/services/device-registry-coordinator";
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

function createCoordinator() {
  const stub: DeviceRegistryCoordinatorStub = {
    deviceTokenByKey: vi.fn(async () => null),
    saveDeviceTokenByKey: vi.fn(async () => {}),
    deleteDeviceByKey: vi.fn(async () => true),
  };
  const coordinatorForKey = vi.fn((_key: string) => stub);
  return { coordinatorForKey, stub };
}

describe("KVDeviceRegistry count caching", () => {
  it("validates device keys against the complete KV storage key", () => {
    const { coordinatorForKey } = createCoordinator();
    const registry = new KVDeviceRegistry(
      createNamespace(),
      coordinatorForKey,
      () => 1_000,
    );

    expect(registry.canStoreDeviceKey("x".repeat(505))).toBe(true);
    expect(registry.canStoreDeviceKey("é".repeat(253))).toBe(false);
  });

  it("reuses a recent cached device count", async () => {
    const namespace = createNamespace();
    const { coordinatorForKey } = createCoordinator();
    let now = 1_000;
    const registry = new KVDeviceRegistry(
      namespace,
      coordinatorForKey,
      () => now,
    );

    await expect(registry.countAll()).resolves.toBe(2);
    await expect(registry.countAll()).resolves.toBe(2);

    expect(namespace.list).toHaveBeenCalledTimes(1);

    now += 60_001;
    await expect(registry.countAll()).resolves.toBe(2);

    expect(namespace.list).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cached count after writes", async () => {
    const namespace = createNamespace();
    const { coordinatorForKey } = createCoordinator();
    const registry = new KVDeviceRegistry(
      namespace,
      coordinatorForKey,
      () => 1_000,
    );

    await registry.countAll();
    await registry.saveDeviceTokenByKey("alpha", "token-alpha");
    await registry.countAll();
    await registry.deleteDeviceByKey("alpha", "token-alpha");
    await registry.countAll();

    expect(namespace.list).toHaveBeenCalledTimes(3);
  });

  it("deletes a device when registration stores an empty token", async () => {
    const { coordinatorForKey, stub } = createCoordinator();
    const registry = new KVDeviceRegistry(
      createNamespace(),
      coordinatorForKey,
      () => 1_000,
    );

    await expect(registry.saveDeviceTokenByKey("alpha", "")).resolves.toBe(
      "alpha",
    );

    expect(stub.saveDeviceTokenByKey).toHaveBeenCalledWith("alpha", "");
  });

  it("delegates conditional deletion to the per-key coordinator", async () => {
    const { coordinatorForKey, stub } = createCoordinator();
    vi.mocked(stub.deleteDeviceByKey).mockResolvedValueOnce(false);
    const registry = new KVDeviceRegistry(
      createNamespace(),
      coordinatorForKey,
      () => 1_000,
    );

    await expect(
      registry.deleteDeviceByKey("alpha", "old-token"),
    ).resolves.toBe(false);

    expect(coordinatorForKey).toHaveBeenCalledWith("alpha");
    expect(stub.deleteDeviceByKey).toHaveBeenCalledWith("alpha", "old-token");
  });
});
