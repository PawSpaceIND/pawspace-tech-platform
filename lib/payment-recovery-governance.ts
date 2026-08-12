/**
 * Customer-bound ₹300 payment-recovery entitlement. When a customer starts a booking but the payment
 * does not succeed (abandoned/failed), ONLY that customer becomes eligible for a one-time ₹300 flat
 * recovery offer to complete the booking. This is an entitlement (Customer + Booking + payment-not-done
 * → ₹300), not a public code anyone can use.
 *
 * Rules: one use, short expiry (default 7 days), non-transferable (locked to the issuing customer), no
 * stacking (at most one active entitlement per customer), and automatic cancellation the moment the
 * original payment subsequently succeeds. Cold-DB safe; every write is idempotent.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const empty = () => ({ results: [] as Row[] });
export const RECOVERY_AMOUNT = 300;
const DEFAULT_EXPIRY_DAYS = 7;

export async function ensurePaymentRecoveryTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS payment_recovery_entitlements (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,booking_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'active',issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,redeemed_at INTEGER,redeemed_booking_id TEXT,cancelled_at INTEGER,cancel_reason TEXT,updated_at INTEGER NOT NULL,UNIQUE(customer_id,booking_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_recovery_customer ON payment_recovery_entitlements(customer_id,status)"),
  ]);
}

const shape = (r: Row) => ({ id: String(r.id), customerId: String(r.customer_id), bookingId: String(r.booking_id), amount: Number(r.amount), status: String(r.status), issuedAt: Number(r.issued_at), expiresAt: Number(r.expires_at), redeemedBookingId: r.redeemed_booking_id ? String(r.redeemed_booking_id) : null });

/** Issue the ₹300 entitlement for a payment-not-done booking. Idempotent per (customer,booking); refuses
 * to stack a second active entitlement on the same customer. */
export async function issueRecoveryEntitlement(db: Db, input: { customerId: string; bookingId: string; amount?: number; expiryDays?: number; at?: number }) {
  await ensurePaymentRecoveryTables(db);
  const customerId = String(input.customerId || "").trim(), bookingId = String(input.bookingId || "").trim();
  if (!customerId || !bookingId) throw new Error("customerId and bookingId are required");
  const at = input.at ?? Date.now(), amount = Number(input.amount) || RECOVERY_AMOUNT, expiresAt = at + Math.max(1, Number(input.expiryDays) || DEFAULT_EXPIRY_DAYS) * DAY;
  const prior = await db.prepare("SELECT * FROM payment_recovery_entitlements WHERE customer_id=? AND booking_id=?").bind(customerId, bookingId).first<Row>().catch(() => null);
  if (prior) return { duplicatePrevented: true, entitlement: shape(prior) };
  // no stacking: if the customer already has any active, non-expired entitlement, don't issue another
  const activeElsewhere = await db.prepare("SELECT id FROM payment_recovery_entitlements WHERE customer_id=? AND status='active' AND expires_at>?").bind(customerId, at).first<Row>().catch(() => null);
  if (activeElsewhere) return { duplicatePrevented: true, reason: "customer_already_has_active_entitlement", entitlementId: String(activeElsewhere.id) };
  const id = uid("PRE");
  await db.prepare("INSERT INTO payment_recovery_entitlements (id,customer_id,booking_id,amount,status,issued_at,expires_at,updated_at) VALUES (?,?,?,?, 'active',?,?,?)").bind(id, customerId, bookingId, amount, at, expiresAt, at).run();
  const row = await db.prepare("SELECT * FROM payment_recovery_entitlements WHERE id=?").bind(id).first<Row>();
  return { duplicatePrevented: false, entitlement: shape(row!) };
}

/** Auto-cancel active entitlements for a customer once their payment succeeds (no ₹300 after paying). */
export async function cancelRecoveryEntitlements(db: Db, input: { customerId: string; bookingId?: string; reason?: string; at?: number }) {
  await ensurePaymentRecoveryTables(db);
  const at = input.at ?? Date.now(), reason = String(input.reason || "payment_succeeded");
  const res = await db.prepare("UPDATE payment_recovery_entitlements SET status='cancelled',cancelled_at=?,cancel_reason=?,updated_at=? WHERE customer_id=? AND status='active'").bind(at, reason, at, String(input.customerId)).run().catch(() => ({ meta: { changes: 0 } }));
  return { cancelled: Number(res.meta?.changes || 0) };
}

/** Redeem the entitlement against a new booking. Enforces active + not expired + non-transferable. */
export async function redeemRecoveryEntitlement(db: Db, input: { customerId: string; entitlementId?: string; redeemedBookingId: string; at?: number }) {
  await ensurePaymentRecoveryTables(db);
  const at = input.at ?? Date.now(), customerId = String(input.customerId || "").trim();
  const row = input.entitlementId
    ? await db.prepare("SELECT * FROM payment_recovery_entitlements WHERE id=?").bind(input.entitlementId).first<Row>().catch(() => null)
    : await db.prepare("SELECT * FROM payment_recovery_entitlements WHERE customer_id=? AND status='active' AND expires_at>? ORDER BY issued_at DESC LIMIT 1").bind(customerId, at).first<Row>().catch(() => null);
  if (!row) throw new Error("No redeemable recovery entitlement found");
  if (String(row.customer_id) !== customerId) throw new Error("Recovery entitlement is non-transferable (belongs to another customer)");
  if (String(row.status) !== "active") throw new Error(`Recovery entitlement is ${String(row.status)}, not redeemable`);
  if (Number(row.expires_at) <= at) throw new Error("Recovery entitlement has expired");
  const res = await db.prepare("UPDATE payment_recovery_entitlements SET status='redeemed',redeemed_at=?,redeemed_booking_id=?,updated_at=? WHERE id=? AND status='active'").bind(at, String(input.redeemedBookingId), at, String(row.id)).run();
  if (Number(res.meta?.changes || 0) === 0) throw new Error("Recovery entitlement could not be redeemed (already used)");
  return { entitlementId: String(row.id), amount: Number(row.amount), redeemedBookingId: String(input.redeemedBookingId) };
}

/** The active, non-expired entitlement for a customer (what the app applies at checkout), if any. */
export async function activeRecoveryForCustomer(db: Db, input: { customerId: string; at?: number }) {
  await ensurePaymentRecoveryTables(db);
  const at = input.at ?? Date.now();
  const row = await db.prepare("SELECT * FROM payment_recovery_entitlements WHERE customer_id=? AND status='active' AND expires_at>? ORDER BY issued_at DESC LIMIT 1").bind(String(input.customerId), at).first<Row>().catch(() => null);
  return row ? shape(row) : null;
}

/** Expire active entitlements past their window. Cold-DB safe. */
export async function runRecoveryExpirySweep(db: Db, input: { asOf?: number } = {}) {
  await ensurePaymentRecoveryTables(db).catch(() => {});
  const at = input.asOf ?? Date.now();
  const res = await db.prepare("UPDATE payment_recovery_entitlements SET status='expired',updated_at=? WHERE status='active' AND expires_at<=?").bind(at, at).run().catch(() => ({ meta: { changes: 0 } }));
  return { expired: Number(res.meta?.changes || 0) };
}

/** Payment-recovery report: issued, redeemed, expired, cancelled, recovered bookings + revenue. */
export async function paymentRecoveryReport(db: Db) {
  await ensurePaymentRecoveryTables(db);
  const rows = await db.prepare("SELECT status,COUNT(*) c,SUM(amount) amt FROM payment_recovery_entitlements GROUP BY status").all<Row>().catch(empty);
  const by: Record<string, { count: number; amount: number }> = {};
  for (const r of rows.results) by[String(r.status)] = { count: Number(r.c), amount: Number(r.amt || 0) };
  const recovered = await db.prepare("SELECT COUNT(*) c,SUM(amount) amt FROM payment_recovery_entitlements WHERE status='redeemed'").first<Row>().catch(() => null);
  const totalIssued = Object.values(by).reduce((s, v) => s + v.count, 0);
  const redeemed = by.redeemed?.count || 0;
  return { issued: totalIssued, active: by.active?.count || 0, redeemed, expired: by.expired?.count || 0, cancelled: by.cancelled?.count || 0, recoveredBookings: Number(recovered?.c || 0), recoveredDiscountValue: Number(recovered?.amt || 0), redemptionRate: totalIssued ? Math.round((redeemed / totalIssued) * 1000) / 10 : 0 };
}
