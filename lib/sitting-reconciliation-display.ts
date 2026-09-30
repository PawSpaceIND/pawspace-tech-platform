/** Presentation only: an absent pre-completion ledger is not a tax configuration diagnosis. */
export function sittingReconciliationLabel(bookingStatus: unknown, reconciliation: Record<string, unknown> | null | undefined): string {
  if (!reconciliation) return "Not reconciled yet";
  const label = (value: unknown) => String(value || "not configured").replaceAll("_", " ");
  const pendingCompletion = ["confirmed", "assigned", "awaiting_provider_acceptance", "in_service"].includes(String(bookingStatus));
  if (pendingCompletion && reconciliation.settlement_state === "not_due" && reconciliation.tax_state === "configuration_required") {
    const refund = label(reconciliation.refund_state);
    return `${reconciliation.refund_state === "attention_required" ? "Refund review required. " : ""}Settlement and tax reconciliation pending service completion · refund ${refund}. Tax configuration has not been assessed by this pre-completion record.`;
  }
  return `${label(reconciliation.status)} · refund ${label(reconciliation.refund_state)} · settlement ${label(reconciliation.settlement_state)} · tax ${label(reconciliation.tax_state)}`;
}
