import { generateDeviceKey } from "@/services/device-key";
import type { DeviceRegistry } from "@/types";

const DEVICE_KEY_PREFIX = "device:";
const DEVICE_COUNT_CACHE_TTL_MS = 60 * 1000;

function storageKey(key: string): string {
  return `${DEVICE_KEY_PREFIX}${key}`;
}

export class KVDeviceRegistry implements DeviceRegistry {
  private cachedCount: { value: number; expiresAt: number } | null = null;

  constructor(
    private readonly namespace: KVNamespace,
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

  async deviceTokenByKey(key: string): Promise<string> {
    const token = await this.namespace.get(storageKey(key));
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

    if (token.length === 0) {
      await this.namespace.delete(storageKey(nextKey));
      this.invalidateCountCache();
      return nextKey;
    }

    await this.namespace.put(storageKey(nextKey), token);
    this.invalidateCountCache();
    return nextKey;
  }

  async deleteDeviceByKey(key: string): Promise<void> {
    await this.namespace.delete(storageKey(key));
    this.invalidateCountCache();
  }
}
