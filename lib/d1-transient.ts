/**
 * D1 refusing a query for a moment is not a server bug, and the customer must not see it as one.
 *
 * WHY THIS EXISTS. While a `wrangler d1 execute --remote --file` import runs, D1 refuses every other
 * query with "D1_ERROR: Currently processing a long-running import." (wrangler itself warns that the
 * database "will be unavailable to serve queries"). Staging deploys used to import 54 SQL files each,
 * several times a night, so a customer booking during a deploy got HTTP 500 with that raw text
 * (round-2: POST /api/sitting-bookings and POST /api/taxi-ride-bookings), and a route that let the
 * error escape produced Cloudflare's HTML error page, which the screens then showed as
 * "Unexpected token '<'". D1 also refuses queries while it is overloaded.
 *
 * Both refusals happen BEFORE the statement runs, so nothing was written and the same request can
 * simply be tried again. Anything else - including "Network connection lost", where a write may or
 * may not have landed - is deliberately NOT classified here.
 */

const REFUSED_BEFORE_EXECUTION = /Currently processing a long-running import|D1 DB is overloaded|Too many requests queued/i;

export const SERVICE_BUSY_CODE = "SERVICE_BUSY";
export const SERVICE_BUSY_MESSAGE = "PawSpace is busy for a moment. Please try again in a few seconds.";
export const SERVICE_BUSY_RETRY_SECONDS = 5;
/** Marks a response this module produced, so the Worker can retry a read once without re-parsing the body. */
export const SERVICE_BUSY_HEADER = "x-pawspace-service-busy";

function messageOf(value: unknown): string {
  if (value instanceof Error) return `${value.message} ${value.cause instanceof Error ? value.cause.message : ""}`;
  return typeof value === "string" ? value : "";
}

export function isTransientD1Refusal(value: unknown): boolean {
  return REFUSED_BEFORE_EXECUTION.test(messageOf(value));
}

export function serviceBusyResponse(): Response {
  return Response.json(
    { error: SERVICE_BUSY_MESSAGE, code: SERVICE_BUSY_CODE, retryAfterSeconds: SERVICE_BUSY_RETRY_SECONDS },
    { status: 503, headers: { "retry-after": String(SERVICE_BUSY_RETRY_SECONDS), "cache-control": "no-store", [SERVICE_BUSY_HEADER]: "1" } },
  );
}

export function isServiceBusyResponse(response: Response): boolean {
  return response.status === 503 && response.headers.get(SERVICE_BUSY_HEADER) === "1";
}

/**
 * A route that caught the refusal answers 5xx with the raw D1 text in its body. Only 5xx bodies are
 * read (they are rare), and only a body that names a refusal is replaced; every other response is
 * returned untouched.
 */
export async function replaceTransientD1Failure(response: Response): Promise<Response> {
  if (response.status < 500 || isServiceBusyResponse(response)) return response;
  let body = "";
  try { body = await response.clone().text(); } catch { return response; }
  return isTransientD1Refusal(body) ? serviceBusyResponse() : response;
}
