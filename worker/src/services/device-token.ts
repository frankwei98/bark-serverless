export const HARMONY_TOKEN_PREFIX = "harmony:";
export const MAX_HARMONY_TOKEN_BYTES = 4096;

const HARMONY_PLATFORM_ALIASES = new Set(["harmony", "harmonyos", "hmos"]);

export type DeviceProvider = "apns" | "huawei";

export interface RoutedDeviceToken {
  provider: DeviceProvider;
  storedToken: string;
  providerToken: string;
}

export function isHarmonyPlatform(platform: unknown): boolean {
  return (
    typeof platform === "string" &&
    HARMONY_PLATFORM_ALIASES.has(platform.trim().toLowerCase())
  );
}

export function encodeRegisteredDeviceToken(
  token: string,
  platform: unknown,
): string {
  if (token.startsWith(`${HARMONY_TOKEN_PREFIX}${HARMONY_TOKEN_PREFIX}`)) {
    throw new Error("device token is invalid");
  }

  const hasHarmonyPrefix = token.startsWith(HARMONY_TOKEN_PREFIX);
  const providerToken = hasHarmonyPrefix
    ? token.slice(HARMONY_TOKEN_PREFIX.length)
    : token;
  if (hasHarmonyPrefix && providerToken.length === 0) {
    throw new Error("device token is empty");
  }

  if (!isHarmonyPlatform(platform)) {
    return token;
  }

  if (
    providerToken.length === 0 ||
    new TextEncoder().encode(providerToken).byteLength > MAX_HARMONY_TOKEN_BYTES
  ) {
    throw new Error("device token is invalid");
  }

  return `${HARMONY_TOKEN_PREFIX}${providerToken}`;
}

export function routeDeviceToken(storedToken: string): RoutedDeviceToken {
  if (!storedToken.startsWith(HARMONY_TOKEN_PREFIX)) {
    return {
      provider: "apns",
      storedToken,
      providerToken: storedToken,
    };
  }

  return {
    provider: "huawei",
    storedToken,
    providerToken: storedToken.slice(HARMONY_TOKEN_PREFIX.length),
  };
}
