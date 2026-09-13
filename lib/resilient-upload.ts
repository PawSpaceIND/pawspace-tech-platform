/** Slow-network upload helper. Times out instead of hanging the partner completion screen. */
export type UploadResult = { ok: true; response: Response } | { ok: false; error: string; timedOut: boolean };

export async function uploadWithTimeout(input: {
  url: string;
  body: BodyInit;
  headers?: HeadersInit;
  timeoutMs?: number;
}): Promise<UploadResult> {
  const timeoutMs = Math.max(3_000, Number(input.timeoutMs || 20_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      body: input.body,
      headers: input.headers,
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `Upload failed (${response.status})`, timedOut: false };
    return { ok: true, response };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { ok: false, error: timedOut ? "Upload timed out on a slow connection. Retry." : "Upload failed. Retry." , timedOut };
  } finally {
    clearTimeout(timer);
  }
}
