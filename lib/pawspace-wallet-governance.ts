/**
 * PawSpace Wallet - a customer-owned store-credit ledger.
 *
 * Manual staff credits use maker/checker governance before this ledger is touched. System-generated
 * refunds may still call creditWallet directly with their own deterministic idempotency key. Customer
 * redemptions remain customer-owned and never pass through the manual approval workflow.
 */

import { ACCT, postJournal, periodOf, round } from "./finance-accounts";
import { remainingPayableForCredit } from "./booking-credit-application";

type Db = D1Database;
type Row = Record<string, unknown>;
type CreditInput = { customerId: string; amount: number; source: string; sourceId?: string; idempotencyKey: string; note?: string; actorId: string };

type CreditRequestInput = Omit<CreditInput, "actorId"> & { requestedBy: string };

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const today = () => new Date().toISOString().slice(0, 10);
export const WALLET_BONUS_RATE = 0.10;
export const MANUAL_CREDIT_DUAL_CONTROL_THRESHOLD = 0; // every positive manual credit needs a checker
const CREDIT_SOURCES = ["refund", "cancellation", "goodwill"];
const MAX_CREDIT = 1_000_000;

function workflowError(message: string, status: number): never {
  throw Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

function canonicalCredit(input: CreditInput | CreditRequestInput) {
  const customerId = String(input.customerId || "").trim();
  const amount = round(Number(input.amount));
  const source = String(input.source || "").trim().toLowerCase();
  const sourceId = String(input.sourceId || "").trim() || null;
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  const note = String(input.note || "").trim() || null;
  if (!customerId) throw new Error("A customer is required");
  if (!CREDIT_SOURCES.includes(source)) throw new Error("Wallet credit source must be refund, cancellation or goodwill");
  if (!(amount > 0) || amount > MAX_CREDIT) throw new Error(`Credit amount must be between 0.01 and ${MAX_CREDIT}`);
  if (!idempotencyKey) throw new Error("An idempotency key is required");
  return { customerId, amount, source, sourceId, idempotencyKey, note };
}

async function hashPayload(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function sameNullable(a: unknown, b: string | null) {
  return (a == null || String(a) === "") ? b === null : String(a) === b;
}

function creditMatches(row: Row, input: ReturnType<typeof canonicalCredit>) {
  return String(row.customer_id) === input.customerId
    && round(Number(row.amount)) === input.amount
    && String(row.source_type) === input.source
    && sameNullable(row.source_id, input.sourceId)
    && sameNullable(row.note, input.note);
}

function requestView(row: Row) {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    amount: Number(row.amount),
    source: String(row.source_type),
    sourceId: row.source_id ? String(row.source_id) : null,
    note: row.note ? String(row.note) : null,
    status: String(row.status),
    requestedBy: String(row.requested_by),
    requestedAt: Number(row.requested_at),
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? Number(row.approved_at) : null,
    ledgerId: row.ledger_id ? String(row.ledger_id) : null,
    creditedAt: row.credited_at ? Number(row.credited_at) : null,
  };
}

export async function ensurePawspaceWalletTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS pawspace_wallet_accounts (customer_id TEXT PRIMARY KEY,balance REAL NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS pawspace_wallet_ledger (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,entry_type TEXT NOT NULL,amount REAL NOT NULL,bonus_amount REAL NOT NULL DEFAULT 0,applied_value REAL NOT NULL DEFAULT 0,source_type TEXT NOT NULL,source_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,note TEXT,balance_after REAL NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_wallet_ledger_customer ON pawspace_wallet_ledger(customer_id,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS pawspace_wallet_credit_requests (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,amount REAL NOT NULL,source_type TEXT NOT NULL,source_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,note TEXT,status TEXT NOT NULL DEFAULT 'pending',requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,approved_by TEXT,approved_at INTEGER,ledger_id TEXT,credited_at INTEGER,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_wallet_credit_requests_status ON pawspace_wallet_credit_requests(status,requested_at)"),
  ]);
}

export async function walletBalance(db: Db, customerId: string): Promise<number> {
  await ensurePawspaceWalletTables(db);
  const row = await db.prepare("SELECT balance FROM pawspace_wallet_accounts WHERE customer_id=?").bind(customerId).first<Row>();
  return round(Number(row?.balance || 0));
}

async function applyDelta(db: Db, customerId: string, delta: number) {
  const now = Date.now();
  await db.prepare("INSERT INTO pawspace_wallet_accounts (customer_id,balance,updated_at) VALUES (?,?,?) ON CONFLICT(customer_id) DO UPDATE SET balance=balance+?,updated_at=?")
    .bind(customerId, round(delta), now, round(delta), now).run();
  return walletBalance(db, customerId);
}

async function postCreditJournal(db: Db, input: { ledgerId: string; idempotencyKey: string; customerId: string; amount: number; source: string }) {
  return postJournal(db, {
    groupKey: `wallet-credit-${input.idempotencyKey}`,
    entryDate: today(),
    periodCode: periodOf(today()),
    sourceType: "wallet_credit",
    sourceId: input.ledgerId,
    narration: `Wallet credit (${input.source}) for ${input.customerId}`,
    lines: [
      { accountCode: ACCT.REFUNDS, debit: input.amount },
      { accountCode: ACCT.WALLET_LIABILITY, credit: input.amount },
    ],
  });
}

/** Direct/system credit primitive. Manual staff routes must request + approve instead. */
export async function creditWallet(db: Db, raw: CreditInput) {
  await ensurePawspaceWalletTables(db);
  const input = canonicalCredit(raw);
  const prior = await db.prepare("SELECT * FROM pawspace_wallet_ledger WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
  if (prior) {
    if (!creditMatches(prior, input)) workflowError("Wallet credit idempotency key is already bound to another payload", 409);
    await postCreditJournal(db, { ledgerId: String(prior.id), ...input });
    return { alreadyCredited: true, ledgerId: String(prior.id), amount: Number(prior.amount), balance: await walletBalance(db, input.customerId) };
  }

  const balance = await applyDelta(db, input.customerId, input.amount);
  const id = uid("WAL");
  try {
    await db.prepare("INSERT INTO pawspace_wallet_ledger (id,customer_id,entry_type,amount,bonus_amount,applied_value,source_type,source_id,idempotency_key,note,balance_after,actor_id,created_at) VALUES (?,?,'credit',?,0,0,?,?,?,?,?,?,?)")
      .bind(id, input.customerId, input.amount, input.source, input.sourceId, input.idempotencyKey, input.note, balance, raw.actorId, Date.now()).run();
  } catch (error) {
    await applyDelta(db, input.customerId, -input.amount);
    if (!(error instanceof Error && /UNIQUE/i.test(error.message))) throw error;
    const raced = await db.prepare("SELECT * FROM pawspace_wallet_ledger WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
    if (!raced || !creditMatches(raced, input)) workflowError("Wallet credit idempotency key is already bound to another payload", 409);
    await postCreditJournal(db, { ledgerId: String(raced.id), ...input });
    return { alreadyCredited: true, ledgerId: String(raced.id), amount: Number(raced.amount), balance: await walletBalance(db, input.customerId) };
  }

  await postCreditJournal(db, { ledgerId: id, ...input });
  return { alreadyCredited: false, ledgerId: id, amount: input.amount, balance };
}

/** Maker step: records a pending manual credit without changing wallet balance or finance journals. */
export async function requestWalletCredit(db: Db, raw: CreditRequestInput) {
  await ensurePawspaceWalletTables(db);
  const input = canonicalCredit(raw);
  const requestedBy = String(raw.requestedBy || "").trim().toLowerCase();
  if (!requestedBy) throw new Error("A requesting actor is required");
  if (!(input.amount > MANUAL_CREDIT_DUAL_CONTROL_THRESHOLD)) throw new Error("Manual wallet credit does not meet the configured approval threshold");
  const payloadHash = await hashPayload([input.customerId, input.amount, input.source, input.sourceId, input.note]);
  const id = uid("WCR");
  const now = Date.now();
  const inserted = await db.prepare("INSERT OR IGNORE INTO pawspace_wallet_credit_requests (id,customer_id,amount,source_type,source_id,idempotency_key,payload_hash,note,status,requested_by,requested_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)")
    .bind(id, input.customerId, input.amount, input.source, input.sourceId, input.idempotencyKey, payloadHash, input.note, requestedBy, now, now).run();
  const row = await db.prepare("SELECT * FROM pawspace_wallet_credit_requests WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
  if (!row) throw new Error("Unable to create wallet credit request");
  if (String(row.payload_hash) !== payloadHash) workflowError("Wallet credit request idempotency key is already bound to another payload", 409);
  return { ...requestView(row), alreadyRequested: !Number(inserted.meta?.changes || 0), requiresApproval: true, threshold: MANUAL_CREDIT_DUAL_CONTROL_THRESHOLD };
}

/** Checker step: a distinct finance actor approves; the deterministic credit is safe to retry. */
export async function approveWalletCreditRequest(db: Db, input: { requestId: string; approvedBy: string }) {
  await ensurePawspaceWalletTables(db);
  const requestId = String(input.requestId || "").trim();
  const approvedBy = String(input.approvedBy || "").trim().toLowerCase();
  if (!requestId || !approvedBy) throw new Error("A credit request and approving actor are required");
  let row = await db.prepare("SELECT * FROM pawspace_wallet_credit_requests WHERE id=?").bind(requestId).first<Row>();
  if (!row) workflowError("Wallet credit request not found", 404);
  if (String(row.requested_by).toLowerCase() === approvedBy) workflowError("Wallet credit requires approval by a distinct finance actor", 403);

  let newlyApproved = false;
  if (String(row.status) === "pending") {
    const now = Date.now();
    const claimed = await db.prepare("UPDATE pawspace_wallet_credit_requests SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE id=? AND status='pending' AND requested_by<>?")
      .bind(approvedBy, now, now, requestId, approvedBy).run();
    newlyApproved = Number(claimed.meta?.changes || 0) === 1;
    row = await db.prepare("SELECT * FROM pawspace_wallet_credit_requests WHERE id=?").bind(requestId).first<Row>();
  }
  if (!row || String(row.status) !== "approved") workflowError("Wallet credit request is not available for approval", 409);

  const credit = await creditWallet(db, {
    customerId: String(row.customer_id),
    amount: Number(row.amount),
    source: String(row.source_type),
    sourceId: row.source_id ? String(row.source_id) : undefined,
    idempotencyKey: `manual-wallet-credit:${requestId}`,
    note: row.note ? String(row.note) : undefined,
    actorId: String(row.approved_by || approvedBy),
  });
  const now = Date.now();
  await db.prepare("UPDATE pawspace_wallet_credit_requests SET ledger_id=COALESCE(ledger_id,?),credited_at=COALESCE(credited_at,?),updated_at=? WHERE id=? AND status='approved'")
    .bind(credit.ledgerId, now, now, requestId).run();
  const completed = await db.prepare("SELECT * FROM pawspace_wallet_credit_requests WHERE id=?").bind(requestId).first<Row>();
  return { ...requestView(completed || row), newlyApproved, alreadyApproved: !newlyApproved, credit };
}

export function quoteWalletRedemption(balance: number, bookingTotal: number) {
  const maxAppliedByBalance = round(balance * (1 + WALLET_BONUS_RATE));
  const appliedValue = round(Math.min(maxAppliedByBalance, bookingTotal));
  const walletUsed = round(appliedValue / (1 + WALLET_BONUS_RATE));
  const bonus = round(appliedValue - walletUsed);
  return { appliedValue, walletUsed, bonus };
}

export async function redeemWalletForBooking(db: Db, input: { customerId: string; bookingId: string; walletAmount?: number; actorId: string }) {
  await ensurePawspaceWalletTables(db);
  const customerId = String(input.customerId || "").trim();
  const bookingId = String(input.bookingId || "").trim();
  if (!customerId || !bookingId) throw new Error("A customer and booking are required");
  const booking = await db.prepare("SELECT customer_id,total_amount,service_code FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.customer_id) !== customerId) throw new Error("You can only spend wallet credit on your own booking");
  const idempotencyKey = `wallet-redeem:${bookingId}`;
  const prior = await db.prepare("SELECT * FROM pawspace_wallet_ledger WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) throw new Error("Wallet credit has already been applied to this booking");
  const balance = await walletBalance(db, customerId);
  if (!(balance > 0)) throw new Error("No wallet balance to redeem");
  const bookingTotal = round(Number(booking.total_amount || 0));
  if (!(bookingTotal > 0)) throw new Error("This booking has no payable amount");
  const requestedWallet = input.walletAmount != null ? round(Math.min(Number(input.walletAmount), balance)) : balance;
  if (!(requestedWallet > 0)) throw new Error("Wallet redemption amount must be positive");
  // Cap against what is still PAYABLE, not against the gross total. Both credit instruments used to
  // measure their own ceiling against canonical_bookings.total_amount and neither writes the booking
  // down, so wallet + points on one booking summed past the order value - Rs 6,000 of discount on a
  // Rs 5,000 booking, from two ordinary self-service calls.
  const payable = await remainingPayableForCredit(db, bookingId, bookingTotal);
  if (!(payable > 0)) throw new Error("This booking is already fully covered by credit you have applied");
  const q = quoteWalletRedemption(requestedWallet, payable);
  if (!(q.walletUsed > 0)) throw new Error("Wallet redemption amount must be positive");
  const now = Date.now();
  const debited = await db.prepare("UPDATE pawspace_wallet_accounts SET balance=balance-?,updated_at=? WHERE customer_id=? AND balance>=?").bind(q.walletUsed, now, customerId, q.walletUsed).run();
  if (!Number(debited.meta?.changes || 0)) throw new Error("Wallet balance is no longer sufficient for this redemption");
  const newBalance = await walletBalance(db, customerId);
  const id = uid("WAL");
  try {
    await db.prepare("INSERT INTO pawspace_wallet_ledger (id,customer_id,entry_type,amount,bonus_amount,applied_value,source_type,source_id,idempotency_key,note,balance_after,actor_id,created_at) VALUES (?,?,'redeem',?,?,?,'booking',?,?,?,?,?,?)")
      .bind(id, customerId, -q.walletUsed, q.bonus, q.appliedValue, bookingId, idempotencyKey, `Applied Rs.${q.appliedValue} (incl. Rs.${q.bonus} bonus) to booking`, newBalance, input.actorId, Date.now()).run();
  } catch (error) {
    if (!(error instanceof Error && /UNIQUE/i.test(error.message))) throw error;
    await applyDelta(db, customerId, q.walletUsed);
    throw new Error("Wallet credit has already been applied to this booking");
  }
  const vertical = booking.service_code ? String(booking.service_code) : null;
  await postJournal(db, { groupKey: `wallet-redeem-${bookingId}`, entryDate: today(), periodCode: periodOf(today()), sourceType: "wallet_redeem", sourceId: id, narration: `Wallet redeemed on booking ${bookingId}`, lines: [
    { accountCode: ACCT.WALLET_LIABILITY, debit: q.walletUsed, vertical },
    { accountCode: ACCT.WALLET_BONUS_EXPENSE, debit: q.bonus, vertical },
    { accountCode: ACCT.CREDITS_APPLIED, credit: q.appliedValue, vertical },
  ] });
  return { bookingId, walletUsed: q.walletUsed, bonus: q.bonus, appliedValue: q.appliedValue, balance: newBalance };
}

export async function walletHistory(db: Db, customerId: string) {
  await ensurePawspaceWalletTables(db);
  const rows = await db.prepare("SELECT id,entry_type,amount,bonus_amount,applied_value,source_type,source_id,note,balance_after,created_at FROM pawspace_wallet_ledger WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT 200").bind(customerId).all<Row>();
  return { balance: await walletBalance(db, customerId), bonusRate: WALLET_BONUS_RATE, history: rows.results.map((r: Row) => ({ id: String(r.id), entryType: String(r.entry_type), amount: Number(r.amount), bonus: Number(r.bonus_amount), appliedValue: Number(r.applied_value), source: String(r.source_type), sourceId: r.source_id ? String(r.source_id) : null, note: r.note ? String(r.note) : null, balanceAfter: Number(r.balance_after), createdAt: Number(r.created_at) })) };
}
