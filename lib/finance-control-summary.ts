/**
 * Finance control-surface figures, computed from persisted rows.
 *
 * The staff Finance panel used to render 48 hardcoded rupee literals — "Net collections ₹42.14L",
 * "Output GST ₹7.27L", "TDS payable ₹72,840", a bank reconciliation showing "284 auto-matched ₹43.82L",
 * and a Ledger tab asserting "Dr ₹1,13,480 = Cr ₹1,13,480". None of it came from the database. A finance
 * reviewer signing off a UAT round was reading invented numbers, and the fabricated balanced ledger sat
 * exactly where the double-entry invariant is supposed to be demonstrated.
 *
 * This module follows the doctrine the repository already applies to the analytics and control-tower
 * surfaces: every figure is counted from a governance table, and anything without a canonical source
 * comes back null and is rendered as "Not connected" rather than a plausible number. A null here is a
 * deliberate, documented absence — see UNSOURCED_FINANCE_METRICS, which also names the surface that
 * does own each figure, so a reviewer knows where to go rather than being left with a blank.
 */

export type ExpenseRow = { amount: number; status: string };
export type BillRow = { total_amount: number; status: string };
export type JournalRow = { debit: number; credit: number };
export type BankRow = { amount: number; status?: string | null; match_type?: string | null };

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Expense/bill states that still await a human decision. */
const PENDING_EXPENSE = new Set(["submitted", "approval_due", "held"]);
const PENDING_BILL = new Set(["draft", "approval_due"]);

/**
 * Figures this endpoint genuinely cannot source, with the surface that owns each one. Rendering a
 * number for any of these would be inventing it; rendering nothing at all would just move the problem,
 * because a reviewer cannot tell "zero" from "not wired". So each carries its real owner.
 */
export const UNSOURCED_FINANCE_METRICS: Record<string, string> = {
  netCollections: "Customer collections live in booking_payments — see /api/payment-reconciliation",
  contribution: "No canonical contribution-margin source is connected",
  cashRunway: "No canonical cash-position source is connected",
  outputGst: "GST registers are owned by /api/gst-accounting",
  inputGst: "GST registers are owned by /api/gst-accounting",
  itcAtRisk: "GST registers are owned by /api/gst-accounting",
  tdsPayable: "TDS is owned by /api/gst-accounting",
  netStatutoryDue: "Statutory position is owned by /api/gst-accounting",
  providerPayable: "Provider payout rails are not connected (INT-PAY-02)",
  payrollPosting: "Payroll posting is not connected",
  employeeReimbursements: "Reimbursement settlement is not connected",
  settlementHolds: "Settlement holds are not connected",
};

export type FinanceControlSummary = {
  expenses: number;
  payables: number;
  pendingApprovals: number;
  ledger: { debit: number; credit: number; balanced: boolean; entries: number };
  bank: {
    imported: number;
    autoMatched: { count: number; amount: number };
    suggested: { count: number; amount: number };
    unmatched: { count: number; amount: number };
    duplicate: { count: number; amount: number };
  };
  unsourced: Record<string, null>;
};

/**
 * Count every figure the finance endpoint can actually stand behind.
 *
 * The ledger totals are the reason this is a function rather than a template: `balanced` is computed by
 * comparing summed debits against summed credits, so an unbalanced set of journal rows is REPORTED as
 * unbalanced. The panel previously hardcoded the equality, which meant the one invariant finance UAT
 * exists to check could never fail on screen.
 */
export function financeControlSummary(input: {
  expenses?: ExpenseRow[];
  bills?: BillRow[];
  journals?: JournalRow[];
  bank?: BankRow[];
}): FinanceControlSummary {
  const expenses = input.expenses ?? [];
  const bills = input.bills ?? [];
  const journals = input.journals ?? [];
  const bank = input.bank ?? [];

  const debit = journals.reduce((sum, row) => sum + num(row.debit), 0);
  const credit = journals.reduce((sum, row) => sum + num(row.credit), 0);

  const bucket = (predicate: (row: BankRow) => boolean) => {
    const rows = bank.filter(predicate);
    return { count: rows.length, amount: rows.reduce((sum, row) => sum + num(row.amount), 0) };
  };
  const state = (row: BankRow) => String(row.status ?? "").trim();

  return {
    expenses: expenses.reduce((sum, row) => sum + num(row.amount), 0),
    payables: bills.filter((row) => row.status !== "paid").reduce((sum, row) => sum + num(row.total_amount), 0),
    pendingApprovals:
      expenses.filter((row) => PENDING_EXPENSE.has(String(row.status))).length +
      bills.filter((row) => PENDING_BILL.has(String(row.status))).length,
    ledger: {
      debit,
      credit,
      // Rounded to paise before comparing: float addition over many rows should not report a balanced
      // book as broken, and nothing in this ledger is denominated finer than a paisa.
      balanced: Math.round(debit * 100) === Math.round(credit * 100),
      entries: journals.length,
    },
    bank: {
      imported: bank.length,
      autoMatched: bucket((row) => state(row) === "matched" || state(row) === "auto_matched"),
      suggested: bucket((row) => state(row) === "suggested"),
      unmatched: bucket((row) => state(row) === "unmatched" || state(row) === ""),
      duplicate: bucket((row) => state(row) === "duplicate" || state(row) === "reversal"),
    },
    unsourced: Object.fromEntries(Object.keys(UNSOURCED_FINANCE_METRICS).map((key) => [key, null])),
  };
}

/** The finance-relevant entries of the integration registry, by the code each is registered under. */
export const FINANCE_INTEGRATION_CODES = {
  paymentGateway: "INT-PAY-01",
  payoutRails: "INT-PAY-02",
  bankFeed: "INT-BANK-01",
  accountingExport: "INT-ACCT-01",
  gstFiling: "INT-TAX-01",
} as const;

/**
 * Only one readiness state means a live integration was actually exercised end to end. Everything else
 * is some flavour of not-yet, and must read as not-yet on a staff surface.
 */
export function integrationLabel(readinessState: unknown, credentialStatus?: unknown): string {
  const state = String(readinessState ?? "").trim();
  if (state === "controlled_live_verified") return "Live · verified";
  if (state === "not_applicable") return "Not applicable";
  if (state === "blocked") return "Blocked";
  const credential = String(credentialStatus ?? "").trim();
  const suffix = credential === "configured" ? " · credentials present, not verified live" : " · not connected";
  const readable = state ? state.replaceAll("_", " ") : "unknown";
  return `${readable}${suffix}`;
}

/**
 * Derive the finance source-status block from the persisted integration registry.
 *
 * This used to be a literal — `{bankFeed:"import-ready", ocr:"integration-ready", accountingExport:"Tally
 * / Zoho Books ready"}` — which claimed readiness the registry does not grant. INT-BANK-01, INT-ACCT-01
 * and INT-TAX-01 are all `production_setup_required`, and OCR had no registry entry at all, so its
 * "integration-ready" label was backed by nothing whatsoever. Reading the registry means the label can
 * never drift ahead of the recorded state, and an integration nobody registered reports as unregistered
 * rather than as ready.
 */
export function financeSourceStatus(
  items: Array<{ integrationCode?: unknown; code?: unknown; readinessState?: unknown; credentialStatus?: unknown }>,
): Record<string, string> {
  const byCode = new Map<string, { readinessState?: unknown; credentialStatus?: unknown }>();
  for (const item of items) {
    const code = String(item.integrationCode ?? item.code ?? "").trim();
    if (code) byCode.set(code, item);
  }
  const label = (code: string) => {
    const entry = byCode.get(code);
    if (!entry) return "Not registered — no readiness record exists";
    return integrationLabel(entry.readinessState, entry.credentialStatus);
  };
  return {
    paymentGateway: label(FINANCE_INTEGRATION_CODES.paymentGateway),
    payoutRails: label(FINANCE_INTEGRATION_CODES.payoutRails),
    bankFeed: label(FINANCE_INTEGRATION_CODES.bankFeed),
    accountingExport: label(FINANCE_INTEGRATION_CODES.accountingExport),
    gstFiling: label(FINANCE_INTEGRATION_CODES.gstFiling),
    // Issue #232 tracks live OCR/vendor-bill ingestion, but no integration is registered for it. Saying
    // so is the honest answer; the previous "integration-ready" was a claim with no record behind it.
    ocr: label("INT-OCR-01"),
  };
}
