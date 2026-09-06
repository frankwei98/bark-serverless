export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeParamKeys(source: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toLowerCase();
    if (Object.hasOwn(normalized, normalizedKey)) {
      throw new Error(`duplicate parameter key: ${normalizedKey}`);
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}
