/*
 * A booking window is an INSTANT, not a string.
 *
 * MEASURED in a browser against the real app, driving app/training/page.tsx end to end with a real
 * customer, pet, address and published trainer roster:
 *
 *   POST /api/uat-scheduling     -> 200 {"status":"assigned","provider":{"id":"train_kiran"}}
 *   POST /api/canonical-bookings -> 409 "Training booking window does not match the first reserved session"
 *
 * Two steps of the same flow disagreeing about the same window. app/training/page.tsx:49 builds
 * `${date}T10:00:00+05:30`; backend/src/scheduling.ts:49 writes every occurrence through
 * new Date(v).toISOString(), so the reservation holds `...T04:30:00.000Z`. Identical instant,
 * different spelling — and the guards compared the two with `!==` on strings. The reservation had
 * already been committed and the provider's capacity already held by the time the booking was refused.
 *
 * The semantics here are not new: lib/walking-governance.ts, lib/taxi-governance.ts,
 * app/api/uat-scheduling/route.ts and app/api/sitting-bookings/route.ts each carried their own private
 * copy of exactly this comparison. Four copies is how Training, Boarding and Sitting came to be
 * written without one. This is that comparison, once.
 *
 * Unreadable on either side is REFUSED, never read as matching: a value that cannot be parsed is not
 * evidence that two windows agree. The private copies relied on `NaN === NaN` being false to get there;
 * the Number.isFinite gate says it, so a future edit cannot lose it by accident. [PTJA-P1-F31]
 */
export function sameInstant(a:unknown,b:unknown){
  const left=new Date(String(a)).getTime(),right=new Date(String(b)).getTime();
  return Number.isFinite(left)&&Number.isFinite(right)&&left===right;
}
