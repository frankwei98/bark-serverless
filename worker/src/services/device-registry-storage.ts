export const DEVICE_KEY_PREFIX = "device:";

export function deviceStorageKey(deviceKey: string): string {
  return `${DEVICE_KEY_PREFIX}${deviceKey}`;
}
