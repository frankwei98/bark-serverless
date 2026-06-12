import { generateDeviceKey } from "@/device-key";
import type { DeviceRegistry } from "@/types";

const DEVICE_KEY_PREFIX = "device:";

function storageKey(key: string): string {
  return `${DEVICE_KEY_PREFIX}${key}`;
}

export class KVDeviceRegistry implements DeviceRegistry {
  constructor(private readonly namespace: KVNamespace) {}

  async countAll(): Promise<number> {
    let cursor: string | undefined;
    let total = 0;

    do {
      const page = await this.namespace.list({ prefix: DEVICE_KEY_PREFIX, cursor });
      total += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

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
      return nextKey;
    }

    await this.namespace.put(storageKey(nextKey), token);
    return nextKey;
  }

  async deleteDeviceByKey(key: string): Promise<void> {
    await this.namespace.delete(storageKey(key));
  }
}
