import type { WalkingQuote } from "./walking-commercial-client";

/** Quote identity/expiry can refresh; reviewed prices and service terms need renewed consent. */
export function walkingQuoteNeedsReview(reviewed: WalkingQuote | null, fresh: WalkingQuote): boolean {
  if (!reviewed) return true;
  const terms = (quote: WalkingQuote) => [
    quote.packageCode, quote.packageName, quote.packageVersion, quote.durationMinutes,
    quote.mode, quote.petCount, quote.walkCount, [...quote.weekdays].sort((a, b) => a - b),
    quote.scheduledStart, quote.scheduledEnd, quote.perWalkAmount, quote.totalAmount,
    quote.amountDueNow, quote.paymentMode, quote.liveMoney,
  ];
  return JSON.stringify(terms(reviewed)) !== JSON.stringify(terms(fresh));
}
