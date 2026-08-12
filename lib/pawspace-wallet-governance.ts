/**
 * PawSpace Wallet - a customer-owned store-credit ledger.
 *
 * Credit goes into the wallet from refunds, cancellations and goodwill instead of (or alongside) a
 * cash refund. When the customer later spends wallet credit on a booking they get 10% ENHANCED
 * value: every Rs.100 of wallet becomes Rs.110 of booking value. The 10% top-up is a marketing
 * incentive (wallet-bonus expense); it never inflates the customer's cash balance, only their
 * purchasing power at redemption.
 *
 * Accounting (all via finance-accounts.postJournal, balanced + idempotent):
 *   credit:  Dr Refunds and Cancellations   Cr Customer Wallet Liability          (non-cash)
 *   redeem:  Dr Customer Wallet Liability + Dr Wallet Bonus Expense
 *            Cr Customer Credits Applied (= walletUsed x 1.10)                     (non-cash)
 * Neither touches a cash account, so wallet activity never distorts the cash-flow statement.
 */

import { ACCT, postJournal, periodOf, round } from "./finance-accounts";

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const today = () => new Date().toISOString().slice(0, 10);
export const WALLET_BONUS_RATE = 0.10; // 10% enhanced value on redemption
const CREDIT_SOURCES = ["refund", "cancellation", "goodwill"];
const MAX_CREDIT = 1_000_000; // guard-rail on a single credit

export async function ensurePawspaceWalletTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS pawspace_wallet_accounts (customer_id TEXT PRIMARY KEY,balance REAL NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS pawspace_wallet_ledger (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,entry_type TEXT NOT NULL,amount REAL NOT NULL,bonus_amount REAL NOT NULL DEFAULT 0,applied_value REAL NOT NULL DEFAULT 0,source_type TEXT NOT NULL,source_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,note TEXT,balance_after REAL NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_wallet_ledger_customer ON pawspace_wallet_ledger(customer_id,created_at)"),
  ]);
}

export async function walletBalance(db: Db, customerId: string): Promise<number> {
  await ensurePawspaceWalletTables(db);
  const row = await db.prepare("SELECT balance FROM pawspace_wallet_accounts WHERE customer_id=?").bind(customerId).first<Row>();
  return round(Number(row?.balance || 0));
}

async function applyDelta(db: Db, customerId: string, delta: number) {
  const now = Date.now();
  await db.prepare("INSERT INTO pawspace_wallet_accounts (customer_id,balance,updated_at) VALUES (?,?,?) ON CONFLICT(customer_id) DO UPDATE SET balance=balance+?,updated_at=?").bind(customerId, round(delta), now, round(delta), now).run();
  return walletBalance(db, customerId);
}

/** Credit store credit into a customer's wallet (from a refund / cancellation / goodwill). Idempotent. */
export async function creditWallet(db: Db, input: { customerId: string; amount: number; source: string; sourceId?: string; idempotencyKey: string; note?: string; actorId: string }) {
  await ensurePawspaceWalletTables(db);
  const customerId = String(input.customerId || "").trim();
  const amount = round(Number(input.amount));
  const source = String(input.source || "").toLowerCase();
  if (!customerId) throw new Error("A customer is required");
  if (!CREDIT_SOURCES.includes(source)) throw new Error("Wallet credit source must be refund, cancellation or goodwill");
  if (!(amount > 0) || amount > MAX_CREDIT) throw new Error(`Credit amount must be between 1 and ${MAX_CREDIT}`);
  if (!input.idempotencyKey) throw new Error("An idempotency key is required");
  const prior = await db.prepare("SELECT * FROM pawspace_wallet_ledger WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
  if (prior) return { alreadyCredited: true, ledgerId: String(prior.id), amount: Number(prior.amount), balance: await walletBalance(db, customerId) };
  const balance = await applyDelta(db, customerId, amount);
  const id = uid("WAL");
  await db.prepare("INSERT INTO pawspace_wallet_ledger (id,customer_id,entry_type,amount,bonus_amount,applied_value,source_type,source_id,idempotency_key,note,balance_after,actor_id,created_at) VALUES (?,?,'credit',?,0,0,?,?,?,?,?,?,?)")
    .bind(id, customerId, amount, source, input.sourceId || null, input.idempotencyKey, input.note || null, balance, input.actorId, Date.now()).run();
  await postJournal(db, { groupKey: `wallet-credit-${input.idempotencyKey}`, entryDate: today(), periodCode: periodOf(today()), sourceType: "wallet_credit", sourceId: id, narration: `Wallet credit (${source}) for ${customerId}`, lines: [
    { accountCode: ACCT.REFUNDS, debit: amount },
    { accountCode: ACCT.WALLET_LIABILITY, credit: amount },
  ] });
  return { alreadyCredited: false, ledgerId: id, amount, balance };
}

/**
 * Preview how much booking value a customer's wallet can fund for a given booking total, honouring
 * the 10% enhancement and never over-applying beyond the booking total.
 */
export function quoteWalletRedemption(balance: number, bookingTotal: number) {
  const maxAppliedByBalance = round(balance * (1 + WALLET_BONUS_RATE));
  const appliedValue = round(Math.min(maxAppliedByBalance, bookingTotal));
  const walletUsed = round(appliedValue / (1 + WALLET_BONUS_RATE));
  const bonus = round(appliedValue - walletUsed);
  return { appliedValue, walletUsed, bonus };
}

/**
 * Redeem wallet credit against a real customer-owned booking, at 10% enhanced value. One redemption
 * per booking. Returns the value applied to the booking (wallet used + 10% bonus).
 */
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
  // customer may cap how much wallet to spend; default is as much as helps this booking
  const requestedWallet = input.walletAmount != null ? round(Math.min(Number(input.walletAmount), balance)) : balance;
  if (!(requestedWallet > 0)) throw new Error("Wallet redemption amount must be positive");
  const q = quoteWalletRedemption(requestedWallet, bookingTotal);
  if (!(q.walletUsed > 0)) throw new Error("Wallet redemption amount must be positive");
  const newBalance = await applyDelta(db, customerId, -q.walletUsed);
  const id = uid("WAL");
  await db.prepare("INSERT INTO pawspace_wallet_ledger (id,customer_id,entry_type,amount,bonus_amount,applied_value,source_type,source_id,idempotency_key,note,balance_after,actor_id,created_at) VALUES (?,?,'redeem',?,?,?,'booking',?,?,?,?,?,?)")
    .bind(id, customerId, -q.walletUsed, q.bonus, q.appliedValue, bookingId, idempotencyKey, `Applied Rs.${q.appliedValue} (incl. Rs.${q.bonus} bonus) to booking`, newBalance, input.actorId, Date.now()).run();
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
