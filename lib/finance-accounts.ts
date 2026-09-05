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
  /*
   * The two accounts the approved collection rules name. [PTJA-W2-B2-R04]
   *
   * Gateway clearing is deliberately NOT a cash account: money a gateway has captured is not money in the
   * bank, and the approved rules post a separate settlement entry to move it. That distinction is the
   * whole reason the cash-flow statement can now tell "collected" from "in the bank" - it previously had
   * nothing at all to draw it from.
   */
  GATEWAY_CLEARING: "1020-Payment Gateway Clearing",      // captured by the gateway, not yet settled
  CUSTOMER_COLLECTIONS: "2230-Customer Collections",      // control: money taken from customers
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

/**
 * The identity every collection entry must retain, per the approved rules: booking and customer, city and
 * service, payment and settlement references, tax and gateway fee separately from the amount, the payment
 * method, the transaction timestamp, the collector for cash, and the reversal reference for a refund.
 *
 * Real columns rather than a JSON blob, because finance queries these - "which rider still owes us cash
 * for August" is a WHERE clause, not a string search. All additive and nullable, so every existing row
 * and every existing caller is unaffected. [PTJA-W2-B2-R04]
 */
const COLLECTION_COLUMNS: Array<[string, string]> = [
  ["booking_id", "text"], ["customer_id", "text"], ["city_id", "text"], ["service_code", "text"],
  ["payment_id", "text"], ["settlement_id", "text"], ["payment_method", "text"],
  ["tax_amount", "real"], ["gateway_fee", "real"], ["collector_id", "text"],
  ["reversal_reference", "text"], ["transaction_at", "integer"],
  ["verification_status", "text"], ["verified_by", "text"], ["verified_at", "integer"],
];

const FINANCE_JOURNAL_BASE_COLUMNS=["id","entry_date","source_type","source_id","account_code","debit","credit","narration","period_code","posted","created_at"] as const;
const financeJournalReady=new WeakSet<Db>();
const financeJournalEnsuring=new WeakMap<Db,Promise<void>>();

async function financeJournalSchemaReady(db:Db){
  try{
    const info=await db.prepare("PRAGMA table_info(finance_journal_entries)").all<Row>();
    const names=new Set(info.results.map(row=>String(row.name??"")));
    if(!names.size)return false;
    return FINANCE_JOURNAL_BASE_COLUMNS.every(column=>names.has(column))&&COLLECTION_COLUMNS.every(([column])=>names.has(column));
  }catch{return false;}
}

async function ensureFinanceJournalTableUncached(db:Db){
  // Steady-state requests must not replay schema writes. Under 100-way booking concurrency the old
  // CREATE + fourteen ALTER attempts serialized D1 even though every column already existed, and
  // postCollectionEvent called this path twice per request. A single read-only PRAGMA proves the
  // deployed schema is complete; DDL is reserved for an actually missing/old schema.
  if(await financeJournalSchemaReady(db))return;
  await db.prepare("CREATE TABLE IF NOT EXISTS finance_journal_entries (id text PRIMARY KEY NOT NULL,entry_date text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,account_code text NOT NULL,cost_centre text,vertical text,debit real DEFAULT 0 NOT NULL,credit real DEFAULT 0 NOT NULL,narration text NOT NULL,period_code text NOT NULL,posted integer DEFAULT 0 NOT NULL,created_at integer NOT NULL)").run();
  for (const [column, type] of COLLECTION_COLUMNS) {
    await db.prepare(`ALTER TABLE finance_journal_entries ADD COLUMN ${column} ${type}`).run()
      .catch((error: unknown) => { if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error; });
  }
}

export async function ensureFinanceJournalTable(db:Db){
  if(financeJournalReady.has(db))return;
  const inFlight=financeJournalEnsuring.get(db);
  if(inFlight)return inFlight;
  const work=ensureFinanceJournalTableUncached(db)
    .then(()=>{financeJournalReady.add(db);})
    .finally(()=>{financeJournalEnsuring.delete(db);});
  financeJournalEnsuring.set(db,work);
  return work;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Post one balanced, idempotent journal. groupKey must be unique per business event; re-posting the
 * same groupKey is a no-op (duplicatePrevented). Debits must equal credits (within 0.01).
 */
export type JournalMetadata = Partial<Record<"bookingId"|"customerId"|"cityId"|"serviceCode"|"paymentId"|"settlementId"|"paymentMethod"|"collectorId"|"reversalReference"|"verificationStatus", string|null>> & Partial<Record<"taxAmount"|"gatewayFee"|"transactionAt", number|null>>;

export async function postJournal(db: Db, input: { groupKey: string; entryDate: string; periodCode: string; sourceType: string; sourceId: string; narration: string; lines: JournalLine[]; metadata?: JournalMetadata }) {
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
  const journalGroup = `JRN-${input.groupKey}`;
  const[period,existing]=await Promise.all([
    db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(datedPeriod).first<Row>().catch(() => null),
    db.prepare("SELECT id FROM finance_journal_entries WHERE id=?").bind(`${journalGroup}-1`).first<Row>(),
  ]);
  if (String(period?.status ?? "") === "locked") throw new Error(`period_locked: ${datedPeriod} is closed and locked; post corrections in the next open period`);
  // every group always writes its first line as `${journalGroup}-1`, so an exact hit means already posted
  if (existing) return { journalGroup, posted: false, duplicatePrevented: true };
  const now = Date.now();
  const meta = input.metadata ?? {};
  // The read above is a fast replay path, not the concurrency boundary. Two checkers can both observe
  // no row before either writes, so the insert itself must be idempotent. D1 batches serialize the
  // complete journal; INSERT OR IGNORE makes the losing batch a clean duplicate instead of surfacing a
  // UNIQUE violation from finance_journal_entries.id.
  const results=await db.batch(lines.map((l, i) => db.prepare("INSERT OR IGNORE INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at,booking_id,customer_id,city_id,service_code,payment_id,settlement_id,payment_method,tax_amount,gateway_fee,collector_id,reversal_reference,transaction_at,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(`${journalGroup}-${i + 1}`, input.entryDate, input.sourceType, input.sourceId, l.accountCode, l.costCentre ?? null, l.vertical ?? null, round2(Number(l.debit) || 0), round2(Number(l.credit) || 0), input.narration, input.periodCode, now,
      meta.bookingId ?? null, meta.customerId ?? null, meta.cityId ?? null, meta.serviceCode ?? null, meta.paymentId ?? null, meta.settlementId ?? null, meta.paymentMethod ?? null,
      meta.taxAmount ?? null, meta.gatewayFee ?? null, meta.collectorId ?? null, meta.reversalReference ?? null, meta.transactionAt ?? null, meta.verificationStatus ?? null)));
  if(Number(results[0]?.meta?.changes||0)===0)return { journalGroup, posted: false, duplicatePrevented: true };
  return { journalGroup, posted: true, lines: lines.length };
}

export const periodOf = (isoDate: string) => isoDate.slice(0, 7);
export const round = round2;
