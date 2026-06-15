import { afterEach, describe, expect, it, vi } from "vitest";

import { generateDeviceKey } from "@/services/device-key";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("generateDeviceKey", () => {
  it("returns keys with the expected length and alphabet", () => {
    const key = generateDeviceKey();

    expect(key).toHaveLength(22);
    expect(key).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/);
  });

  it("rejects out-of-range bytes instead of using modulo bias", () => {
    const getRandomValues = vi
      .fn<(buffer: Uint8Array) => Uint8Array>()
      .mockImplementationOnce((buffer) => {
        buffer[0] = 255;
        return buffer;
      })
      .mockImplementationOnce((buffer) => {
        buffer[0] = 0;
        return buffer;
      });

    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      getRandomValues,
    });

    expect(generateDeviceKey(1)).toBe("2");
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});
