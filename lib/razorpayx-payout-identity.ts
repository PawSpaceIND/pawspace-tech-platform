type Row = Record<string, unknown>;
export type RazorpayXPayoutIdentity = {
  localPayoutId: string; fundAccountId: string; amountPaise: number; currency: string;
  providerPayoutId?: string | null;
};
const text = (value: unknown) => String(value ?? "").trim();
export const razorpayXPayoutReference = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40);
/** Same immutable identity check for salary and partner receipts; never expose beneficiary values in errors. */
export function razorpayXPayoutIdentityProblem(payout: Row, expected: RazorpayXPayoutIdentity): string | null {
  if (!/^pout_[A-Za-z0-9]+$/.test(text(payout.id)) ||
      (expected.providerPayoutId && text(payout.id) !== expected.providerPayoutId) ||
      text(payout.reference_id) !== razorpayXPayoutReference(expected.localPayoutId) ||
      !expected.fundAccountId || text(payout.fund_account_id) !== expected.fundAccountId ||
      !Number.isSafeInteger(payout.amount) || payout.amount !== expected.amountPaise ||
      expected.currency !== "INR" || text(payout.currency) !== expected.currency)
    return "RazorpayX payout identity, amount, beneficiary or currency mismatch";
  return null;
}
