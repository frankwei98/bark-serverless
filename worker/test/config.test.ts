import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_BATCH_PUSH_COUNT, parseCloseRegister, parseMaxBatchPushCount } from "@/config";

describe("parseMaxBatchPushCount", () => {
  it("uses a finite default when the env var is absent", () => {
    expect(parseMaxBatchPushCount()).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
  });

  it("keeps explicit unlimited mode for -1", () => {
    expect(parseMaxBatchPushCount("-1")).toBe(-1);
  });

  it("falls back to the finite default for invalid values", () => {
    expect(parseMaxBatchPushCount("0")).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
    expect(parseMaxBatchPushCount("abc")).toBe(DEFAULT_MAX_BATCH_PUSH_COUNT);
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
