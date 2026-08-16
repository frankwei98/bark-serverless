import { describe, expect, it } from "vitest";

import {
  DEFAULT_APNS_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_BATCH_PUSH_COUNT,
  HARD_MAX_APNS_REQUEST_TIMEOUT_MS,
  HARD_MAX_REQUEST_BODY_BYTES,
  parseApnsRequestTimeoutMs,
  parseCloseRegister,
  parseMaxBatchPushCount,
  parseMaxRequestBodyBytes,
} from "@/config";
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from "@/utils/validation";

describe("parseMaxBatchPushCount", () => {
  it("uses a finite default when the env var is absent", () => {
    expect(parseMaxBatchPushCount()).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
  });

  it("caps unlimited and oversized values at the hard limit", () => {
    expect(parseMaxBatchPushCount("-1")).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
    expect(parseMaxBatchPushCount("1000000")).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
  });

  it("falls back to the finite default for invalid values", () => {
    expect(parseMaxBatchPushCount("0")).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
    expect(parseMaxBatchPushCount("abc")).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
  });
});

describe("parseApnsRequestTimeoutMs", () => {
  it("uses a finite default when the env var is absent", () => {
    expect(parseApnsRequestTimeoutMs()).toBe(DEFAULT_APNS_REQUEST_TIMEOUT_MS);
  });

  it("accepts positive timeout values", () => {
    expect(parseApnsRequestTimeoutMs("1250")).toBe(1_250);
  });

  it("accepts the hard maximum and rejects larger timeouts", () => {
    expect(parseApnsRequestTimeoutMs(String(HARD_MAX_APNS_REQUEST_TIMEOUT_MS))).toBe(
      HARD_MAX_APNS_REQUEST_TIMEOUT_MS,
    );
    expect(
      parseApnsRequestTimeoutMs(String(HARD_MAX_APNS_REQUEST_TIMEOUT_MS + 1)),
    ).toBe(DEFAULT_APNS_REQUEST_TIMEOUT_MS);
  });

  it("falls back to the default for invalid values", () => {
    expect(parseApnsRequestTimeoutMs("0")).toBe(DEFAULT_APNS_REQUEST_TIMEOUT_MS);
    expect(parseApnsRequestTimeoutMs("abc")).toBe(DEFAULT_APNS_REQUEST_TIMEOUT_MS);
  });
});

describe("parseMaxRequestBodyBytes", () => {
  it("accepts the hard maximum and rejects larger bodies", () => {
    expect(parseMaxRequestBodyBytes(String(HARD_MAX_REQUEST_BODY_BYTES))).toBe(
      HARD_MAX_REQUEST_BODY_BYTES,
    );
    expect(
      parseMaxRequestBodyBytes(String(HARD_MAX_REQUEST_BODY_BYTES + 1)),
    ).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
  });
});

describe("parseCloseRegister", () => {
  it("returns false when the env var is absent", () => {
    expect(parseCloseRegister()).toBe(false);
  });

  it("accepts boolean true and case-insensitive string true", () => {
    expect(parseCloseRegister(true)).toBe(true);
    expect(parseCloseRegister("true")).toBe(true);
    expect(parseCloseRegister("TRUE")).toBe(true);
    expect(parseCloseRegister(" True ")).toBe(true);
  });

  it("returns false for boolean false and non-true strings", () => {
    expect(parseCloseRegister(false)).toBe(false);
    expect(parseCloseRegister("false")).toBe(false);
    expect(parseCloseRegister("1")).toBe(false);
  });
});
