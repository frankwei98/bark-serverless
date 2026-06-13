import type { CommonResp } from "@/types";

export const INTERNAL_ERROR_MESSAGE = "internal server error";

export function success(now: number): CommonResp {
  return {
    code: 200,
    message: "success",
    timestamp: now,
  };
}

export function failed(now: number, code: number, message: string): CommonResp {
  return {
    code,
    message,
    timestamp: now,
  };
}

export function withData(now: number, data: unknown): CommonResp {
  return {
    code: 200,
    message: "success",
    timestamp: now,
    data,
  };
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
