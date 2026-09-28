export type RazorpayXDispatchSummary = {
  connected?: boolean; reconciliationRequired?: boolean; duplicatePrevented?: boolean;
  accounting?: {status: string; reason?: string | null};
};
export function razorpayXDispatchNeedsReview(result: RazorpayXDispatchSummary): boolean {
  return result.reconciliationRequired === true || Boolean(result.accounting &&
    !["awaiting_provider", "principal_settled"].includes(result.accounting.status));
}
/** One truthful notice for both Finance screens and the UAT one-click release. No provider diagnostics are echoed. */
export function razorpayXDispatchNotice(result: RazorpayXDispatchSummary | undefined) {
  if (!result?.connected) return {warning: true, message: "RazorpayX TEST dispatch is not confirmed. The original instruction is retained for review."};
  if (razorpayXDispatchNeedsReview(result)) return {warning: true, message: "RazorpayX TEST accepted the instruction, but accounting requires Finance review. Do not send another payout; recheck the original payout books."};
  return {warning: false, message: "RazorpayX TEST has the instruction. Check the provider status and payout books; dispatch is not proof of bank settlement."};
}
