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
  const bytes = await readLimitedBytes(request, maxBytes);
  return new TextDecoder().decode(bytes);
}

export async function readLimitedBytes(
  request: BodySource,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<Uint8Array> {
  try {
    assertContentLengthWithinLimit(request, maxBytes);
  } catch (error) {
    if (request.body) {
      await request.body.cancel().catch(() => {});
    }
    throw error;
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("request body is too large");
      }

      chunks.push(value);
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readLimitedFormData(
  request: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<FormData> {
  const bytes = await readLimitedBytes(request, maxBytes);
  if (bytes.byteLength === 0) {
    return new FormData();
  }

  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const bufferedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });

  try {
    return await bufferedRequest.formData();
  } catch {
    return new FormData();
  }
}
