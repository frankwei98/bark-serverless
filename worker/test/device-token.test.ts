import { describe, expect, it } from "vitest";

import {
  encodeRegisteredDeviceToken,
  routeDeviceToken,
} from "@/services/device-token";

describe("device token provider codec", () => {
  it("routes legacy values to APNs unchanged", () => {
    expect(routeDeviceToken("ios-token")).toEqual({
      provider: "apns",
      storedToken: "ios-token",
      providerToken: "ios-token",
    });
  });

  it("routes reserved Harmony values and strips exactly one prefix", () => {
    expect(routeDeviceToken("harmony:shark-token")).toEqual({
      provider: "huawei",
      storedToken: "harmony:shark-token",
      providerToken: "shark-token",
    });
  });

  it("does not let an explicit non-Harmony platform override the reserved prefix", () => {
    const stored = encodeRegisteredDeviceToken("harmony:shark-token", "ios");
    expect(routeDeviceToken(stored).provider).toBe("huawei");
  });
});
