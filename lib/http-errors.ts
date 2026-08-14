/**
 * The status a thrown error should be answered with, for errors the CALLER caused.
 *
 * The repo already had this convention and only half-used it. backend/src/scheduling.ts annotates its
 * rejections with `statusCode:422` and backend/src/app.ts honours the annotation, but the Worker's
 * authError() ignored it and answered 500 for anything that was not already a Response. So on staging:
 *
 *   Customer B rates Customer A's booking   -> refused correctly, answered HTTP 500
 *   Customer B redeems wallet on A's booking -> refused correctly, answered HTTP 500
 *   grooming booked for 60 min (min 120)     -> rejected correctly, answered HTTP 500
 *
 * Every one of those refusals held - nothing was written, no money moved - but the caller could not
 * tell a refusal from an outage, and no test looking for 401/403 scored them as refused.
 *
 * The fix is deliberately narrow: an error says what class it is at the point where the decision is
 * made, and authError() honours that. An error that says nothing is still a 500, because an
 * unexpected failure IS a server error and must keep saying so - the failure mode to avoid is a real
 * outage quietly reported as "bad request" and never paged on.
 *
 * This module deliberately imports nothing, so a pure-domain lib can classify its own refusals
 * without pulling the whole auth/session graph into its module.
 */

/** The classes a caller-caused failure is allowed to be. Not an open range: each has one meaning. */
export type ClientErrorStatus =
  | 400 // malformed or out-of-range input
  | 401 // not authenticated
  | 403 // authenticated, but not permitted / not the owner
  | 404 // the addressed record does not exist (or is not visible to this caller)
  | 409 // the request is well-formed but conflicts with current state
  | 422 // well-formed and understood, but not satisfiable as asked
  | 429; // rate limited

const CLIENT_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422, 429]);

/** Attach an explicit response class to an error, so authError() answers with it instead of 500. */
export function clientError(status: ClientErrorStatus, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** Not the owner of this record. The single most important one: it must never surface as a 500. */
export const ownershipDenied = (message: string) => clientError(403, message);

/** No such record — or none this caller may see. */
export const notFound = (message: string) => clientError(404, message);

/** The input itself is wrong: missing, malformed, or out of range. */
export const badInput = (message: string) => clientError(400, message);

/** The input is fine but the current state forbids it: already used, already rated, expired. */
export const stateConflict = (message: string) => clientError(409, message);

/**
 * The response class an error is asking for, or null when it is not asking for one.
 *
 * Only an integer in the allowed set counts. Anything else - no annotation, a string, a 5xx, a
 * number outside the set - returns null and the caller answers 500. That is what keeps this from
 * becoming "every error is a 4xx": a genuine unexpected failure carries no annotation, so it cannot
 * accidentally be downgraded out of the alerting path.
 */
export function clientStatusOf(error: unknown): ClientErrorStatus | null {
  const annotated = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (typeof annotated !== "number" || !Number.isInteger(annotated)) return null;
  return CLIENT_STATUSES.has(annotated) ? (annotated as ClientErrorStatus) : null;
}
