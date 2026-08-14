/**
 * Booking-status revenue recognition — one classification, shared by every board/finance GMV/LTV report.
 *
 * Founder's decision on task #37 (delivered vs committed) fixed the monthly close, but the same figure
 * is recomputed independently by the GMV/LTV reports (company analytics, P&L turnover, unit economics).
 * Each of those still filtered with a DENYLIST — `status NOT IN ('cancelled','draft')` — so every status
 * the product grew since (`no_show`, `awaiting_host_acceptance`, `awaiting_acceptance`, `pending`,
 * `refunded`) silently counted as GMV, and any brand-new status would too. Task #55 reconciles them onto
 * the same ALLOWLIST the close uses, so an unclassified status fails closed (is NOT counted) rather than
 * becoming revenue by default.
 *
 * Delivered = earned (service done). Committed = booked and scheduled, not yet delivered. GMV/LTV recognise
 * the union of the two, exactly as the close's revenue total does (delivered + committed).
 *
 * Explicitly EXCLUDED (must never count as GMV/LTV): cancelled, refunded, no_show,
 * awaiting_host_acceptance, awaiting_acceptance, draft, pending — and anything not on the allowlist.
 *
 * OUT OF SCOPE of #55, deliberately NOT governed by this module:
 *   - Food revenue recognition (food_orders has its own vocabulary) — task #56.
 *   - Subscription BI liability/segmentation — task #57.
 *   - The marketing/targeting per-customer LTV definition — task #58.
 */

export const DELIVERED_BOOKING_STATUSES = ["completed"] as const;
export const COMMITTED_BOOKING_STATUSES = ["confirmed", "in_progress"] as const;

/** Delivered ∪ committed — the statuses that count toward board/finance GMV and LTV. Allowlist. */
export const RECOGNIZED_BOOKING_STATUSES = [...DELIVERED_BOOKING_STATUSES, ...COMMITTED_BOOKING_STATUSES] as const;

const RECOGNIZED = new Set<string>(RECOGNIZED_BOOKING_STATUSES);

/** Fail-closed: an unknown / new / excluded status is NOT recognized revenue. */
export function isRecognizedBookingRevenue(status: unknown): boolean {
  return RECOGNIZED.has(String(status ?? ""));
}

/** For `WHERE status IN ${RECOGNIZED_BOOKING_STATUS_SQL}` clauses — same allowlist, expressed in SQL. */
export const RECOGNIZED_BOOKING_STATUS_SQL = `(${RECOGNIZED_BOOKING_STATUSES.map((s) => `'${s}'`).join(",")})`;
