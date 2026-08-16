import { describe, expect, it } from "vitest";

import { DeviceRegistryCoordinatorCore } from "@/services/device-registry-coordinator";

function createStorage() {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return values.delete(key);
    },
  };
  return { storage, values };
}

function createNamespace(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const namespace = {
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      values.set(key, value);
    },
    async delete(key: string): Promise<void> {
      values.delete(key);
    },
  };
  return { namespace, values };
}

function createCoordinator(deviceKey: string, token: string) {
  const { storage } = createStorage();
  const { namespace, values } = createNamespace({
    [`device:${deviceKey}`]: token,
  });
  const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace);
  return { coordinator, values };
}

describe("DeviceRegistryCoordinator", () => {
  it("preserves a replacement token when registration reaches the coordinator first", async () => {
    const { coordinator, values } = createCoordinator("alpha", "old-token");

    await expect(coordinator.deviceTokenByKey("alpha")).resolves.toBe(
      "old-token",
    );
    const save = coordinator.saveDeviceTokenByKey("alpha", "new-token");
    const cleanup = coordinator.deleteDeviceByKey("alpha", "old-token");

    await expect(Promise.all([save, cleanup])).resolves.toEqual([
      undefined,
      false,
    ]);
    await expect(coordinator.deviceTokenByKey("alpha")).resolves.toBe(
      "new-token",
    );
    expect(values.get("device:alpha")).toBe("new-token");
  });

  it("allows a replacement token after cleanup reaches the coordinator first", async () => {
    const { coordinator, values } = createCoordinator("alpha", "old-token");

    const cleanup = coordinator.deleteDeviceByKey("alpha", "old-token");
    const save = coordinator.saveDeviceTokenByKey("alpha", "new-token");

    await expect(Promise.all([cleanup, save])).resolves.toEqual([
      true,
      undefined,
    ]);
    await expect(coordinator.deviceTokenByKey("alpha")).resolves.toBe(
      "new-token",
    );
    expect(values.get("device:alpha")).toBe("new-token");
  });
});
