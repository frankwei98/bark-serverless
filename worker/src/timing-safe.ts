export function timingSafeStringEqual(
  actual: string | null | undefined,
  expected: string,
): boolean {
  if (actual === null || actual === undefined) {
    return false;
  }

  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return diff === 0;
}
