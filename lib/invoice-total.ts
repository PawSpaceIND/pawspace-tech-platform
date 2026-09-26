/**
 * The amount the customer is billed on an invoice row. The two invoice writers use the columns differently:
 * completion invoices store gross = order value (GST included) and net = value after GST, while the UAT
 * invoice stores net = amount payable (adding GST when it is exclusive). Either way the customer's total is
 * the larger of the two; showing "net" displayed a pre-GST figure (Rs 1,174 beside Rs 1,241 captured).
 */
export function invoiceTotal(row: { gross_amount?: unknown; net_amount?: unknown }) {
  const gross = Number(row.gross_amount || 0), net = Number(row.net_amount || 0);
  return Math.max(Number.isFinite(gross) ? gross : 0, Number.isFinite(net) ? net : 0);
}
