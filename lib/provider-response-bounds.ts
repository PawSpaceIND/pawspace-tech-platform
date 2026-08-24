/**
 * One bounded reader for every external provider response.
 *
 * `await response.text()` on an untrusted origin is unbounded: a provider (or anything that can
 * answer in its place) returning a multi-megabyte body buffers all of it inside a Worker with a hard
 * memory ceiling, and the request dies with an out-of-memory error rather than the honest "the
 * provider misbehaved" this returns. The telephony adapter grew its own copy of this loop first; a
 * second copy in the AI adapter would have been the point where the two started to drift.
 *
 * The size is checked BEFORE each chunk is retained, so an oversized body is refused after the first
 * chunk that crosses the line rather than after the whole thing is in memory.
 */

export class ProviderResponseTooLarge extends Error {
  // A plain field, not a parameter property: the test runner strips types rather than compiling them,
  // and `constructor(readonly x)` is the one class shape strip-only mode refuses.
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Provider response exceeded ${maxBytes} bytes`);
    this.name = "ProviderResponseTooLarge";
    this.maxBytes = maxBytes;
  }
}

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new ProviderResponseTooLarge(0);
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ProviderResponseTooLarge(maxBytes);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ProviderResponseTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}
