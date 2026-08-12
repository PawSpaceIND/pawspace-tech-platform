/**
 * Wires the accrual revenue-recognition engine into the live booking lifecycle, the same way the
 * PawPoints earn sweep wires into completed bookings: a cold-DB-safe reconciliation sweep that reads
 * canonical booking / subscription state and books the right accrual entries. Running it from the
 * background scheduler keeps the P&L on an accrual basis automatically, without editing the large
 * governed /api/canonical-bookings transaction or every vertical's lifecycle.
 *
 * What it reconciles each run (all idempotent):
 *   subscriptions   - a prepaid grooming subscription opens a Deferred Revenue schedule for its pack
 *                     price over its sessions; revenue is then recognised up to sessions_consumed.
 *   advance bookings - a prepaid+captured booking (not a subscription purchase, not a subscription-
 *                     credit redemption) opens an Advance from Customers schedule; the full amount is
 *                     recognised once the booking is completed (service utilised).
 */

import { recordDeferredRevenue, recognizeSubscriptionUsage, recognizeAdvanceBooking, ensureRevenueRecognitionTables } from "./revenue-recognition-governance";

type Db = D1Database;
type Row = Record<string, unknown>;
const SYS = "system:revrec-sweep";
const empty = () => ({ results: [] as Row[] });

export async function runRevenueRecognitionSweep(db: Db, input: { asOf?: number } = {}) {
  await ensureRevenueRecognitionTables(db);
  const at = new Date(input.asOf ?? Date.now()).toISOString().slice(0, 10);
  let subscriptionsOpened = 0, subscriptionSessionsRecognized = 0, advancesOpened = 0, advancesRecognized = 0;

  // 1) Prepaid grooming subscriptions: pack price comes from the source booking; sessions from the plan.
  const subs = await db.prepare("SELECT s.id id,s.customer_id customer_id,s.total_sessions total,s.sessions_consumed consumed,b.total_amount amount FROM customer_grooming_subscriptions s JOIN canonical_bookings b ON b.id=s.source_booking_id JOIN booking_payments p ON p.booking_id=s.source_booking_id WHERE p.status='captured' AND b.total_amount>0").all<Row>().catch(empty);
  for (const s of subs.results) {
    const opened = await recordDeferredRevenue(db, { sourceType: "subscription", sourceId: String(s.id), customerId: String(s.customer_id), serviceCode: "grooming", totalAmount: Number(s.amount), totalUnits: Number(s.total), collectedToBank: true, at, actorId: SYS }).catch(() => null);
    if (opened && !opened.alreadyRecorded) subscriptionsOpened++;
    if (Number(s.consumed) > 0) {
      const rec = await recognizeSubscriptionUsage(db, { sourceId: String(s.id), sessionsConsumed: Number(s.consumed), at, actorId: SYS }).catch(() => null) as Row | null;
      if (rec && rec.recognized !== false && !rec.alreadyRecognized) subscriptionSessionsRecognized++;
    }
  }

  // 2) Advance bookings: prepaid+captured, excluding subscription purchases and subscription-credit redemptions.
  const advance = await db.prepare("SELECT b.id id,b.customer_id customer_id,b.service_code svc,b.total_amount amount,b.status status FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE p.mode='prepaid' AND p.status='captured' AND b.total_amount>0 AND b.id NOT IN (SELECT source_booking_id FROM customer_grooming_subscriptions) AND b.id NOT IN (SELECT booking_id FROM booking_subscription_usage)").all<Row>().catch(empty);
  for (const b of advance.results) {
    const opened = await recordDeferredRevenue(db, { sourceType: "advance_booking", sourceId: String(b.id), customerId: String(b.customer_id), serviceCode: String(b.svc), totalAmount: Number(b.amount), collectedToBank: true, at, actorId: SYS }).catch(() => null);
    if (opened && !opened.alreadyRecorded) advancesOpened++;
    if (String(b.status) === "completed") {
      const rec = await recognizeAdvanceBooking(db, { sourceId: String(b.id), at, actorId: SYS }).catch(() => null) as Row | null;
      if (rec && rec.recognized !== false) advancesRecognized++;
    }
  }

  return { sweep: "revenue_recognition", subscriptionsOpened, subscriptionSessionsRecognized, advancesOpened, advancesRecognized };
}
