import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Task 23 audit — the remaining verticals and cross-cutting surfaces: funeral
// manual orders (GST toggle maths), relocation enquiry intake, service reviews
// and their reward codes, and the risk/anomaly flag workflow. Real execution
// over real SQLite; the honest scope of each module is asserted rather than
// polished over.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const NOW = 1770000000000;
const OPS = "ops.one@pawspace.in";
const OPS_TWO = "ops.two@pawspace.in";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_name TEXT,provider_id TEXT,status TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT,total_amount REAL NOT NULL,currency TEXT DEFAULT 'INR',created_at INTEGER,updated_at INTEGER)");
  return { sqlite, db };
}
function booking(sqlite, id, customerId, serviceCode, status = "completed", amount = 1349) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,provider_id,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, customerId, serviceCode, "Package", "PROV-1", status, "2026-07-10T05:00:00.000Z", "2026-07-10T06:00:00.000Z", amount, "INR", NOW, NOW);
}

// ---------------------------------------------------------------------------
// 1. Funeral manual orders: GST off by default, exact maths when switched on.
// ---------------------------------------------------------------------------
test("funeral manual orders charge no GST by default and exactly 18% once switched on", async () => {
  const { sqlite, db } = fresh();
  const funeral = await import("../lib/funeral-manual-order.ts");

  const noGst = await funeral.recordFuneralConvertedOrder(db, { customerName: "Ravi Kumar", phone: "9876500001", paymentMethod: "upi", orderValue: 12000, orderDate: "2026-07-10", actorId: OPS });
  assert.equal(noGst.gstEnabled, false);
  assert.equal(noGst.gstAmount, 0);
  assert.equal(noGst.totalAmount, 12000, "GST is off by default, so the customer pays the order value");

  await funeral.setFuneralManualGstMode(db, { enabled: true, actorId: OPS });
  const withGst = await funeral.recordFuneralConvertedOrder(db, { customerName: "Sana Iqbal", phone: "9876500002", paymentMethod: "card", orderValue: 12000, orderDate: "2026-07-11", actorId: OPS });
  assert.equal(withGst.gstEnabled, true);
  assert.equal(withGst.gstAmount, 2160, "18% of Rs.12,000");
  assert.equal(withGst.totalAmount, 14160);

  // The toggle applies to future orders only: the earlier order is untouched.
  const directory = await funeral.funeralManualOrderDirectory(db);
  const first = directory.orders.find((row) => row.customerName === "Ravi Kumar");
  assert.equal(first.gstAmount, 0, "switching GST on does not retroactively re-tax a captured order");
  assert.equal(directory.gstEnabled, true);
  assert.equal(directory.truth.gstChargedByDefault, false);
  assert.equal(directory.truth.liveMoney, false, "the module is honest that no live money moved");

  // Rounding is money-exact, not floating-point noise.
  const odd = await funeral.recordFuneralConvertedOrder(db, { customerName: "Odd Amount", phone: "9876500003", paymentMethod: "cash", orderValue: 8333.33, orderDate: "2026-07-12", actorId: OPS });
  assert.equal(odd.gstAmount, 1500, "18% of 8333.33 = 1500.00 (rounded to paise)");
  assert.equal(odd.totalAmount, 9833.33);

  await assert.rejects(() => funeral.setFuneralManualGstMode(db, { enabled: true, gstRate: 18, actorId: OPS }), /fraction between 0 and 1/);
  await assert.rejects(() => funeral.recordFuneralConvertedOrder(db, { customerName: "", phone: "9876500004", paymentMethod: "upi", orderValue: 100, orderDate: "2026-07-10", actorId: OPS }), /Customer name is required/);
  await assert.rejects(() => funeral.recordFuneralConvertedOrder(db, { customerName: "No Value", phone: "9876500004", paymentMethod: "upi", orderValue: 0, orderDate: "2026-07-10", actorId: OPS }), /Order value must be positive/);
  await assert.rejects(() => funeral.recordFuneralConvertedOrder(db, { customerName: "Bad Date", phone: "9876500004", paymentMethod: "upi", orderValue: 100, orderDate: "10-07-2026", actorId: OPS }), /real order date is required/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM funeral_manual_orders").get().c, 3, "rejected captures write nothing");
});

// ---------------------------------------------------------------------------
// 2. Relocation enquiry: validation + domestic/international capture.
// ---------------------------------------------------------------------------
test("relocation enquiry validates contact details and records domestic vs international", async () => {
  const { sqlite, db } = fresh();
  const relocation = await import("../lib/relocation-enquiry.ts");
  const valid = {
    customerName: "Priya Nair", phonePrimary: "9876500010", email: "priya@example.test", petType: "dog",
    relocationKind: "international", pickupDate: "2026-09-01", pickupApproxTime: "09:30",
    pickupLocation: "Indiranagar, Bengaluru", dropLocation: "Dubai, UAE", expectedTravelDate: "2026-09-05",
  };
  const created = await relocation.createRelocationEnquiry(db, valid);
  assert.equal(created.relocationKind, "international");
  assert.equal(created.status, "new");

  const domestic = await relocation.createRelocationEnquiry(db, { ...valid, relocationKind: "domestic", dropLocation: "Pune, Maharashtra", email: "priya2@example.test" });
  assert.equal(domestic.relocationKind, "domestic");

  await assert.rejects(() => relocation.createRelocationEnquiry(db, { ...valid, relocationKind: "interplanetary" }), /domestic|international/i);
  await assert.rejects(() => relocation.createRelocationEnquiry(db, { ...valid, phonePrimary: "12345" }), /phone/i);
  await assert.rejects(() => relocation.createRelocationEnquiry(db, { ...valid, email: "not-an-email" }), /email/i);
  await assert.rejects(() => relocation.createRelocationEnquiry(db, { ...valid, petType: "dragon" }), /dog|cat/i);
  await assert.rejects(() => relocation.createRelocationEnquiry(db, { ...valid, pickupApproxTime: "25:00" }), /time/i);
  await assert.rejects(() => relocation.createRelocationEnquiry(db, { ...valid, pickupDate: "01-09-2026" }), /date/i);

  const list = await relocation.listRelocationEnquiries(db);
  assert.equal(list.length, 2, "only the two valid enquiries were stored");
  assert.deepEqual([...new Set(list.map((row) => row.relocationKind))].sort(), ["domestic", "international"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM relocation_enquiries").get().c, 2);
});

// ---------------------------------------------------------------------------
// 3. Service reviews: cadence, ownership, reward maths, one-time redemption.
// ---------------------------------------------------------------------------
async function reviewWorld() {
  const { sqlite, db } = fresh();
  const config = await import("../lib/review-configuration-governance.ts");
  const reviews = await import("../lib/service-review-governance.ts");
  await reviews.ensureServiceReviewTables(db);
  const activate = async (payload) => {
    const draft = await config.saveReviewConfig(db, payload, OPS);
    await config.approveReviewConfig(db, { id: draft.id, approvalReference: "OPS-2026-07", actor: OPS_TWO });
    return draft;
  };
  return { sqlite, db, config, reviews, activate };
}

test("review config is maker/checker gated and drives the request cadence", async () => {
  const { db, config, reviews, activate } = await reviewWorld();
  const draft = await config.saveReviewConfig(db, { serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] }, OPS);
  await assert.rejects(() => config.approveReviewConfig(db, { id: draft.id, approvalReference: "OPS-1", actor: OPS }), /cannot approve their own review config/);
  await assert.rejects(() => config.approveReviewConfig(db, { id: draft.id, approvalReference: "  ", actor: OPS_TWO }), /approval reference is required/);
  await config.approveReviewConfig(db, { id: draft.id, approvalReference: "OPS-2026-07", actor: OPS_TWO });

  // Without an active config for a service, nothing is requested (rather than a guessed default).
  const none = await reviews.requestServiceReview(db, { bookingId: "BK-NOCFG", serviceCode: "pet_taxi", customerId: "CUS-1" });
  assert.equal(none.requested, false);
  assert.equal(none.reason, "no_active_review_config");

  const first = await reviews.requestServiceReview(db, { bookingId: "BK-G1", serviceCode: "grooming", customerId: "CUS-1" });
  assert.equal(first.requested, true);
  const replay = await reviews.requestServiceReview(db, { bookingId: "BK-G1", serviceCode: "grooming", customerId: "CUS-1" });
  assert.equal(replay.requested, false);
  assert.equal(replay.reason, "already_requested", "a completed booking is not asked twice");

  // Training asks every 3rd session only.
  await activate({ serviceCode: "dog_training", questions: [{ text: "How is the training going?" }], triggerType: "every_n_sessions", triggerInterval: 3, channels: ["notification"] });
  assert.equal((await reviews.requestServiceReview(db, { bookingId: "BK-T1", serviceCode: "dog_training", customerId: "CUS-1", completedSessionCount: 2 })).reason, "cadence_not_reached");
  const third = await reviews.requestServiceReview(db, { bookingId: "BK-T1", serviceCode: "dog_training", customerId: "CUS-1", completedSessionCount: 3 });
  assert.equal(third.requested, true);
  assert.equal(third.sequence, 1);
  const sixth = await reviews.requestServiceReview(db, { bookingId: "BK-T1", serviceCode: "dog_training", customerId: "CUS-1", completedSessionCount: 6 });
  assert.equal(sixth.requested, true);
  assert.equal(sixth.sequence, 2, "the same training booking asks again at the next cadence point");
});

test("review submission is owner-only, single-shot, and only 5 stars offers the public-review reward", async () => {
  const { db, reviews, activate } = await reviewWorld();
  await activate({ serviceCode: "grooming", questions: [{ text: "How was the groomer?" }, { text: "Was the pet comfortable?" }], triggerType: "every_service", channels: ["notification"] });
  const request = await reviews.requestServiceReview(db, { bookingId: "BK-R1", serviceCode: "grooming", customerId: "CUS-1" });

  await assert.rejects(() => reviews.submitServiceReview(db, { requestId: request.requestId, customerId: "CUS-OTHER", stars: 5 }), /only submit your own review/);
  await assert.rejects(() => reviews.submitServiceReview(db, { requestId: request.requestId, customerId: "CUS-1", stars: 6 }), /whole number from 1 to 5/);
  await assert.rejects(() => reviews.submitServiceReview(db, { requestId: request.requestId, customerId: "CUS-1", stars: 4.5 }), /whole number from 1 to 5/);

  const threeStar = await reviews.requestServiceReview(db, { bookingId: "BK-R2", serviceCode: "grooming", customerId: "CUS-1" });
  const low = await reviews.submitServiceReview(db, { requestId: threeStar.requestId, customerId: "CUS-1", stars: 3, answers: { comment: "Late arrival" } });
  assert.equal(low.fiveStar, false);
  assert.ok(!("publicReviewRewardAvailable" in low), "a 3-star review is not asked to post publicly");

  const high = await reviews.submitServiceReview(db, { requestId: request.requestId, customerId: "CUS-1", stars: 5 });
  assert.equal(high.fiveStar, true);
  assert.equal(high.publicReviewRewardAvailable, true);
  assert.ok(high.googleReviewLink.startsWith("https://"));
  await assert.rejects(() => reviews.submitServiceReview(db, { requestId: request.requestId, customerId: "CUS-1", stars: 5 }), /already been submitted/);
});

test("public-review rewards: Rs.250 for one platform, Rs.400 grooming-only for both, single-use", async () => {
  const { sqlite, db, reviews, activate } = await reviewWorld();
  await activate({ serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] });
  booking(sqlite, "BK-CLAIM", "CUS-1", "grooming");
  booking(sqlite, "BK-BOARD", "CUS-1", "boarding");
  booking(sqlite, "BK-STRANGER", "CUS-OTHER", "grooming");

  await assert.rejects(() => reviews.claimPublicReview(db, { bookingId: "BK-STRANGER", customerId: "CUS-1", platform: "google", actorId: "CUS-1" }), /your own order/);
  await assert.rejects(() => reviews.claimPublicReview(db, { bookingId: "BK-CLAIM", customerId: "CUS-1", platform: "instagram", actorId: "CUS-1" }), /'google' or 'app'/);

  const google = await reviews.claimPublicReview(db, { bookingId: "BK-CLAIM", customerId: "CUS-1", platform: "google", actorId: "CUS-1" });
  assert.equal(google.reward.discount, 250);
  assert.equal(google.reward.scope, "any");
  assert.equal(google.verification, "self_declared", "we cannot verify a Google review without their API, and say so");

  const app = await reviews.claimPublicReview(db, { bookingId: "BK-CLAIM", customerId: "CUS-1", platform: "app", actorId: "CUS-1" });
  assert.equal(app.claimNumber, 2);
  assert.equal(app.reward.discount, 400);
  assert.equal(app.reward.scope, "grooming");

  await assert.rejects(() => reviews.claimPublicReview(db, { bookingId: "BK-CLAIM", customerId: "CUS-1", platform: "google", actorId: "CUS-1" }), /already claimed/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM review_reward_codes WHERE customer_id='CUS-1'").get().c, 2, "a rejected re-claim issues no extra reward");

  // The Rs.400 reward is grooming-only; the Rs.250 one works anywhere.
  await assert.rejects(() => reviews.redeemReviewReward(db, { code: app.reward.code, customerId: "CUS-1", bookingId: "BK-BOARD", actorId: "CUS-1" }), /valid on grooming only/);
  await assert.rejects(() => reviews.redeemReviewReward(db, { code: google.reward.code, customerId: "CUS-OTHER", bookingId: "BK-STRANGER", actorId: "CUS-OTHER" }), /belongs to another account/);
  const redeemed = await reviews.redeemReviewReward(db, { code: google.reward.code, customerId: "CUS-1", bookingId: "BK-BOARD", actorId: "CUS-1" });
  assert.equal(redeemed.discountApplied, 250);
  assert.equal(redeemed.duplicatePrevented, false);
  await assert.rejects(() => reviews.redeemReviewReward(db, { code: google.reward.code, customerId: "CUS-1", bookingId: "BK-BOARD", actorId: "CUS-1" }), /already been used/);

  const remaining = await reviews.listReviewRewards(db, "CUS-1");
  assert.deepEqual(remaining.map((row) => row.discount), [400], "only the unspent reward is still offered");
});

test("a review reward cannot be spent twice by two concurrent redemptions", async () => {
  const { sqlite, db, reviews, activate } = await reviewWorld();
  await activate({ serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] });
  booking(sqlite, "BK-RACE", "CUS-R", "grooming");
  booking(sqlite, "BK-RACE-A", "CUS-R", "grooming");
  booking(sqlite, "BK-RACE-B", "CUS-R", "grooming");
  const claim = await reviews.claimPublicReview(db, { bookingId: "BK-RACE", customerId: "CUS-R", platform: "google", actorId: "CUS-R" });
  const results = await Promise.allSettled([
    reviews.redeemReviewReward(db, { code: claim.reward.code, customerId: "CUS-R", bookingId: "BK-RACE-A", actorId: "CUS-R" }),
    reviews.redeemReviewReward(db, { code: claim.reward.code, customerId: "CUS-R", bookingId: "BK-RACE-B", actorId: "CUS-R" }),
  ]);
  const applied = results.filter((r) => r.status === "fulfilled" && r.value.duplicatePrevented === false);
  assert.equal(applied.length, 1, "only one booking gets the discount");
  const row = sqlite.prepare("SELECT status,redeemed_booking_id FROM review_reward_codes WHERE code=?").get(claim.reward.code);
  assert.equal(row.status, "redeemed");
  assert.ok(["BK-RACE-A", "BK-RACE-B"].includes(row.redeemed_booking_id));
});

test("rejecting a self-declared review claim voids its unspent reward", async () => {
  const { sqlite, db, reviews, activate } = await reviewWorld();
  await activate({ serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] });
  booking(sqlite, "BK-FAKE", "CUS-F", "grooming");
  booking(sqlite, "BK-FAKE-USE", "CUS-F", "grooming");
  const claim = await reviews.claimPublicReview(db, { bookingId: "BK-FAKE", customerId: "CUS-F", platform: "google", actorId: "CUS-F" });
  const claimId = sqlite.prepare("SELECT id FROM review_public_claims WHERE booking_id='BK-FAKE'").get().id;

  const rejected = await reviews.verifyPublicReview(db, { claimId, actor: OPS, verified: false });
  assert.equal(rejected.verificationStatus, "rejected");
  assert.equal(rejected.rewardVoided, true, "a claim staff found to be false must not keep buying a discount");
  await assert.rejects(() => reviews.redeemReviewReward(db, { code: claim.reward.code, customerId: "CUS-F", bookingId: "BK-FAKE-USE", actorId: "CUS-F" }), /already been used/);

  // A verified claim keeps its reward.
  booking(sqlite, "BK-REAL", "CUS-F", "grooming");
  const good = await reviews.claimPublicReview(db, { bookingId: "BK-REAL", customerId: "CUS-F", platform: "google", actorId: "CUS-F" });
  const goodId = sqlite.prepare("SELECT id FROM review_public_claims WHERE booking_id='BK-REAL'").get().id;
  const verified = await reviews.verifyPublicReview(db, { claimId: goodId, actor: OPS, verified: true });
  assert.equal(verified.verificationStatus, "verified");
  assert.equal(verified.rewardVoided, false);
  const redeemed = await reviews.redeemReviewReward(db, { code: good.reward.code, customerId: "CUS-F", bookingId: "BK-FAKE-USE", actorId: "CUS-F" });
  assert.equal(redeemed.discountApplied, 250);
});

test("the review sweep only chases completed bookings of every-service verticals", async () => {
  const { sqlite, db, reviews, activate } = await reviewWorld();
  await activate({ serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] });
  await activate({ serviceCode: "dog_training", questions: [{ text: "How is training going?" }], triggerType: "every_n_sessions", triggerInterval: 3, channels: ["notification"] });
  booking(sqlite, "BK-SW-DONE", "CUS-1", "grooming", "completed");
  booking(sqlite, "BK-SW-OPEN", "CUS-1", "grooming", "confirmed");
  booking(sqlite, "BK-SW-CANCELLED", "CUS-1", "grooming", "cancelled");
  booking(sqlite, "BK-SW-TRAINING", "CUS-1", "dog_training", "completed");

  const sweep = await reviews.runServiceReviewSweep(db, { asOf: NOW });
  assert.equal(sweep.requested, 1, "only the completed grooming booking is chased");
  const requested = sqlite.prepare("SELECT booking_id FROM review_requests").all().map((row) => row.booking_id);
  assert.deepEqual(requested, ["BK-SW-DONE"]);
  const again = await reviews.runServiceReviewSweep(db, { asOf: NOW + 60000 });
  assert.equal(again.requested, 0, "the five-minute scheduler does not re-ask the same customer");
});

// ---------------------------------------------------------------------------
// 4. Risk/anomaly: flags are advisory, human-reviewed, and never move money.
// ---------------------------------------------------------------------------
test("risk sweep flags reward farming from real claim history and never touches money", async () => {
  const { sqlite, db, reviews, activate } = await reviewWorld();
  const risk = await import("../lib/risk-anomaly-governance.ts");
  await activate({ serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] });

  // A farmer: claims rewards on several orders without ever leaving a 5-star review in our flow.
  for (let index = 1; index <= 4; index++) {
    booking(sqlite, `BK-FARM-${index}`, "CUS-FARM", "grooming");
    await reviews.claimPublicReview(db, { bookingId: `BK-FARM-${index}`, customerId: "CUS-FARM", platform: "google", actorId: "CUS-FARM" });
    await reviews.claimPublicReview(db, { bookingId: `BK-FARM-${index}`, customerId: "CUS-FARM", platform: "app", actorId: "CUS-FARM" });
  }
  // An honest customer: one claim, backed by a real 5-star review.
  booking(sqlite, "BK-HONEST", "CUS-HONEST", "grooming");
  const request = await reviews.requestServiceReview(db, { bookingId: "BK-HONEST", serviceCode: "grooming", customerId: "CUS-HONEST" });
  await reviews.submitServiceReview(db, { requestId: request.requestId, customerId: "CUS-HONEST", stars: 5 });
  await reviews.claimPublicReview(db, { bookingId: "BK-HONEST", customerId: "CUS-HONEST", platform: "google", actorId: "CUS-HONEST" });

  const sweep = await risk.runRiskAnomalySweep(db, { asOf: NOW });
  assert.ok(sweep.reviewRewardsFlagsOpen >= 1, "the farming pattern raises at least one flag");
  const flags = await risk.listRiskFlags(db, { domain: "review_rewards" });
  const farmer = flags.find((flag) => flag.subjectId === "CUS-FARM");
  assert.ok(farmer, "the farming customer is flagged");
  assert.ok(farmer.score >= 0.4, `score should be at least medium (was ${farmer.score})`);
  assert.equal(farmer.status, "open");
  assert.ok(farmer.signals.claimsWithoutReview >= 4, "the flag cites the real signal that raised it");
  assert.ok(!flags.some((flag) => flag.subjectId === "CUS-HONEST"), "one genuine, review-backed claim is not flagged");

  // Flagging never voids or spends anything: the rewards are all still exactly as issued.
  const rewardStatuses = sqlite.prepare("SELECT DISTINCT status FROM review_reward_codes").all().map((row) => row.status);
  assert.deepEqual(rewardStatuses, ["issued"], "the risk engine flags for a human and moves no money itself");

  // Re-running the sweep refreshes the flag rather than duplicating it.
  await risk.runRiskAnomalySweep(db, { asOf: NOW + 60000 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM risk_flags WHERE subject_id='CUS-FARM' AND domain='review_rewards'").get().c, 1);
});

test("a risk flag is decided once, with a note, by a human", async () => {
  const { sqlite, db, reviews, activate } = await reviewWorld();
  const risk = await import("../lib/risk-anomaly-governance.ts");
  await activate({ serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] });
  for (let index = 1; index <= 4; index++) {
    booking(sqlite, `BK-RF-${index}`, "CUS-RF", "grooming");
    await reviews.claimPublicReview(db, { bookingId: `BK-RF-${index}`, customerId: "CUS-RF", platform: "google", actorId: "CUS-RF" });
    await reviews.claimPublicReview(db, { bookingId: `BK-RF-${index}`, customerId: "CUS-RF", platform: "app", actorId: "CUS-RF" });
  }
  await risk.runRiskAnomalySweep(db, { asOf: NOW });
  const flag = (await risk.listRiskFlags(db, { domain: "review_rewards", status: "open" }))[0];
  assert.ok(flag, "there is an open flag to review");

  await assert.rejects(() => risk.reviewRiskFlag(db, { id: flag.id, decision: "banned", note: "Not a supported decision", actor: OPS }), /'cleared' or 'actioned'/);
  await assert.rejects(() => risk.reviewRiskFlag(db, { id: flag.id, decision: "cleared", note: "ok", actor: OPS }), /review note is required/);

  const results = await Promise.allSettled([
    risk.reviewRiskFlag(db, { id: flag.id, decision: "actioned", note: "Confirmed abuse, rewards revoked manually", actor: OPS }),
    risk.reviewRiskFlag(db, { id: flag.id, decision: "cleared", note: "Looks fine to me on second glance", actor: OPS_TWO }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "two reviewers cannot both decide the same flag");
  const row = sqlite.prepare("SELECT status,reviewed_by,review_note FROM risk_flags WHERE id=?").get(flag.id);
  assert.ok(["actioned", "cleared"].includes(row.status));
  assert.ok(row.review_note.length >= 5, "the decision carries the reviewer's real note");
  await assert.rejects(() => risk.reviewRiskFlag(db, { id: flag.id, decision: "cleared", note: "Trying to overturn it later", actor: OPS }), /already been reviewed/);
});

// ---------------------------------------------------------------------------
// 5. Honest-scope guards across these verticals.
// ---------------------------------------------------------------------------
test("misc vertical modules do not fabricate values or use banned DB access", () => {
  for (const path of [
    "lib/funeral-manual-order.ts", "lib/funeral-memorial-governance.ts",
    "lib/relocation-enquiry.ts", "lib/relocation-governance.ts",
    "lib/service-review-governance.ts", "lib/review-configuration-governance.ts",
    "lib/risk-anomaly-governance.ts", "lib/catalogue-governance.ts", "lib/i18n-governance.ts",
  ]) {
    const source = read(path);
    assert.ok(!/Math\.random/.test(source), `${path} must not fabricate values with Math.random`);
    assert.ok(!/globalThis\.__D1__/.test(source), `${path} must not use the banned globalThis D1 pattern`);
  }
});

test("the risk engine is documented and implemented as flag-only, never an autonomous money action", () => {
  const source = read("lib/risk-anomaly-governance.ts");
  assert.ok(/NEVER blocks money|never blocks money/i.test(source), "the module states its non-autonomous scope");
  // The doc comment names refunds/payouts as forbidden autonomous actions; what matters is that no
  // money-moving statement exists in the module at all.
  for (const forbidden of ["UPDATE pawspace_wallet_ledger", "INSERT INTO pawspace_wallet_ledger", "UPDATE review_reward_codes", "UPDATE booking_payments", "INSERT INTO booking_payments"]) {
    assert.ok(!source.includes(forbidden), `the risk engine must not itself perform: ${forbidden}`);
  }
  const writes = [...source.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map((match) => match[2]);
  assert.deepEqual([...new Set(writes)].sort(), ["risk_flags"], "the only table the risk engine writes is its own flag table");
});
