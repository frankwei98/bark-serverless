const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DEFAULT_LENGTH = 22;

export function generateDeviceKey(length = DEFAULT_LENGTH): string {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);

  let output = "";
  for (const value of buffer) {
    output += ALPHABET[value % ALPHABET.length];
  }
  return output;
}
