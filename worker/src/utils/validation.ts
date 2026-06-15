export const DEFAULT_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

interface BodySource {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function contentLength(request: BodySource): number | null {
  const raw = request.headers.get("content-length");
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function assertContentLengthWithinLimit(
  request: BodySource,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): void {
  const length = contentLength(request);
  if (length !== null && length > maxBytes) {
    throw new Error("request body is too large");
  }
}

export async function readLimitedText(
  request: BodySource,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<string> {
  assertContentLengthWithinLimit(request, maxBytes);

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error("request body is too large");
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function assertBodyWithinLimit(
  request: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  assertContentLengthWithinLimit(request, maxBytes);

  if (!request.body) {
    return;
  }

  const reader = request.clone().body!.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("request body is too large");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
