export const INTERNAL_MEDIA_LIMIT = 10 * 1024 * 1024;
export function assertInternalMediaEnvironment(env: Record<string, unknown>) {
  if (env.PAWSPACE_INTERNAL_MEDIA_ENABLED !== "true" || env.APP_ENV !== "staging" || env.PAWSPACE_MEDIA_ENV !== "uat") {
    throw new Response("Internal media testing is not enabled", { status: 404 });
  }
}
export async function readVerifiedPhoto(request: Request, expected: { size: number; type: string; sha256: string }) {
  if (!Number.isInteger(expected.size) || expected.size <= 0 || expected.size > INTERNAL_MEDIA_LIMIT) throw new Response("Photo size is not allowed", { status: 413 });
  if (!["image/jpeg", "image/png", "image/webp"].includes(expected.type) || request.headers.get("content-type") !== expected.type) throw new Response("Photo type does not match registration", { status: 400 });
  const reader = request.body?.getReader();
  if (!reader) throw new Response("Photo is required", { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected.size) { await reader.cancel(); throw new Response("Photo exceeds registered size", { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (size !== expected.size) throw new Response("Photo size does not match registration", { status: 400 });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (sha !== expected.sha256.toLowerCase()) throw new Response("Photo checksum does not match registration", { status: 400 });
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const signature = expected.type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : expected.type === "image/png" ? [...bytes.slice(0, 8)].join(",") === "137,80,78,71,13,10,26,10"
    : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (!signature) throw new Response("Photo content does not match its type", { status: 400 });
  return bytes;
}
