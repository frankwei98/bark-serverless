import { generateDeviceKey } from "@/services/device-key";
import type {
  DeviceRegistryCoordinatorStub,
} from "@/services/device-registry-coordinator";
import {
  DEVICE_KEY_PREFIX,
  deviceStorageKey,
} from "@/services/device-registry-storage";
import type { DeviceRegistry } from "@/types";

const KV_MAX_KEY_BYTES = 512;
const DEVICE_COUNT_CACHE_TTL_MS = 60 * 1000;
const textEncoder = new TextEncoder();

export class KVDeviceRegistry implements DeviceRegistry {
  private cachedCount: { value: number; expiresAt: number } | null = null;

  constructor(
    private readonly namespace: KVNamespace,
    private readonly coordinatorForKey: (
      key: string,
    ) => DeviceRegistryCoordinatorStub,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private invalidateCountCache(): void {
    this.cachedCount = null;
  }

  async countAll(): Promise<number> {
    if (this.cachedCount && this.cachedCount.expiresAt > this.now()) {
      return this.cachedCount.value;
    }

    let cursor: string | undefined;
    let total = 0;

    do {
      const page = await this.namespace.list({ prefix: DEVICE_KEY_PREFIX, cursor });
      total += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    this.cachedCount = {
      value: total,
      expiresAt: this.now() + DEVICE_COUNT_CACHE_TTL_MS,
    };

    return total;
  }

  canStoreDeviceKey(key: string): boolean {
    return (
      textEncoder.encode(deviceStorageKey(key)).byteLength <= KV_MAX_KEY_BYTES
    );
  }

  async deviceTokenByKey(key: string): Promise<string> {
    const token = await this.coordinatorForKey(key).deviceTokenByKey(key);
    if (token === null) {
      throw new Error("key not found");
    }
    if (token.length === 0) {
      throw new Error("device token invalid");
    }
    return token;
  }

  async saveDeviceTokenByKey(key: string, token: string): Promise<string> {
    const nextKey = key || generateDeviceKey();
    await this.coordinatorForKey(nextKey).saveDeviceTokenByKey(nextKey, token);
    this.invalidateCountCache();
    return nextKey;
  }

  async deleteDeviceByKey(key: string, expectedToken?: string): Promise<boolean> {
    const deleted = await this.coordinatorForKey(key).deleteDeviceByKey(
      key,
      expectedToken,
    );
    if (deleted) {
      this.invalidateCountCache();
    }
    return deleted;
  }
}
