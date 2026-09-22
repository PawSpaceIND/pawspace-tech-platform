/**
 * Decides which Grooming package price the customer screen may quote, and whether that price is
 * still settling.
 *
 * The checkout used to inline this as `livePrice!=null?livePrice:bundle(...)`, which silently fell
 * back to the hardcoded catalogue bundle whenever the live quote was in flight. The server resolves
 * the live Pricing Control price unconditionally, so a booking confirmed inside that window is
 * submitted at the fallback price and refused with "Submitted Grooming total does not match
 * governed catalogue". Returning `pending` lets the screen hold Confirm instead of quoting a price
 * the server will not honour.
 *
 * A subscription price is governed by the plan rather than Pricing Control, so it is never pending.
 */
export type GroomingLivePriceState = { price: number; pending: boolean };

export function groomingLivePriceState(input: {
  /** True when the visit is drawing on a subscription plan rather than a per-visit package. */
  isSubscription: boolean;
  /** The resolved live Pricing Control price, or null while the quote is in flight or unavailable. */
  livePrice: number | null;
  /** The hardcoded catalogue bundle price for this package and pet count. */
  fallbackPrice: number;
  /** False once the live quote has settled, whether it resolved or failed. */
  liveQuoteInFlight: boolean;
}): GroomingLivePriceState {
  if (input.isSubscription) return { price: input.fallbackPrice, pending: false };
  if (input.livePrice != null) return { price: input.livePrice, pending: false };
  // No live price yet. The bundle price is the honest thing to display, but it is only safe to book
  // on once the quote has actually settled — a failed quote means Pricing Control has no active row,
  // and the server will fall back to the same bundle price.
  return { price: input.fallbackPrice, pending: input.liveQuoteInFlight };
}
