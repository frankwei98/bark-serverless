import { describe, expect, it, vi } from "vitest";
import { DeviceRegistryCoordinatorCore } from "@/services/device-registry-coordinator";

function createStorage() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let rejectTransactionAlarm = false;
  const transactionStarted = vi.fn();
  const direct = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { return values.delete(key); },
    async setAlarm(time: number | Date) { alarm = time instanceof Date ? time.getTime() : time; },
    async deleteAlarm() { alarm = null; },
  };
  const storage = {
    ...direct,
    async transaction<T>(closure: (transaction: typeof direct) => Promise<T>): Promise<T> {
      transactionStarted();
      const staged = new Map(values);
      let stagedAlarm = alarm;
      const transaction = {
        async get<U>(key: string) { return staged.get(key) as U | undefined; },
        async put(key: string, value: unknown) { staged.set(key, value); },
        async delete(key: string) { return staged.delete(key); },
        async setAlarm(time: number | Date) {
          if (rejectTransactionAlarm) {
            rejectTransactionAlarm = false;
            throw new Error("alarm storage unavailable");
          }
          stagedAlarm = time instanceof Date ? time.getTime() : time;
        },
        async deleteAlarm() { stagedAlarm = null; },
      };
      const result = await closure(transaction);
      values.clear();
      for (const entry of staged) values.set(...entry);
      alarm = stagedAlarm;
      return result;
    },
  };
  return {
    storage,
    values,
    getAlarm: () => alarm,
    transactionStarted,
    rejectNextTransactionAlarm: () => { rejectTransactionAlarm = true; },
  };
}

function createNamespace(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const namespace = {
    async get(key: string) { return values.get(key) ?? null; },
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  };
  return { namespace, values };
}

describe("DeviceRegistryCoordinator", () => {
  it("preserves prefixed registrations and compares the entire stored token", async () => {
    const { storage } = createStorage();
    const { namespace, values } = createNamespace({ "device:alpha": "legacy-ios-token" });
    let now = 4000;
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace, { now: () => now });
    await coordinator.saveDeviceTokenByKey("alpha", "harmony:new-token");
    expect(values.get("device:alpha")).toBe("harmony:new-token");
    await expect(coordinator.deleteDeviceByKey("alpha", "legacy-ios-token")).resolves.toBe(false);
    await expect(coordinator.deleteDeviceByKey("alpha", "new-token")).resolves.toBe(false);
    await expect(coordinator.deleteDeviceByKey("alpha", "harmony:new-token")).resolves.toBe(true);
    now += 1000;
    await coordinator.alarm();
    expect(values.has("device:alpha")).toBe(false);
    const reloaded = new DeviceRegistryCoordinatorCore(storage, namespace);
    await expect(reloaded.deviceTokenByKey("alpha")).resolves.toBeNull();
  });

  it("preserves a replacement token when registration wins the race", async () => {
    const { storage } = createStorage();
    const { namespace, values } = createNamespace({ "device:alpha": "old-token" });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace);
    const save = coordinator.saveDeviceTokenByKey("alpha", "new-token");
    const cleanup = coordinator.deleteDeviceByKey("alpha", "old-token");
    await expect(Promise.all([save, cleanup])).resolves.toEqual([undefined, false]);
    await expect(coordinator.deviceTokenByKey("alpha")).resolves.toBe("new-token");
    expect(values.get("device:alpha")).toBe("new-token");
  });

  it("publishes the replacement after cleanup wins the race", async () => {
    const { storage } = createStorage();
    const { namespace, values } = createNamespace({ "device:alpha": "old-token" });
    let now = 4_000;
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace, {
      now: () => now,
    });

    await expect(coordinator.deleteDeviceByKey("alpha", "old-token")).resolves.toBe(true);
    await coordinator.saveDeviceTokenByKey("alpha", "new-token");

    await expect(coordinator.deviceTokenByKey("alpha")).resolves.toBe("new-token");
    expect(values.has("device:alpha")).toBe(false);
    now = 5_000;
    await coordinator.alarm();
    expect(values.get("device:alpha")).toBe("new-token");
  });

  it("migrates an unchanged legacy token without rewriting KV", async () => {
    const { storage, values } = createStorage();
    const { namespace } = createNamespace({ "device:alpha": "same-token" });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace);
    await coordinator.saveDeviceTokenByKey("alpha", "same-token");
    expect(values.get("registration")).toEqual({ deviceKey: "alpha", token: "same-token", generation: 0 });
    expect(namespace.put).not.toHaveBeenCalled();
  });

  it("does not rewrite authoritative or KV state for the same token", async () => {
    const { storage, values, transactionStarted } = createStorage();
    values.set("registration", {
      deviceKey: "alpha",
      token: "same-token",
      generation: 7,
    });
    const { namespace } = createNamespace({ "device:alpha": "same-token" });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace);

    await coordinator.saveDeviceTokenByKey("alpha", "same-token");
    await coordinator.saveDeviceTokenByKey("alpha", "same-token");

    expect(transactionStarted).not.toHaveBeenCalled();
    expect(namespace.put).not.toHaveBeenCalled();
    expect(namespace.delete).not.toHaveBeenCalled();
  });

  it("does not acknowledge registration when atomic alarm scheduling fails", async () => {
    const { storage, values, rejectNextTransactionAlarm } = createStorage();
    values.set("registration", {
      deviceKey: "alpha",
      token: "old-token",
      generation: 2,
    });
    const { namespace } = createNamespace({ "device:alpha": "old-token" });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace);
    await expect(coordinator.deviceTokenByKey("alpha")).resolves.toBe("old-token");
    rejectNextTransactionAlarm();

    await expect(
      coordinator.saveDeviceTokenByKey("alpha", "new-token"),
    ).rejects.toThrow("alarm storage unavailable");

    expect(values.get("registration")).toEqual({
      deviceKey: "alpha",
      token: "old-token",
      generation: 2,
    });
    expect(values.has("pendingMirror")).toBe(false);
    await expect(coordinator.deviceTokenByKey("alpha")).resolves.toBe("old-token");
    expect(namespace.put).not.toHaveBeenCalled();
  });

  it("atomically stores a changed registration, pending mirror, and alarm", async () => {
    const { storage, values, getAlarm } = createStorage();
    values.set("registration", { deviceKey: "alpha", token: "old", generation: 3, lastMirrorAtMs: 5_000 });
    const { namespace } = createNamespace({ "device:alpha": "old" });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace, { now: () => 5_100 });
    await coordinator.saveDeviceTokenByKey("alpha", "new");
    expect(values.get("registration")).toEqual({ deviceKey: "alpha", token: "new", generation: 4, lastMirrorAtMs: 5_000 });
    expect(values.get("pendingMirror")).toEqual({ generation: 4, token: "new", dueAtMs: 6_000, failures: 0 });
    expect(getAlarm()).toBe(6_000);
    expect(namespace.put).not.toHaveBeenCalled();
  });

  it("recovers a failed mirror through an alarm after eviction", async () => {
    const { storage, values, getAlarm } = createStorage();
    const { namespace, values: mirrored } = createNamespace();
    let now = 8_000;
    namespace.put.mockRejectedValueOnce(new Error("KV unavailable"));
    const first = new DeviceRegistryCoordinatorCore(storage, namespace, { now: () => now });
    await expect(first.saveDeviceTokenByKey("alpha", "new")).resolves.toBeUndefined();
    expect(values.get("pendingMirror")).toEqual({ generation: 1, token: "new", dueAtMs: 9_000, failures: 1 });
    expect(getAlarm()).toBe(9_000);
    now = 9_000;
    await new DeviceRegistryCoordinatorCore(storage, namespace, { now: () => now }).alarm();
    expect(mirrored.get("device:alpha")).toBe("new");
    expect(values.has("pendingMirror")).toBe(false);
    expect(getAlarm()).toBeNull();
  });

  it("paces the next mirror from the prior attempt completion", async () => {
    const { storage, values, getAlarm } = createStorage();
    const { namespace } = createNamespace();
    let now = 20_000;
    namespace.put.mockImplementation(async () => {
      now = 20_500;
    });
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace, {
      now: () => now,
    });

    await coordinator.saveDeviceTokenByKey("alpha", "first");
    now = 20_600;
    await coordinator.saveDeviceTokenByKey("alpha", "second");

    expect(values.get("pendingMirror")).toEqual({
      generation: 2,
      token: "second",
      dueAtMs: 21_500,
      failures: 0,
    });
    expect(getAlarm()).toBe(21_500);
    expect(namespace.put).toHaveBeenCalledOnce();
  });

  it("inherits an interrupted mirror reservation after reload", async () => {
    const { storage, values, getAlarm } = createStorage();
    values.set("registration", {
      deviceKey: "alpha",
      token: "interrupted-token",
      generation: 4,
      lastMirrorAtMs: 40_000,
    });
    values.set("pendingMirror", {
      generation: 4,
      token: "interrupted-token",
      dueAtMs: 100_000,
      failures: 0,
    });
    const { namespace } = createNamespace();
    const reloaded = new DeviceRegistryCoordinatorCore(storage, namespace, {
      now: () => 40_100,
    });

    await reloaded.saveDeviceTokenByKey("alpha", "latest-token");

    expect(values.get("pendingMirror")).toEqual({
      generation: 5,
      token: "latest-token",
      dueAtMs: 100_000,
      failures: 0,
    });
    expect(getAlarm()).toBe(100_000);
    expect(namespace.put).not.toHaveBeenCalled();
  });

  it("mirrors only the latest state when a retry is pending", async () => {
    const { storage, values } = createStorage();
    const { namespace, values: mirrored } = createNamespace();
    let now = 10_000;
    namespace.put.mockRejectedValueOnce(new Error("KV unavailable"));
    const coordinator = new DeviceRegistryCoordinatorCore(storage, namespace, { now: () => now });
    await coordinator.saveDeviceTokenByKey("alpha", "superseded");
    now = 10_100;
    await coordinator.saveDeviceTokenByKey("alpha", "latest");
    now = 11_000;
    await coordinator.alarm();
    expect(mirrored.get("device:alpha")).toBe("latest");
    expect(namespace.put).toHaveBeenCalledTimes(2);
    expect(values.has("pendingMirror")).toBe(false);
  });
});
