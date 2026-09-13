export async function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Network request timed out. Please retry; replay-safe actions will reuse their idempotency key.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
