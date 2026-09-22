/**
 * Decides which Grooming package price the customer screen may quote, and whether Confirm must
 * wait for it.
 *
 * The server resolves the live Pricing Control price for every Grooming booking and refuses a total
 * that disagrees ("Submitted Grooming total does not match governed catalogue"). So the screen may
 * only let a booking through at a price it has actually received from the server FOR THIS BASKET.
 *
 * A quote is therefore keyed to the basket it was fetched for (package, start, city, zone). Two
 * earlier forms of this logic got that wrong in opposite directions:
 *
 * - Blanking the price on every re-render let a booking go out at the hardcoded bundle price while
 *   a fresh quote was in flight — the original 409 on "Pay online".
 * - Keeping the last price across a refetch then let a changed basket go out at the PREVIOUS
 *   basket's price.
 *
 * Matching on the key rules out both. It also separates "resolved" from "failed": the quote
 * endpoint answers a basket with no Pricing Control row by returning the caller's own fallback as a
 * resolved price, so a failure is never the same thing as "no row" and must never unblock Confirm.
 *
 * A subscription visit is priced by its plan, not Pricing Control, and is never held.
 */
export type GroomingLiveQuote =
  | { key: string; status: "resolved"; price: number }
  | { key: string; status: "failed" };

export type GroomingLivePriceState = { price: number; pending: boolean; failed: boolean };

export function groomingLivePriceState(input: {
  /** True when the visit draws on a subscription plan rather than a per-visit package. */
  isSubscription: boolean;
  /** The basket the screen is showing now, or "" when no live quote applies (no verified address). */
  currentKey: string;
  /** The most recent quote received, for whichever basket it was fetched. */
  quote: GroomingLiveQuote | null;
  /** The hardcoded catalogue bundle price for the current package and pet count. */
  fallbackPrice: number;
}): GroomingLivePriceState {
  if (input.isSubscription || !input.currentKey) return { price: input.fallbackPrice, pending: false, failed: false };
  const quote = input.quote;
  // A quote for a different basket is stale: never display or submit it.
  if (!quote || quote.key !== input.currentKey) return { price: input.fallbackPrice, pending: true, failed: false };
  if (quote.status === "resolved") return { price: quote.price, pending: false, failed: false };
  // The server has an answer we could not obtain. Showing the bundle price is honest as a display,
  // but booking on it could be refused, so Confirm stays held until a retry resolves.
  return { price: input.fallbackPrice, pending: true, failed: true };
}
