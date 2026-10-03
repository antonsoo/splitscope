/** Bound input while reading, before allocating a decoded string or parsing XML. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const tooLarge = () =>
  new Error(
    "This file exceeds the 25 MiB input limit. Export a smaller splits file and try again.",
  );

export async function readInputStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limit = MAX_INPUT_BYTES,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw tooLarge();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function readFileBytes(file: File, signal: AbortSignal): Promise<Uint8Array> {
  if (file.size > MAX_INPUT_BYTES) return Promise.reject(tooLarge());
  return readInputStream(file.stream(), signal);
}

export async function readSampleBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Sample download failed (HTTP ${response.status}).`);
  }
  if (Number(response.headers.get("content-length")) > MAX_INPUT_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) throw new Error("The sample response was empty.");
  return readInputStream(response.body, signal);
}
