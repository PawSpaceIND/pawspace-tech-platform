/*
 * Turn a failed API response into a sentence a person can read.
 *
 * Three onboarding pages did `throw new Error(await r.text())`, which put the raw response body on
 * screen. A caregiver whose application could not be submitted was shown
 *
 *   {"error":"An active onboarding policy is required before submission"}
 *
 * brace-wrapped, in an alert, with no idea whether they had done something wrong. They had not: the
 * platform had no onboarding policy published for their service and city.
 *
 * The envelope is never what the reader wants. This unwraps it, and falls back to a plain apology
 * rather than showing JSON when there is nothing useful inside.
 */
export const GENERIC_API_ERROR = "We could not save that just now. Please try again, or contact us if it keeps happening.";

export async function apiErrorMessage(response: Response, fallback = GENERIC_API_ERROR) {
  const body = await response.text().catch(() => "");
  return messageFromBody(body, fallback);
}

/** Split out so the unwrapping can be tested without constructing a Response. */
export function messageFromBody(body: string, fallback = GENERIC_API_ERROR) {
  const raw = (body ?? "").trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const message = typeof parsed?.error === "string" ? parsed.error
      : typeof parsed?.message === "string" ? parsed.message : "";
    return message.trim() || fallback;
  } catch { /* not JSON: fall through */ }
  // Plain text is fine to show; a JSON-shaped blob we could not parse is not.
  return raw.startsWith("{") || raw.startsWith("[") ? fallback : raw;
}
