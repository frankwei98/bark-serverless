type Stage = "routing" | "configuration" | "payload" | "jwt" | "fetch" | "response_body" | "response_parse";
type Event = "start" | "configuration" | "payload_ready" | "jwt_ready" | "http_start" | "http_response" | "body_read" | "business_response" | "success";

interface Diagnostics {
  errorType: string;
  errorCategory: string;
}

/** Classify runtime failures without logging arbitrary exception text or causes. */
function diagnose(error: unknown): Diagnostics {
  const allowedNames = new Set(["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "OperationError", "DataError", "InvalidAccessError", "NotSupportedError", "HuaweiPushError"]);
  const name = error instanceof Error ? error.name : "UnknownError";
  const errorType = allowedNames.has(name) ? name : "UnknownError";
  let current = error;
  let text = "";
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    text += ` ${current.message}`;
    current = current.cause;
  }
  const patterns: [RegExp, string][] = [
    [/different request|outside.*request|I\/O.*context|I\/O on behalf/i, "worker_io_context"],
    [/timed? ?out|timeout/i, "timeout"],
    [/abort/i, "aborted"],
    [/dns|ENOTFOUND|EAI_AGAIN|resolve.*host/i, "dns"],
    [/tls|ssl|certificate|handshake/i, "tls"],
    [/redirect/i, "redirect"],
    [/ECONNRESET|connection.*reset|connection.*closed|disconnected/i, "connection_reset"],
    [/ECONNREFUSED|connection.*refused/i, "connection_refused"],
    [/network.*connection.*lost|network.*lost/i, "connection_lost"],
    [/fetch failed/i, "fetch_failed"],
    [/too many subrequests|limit exceeded|resource limit/i, "resource_limit"],
    [/internal error/i, "runtime_internal_error"],
  ];
  return { errorType, errorCategory: patterns.find(([pattern]) => pattern.test(text))?.[1] ?? "unclassified" };
}

interface Details {
  projectConfigured?: boolean;
  keyIdConfigured?: boolean;
  subAccountConfigured?: boolean;
  privateKeyConfigured?: boolean;
  pushType?: 0 | 6;
  payloadBytes?: number;
  responseBytes?: number;
  jwtCache?: "hit" | "miss" | "pending";
  timeoutMs?: number;
  businessCode?: string;
}

/** One log context per send; no message, token, account, URL path or JWT values. */
export class HuaweiPushLog {
  private readonly attemptId = crypto.randomUUID();
  private readonly startedAt = Date.now();
  stage: Stage = "configuration";
  httpStatus?: number;
  timedOut = false;
  private diagnostic?: Diagnostics;

  capture(error: unknown): void {
    this.diagnostic = diagnose(error);
  }

  private base() {
    return {
      provider: "huawei", attemptId: this.attemptId, stage: this.stage,
      elapsedMs: Math.max(0, Date.now() - this.startedAt), httpStatus: this.httpStatus,
    };
  }

  info(event: Event, details: Details = {}): void {
    console.info(JSON.stringify({ ...this.base(), event: `huawei.push.${event}`, ...details }));
  }

  failure(error: unknown): void {
    // Provider response text and Error.message/stack can contain credentials.
    const businessCode = error instanceof Error && "businessCode" in error
      && typeof error.businessCode === "string" && /^\d{8}$/.test(error.businessCode)
      ? error.businessCode : undefined;
    const retryable = error instanceof Error && "retryable" in error
      && typeof error.retryable === "boolean" ? error.retryable : undefined;
    console.error(JSON.stringify({
      ...this.base(), event: "huawei.push.failure", timedOut: this.timedOut,
      businessCode, retryable, ...(this.diagnostic ?? diagnose(error)),
      ...(this.timedOut ? { errorCategory: "timeout" } : {}),
    }));
  }
}
