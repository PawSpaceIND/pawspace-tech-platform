/** Share one deadline between fetch and (when requested) its JSON body. Caller cancellation stays cancellation. */
async function withDeadline<T>(input: RequestInfo | URL, init: RequestInit, timeoutMs: number, consume: (response: Response) => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Network timeout must be a positive finite number");
  const caller = init.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
  if (caller?.aborted) throw caller.reason ?? new DOMException("Request cancelled", "AbortError");
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(caller?.reason);
  caller?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { if (!controller.signal.aborted) { timedOut = true; controller.abort(); } }, timeoutMs);
  try {
    const result = await consume(await fetch(input, { ...init, signal: controller.signal }));
    if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Request cancelled", "AbortError");
    return result;
  } catch (error) {
    if (timedOut) throw Object.assign(new Error("Network request timed out. Please retry; replay-safe actions will reuse their idempotency key."), { retry: true });
    throw error;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", cancel);
  }
}

/** The deadline covers response headers. Use boundedJsonFetch when a stalled body must also be bounded. */
export async function boundedFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  return withDeadline(input, init, timeoutMs, async response => response);
}

/** Small JSON API responses: the deadline includes receiving and parsing the body, not just headers. */
export async function boundedJsonFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 20_000): Promise<{ response: Response; body: unknown }> {
  return withDeadline(input, init, timeoutMs, async response => {
    // Keep HTTP status available for classifying HTML gateway/authorization errors.
    const body: unknown = await response.json().catch(error => { if (response.ok) throw error; return null; });
    return { response, body };
  });
}
