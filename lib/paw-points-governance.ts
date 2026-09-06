/**
 * PawPoints - a real, auditable loyalty ledger for retention, goodwill and win-back.
 *
 * - Earn: a completed booking earns points (1 point per Rs.10 spent), awarded idempotently by a
 *   sweep so no vertical's completion code needs changing and a booking is never double-credited.
 * - Redeem: points convert to a real discount on a real customer-owned booking (Rs.0.50/point),
 *   capped at 20% of the booking so margin is protected; one redemption per booking.
 * - Goodwill: staff can grant bonus points (e.g. after a service complaint) with a reason.
 * - Win-back: a targeted, once-per-campaign grant to bring a lapsed customer back.
 *
 * Everything is an append-only ledger row (credit = positive, debit = negative); the balance is the
 * live SUM, so it is fully auditable and can never silently drift. Idempotency keys make every
 * earn / redeem / grant safe to retry.
 */

import { remainingPayableForCredit } from "./booking-credit-application";

type Db = D1Database;
type Row = Record<string, unknown>;

export const EARN_POINTS_PER_RUPEE = 0.1;      // 1 point per Rs.10 spent
export const REDEEM_RUPEE_PER_POINT = 0.5;     // 1 point = Rs.0.50 off
export const MAX_REDEEM_FRACTION = 0.2;        // a redemption can cover at most 20% of a booking
const MAX_GRANT_POINTS = 5000;                 // guard-rail on a single staff/win-back grant
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

export async function ensurePawPointsTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS paw_points_ledger (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,entry_type TEXT NOT NULL,points INTEGER NOT NULL,reason TEXT,source_type TEXT,booking_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paw_points_customer ON paw_points_ledger(customer_id)"),
  ]);
}

export async function pawPointsBalance(db: Db, customerId: string) {
  await ensurePawPointsTables(db);
  const row = await db.prepare("SELECT COALESCE(SUM(points),0) balance FROM paw_points_ledger WHERE customer_id=?").bind(customerId).first<Row>();
  return Number(row?.balance || 0);
}

async function post(db: Db, entry: { customerId: string; entryType: string; points: number; reason?: string | null; sourceType?: string; bookingId?: string | null; idempotencyKey: string; createdBy: string }) {
  const existing = await db.prepare("SELECT id,points FROM paw_points_ledger WHERE idempotency_key=?").bind(entry.idempotencyKey).first<Row>();
  if (existing) return { id: String(existing.id), points: Number(existing.points), duplicatePrevented: true };
  const id = uid("PP");
  await db.prepare("INSERT INTO paw_points_ledger (id,customer_id,entry_type,points,reason,source_type,booking_id,idempotency_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, entry.customerId, entry.entryType, Math.round(entry.points), entry.reason ?? null, entry.sourceType ?? null, entry.bookingId ?? null, entry.idempotencyKey, entry.createdBy, Date.now()).run();
  return { id, points: Math.round(entry.points), duplicatePrevented: false };
}

/** Award earn-points for a single completed booking (idempotent per booking). */
export async function earnPointsForBooking(db: Db, input: { bookingId: string; actorId?: string }) {
  await ensurePawPointsTables(db);
  const booking = await db.prepare("SELECT id,customer_id,total_amount,status FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.status) !== "completed") throw new Error("Points are earned only on completed bookings");
  const points = Math.floor(Number(booking.total_amount || 0) * EARN_POINTS_PER_RUPEE);
  if (points <= 0) return { bookingId: input.bookingId, pointsEarned: 0 };
  const result = await post(db, { customerId: String(booking.customer_id), entryType: "earned", points, reason: "Completed booking", sourceType: "booking", bookingId: input.bookingId, idempotencyKey: `earn:booking:${input.bookingId}`, createdBy: input.actorId || "system:paw-points" });
  return { bookingId: input.bookingId, pointsEarned: result.duplicatePrevented ? 0 : result.points, alreadyCredited: result.duplicatePrevented };
}

/** Sweep: credit earn-points for every completed booking not yet credited. Idempotent, cold-DB safe. */
export async function runPawPointsEarnSweep(db: Db, input: { limit?: number } = {}) {
  await ensurePawPointsTables(db);
  const rows = await db.prepare(
    "SELECT b.id,b.customer_id,b.total_amount FROM canonical_bookings b LEFT JOIN paw_points_ledger l ON l.booking_id=b.id AND l.entry_type='earned' WHERE b.status='completed' AND b.total_amount>0 AND l.id IS NULL ORDER BY b.updated_at DESC LIMIT ?"
  ).bind(Math.min(Number(input.limit) || 200, 500)).all<Row>().catch(() => ({ results: [] as Row[] }));
  let credited = 0, totalPoints = 0;
  for (const b of rows.results) {
    const points = Math.floor(Number(b.total_amount || 0) * EARN_POINTS_PER_RUPEE);
    if (points <= 0) continue;
    const r = await post(db, { customerId: String(b.customer_id), entryType: "earned", points, reason: "Completed booking", sourceType: "booking", bookingId: String(b.id), idempotencyKey: `earn:booking:${String(b.id)}`, createdBy: "system:paw-points" });
    if (!r.duplicatePrevented) { credited++; totalPoints += r.points; }
  }
  return { bookingsCredited: credited, pointsAwarded: totalPoints };
}

/** Staff goodwill grant (service recovery). Positive points, reason required, capped. */
export async function grantGoodwillPoints(db: Db, input: { customerId: string; points: number; reason: string; actorId: string; idempotencyKey?: string }) {
  await ensurePawPointsTables(db);
  const points = Math.floor(Number(input.points));
  if (!Number.isFinite(points) || points <= 0 || points > MAX_GRANT_POINTS) throw new Error(`Goodwill points must be between 1 and ${MAX_GRANT_POINTS}`);
  if (input.reason.trim().length < 5) throw new Error("A reason for the goodwill grant is required");
  const result = await post(db, { customerId: input.customerId, entryType: "goodwill", points, reason: input.reason.trim(), sourceType: "staff_goodwill", idempotencyKey: input.idempotencyKey || `goodwill:${input.customerId}:${Date.now()}`, createdBy: input.actorId });
  return { customerId: input.customerId, pointsGranted: result.duplicatePrevented ? 0 : result.points, balance: await pawPointsBalance(db, input.customerId) };
}

/** Targeted win-back grant for a lapsed customer - once per campaign (idempotent on campaignKey). */
export async function grantWinbackPoints(db: Db, input: { customerId: string; points: number; campaignKey: string; actorId: string }) {
  await ensurePawPointsTables(db);
  const points = Math.floor(Number(input.points));
  if (!Number.isFinite(points) || points <= 0 || points > MAX_GRANT_POINTS) throw new Error(`Win-back points must be between 1 and ${MAX_GRANT_POINTS}`);
  if (!input.campaignKey.trim()) throw new Error("A win-back campaign key is required");
  const result = await post(db, { customerId: input.customerId, entryType: "winback", points, reason: `Win-back: ${input.campaignKey.trim()}`, sourceType: "winback_campaign", idempotencyKey: `winback:${input.campaignKey.trim()}:${input.customerId}`, createdBy: input.actorId });
  return { customerId: input.customerId, pointsGranted: result.duplicatePrevented ? 0 : result.points, alreadyGranted: result.duplicatePrevented, balance: await pawPointsBalance(db, input.customerId) };
}

/** Redeem points for a discount on a real customer-owned booking (one redemption per booking). */
export async function redeemPoints(db: Db, input: { customerId: string; points: number; bookingId: string; actorId: string }) {
  await ensurePawPointsTables(db);
  const requested = Math.floor(Number(input.points));
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Enter a positive number of points to redeem");
  const booking = await db.prepare("SELECT id,customer_id,total_amount FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.customer_id) !== input.customerId) throw new Error("You can only redeem points on your own booking");
  const already = await db.prepare("SELECT id FROM paw_points_ledger WHERE idempotency_key=?").bind(`redeem:booking:${input.bookingId}`).first<Row>();
  if (already) throw new Error("Points have already been redeemed on this booking");
  const balance = await pawPointsBalance(db, input.customerId);
  if (balance <= 0) throw new Error("You have no PawPoints to redeem yet");
  const bookingTotal = Number(booking.total_amount || 0);
  // The margin cap is unchanged and still measured on the GROSS total - but it was the ONLY ceiling,
  // and being gross it survived intact even after wallet credit had already covered 100% of the
  // booking. The tighter of the two now binds: a redemption may never take a booking's applied credit
  // past what the order is worth.
  const payable = await remainingPayableForCredit(db, input.bookingId, bookingTotal);
  const maxDiscount = Math.min(Math.floor(bookingTotal * MAX_REDEEM_FRACTION), Math.floor(payable));
  let pointsUsed = Math.min(requested, balance);
  let discount = Math.floor(pointsUsed * REDEEM_RUPEE_PER_POINT);
  if (discount > maxDiscount) { discount = maxDiscount; pointsUsed = Math.ceil(discount / REDEEM_RUPEE_PER_POINT); }
  if (discount <= 0) throw new Error(payable > 0 ? "Not enough points for a redeemable discount on this booking" : "This booking is already fully covered by credit you have applied, so there is nothing left to discount");
  // Guarded debit: the ledger row is only written while the live SUM can still cover the spend
  // inside the same statement, so concurrent redemptions on different bookings can never drive the
  // points balance negative (the balance read above is advisory only).
  try {
    const debited = await db.prepare("INSERT INTO paw_points_ledger (id,customer_id,entry_type,points,reason,source_type,booking_id,idempotency_key,created_by,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(points),0) FROM paw_points_ledger WHERE customer_id=?)>=?")
      .bind(uid("PP"), input.customerId, "redeemed", -pointsUsed, `Redeemed on booking ${input.bookingId}`, "booking", input.bookingId, `redeem:booking:${input.bookingId}`, input.actorId, Date.now(), input.customerId, pointsUsed).run();
    if (!Number(debited.meta?.changes || 0)) throw new Error("Your PawPoints balance is no longer sufficient for this redemption");
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) throw new Error("Points have already been redeemed on this booking");
    throw error;
  }
  return { bookingId: input.bookingId, pointsRedeemed: pointsUsed, discountApplied: discount, balance: await pawPointsBalance(db, input.customerId) };
}

/**
 * A cancelled booking must not strand points that were already redeemed on it. Restoration is
 * append-only and deterministic per booking, so approval retries repair partial cancellation work
 * without ever double-crediting the customer.
 */
export async function restoreRedeemedPointsForCancelledBooking(db: Db, input: { customerId: string; bookingId: string; actorId: string }) {
  await ensurePawPointsTables(db);
  const redeemed = await db.prepare("SELECT customer_id,points FROM paw_points_ledger WHERE idempotency_key=?")
    .bind(`redeem:booking:${input.bookingId}`).first<Row>();
  if (!redeemed) return { bookingId: input.bookingId, pointsRestored: 0, alreadyRestored: false, notRequired: true, balance: await pawPointsBalance(db, input.customerId) };
  if (String(redeemed.customer_id) !== input.customerId) throw new Error("Redeemed PawPoints belong to another customer");
  const points = Math.max(0, -Math.round(Number(redeemed.points || 0)));
  if (!points) return { bookingId: input.bookingId, pointsRestored: 0, alreadyRestored: false, notRequired: true, balance: await pawPointsBalance(db, input.customerId) };
  const result = await post(db, {
    customerId: input.customerId,
    entryType: "cancellation_restore",
    points,
    reason: `Restored after cancelled booking ${input.bookingId}`,
    sourceType: "booking_cancellation",
    bookingId: input.bookingId,
    idempotencyKey: `restore:cancelled-booking:${input.bookingId}`,
    createdBy: input.actorId,
  });
  return {
    bookingId: input.bookingId,
    pointsRestored: result.duplicatePrevented ? 0 : result.points,
    alreadyRestored: result.duplicatePrevented,
    notRequired: false,
    balance: await pawPointsBalance(db, input.customerId),
  };
}

export async function pawPointsHistory(db: Db, customerId: string) {
  await ensurePawPointsTables(db);
  const rows = await db.prepare("SELECT entry_type,points,reason,booking_id,created_at FROM paw_points_ledger WHERE customer_id=? ORDER BY created_at DESC LIMIT 50").bind(customerId).all<Row>();
  return { balance: await pawPointsBalance(db, customerId), history: rows.results.map((r: Row) => ({ entryType: String(r.entry_type), points: Number(r.points), reason: r.reason ? String(r.reason) : null, bookingId: r.booking_id ? String(r.booking_id) : null, createdAt: Number(r.created_at) })) };
}
