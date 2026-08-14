/**
 * P1 RUNTIME CLOSURE TEST — coupon expiry/scope enforcement, and the coupon↔refund reversal boundary.
 *
 * (a) EXPIRY + SCOPE: quoteCoupon rejects a coupon that is outside its validity window, or out of scope
 *     for the service / city / channel / order value. Driven through the REAL lib.coupon-governance over
 *     a real D1 (no auth surface involved — this is governance logic, executed, not regex-matched).
 *
 * (b) SINGLE-USE + REVERSAL BOUNDARY: consuming a quote is a one-shot atomic claim, and the per-customer
 *     limit holds. For the coupon↔refund direction, the current, DOCUMENTED contract is that a booking
 *     refund/cancel does NOT reinstate coupon capacity — automatic coupon reversal on refund is a
 *     founder-policy-DEFERRED gap (docs/COUPON_GOVERNANCE_UAT.md; docs/IMPLEMENTATION_READINESS_AUDIT).
 *     This test PINS that contract (a refunded booking's redemption stays 'consumed') rather than
 *     inventing an unapproved reversal policy. It is a classification test, not a fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__COUP_DB__", "__COUP_ENV__");

const { quoteCoupon, consumeCouponQuote } = await import("../lib/coupon-governance.ts");

const CUSTOMER = "CUS-COUP-1";
// The seeded UATCARE100 campaign: fixed Rs.100 off, minOrder 500, city blr, channels
// customer_app/assisted_staff, services grooming/dog_training/boarding/pet_sitting, perCustomerLimit 2.
const VALID = { code: "UATCARE100", customerId: CUSTOMER, serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode: "pkg-std", orderValue: 1500, paymentMode: "full", isSubscription: false };

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__COUP_DB__ = db;
  globalThis.__COUP_ENV__ = {};
  // canonical_bookings is read by consumeCouponQuote (booking must belong to the customer).
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed')");
  return { sqlite, db };
}
const seedBooking = (sqlite, id, status = "confirmed") => sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,status) VALUES (?,?,?)").run(id, CUSTOMER, status);
const redemptionStatus = (sqlite, bookingId) => { const r = sqlite.prepare("SELECT status FROM coupon_redemptions WHERE booking_id=?").get(bookingId); return r ? r.status : null; };

// --- (a) validity window ------------------------------------------------------------------------------

test("a valid, in-scope coupon quotes successfully (control)", async () => {
  const { db } = freshDb();
  const q = await quoteCoupon(db, VALID);
  assert.equal(q.valid, true, `a valid coupon must quote: ${JSON.stringify(q)}`);
  assert.equal(q.discount, 100, "fixed Rs.100 discount");
});

test("an EXPIRED coupon is rejected (outside validity window)", async () => {
  const { sqlite, db } = freshDb();
  await quoteCoupon(db, VALID); // triggers seedUatCoupons so the campaign row exists
  sqlite.prepare("UPDATE coupon_campaigns SET valid_until=? WHERE code='UATCARE100'").run(Date.now() - 1000);
  const q = await quoteCoupon(db, VALID);
  assert.equal(q.valid, false);
  assert.match(String(q.error), /outside its validity window/);
});

// --- (a) scope: service / city / channel / min-order --------------------------------------------------

test("a coupon OUT OF SERVICE SCOPE is rejected", async () => {
  const { db } = freshDb();
  const q = await quoteCoupon(db, { ...VALID, serviceCode: "pet_taxi" }); // not in the campaign's services
  assert.equal(q.valid, false);
  assert.match(String(q.error), /not eligible for this service/);
});

test("a coupon OUT OF CITY SCOPE is rejected (blr-only coupon, maa request)", async () => {
  const { db } = freshDb();
  const q = await quoteCoupon(db, { ...VALID, cityId: "maa" });
  assert.equal(q.valid, false);
  assert.match(String(q.error), /not eligible in this city/);
});

test("a coupon OUT OF CHANNEL SCOPE is rejected", async () => {
  const { db } = freshDb();
  const q = await quoteCoupon(db, { ...VALID, channel: "whatsapp" }); // not customer_app/assisted_staff
  assert.equal(q.valid, false);
  assert.match(String(q.error), /not eligible on this channel/);
});

test("a coupon BELOW MINIMUM ORDER VALUE is rejected", async () => {
  const { db } = freshDb();
  const q = await quoteCoupon(db, { ...VALID, orderValue: 100 }); // minOrder is 500
  assert.equal(q.valid, false);
  assert.match(String(q.error), /Minimum order value not met/);
});

// --- (b) single-use + per-customer limit --------------------------------------------------------------

test("a consumed quote cannot be consumed twice (atomic single-use claim)", async () => {
  const { sqlite, db } = freshDb();
  seedBooking(sqlite, "BK-1");
  const q = await quoteCoupon(db, VALID);
  const first = await consumeCouponQuote(db, { quoteId: q.quoteId, bookingId: "BK-1", customerId: CUSTOMER, idempotencyKey: "ik-1" });
  assert.equal(first.redemption.status, "consumed");
  await assert.rejects(
    () => consumeCouponQuote(db, { quoteId: q.quoteId, bookingId: "BK-1", customerId: CUSTOMER, idempotencyKey: "ik-2" }),
    /Coupon quote is no longer open/,
    "the same quote must not consume twice",
  );
});

test("the per-customer usage limit (2) is enforced across bookings", async () => {
  const { sqlite, db } = freshDb();
  for (const id of ["BK-1", "BK-2", "BK-3"]) seedBooking(sqlite, id);
  for (let i = 1; i <= 2; i++) {
    const q = await quoteCoupon(db, VALID);
    assert.equal(q.valid, true, `redemption ${i} within limit should quote`);
    await consumeCouponQuote(db, { quoteId: q.quoteId, bookingId: `BK-${i}`, customerId: CUSTOMER, idempotencyKey: `ik-${i}` });
  }
  // Third quote must be refused at quote time — the customer has hit perCustomerLimit=2.
  const third = await quoteCoupon(db, VALID);
  assert.equal(third.valid, false);
  assert.match(String(third.error), /reached this coupon's usage limit/);
});

// --- (b) coupon↔refund reversal boundary — PIN the documented policy-deferred gap ----------------------

test("BOUNDARY (policy-deferred): a refunded/cancelled booking does NOT auto-reverse its coupon redemption", async () => {
  const { sqlite, db } = freshDb();
  seedBooking(sqlite, "BK-R");
  const q = await quoteCoupon(db, VALID);
  await consumeCouponQuote(db, { quoteId: q.quoteId, bookingId: "BK-R", customerId: CUSTOMER, idempotencyKey: "ik-r" });
  assert.equal(redemptionStatus(sqlite, "BK-R"), "consumed", "redemption is consumed after use");

  // The booking is now refunded/cancelled. There is deliberately NO coupon-reversal path wired to
  // refund/cancel — automatic coupon-capacity reinstatement is a founder-policy-deferred decision
  // (see docs/COUPON_GOVERNANCE_UAT.md). Assert the CURRENT contract holds: capacity is not silently
  // reinstated, and the redemption is never moved to an (unspecified) 'reversed' state.
  sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id=?").run("BK-R");
  assert.equal(redemptionStatus(sqlite, "BK-R"), "consumed", "coupon capacity is NOT reinstated on refund (policy-deferred, not a defect fixed here)");
  const reversed = sqlite.prepare("SELECT COUNT(*) c FROM coupon_redemptions WHERE status='reversed'").get().c;
  assert.equal(reversed, 0, "there is no coupon 'reversed' status until the reversal policy is approved");
});
