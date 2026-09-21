/**
 * CUST-L-D06: switching payment mode (or any other basket change) silently dropped an applied coupon
 * while Confirm stayed enabled, so the booking was created at full price with no block and only a
 * small, easy-to-miss line of copy. Two things closed the gap, both now centralised here so
 * CouponField and every caller that renders it agree on the same rule instead of each re-deriving it:
 *
 *  1. When a governed coupon quote goes stale, report the code it was applied under - never "" - so
 *     "a coupon was dropped and needs reapplying" is distinguishable from "no coupon was ever
 *     involved". Passing back "" reads identically to the second case and is what let Confirm through.
 *  2. A caller blocks Confirm whenever a coupon code is present without its governed quote id: that
 *     combination only occurs while the discount shown does not match what a booking would charge.
 */

/** True exactly when a coupon code is present but carries no governed quote id - the shown discount is
 * stale and Confirm must not proceed until the customer re-applies the coupon or clears the code. */
export function couponNeedsReapply(couponCode: string, couponQuoteId: string): boolean {
  return Boolean(couponCode.trim()) && !couponQuoteId.trim();
}

/** What CouponField reports through onDiscountChange when its own governed quote goes stale. */
export function droppedCouponReport(appliedCode: string): { discount: number; code: string } {
  return { discount: 0, code: appliedCode };
}
