const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DEFAULT_LENGTH = 22;
const ALPHABET_LENGTH = ALPHABET.length;
const ACCEPTANCE_LIMIT = Math.floor(256 / ALPHABET_LENGTH) * ALPHABET_LENGTH;

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
