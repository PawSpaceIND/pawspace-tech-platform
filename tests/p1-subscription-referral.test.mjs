/**
 * P1 RUNTIME CLOSURE TEST — subscription expiry/renewal + referral-abuse boundaries.
 *
 * Governance logic exercised over a real node:sqlite D1 through the REAL lib functions (executed, not
 * regex-matched). No auth surface is involved in these invariants, so there is no localhost-superuser
 * shortcut — the code runs directly.
 *
 * Subscription:
 *   - grooming subscription past its grace window flips to 'expired' and can no longer move credits;
 *   - the grooming wallet exposes NO auto-renew (renewalPricing:"configuration_required") — pinned;
 *   - the FOOD subscription is the real period-extending renewal: a confirmed renewal payment advances
 *     next_renewal_at by exactly renewal_interval_days, and a replayed payment does not double-advance.
 * Referral abuse:
 *   - self-referral is rejected;
 *   - a second claim for the same friend is rejected (no double claim);
 *   - qualifying twice yields ONE reward (idempotent — no double reward);
 *   - reward reversal is idempotent and refuses when the policy does not authorize it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__SUBREF_DB__", "__SUBREF_ENV__");

const DAY = 86_400_000;
const sub = await import("../lib/subscription-wallet.ts");
const food = await import("../lib/food-subscription-governance.ts");
const ref = await import("../lib/referral-governance.ts");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__SUBREF_DB__ = db;
  globalThis.__SUBREF_ENV__ = {};
  return { sqlite, db };
}

// ===================== SUBSCRIPTION: grooming expiry =====================

async function seedGroomingSub(sqlite, db, { expiresAt, status = "active", graceDays = 0 }) {
  await sub.readSubscriptionWallet(db, "none"); // ensures the subscription-wallet tables exist
  const now = Date.now();
  sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES ('SUB-1','CUS-1','plan-6','grooming-6',6,0,0,?,?,?,'SRC-1','v1',?,?)")
    .run(status, now - 30 * DAY, expiresAt, now, now);
  sqlite.prepare("INSERT INTO grooming_subscription_purchase_snapshots (subscription_id,booking_id,city_id,zone_id,plan_code,catalogue_version,config_json,created_at) VALUES ('SUB-1','SRC-1','blr','blr-east','plan-6','v1',?,?)")
    .run(JSON.stringify({ graceDays, pauseDays: 0, renewalWindowDays: 7 }), now);
}

test("a grooming subscription past its grace window flips to 'expired' on refresh, and then rejects credit movement", async () => {
  const { sqlite, db } = freshDb();
  await seedGroomingSub(sqlite, db, { expiresAt: Date.now() - 2 * DAY, graceDays: 0 });

  const before = await sub.readSubscriptionWallet(db, "SUB-1");
  assert.equal(before.readiness.expired, true, "readiness reports the subscription is past its grace window");

  await sub.mutateSubscriptionWallet(db, { subscriptionId: "SUB-1", action: "refresh_expiry", idempotencyKey: "exp-1", actorId: "ops@pawspace.in" });
  const status = sqlite.prepare("SELECT status FROM customer_grooming_subscriptions WHERE id='SUB-1'").get().status;
  assert.equal(status, "expired", "refresh_expiry transitions the expired subscription to 'expired'");

  // An expired subscription is no longer active and cannot move booking credits.
  await assert.rejects(
    () => sub.mutateSubscriptionWallet(db, { subscriptionId: "SUB-1", action: "reserve", bookingId: "BK-X", credits: 1, idempotencyKey: "res-1", actorId: "ops@pawspace.in" }),
    /is expired and cannot move booking credits/,
  );
});

test("the grooming wallet exposes no auto-renew (renewal is configuration_required, not silently priced)", async () => {
  const { sqlite, db } = freshDb();
  await seedGroomingSub(sqlite, db, { expiresAt: Date.now() + 5 * DAY, graceDays: 3 });
  const wallet = await sub.readSubscriptionWallet(db, "SUB-1");
  assert.equal(wallet.readiness.autoRenewal, false, "no silent auto-renewal");
  assert.equal(wallet.readiness.renewalPricing, "configuration_required", "renewal pricing is not invented");
});

// ===================== SUBSCRIPTION: food renewal extends the period =====================

async function seedFoodSubscription(sqlite, db, { interval = 30 }) {
  await food.getFoodSubscriptionSnapshot(db, { subscriptionId: "none" }); // ensures food-subscription tables
  // queuePaidMessages -> enqueueCommunication reads canonical_customers (incl. consent_json); use the
  // real DDL from the customer-account/communication layer.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,consent_json,created_at,updated_at) VALUES ('CUS-1','blr','Food Customer','+919000003333','food@pawspace.test','{\"whatsapp\":true,\"email\":true}',?,?)").run(Date.now(), Date.now());
  const now = Date.now(), nextRenewal = now + interval * DAY;
  sqlite.prepare("INSERT INTO food_subscriptions (id,source_order_id,customer_id,city_id,zone_id,sku,item_name,quantity,renewal_interval_days,status,communication_channel,unit_price_at_signup,approved_unit_price,current_cycle,next_renewal_at,created_by,created_at,updated_at) VALUES ('FSUB-1','ORD-1','CUS-1','blr','blr-east','SKU-1','Chicken meal',2,?,'active','whatsapp',500,500,0,?,'ops',?,?)")
    .run(interval, nextRenewal, now, now);
  // A renewal awaiting payment for cycle 1 (as createOrLoadRenewal would have produced).
  sqlite.prepare("INSERT INTO food_subscription_renewals (id,subscription_id,cycle_no,sku,quantity,item_version,unit_price,total_amount,currency,status,payment_link_provider,payment_link_environment,payment_link_ref,payment_link_path,due_at,created_at,updated_at) VALUES ('FREN-1','FSUB-1',1,'SKU-1',2,1,500,1000,'INR','payment_pending','internal_uat','uat','FPL-1','/food/pay?r=1',?,?,?)")
    .run(nextRenewal, now, now);
  return { nextRenewal, interval };
}

test("a confirmed FOOD renewal payment advances next_renewal_at by exactly one interval, and a replay does not double-advance", async () => {
  const { sqlite, db } = freshDb();
  const { nextRenewal, interval } = await seedFoodSubscription(sqlite, db, { interval: 30 });

  const r1 = await food.recordFoodSubscriptionRenewalPayment(db, { renewalId: "FREN-1", paymentReference: "PAYREF-0001", actorId: "ops@pawspace.in" });
  assert.equal(r1.status, "paid_invoiced");
  const afterFirst = sqlite.prepare("SELECT next_renewal_at,current_cycle FROM food_subscriptions WHERE id='FSUB-1'").get();
  assert.equal(afterFirst.next_renewal_at, nextRenewal + interval * DAY, "the period advanced by exactly one renewal interval");
  assert.equal(afterFirst.current_cycle, 1, "cycle advanced to 1");

  // Replaying the same renewal payment (same reference) must NOT advance the period again.
  const r2 = await food.recordFoodSubscriptionRenewalPayment(db, { renewalId: "FREN-1", paymentReference: "PAYREF-0001", actorId: "ops@pawspace.in" });
  assert.equal(r2.duplicatePayment, true, "a replayed payment is recognized as a duplicate");
  const afterReplay = sqlite.prepare("SELECT next_renewal_at FROM food_subscriptions WHERE id='FSUB-1'").get();
  assert.equal(afterReplay.next_renewal_at, nextRenewal + interval * DAY, "the period did not double-advance on replay");
});

// ===================== REFERRAL: abuse boundaries =====================

const REFERRER = "CUS-REFERRER", REFERRED = "CUS-REFERRED";

async function seedReferral(sqlite, db) {
  await ref.seedReferralProgramme(db); // ensures referral tables + the base programme
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY, name TEXT, primary_phone TEXT, email TEXT)");
  // Distinct phone + email so the identity-risk check does not put the claim on hold.
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-REFERRER','Refe Rrer','+919000001111','referrer@pawspace.test')").run();
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-REFERRED','Refe Rred','+919000002222','referred@pawspace.test')").run();
  const now = Date.now();
  await ref.saveReferralProgramme(db, {
    id: "uat-referral-programme", name: "UAT Referral Programme", status: "active",
    eligibleServices: ["grooming"], cityIds: ["blr"], rewardUseServices: ["grooming"],
    friendDiscount: 100, referrerReward: 200, perReferrerMonthlyLimit: 5, rewardValidityDays: 30,
    oneRewardPerFriend: true, reversalOnRefund: true, validFrom: now - DAY, validUntil: now + 365 * DAY,
  });
  const { code } = await ref.ensureReferralCode(db, { programmeId: "uat-referral-programme", customerId: REFERRER });
  return { code };
}

test("self-referral is rejected", async () => {
  const { sqlite, db } = freshDb();
  const { code } = await seedReferral(sqlite, db);
  const r = await ref.claimReferral(db, { code, referredCustomerId: REFERRER, serviceCode: "grooming", cityId: "blr", idempotencyKey: "self-1" });
  assert.equal(r.error, "Self-referral is not allowed");
});

test("a second claim for the same friend is rejected (no double claim)", async () => {
  const { sqlite, db } = freshDb();
  const { code } = await seedReferral(sqlite, db);
  const first = await ref.claimReferral(db, { code, referredCustomerId: REFERRED, serviceCode: "grooming", cityId: "blr", idempotencyKey: "c-1" });
  assert.equal(first.status, "pending_booking", `first claim should register: ${JSON.stringify(first)}`);
  const second = await ref.claimReferral(db, { code, referredCustomerId: REFERRED, serviceCode: "grooming", cityId: "blr", idempotencyKey: "c-2" });
  assert.match(String(second.error), /already has a referral claim/);
});

test("qualifying a claim twice yields exactly ONE reward (idempotent — no double reward)", async () => {
  const { sqlite, db } = freshDb();
  const { code } = await seedReferral(sqlite, db);
  const claim = await ref.claimReferral(db, { code, referredCustomerId: REFERRED, serviceCode: "grooming", cityId: "blr", idempotencyKey: "c-1" });
  // The referred customer's first canonical booking: completed + paid + matching service/city.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,service_code TEXT,city_id TEXT,total_amount REAL,created_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (booking_id TEXT PRIMARY KEY,status TEXT,amount REAL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-REF','CUS-REFERRED','completed','grooming','blr',1500,?)").run(Date.now());
  sqlite.prepare("INSERT INTO booking_payments VALUES ('BK-REF','captured',1500)").run();

  const q1 = await ref.qualifyReferralClaim(db, { claimId: claim.claimId, bookingId: "BK-REF", idempotencyKey: "q-1", actorId: "ops@pawspace.in" });
  assert.equal(q1.qualified, true, `first qualify should create the reward: ${JSON.stringify(q1)}`);
  const q2 = await ref.qualifyReferralClaim(db, { claimId: claim.claimId, bookingId: "BK-REF", idempotencyKey: "q-2", actorId: "ops@pawspace.in" });
  assert.equal(q2.duplicatePrevented, true, "a second qualification is idempotent");
  const rewardCount = sqlite.prepare("SELECT COUNT(*) c FROM referral_rewards WHERE claim_id=?").get(claim.claimId).c;
  assert.equal(rewardCount, 1, "exactly one reward exists for the claim");
});

test("reward reversal is idempotent, and refuses when the reward's policy does not authorize reversal", async () => {
  const { sqlite, db } = freshDb();
  const { code } = await seedReferral(sqlite, db);
  const claim = await ref.claimReferral(db, { code, referredCustomerId: REFERRED, serviceCode: "grooming", cityId: "blr", idempotencyKey: "c-1" });
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,service_code TEXT,city_id TEXT,total_amount REAL,created_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (booking_id TEXT PRIMARY KEY,status TEXT,amount REAL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-REF','CUS-REFERRED','completed','grooming','blr',1500,?)").run(Date.now());
  sqlite.prepare("INSERT INTO booking_payments VALUES ('BK-REF','captured',1500)").run();
  const q = await ref.qualifyReferralClaim(db, { claimId: claim.claimId, bookingId: "BK-REF", idempotencyKey: "q-1", actorId: "ops@pawspace.in" });
  const rewardId = q.reward.id;

  // Policy authorizes reversal (programme reversalOnRefund=true): reverse succeeds, replay is idempotent.
  const rev1 = await ref.reverseReferralReward(db, { rewardId, reason: "booking refunded", actorId: "finance@pawspace.in" });
  assert.equal(rev1.status, "reversed");
  const rev2 = await ref.reverseReferralReward(db, { rewardId, reason: "booking refunded", actorId: "finance@pawspace.in" });
  assert.equal(rev2.duplicatePrevented, true, "a second reversal is idempotent, not a double negative event");

  // A reward whose OWN policy snapshot forbids reversal must be refused.
  const now = Date.now();
  sqlite.prepare("INSERT INTO referral_rewards (id,claim_id,programme_id,referrer_customer_id,referred_customer_id,source_booking_id,amount,status,valid_until,policy_snapshot_json,released_at,created_at,updated_at) VALUES ('RWD-NOREV','CLAIM-NOREV','uat-referral-programme','CUS-REFERRER','CUS-REFERRED','BK-NOREV',200,'released',?,?,?,?,?)")
    .run(now + 30 * DAY, JSON.stringify({ reversalOnRefund: false }), now, now, now);
  await assert.rejects(
    () => ref.reverseReferralReward(db, { rewardId: "RWD-NOREV", reason: "refund", actorId: "finance@pawspace.in" }),
    /does not authorize automatic reversal/,
  );
});
