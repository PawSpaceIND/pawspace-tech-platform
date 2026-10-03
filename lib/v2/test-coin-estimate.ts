import { representableTestCoinAmount, type TestCoinPolicy } from "./test-coin-policy";

export type TestCoinEstimateInput = {
  policy: TestCoinPolicy; eligibleAmount: number | null; actualPayable: number | null;
  spendableCoins: number; grantBalanceAdjustment: number; requestedCoins: number; currency: string;
  source?: string; bookingId?: string; blocked?: boolean;
  grants: { source_kind: string; source_id: string; remaining: number; expires_at: number | null }[];
};
/** Read-only quote. Service callers supply their authoritative post-offer amount and due-now.
 * No grant, reservation, financial discount or payment mutation is performed here. */
export function testCoinEstimate(input: TestCoinEstimateInput, now = Date.now()) {
  const { policy } = input;
  // An amount outside safe paise precision is treated as unknown: no estimate is shown and nothing is redeemable.
  const amountKnown = input.currency === "INR" && representableTestCoinAmount(input.eligibleAmount);
  const payableKnown = input.currency === "INR" && representableTestCoinAmount(input.actualPayable);
  const estimatedCoins = policy.enabled && amountKnown ? Math.floor(input.eligibleAmount! * policy.earnPercent / 100) : null;
  const activeGrants = input.grants.filter(g => g.remaining > 0 && g.expires_at !== null && g.expires_at > now);
  const activeOtherGrants = activeGrants.filter(g =>
    !(input.source === g.source_kind && input.bookingId === g.source_id));
  // A positive balance can still include reversal debt against remaining grant principal.
  // Preserve that expiry-independent adjustment as lots expire while the quote is open.
  const activePrincipal = activeGrants.reduce((n, g) => n + g.remaining, 0);
  const adjustedAvailable = Number.isFinite(input.grantBalanceAdjustment) ? Math.max(0, activePrincipal + input.grantBalanceAdjustment) : 0;
  const availableCoins = policy.enabled ? Math.max(0, Math.floor(Math.min(input.spendableCoins, adjustedAvailable, activeOtherGrants.reduce((n, g) => n + g.remaining, 0)))) : 0;
  const validRequest = Number.isSafeInteger(input.requestedCoins) && input.requestedCoins >= 0;
  const maximumCoins = policy.enabled && payableKnown && !input.blocked ? Math.min(availableCoins, Math.floor(input.actualPayable! / policy.previewRupeesPerCoin)) : 0;
  const requestEligible = validRequest && input.requestedCoins <= maximumCoins;
  const simulatedDiscount = requestEligible && payableKnown ? Math.min(input.actualPayable!, Math.round(input.requestedCoins * policy.previewRupeesPerCoin * 100) / 100) : 0;
  return { enabled: policy.enabled, estimatedCoins, earningConfigured: policy.enabled && policy.expirySeconds !== null,
    availableCoins, maximumCoins, requestEligible, simulatedDiscount,
    simulatedPayable: payableKnown ? Math.max(0, input.actualPayable! - simulatedDiscount) : null,
    actualPayable: input.actualPayable, expirySeconds: policy.enabled ? policy.expirySeconds : null,
    nextExpiry: activeOtherGrants.length ? Math.min(...activeOtherGrants.map(g => g.expires_at!)) : null };
}
