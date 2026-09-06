import { describe, expect, it, vi } from "vitest";

import { DeviceRegistryCoordinatorCore } from "@/services/device-registry-coordinator";

function createStorage() {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    put: vi.fn(async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string): Promise<boolean> => {
      return values.delete(key);
    }),
  };
  return { storage, values };
}

function createNamespace(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const namespace = {
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null;
    },
    put: vi.fn(async (key: string, value: string): Promise<void> => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string): Promise<void> => {
      values.delete(key);
    }),
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

  it("does not rewrite durable or KV state for an unchanged token", async () => {
    const { storage } = createStorage();
    const { namespace } = createNamespace({ "device:alpha": "same-token" });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace);

    await coordinator.saveDeviceTokenByKey("alpha", "same-token");
    await coordinator.saveDeviceTokenByKey("alpha", "same-token");

    expect(storage.put).not.toHaveBeenCalled();
    expect(namespace.put).not.toHaveBeenCalled();
    expect(namespace.delete).not.toHaveBeenCalled();
  });

  it("does not rewrite durable or KV state when an absent token is deleted", async () => {
    const { storage } = createStorage();
    const { namespace } = createNamespace();
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace);

    await expect(coordinator.deleteDeviceByKey("alpha")).resolves.toBe(true);

    expect(storage.put).not.toHaveBeenCalled();
    expect(namespace.delete).not.toHaveBeenCalled();
  });

  it("spaces changed KV mirrors at least one second apart", async () => {
    const { storage } = createStorage();
    const { namespace } = createNamespace();
    let nowMs = 5_000;
    const sleep = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace, {
      now: () => nowMs,
      sleep,
    });

    await coordinator.saveDeviceTokenByKey("alpha", "first-token");
    nowMs += 100;
    await coordinator.saveDeviceTokenByKey("alpha", "second-token");

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(900);
    expect(namespace.put).toHaveBeenNthCalledWith(
      1,
      "device:alpha",
      "first-token",
    );
    expect(namespace.put).toHaveBeenNthCalledWith(
      2,
      "device:alpha",
      "second-token",
    );
  });

  it("keeps a failed mirror reservation when retrying", async () => {
    const { storage } = createStorage();
    const { namespace } = createNamespace({ "device:alpha": "old-token" });
    let nowMs = 8_000;
    const sleep = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    namespace.put.mockRejectedValueOnce(new Error("ambiguous KV failure"));
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace, {
      now: () => nowMs,
      sleep,
    });

    await expect(
      coordinator.saveDeviceTokenByKey("alpha", "new-token"),
    ).rejects.toThrow("ambiguous KV failure");
    nowMs += 100;
    await coordinator.saveDeviceTokenByKey("alpha", "new-token");

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(900);
  });
});
