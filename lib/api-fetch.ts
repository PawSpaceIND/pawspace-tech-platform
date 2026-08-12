/**
 * Shared client-side API helper.
 *
 * Fixes the platform-wide class of bug where a caller does `await res.json()` BEFORE checking
 * `res.ok`: a non-JSON error response (a 500 HTML page, a gateway/timeout page, an empty body) then
 * throws a confusing SyntaxError instead of a clean, user-visible message - turning a legitimate
 * 400/401/403/409/500 into "Unexpected token < in JSON". This helper checks the status first, parses
 * safely, and adds request timeout + offline handling. Browser-safe (degrades cleanly under Node).
 *
 * Every failure becomes an ApiError carrying a friendly `.message` (the server's own error text when
 * present, otherwise a status-appropriate default), plus `.kind`, `.status` and the raw `.body` for
 * callers that want to branch.
 */

export type ApiErrorKind = "http" | "network" | "timeout" | "offline" | "parse";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly body: unknown;
  constructor(kind: ApiErrorKind, status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

const FRIENDLY: Record<number, string> = {
  400: "That request couldn't be processed. Please check the details and try again.",
  401: "Your session has expired. Please sign in again.",
  403: "You don't have permission to do that.",
  404: "We couldn't find what you were looking for.",
  409: "That conflicts with the current state - please refresh and try again.",
  422: "Some details need correcting before we can continue.",
  429: "You're going a little fast - please wait a moment and try again.",
  500: "Something went wrong on our side. Please try again in a moment.",
  502: "The service is temporarily unavailable. Please try again shortly.",
  503: "The service is temporarily unavailable. Please try again shortly.",
  504: "The request timed out. Please try again.",
};

export function friendlyHttpMessage(status: number): string {
  return FRIENDLY[status] || (status >= 500 ? FRIENDLY[500] : FRIENDLY[400]);
}

const DEFAULT_TIMEOUT_MS = 20000;
export type ApiFetchOptions = { timeoutMs?: number };

/**
 * Low-level fetch with timeout / offline / network handling and a SAFE JSON parse. Never throws a raw
 * SyntaxError: a non-JSON body on an error response is left undefined for the caller to message; a
 * non-JSON body on a 2xx is surfaced as a clean ApiError("parse").
 */
export async function apiRequest(url: string, init: RequestInit = {}, opts: ApiFetchOptions = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError("offline", 0, "You appear to be offline. Please check your connection and try again.");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: init.signal ?? controller?.signal ?? undefined });
  } catch (error) {
    if (timer) clearTimeout(timer);
    if ((error as { name?: string })?.name === "AbortError") throw new ApiError("timeout", 0, "The request took too long. Please try again.");
    throw new ApiError("network", 0, "We couldn't reach the server. Please check your connection and try again.");
  }
  if (timer) clearTimeout(timer);
  let body: unknown = undefined;
  const text = await res.text().catch(() => "");
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiError("parse", res.status, "We received an unexpected response from the server. Please try again.", text.slice(0, 200));
      // non-JSON error body (HTML/gateway page): leave body undefined; apiSend maps status -> friendly text
    }
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * High-level helper for the platform's standard `{ data?, error? }` response envelope. Does the fetch
 * safely, throws a clean ApiError on any failure (server's `error` message preserved when present),
 * and returns the unwrapped `data` on success.
 */
export async function apiSend<T>(url: string, init: RequestInit = {}, fallbackMessage = "That action could not be completed. Please try again.", opts: ApiFetchOptions = {}): Promise<T> {
  const { ok, status, body } = await apiRequest(url, init, opts);
  const env = (body && typeof body === "object" ? body : {}) as { data?: T; error?: string };
  if (!ok) throw new ApiError("http", status, env.error || friendlyHttpMessage(status), body);
  if (env.data === undefined || env.data === null) throw new ApiError("http", status, env.error || fallbackMessage, body);
  return env.data as T;
}
