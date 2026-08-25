/**
 * Shared double-entry foundation for the wallet, revenue-recognition and cash-flow modules.
 *
 * The platform's books already post payroll/tax journals into finance_journal_entries. These three
 * new modules needed a small set of balance-sheet / control accounts (cash, customer wallet
 * liability, deferred revenue, advances, revenue, refunds, wallet-bonus expense) and one balanced,
 * idempotent posting helper so every module writes its journals the same way. Account codes follow
 * the existing "<code>-<name>" convention: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue,
 * 6xxx expenses.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

export const ACCT = {
  CASH: "1000-Cash in Hand",
  BANK: "1010-Bank",
  CREDITS_APPLIED: "1200-Customer Credits Applied",       // clearing: wallet value applied to a booking
  WALLET_LIABILITY: "2100-Customer Wallet Liability",     // store credit we owe the customer
  DEFERRED_REVENUE: "2200-Deferred Revenue",              // subscriptions billed, sessions not yet used
  ADVANCE_FROM_CUSTOMERS: "2210-Advance from Customers",  // advance bookings paid, service not yet used
  REVENUE: "4000-Service Revenue",
  REFUNDS: "4900-Refunds and Cancellations",              // contra-revenue
  WALLET_BONUS_EXPENSE: "6210-Customer Wallet Bonus",     // cost of the 10% wallet top-up incentive
} as const;

export const CASH_ACCOUNTS = new Set<string>([ACCT.CASH, ACCT.BANK]);

/** Cash-flow classification of a (non-cash) counterpart account. Everything defaults to operating. */
export function cashFlowSection(accountCode: string): "operating" | "investing" | "financing" {
  const prefix = accountCode.slice(0, 2);
  if (["15", "16", "17", "18"].includes(prefix)) return "investing"; // fixed assets / capex
  if (["25", "26"].includes(prefix)) return "financing";            // borrowings
  if (prefix.startsWith("3")) return "financing";                   // equity / capital
  return "operating";
}

export type JournalLine = { accountCode: string; debit?: number; credit?: number; costCentre?: string | null; vertical?: string | null };

export async function ensureFinanceJournalTable(db: Db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS finance_journal_entries (id text PRIMARY KEY NOT NULL,entry_date text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,account_code text NOT NULL,cost_centre text,vertical text,debit real DEFAULT 0 NOT NULL,credit real DEFAULT 0 NOT NULL,narration text NOT NULL,period_code text NOT NULL,posted integer DEFAULT 0 NOT NULL,created_at integer NOT NULL)").run();
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Post one balanced, idempotent journal. groupKey must be unique per business event; re-posting the
 * same groupKey is a no-op (duplicatePrevented). Debits must equal credits (within 0.01).
 */
export async function postJournal(db: Db, input: { groupKey: string; entryDate: string; periodCode: string; sourceType: string; sourceId: string; narration: string; lines: JournalLine[] }) {
  await ensureFinanceJournalTable(db);
  const lines = input.lines.filter(l => (Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0);
  if (!lines.length) throw new Error("A journal needs at least one non-zero line");
  const totalDebit = round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  if (Math.abs(totalDebit - totalCredit) > 0.01) throw new Error(`Journal is not balanced: debit ${totalDebit} != credit ${totalCredit}`);
  // A closed month is closed to the books as well. closeMonth writes finance_close_periods.status
  // ='locked', but nothing on the posting side ever read that row, so a manual journal dated into a
  // locked month posted cleanly and left the lock showing no sign it had been written into - which made
  // every figure published from a closed period provisional. The remedy is the one closeMonth's own
  // refusal already prescribes: post corrections in the next open period.
  //
  // The period is the month the entry is DATED in, not a label travelling alongside it; otherwise the
  // lock is walked round by renaming the period, exactly as the payroll lock was. All four callers
  // already derive periodCode from their own entryDate, so this binds an invariant they already keep.
  const datedPeriod = periodOf(String(input.entryDate));
  if (datedPeriod !== input.periodCode) throw new Error(`period_mismatch: this journal is dated ${datedPeriod}; it cannot be posted as ${input.periodCode}`);
  // A missing finance_close_periods table means no period has ever been closed, so there is nothing to
  // violate - but a row that says 'locked' is decisive.
  const period = await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(datedPeriod).first<Row>().catch(() => null);
  if (String(period?.status ?? "") === "locked") throw new Error(`period_locked: ${datedPeriod} is closed and locked; post corrections in the next open period`);
  const journalGroup = `JRN-${input.groupKey}`;
  // every group always writes its first line as `${journalGroup}-1`, so an exact hit means already posted
  const existing = await db.prepare("SELECT id FROM finance_journal_entries WHERE id=?").bind(`${journalGroup}-1`).first<Row>();
  if (existing) return { journalGroup, posted: false, duplicatePrevented: true };
  const now = Date.now();
  await db.batch(lines.map((l, i) => db.prepare("INSERT INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)")
    .bind(`${journalGroup}-${i + 1}`, input.entryDate, input.sourceType, input.sourceId, l.accountCode, l.costCentre ?? null, l.vertical ?? null, round2(Number(l.debit) || 0), round2(Number(l.credit) || 0), input.narration, input.periodCode, now)));
  return { journalGroup, posted: true, lines: lines.length };
}

export const periodOf = (isoDate: string) => isoDate.slice(0, 7);
export const round = round2;
