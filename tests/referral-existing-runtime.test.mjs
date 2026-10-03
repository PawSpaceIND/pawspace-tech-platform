import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
// Resolver hooks before the referral governance modules: they import extension-less siblings,
// which the CI strip-types mode for tests/*.test.mjs cannot resolve on its own.
installWorkersHooks("__REFERRAL_EXISTING_RUNTIME_DB__", "__REFERRAL_EXISTING_RUNTIME_ENV__");
const { seedReferralProgramme, saveReferralProgramme, ensureReferralCode, claimReferral, reserveReferralReward } = await import("../lib/referral-governance.ts");
const { prepareReferralBooking, referralBookingLinkStatement, referralClaimBoundStatement, tryQualifyLinkedReferral, handleReferralBookingCancellation } = await import("../lib/referral-booking-governance.ts");
class Db {
  sqlite = new DatabaseSync(":memory:");
  prepare(sql, values = []) {
    return { bind: (...v) => this.prepare(sql, v), first: async () => this.sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
      run: async () => ({ meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }),
      runSync: () => ({ meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }) };
  }
  async batch(items) { this.sqlite.exec("BEGIN IMMEDIATE"); try { const result = items.map(i => i.runSync()); this.sqlite.exec("COMMIT"); return result; } catch (e) { this.sqlite.exec("ROLLBACK"); throw e; } }
}
async function fixture() {
  const db = new Db();
  db.sqlite.exec("CREATE TABLE canonical_customers(id TEXT PRIMARY KEY,primary_phone TEXT,email TEXT); INSERT INTO canonical_customers VALUES ('referrer','9000000001','one@test.invalid'),('friend','9000000002','two@test.invalid'); CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,service_code TEXT,city_id TEXT,total_amount REAL,created_at INTEGER); CREATE TABLE booking_payments(booking_id TEXT,status TEXT,amount REAL)");
  await seedReferralProgramme(db);
  return db;
}
// Explicit fixture-only parameters, not defaults or a new approved referral reward policy.
async function configured(db) {
  const now = Date.now();
  await saveReferralProgramme(db, { id: "uat-referral-programme", name: "Isolated referral verification fixture", status: "active", eligibleServices: ["grooming"], cityIds: ["blr"], rewardUseServices: ["grooming"], friendDiscount: 5, referrerReward: 10, perReferrerMonthlyLimit: 2, rewardValidityDays: 7, oneRewardPerFriend: true, reversalOnRefund: true, validFrom: now - 1000, validUntil: now + 3600000 });
  return ensureReferralCode(db, { programmeId: "uat-referral-programme", customerId: "referrer" });
}
test("existing referral code→claim→priced first booking→completed paid qualification→subsequent reservation→refund reversal", async () => {
  const db = await fixture();
  const initial = db.sqlite.prepare("SELECT * FROM referral_programmes").get(); assert.equal(initial.status, "paused"); assert.equal(initial.referrer_reward, null); assert.equal(initial.reward_validity_days, null);
  const code = await configured(db);
  assert.equal((await ensureReferralCode(db, { programmeId: "uat-referral-programme", customerId: "referrer" })).code, code.code);
  const input = { code: code.code, referredCustomerId: "friend", serviceCode: "grooming", cityId: "blr", idempotencyKey: "claim-once" };
  const claim = await claimReferral(db, input); assert.equal(claim.matched, true); assert.equal((await claimReferral(db, input)).duplicatePrevented, true);
  const preparation = await prepareReferralBooking(db, { claimId: claim.claimId, customer: { id: "friend", primaryPhone: "9000000002", email: "two@test.invalid" }, serviceCode: "grooming", cityId: "blr", baseAmount: 100, baseAmountDueNow: 100, hasOtherOffer: false, isSubscription: false });
  assert.equal(preparation.totalAmount, 95); assert.equal(preparation.discountAmount, 5);
  db.sqlite.exec("INSERT INTO canonical_bookings VALUES ('first','friend','confirmed','grooming','blr',95,1); INSERT INTO booking_payments VALUES ('first','created',95)");
  await db.batch([referralBookingLinkStatement(db, { preparation, bookingId: "first", now: Date.now() }), referralClaimBoundStatement(db, { claimId: claim.claimId, now: Date.now() })]);
  assert.equal((await tryQualifyLinkedReferral(db, { bookingId: "first", actorId: "fixture" })).status, "pending_completion");
  db.sqlite.exec("UPDATE canonical_bookings SET status='completed' WHERE id='first'");
  assert.equal((await tryQualifyLinkedReferral(db, { bookingId: "first", actorId: "fixture" })).status, "pending_payment");
  db.sqlite.exec("UPDATE booking_payments SET status='captured' WHERE booking_id='first'");
  const qualified = await tryQualifyLinkedReferral(db, { bookingId: "first", actorId: "fixture" }); assert.equal(qualified.qualified, true); assert.equal(qualified.reward.amount, 10);
  assert.equal((await tryQualifyLinkedReferral(db, { bookingId: "first", actorId: "fixture" })).duplicatePrevented, true);
  db.sqlite.exec("INSERT INTO canonical_bookings VALUES ('next','referrer','confirmed','grooming','blr',100,2)");
  const reservation = { rewardId: qualified.reward.id, bookingId: "next", customerId: "referrer", idempotencyKey: "reserve-once" };
  const reserved = await reserveReferralReward(db, reservation); assert.equal(reserved.bookingPricingAuthoritative, false); assert.equal(reserved.liveMoney, false);
  assert.equal((await reserveReferralReward(db, reservation)).duplicatePrevented, true);
  await handleReferralBookingCancellation(db, { bookingId: "first", actorId: "fixture", reason: "Verified fixture refund" });
  assert.equal(db.sqlite.prepare("SELECT status FROM referral_rewards").get().status, "reversed"); assert.equal(db.sqlite.prepare("SELECT status FROM referral_reward_reservations").get().status, "reversed");
  assert.equal(db.sqlite.prepare("SELECT amount FROM referral_reward_events WHERE event_type='reversed'").get().amount, -10);
  db.sqlite.close();
});
test("existing referral gates reject self-referral, paused policy, expired rewards and wrong reward owner", async () => {
  const db = await fixture(); const code = await configured(db);
  const self = await claimReferral(db, { code: code.code, referredCustomerId: "referrer", serviceCode: "grooming", cityId: "blr", idempotencyKey: "self" });
  assert.match(String(self.error), /Self-referral/);
  const claim = await claimReferral(db, { code: code.code, referredCustomerId: "friend", serviceCode: "grooming", cityId: "blr", idempotencyKey: "friend" });
  db.sqlite.exec("UPDATE referral_programmes SET status='paused'");
  await assert.rejects(prepareReferralBooking(db, { claimId: claim.claimId, customer: { id: "friend", primaryPhone: "9000000002" }, serviceCode: "grooming", cityId: "blr", baseAmount: 100, baseAmountDueNow: 100, hasOtherOffer: false, isSubscription: false }), /paused/);
  // A released fixture reward exercises existing owner/expiry guard; never write actual programmes.
  db.sqlite.prepare("INSERT INTO referral_rewards(id,claim_id,programme_id,referrer_customer_id,referred_customer_id,source_booking_id,amount,status,valid_until,policy_snapshot_json,created_at,updated_at) VALUES ('expired',?,'uat-referral-programme','referrer','friend','first',10,'released',0,'{}',0,0)").run(claim.claimId);
  await assert.rejects(reserveReferralReward(db, { rewardId: "expired", bookingId: "next", customerId: "friend", idempotencyKey: "wrong-owner" }), /does not belong/);
  await assert.rejects(reserveReferralReward(db, { rewardId: "expired", bookingId: "next", customerId: "referrer", idempotencyKey: "expired" }), /expired/);
  db.sqlite.close();
});
