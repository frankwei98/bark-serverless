const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DEFAULT_LENGTH = 22;
const ALPHABET_LENGTH = ALPHABET.length;
const ACCEPTANCE_LIMIT = Math.floor(256 / ALPHABET_LENGTH) * ALPHABET_LENGTH;
const KV_MAX_KEY_BYTES = 512;

export const DEVICE_KEY_STORAGE_PREFIX = "device:";
export const MAX_DEVICE_KEY_BYTES =
  KV_MAX_KEY_BYTES - new TextEncoder().encode(DEVICE_KEY_STORAGE_PREFIX).byteLength;

export function generateDeviceKey(length = DEFAULT_LENGTH): string {
  let output = "";

  while (output.length < length) {
    const buffer = new Uint8Array(length - output.length);
    crypto.getRandomValues(buffer);

    for (const value of buffer) {
      if (value >= ACCEPTANCE_LIMIT) {
        continue;
      }

      output += ALPHABET[value % ALPHABET_LENGTH];
      if (output.length === length) {
        break;
      }
    }
  }

  return output;
}
