/**
 * PawSpace Total Journey Audit, Wave 2 — permanent behavioural regressions for the confirmed Marketing
 * and loyalty defects. Every case executes the real module or the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_MKT_DB__", "__PTJA_MKT_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_MKT_DB__ = db;
  globalThis.__PTJA_MKT_ENV__ = env;
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-W2-MKT-02 (ledger W2-09-M02) — concurrent grooming completion consumes TWO subscription sessions
// for ONE delivered service
//
// In app/api/grooming-lifecycle/route.ts the guarded usage flip
//   UPDATE booking_subscription_usage ... WHERE booking_id=? AND status='reserved'
// and the UNGUARDED counter move
//   UPDATE customer_grooming_subscriptions SET sessions_reserved=MAX(0,sessions_reserved-?),
//                                             sessions_consumed=sessions_consumed+? WHERE id=?
// sat in the SAME db.batch. A caller that loses the flip race still ran the counter update, so a second
// session was consumed that was never delivered.
//
// MEASURED: two concurrent POST /api/grooming-lifecycle {"action":"complete"} on one booking with one
// session reserved against a 10-session subscription. BOTH returned HTTP 200, and both bodies reported
// subscriptionUsage {sessions_reserved:1, sessions_consumed:1, status:'consumed'} - a single consumption
// in the response while the subscription counter had moved twice. The customer silently loses a prepaid
// session; the route's other completion writes are all INSERT OR IGNORE, so this was the one write that
// was not idempotent.
//
// The comment beside the batch asserted the opposite - "Double-consumption stays impossible via the
// usage row's status='reserved' guard above" - which is exactly the reasoning the batch defeats.
//
// This is the same defect already fixed inside lib/subscription-wallet.ts, whose consume branch carries
// the note "Previously both statements sat in one batch, so a lost race still ran the unconditional
// counter update and double-counted the consumption". The correction applies that same shape here: the
// guarded flip runs FIRST and alone, and only the caller whose UPDATE actually changed a row moves the
// counter.
// =====================================================================================================

async function groomingCompletionWorld() {
  const { sqlite, db } = world({ PAWSPACE_MEDIA_ENV: "uat", PAWSPACE_SCHEDULING_ENV: "uat" });
  const now = Date.now();
  sqlite.exec(`
CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
`);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('CUS-SESS','blr','Ananya Sharma','9999900601','ananya@example.test',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('BK-SESS','ik-sess','CUS-SESS','[\"PET-1\"]','[\"SRC-1\"]','blr','blr-east','grooming','dog-basic','Bath & Basic','GRP-SESS','PRV-GROOM-A','2026-08-22T04:30:00.000Z','2026-08-22T06:30:00.000Z','in_service',1899,'seed',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-SESS','BK-SESS','GRP-SESS','PRV-GROOM-A','Arun Groomer','full_time','grooming','2026-08-22T04:30:00.000Z','2026-08-22T06:30:00.000Z','in_service',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES ('PAY-SESS','BK-SESS','CUS-SESS',1899,0,'cash','pay_after_service','created','pik-sess',?,?)").run(now, now);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-MKT','ops.admin@pawspace.test','Ops admin','admin','active',?,?)").bind(now, now).run();

  // The route's own ensureTables creates the subscription and proof tables; run it once, then seed.
  const route = await import("../app/api/grooming-lifecycle/route.ts");
  await route.POST(new Request("https://uat.pawspace.in/api/grooming-lifecycle", {
    method: "POST", headers: { "content-type": "application/json", ...STAFF },
    body: JSON.stringify({ bookingId: "BK-SESS", action: "add_proof", beforePhotoRef: "uat://proof/BK-SESS/before", afterPhotoRef: "uat://proof/BK-SESS/after", checklist: ["bath", "dry"] }),
  }));
  sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES ('GSUB-1','CUS-SESS','groom10','dog-basic',10,1,0,'active',?,?,'BK-SUB-PURCHASE','v1',?,?)").run(now, now + 365 * 86400000, now, now);
  sqlite.prepare("INSERT INTO booking_subscription_usage (id,booking_id,customer_id,plan_code,sessions_reserved,sessions_consumed,status,created_at,updated_at) VALUES ('BSU-1','BK-SESS','CUS-SESS','GSUB-1',1,0,'reserved',?,?)").run(now, now);

  const complete = () => route.POST(new Request("https://uat.pawspace.in/api/grooming-lifecycle", {
    method: "POST", headers: { "content-type": "application/json", ...STAFF },
    body: JSON.stringify({ bookingId: "BK-SESS", action: "complete" }),
  })).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  const subscription = () => sqlite.prepare("SELECT sessions_reserved,sessions_consumed,status FROM customer_grooming_subscriptions WHERE id='GSUB-1'").get();
  return { sqlite, db, complete, subscription };
}

const STAFF = {
  "oai-authenticated-user-email": "ops.admin@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20admin",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

test("W2-MKT-02: two concurrent completions consume exactly one subscription session", async () => {
  const { complete, subscription } = await groomingCompletionWorld();

  const raced = await Promise.allSettled([complete(), complete()]);
  const after = subscription();
  assert.equal(Number(after.sessions_consumed), 1,
    `one delivered service consumes one session, never two: ${JSON.stringify(after)} / ${JSON.stringify(raced.map((r) => r.status))}`);
  assert.equal(Number(after.sessions_reserved), 0, "and the reservation is released exactly once");
});

test("W2-MKT-02: a single completion still consumes its session, and a replay changes nothing", async () => {
  // Non-vacuity. Refusing to move the counter at all would satisfy the case above and strand every
  // reserved session forever.
  const { complete, subscription } = await groomingCompletionWorld();

  const first = await complete();
  assert.equal(first.status, 200, `an ordinary completion still succeeds: ${JSON.stringify(first).slice(0, 300)}`);
  const afterFirst = subscription();
  assert.equal(Number(afterFirst.sessions_consumed), 1, "consuming its session");
  assert.equal(Number(afterFirst.sessions_reserved), 0, "and releasing the reservation");

  await complete();
  assert.deepEqual(subscription(), afterFirst, "a replay of the same completion changes nothing");
});

// =====================================================================================================
// PTJA-W2-MKT-03 (ledger W2-09-M03) — the referrer's monthly reward ceiling is exceeded by two
// concurrent qualifications
//
// qualifyReferralClaim reads the referrer's month-to-date reward count with a plain SELECT COUNT(*) and
// then inserts the reward in an UNGUARDED db.batch, so two qualifications that interleave at that await
// both see count 0 < limit 1 and both issue a reward.
//
// MEASURED: perReferrerMonthlyLimit 1, referrerReward 500. Two concurrent qualifyReferralClaim calls on
// different claims BOTH fulfilled - {amount:500,status:'released'} twice. Neither returned the
// 'Configured monthly reward limit reached' held state the code is written to produce. Rs 1,000 released
// against a Rs 500 configured monthly ceiling.
//
// The per-claim guards that DO exist (referral_rewards.claim_id UNIQUE, source_booking_id UNIQUE) stop
// the same claim being rewarded twice but say nothing about the cross-claim monthly cap - which is the
// only thing standing between a referrer and unbounded reward farming.
//
// The comparable ceiling in lib/coupon-governance.ts is enforced correctly, by putting the count inside
// the INSERT's own subquery so a breach produces a NULL against a NOT NULL column and the write fails
// rather than racing. This applies that same shape.
// =====================================================================================================

async function referralWorld({ monthlyLimit = 1, reward = 500 } = {}) {
  const { sqlite, db } = world();
  const referral = await import("../lib/referral-governance.ts");
  const now = Date.now();
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,city_id TEXT,status TEXT,total_amount REAL,created_at INTEGER,updated_at INTEGER);
CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL NOT NULL DEFAULT 0,status TEXT NOT NULL,idempotency_key TEXT,created_at INTEGER,updated_at INTEGER);
`);
  await referral.ensureReferralTables(db);
  const programme = await referral.saveReferralProgramme(db, {
    id: "uat-referral-programme", name: "UAT referral", status: "active",
    eligibleServices: ["grooming"], cityIds: ["blr"], rewardUseServices: ["grooming"],
    friendDiscount: 500, referrerReward: reward, perReferrerMonthlyLimit: monthlyLimit,
    rewardValidityDays: 30, reversalOnRefund: true, oneRewardPerFriend: true,
    validFrom: now - 86400000, validUntil: now + 86400000 * 30,
  }).catch((error) => ({ error: String(error?.message ?? error) }));
  return { sqlite, db, referral, programme, now };
}

test("W2-MKT-03: two concurrent qualifications cannot exceed the referrer's monthly ceiling", async () => {
  const { sqlite, db, referral, programme, now } = await referralWorld({ monthlyLimit: 1 });
  assert.ok(!programme?.error, `the programme must save: ${JSON.stringify(programme)}`);

  const customer = (id, phone) => sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, "blr", id, phone, `${id}@probe.test`.toLowerCase(), now, now);
  customer("REFERRER", "9000000001");
  const code = await referral.ensureReferralCode(db, { programmeId: "uat-referral-programme", customerId: "REFERRER" });
  const claims = [];
  for (const [index, friend] of ["FRIEND-2", "FRIEND-3"].entries()) {
    customer(friend, `900000001${index + 2}`);
    const claim = await referral.claimReferral(db, {
      code: String(code.code ?? code), referredCustomerId: friend, serviceCode: "grooming", cityId: "blr",
      idempotencyKey: `claim-${friend}`, actorId: "cust:uat",
    });
    claims.push(String(claim.claimId ?? claim.claim?.id ?? ""));
    const bookingId = `BK-${friend}`;
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,status,total_amount,created_at,updated_at) VALUES (?,?,'grooming','blr','completed',2000,?,?)").run(bookingId, friend, now, now);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,2000,2000,'captured',?,?,?)").run(`PAY-${friend}`, bookingId, friend, `pk-${friend}`, now, now);
  }

  const raced = await Promise.allSettled(claims.map((claimId, index) =>
    referral.qualifyReferralClaim(db, { claimId, bookingId: `BK-FRIEND-${index + 2}`, idempotencyKey: `q${index + 2}`, actorId: "ops:uat" })));
  const released = sqlite.prepare("SELECT COUNT(*) n,COALESCE(SUM(amount),0) total FROM referral_rewards WHERE status IN ('pending','released','uat_reserved')").get();
  assert.equal(Number(released.n), 1,
    `a monthly limit of 1 must release exactly one reward: ${JSON.stringify(released)} / ${JSON.stringify(raced.map((r) => r.status === "fulfilled" ? r.value : String(r.reason)))}`);
  assert.equal(Number(released.total), 500, "and Rs 500, not Rs 1,000, against a Rs 500 configured ceiling");
});

test("W2-MKT-03: a referrer within the ceiling is still rewarded", async () => {
  // Non-vacuity. Refusing the second qualification unconditionally would satisfy the case above and
  // break every programme whose limit is above 1.
  const { sqlite, db, referral, programme, now } = await referralWorld({ monthlyLimit: 5 });
  assert.ok(!programme?.error, `the programme must save: ${JSON.stringify(programme)}`);

  const customer = (id, phone) => sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, "blr", id, phone, `${id}@probe.test`.toLowerCase(), now, now);
  customer("REFERRER", "9000000001");
  const code = await referral.ensureReferralCode(db, { programmeId: "uat-referral-programme", customerId: "REFERRER" });
  const claims = [];
  for (const [index, friend] of ["FRIEND-2", "FRIEND-3"].entries()) {
    customer(friend, `900000001${index + 2}`);
    const claim = await referral.claimReferral(db, {
      code: String(code.code ?? code), referredCustomerId: friend, serviceCode: "grooming", cityId: "blr",
      idempotencyKey: `claim-${friend}`, actorId: "cust:uat",
    });
    claims.push(String(claim.claimId ?? claim.claim?.id ?? ""));
    const bookingId = `BK-${friend}`;
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,status,total_amount,created_at,updated_at) VALUES (?,?,'grooming','blr','completed',2000,?,?)").run(bookingId, friend, now, now);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,2000,2000,'captured',?,?,?)").run(`PAY-${friend}`, bookingId, friend, `pk-${friend}`, now, now);
  }

  await Promise.allSettled(claims.map((claimId, index) =>
    referral.qualifyReferralClaim(db, { claimId, bookingId: `BK-FRIEND-${index + 2}`, idempotencyKey: `q${index + 2}`, actorId: "ops:uat" })));
  const released = sqlite.prepare("SELECT COUNT(*) n FROM referral_rewards WHERE status IN ('pending','released','uat_reserved')").get();
  assert.equal(Number(released.n), 2, "both qualifications are rewarded when the ceiling allows it");
});

// =====================================================================================================
// PTJA-W2-MKT-04 (ledger W2-09-M04) — a referral claim still discounts a booking after its programme is
// paused, out of window, and its discount set to zero
//
// prepareReferralBooking validates only the CLAIM row - status, fraud_state, customer, service/city,
// first-booking, identity collision - and reads friendDiscount out of the claim's frozen
// policy_snapshot_json. It never re-reads referral_programmes, so a paused programme, an elapsed
// validity window and a changed or zeroed friend discount are all invisible at redemption time.
//
// MEASURED: with the owning programme paused, its validity window moved wholly into the past, and its
// friend_discount set to 0, prepareReferralBooking still returned {discountAmount:500, totalAmount:1500,
// baseAmount:2000} - a Rs 500 discount from a programme that is paused, expired by 300 days, and
// configured to give nothing.
//
// Expiry and shutdown were enforced only at CLAIM time and in the listing surfaces, never at the moment
// money is given away, so every claim ever created stayed redeemable forever at its original value and
// marketing had no way to stop the bleed short of rejecting each claim by hand.
//
// The correction re-reads the programme at redemption and refuses when it is not active or the window
// has elapsed. It deliberately does NOT change which AMOUNT applies: the frozen snapshot still sets the
// discount for a live programme, because that is what the snapshot is for and re-pricing an outstanding
// claim would be a marketing decision. Pausing exists to stop the bleed; that is all this restores.
// =====================================================================================================

async function referralRedemptionWorld() {
  const { sqlite, db, referral, now } = await referralWorld({ monthlyLimit: 5 });
  const booking = await import("../lib/referral-booking-governance.ts");
  await booking.ensureReferralBookingTables(db);
  const customer = (id, phone) => sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, "blr", id, phone, `${id}@probe.test`.toLowerCase(), now, now);
  customer("REFERRER", "9000000001");
  customer("FRIEND-1", "9000000011");
  const code = await referral.ensureReferralCode(db, { programmeId: "uat-referral-programme", customerId: "REFERRER" });
  const claim = await referral.claimReferral(db, {
    code: String(code.code ?? code), referredCustomerId: "FRIEND-1", serviceCode: "grooming", cityId: "blr",
    idempotencyKey: "claim-friend-1", actorId: "cust:uat",
  });
  const claimId = String(claim.claimId ?? claim.claim?.id ?? "");
  const prepare = () => booking.prepareReferralBooking(db, {
    claimId, customer: { id: "FRIEND-1", primaryPhone: "9000000011", email: "friend-1@probe.test" },
    serviceCode: "grooming", cityId: "blr", baseAmount: 2000, baseAmountDueNow: 2000,
    hasOtherOffer: false, isSubscription: false,
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: String(error?.message ?? error) }));
  return { sqlite, db, prepare, now };
}

test("W2-MKT-04: a paused programme stops discounting outstanding claims", async () => {
  const { sqlite, prepare } = await referralRedemptionWorld();

  const live = await prepare();
  assert.equal(live.ok, true, `a live programme still discounts: ${JSON.stringify(live)}`);
  assert.equal(live.value.discountAmount, 500, "at its configured Rs 500");

  sqlite.prepare("UPDATE referral_programmes SET status='paused' WHERE id='uat-referral-programme'").run();
  const paused = await prepare();
  assert.equal(paused.ok, false, `a paused programme must give nothing away: ${JSON.stringify(paused)}`);
});

test("W2-MKT-04: an elapsed validity window stops discounting too", async () => {
  const { sqlite, prepare, now } = await referralRedemptionWorld();

  sqlite.prepare("UPDATE referral_programmes SET valid_from=?,valid_until=? WHERE id='uat-referral-programme'")
    .run(now - 400 * 86400000, now - 300 * 86400000);
  const expired = await prepare();
  assert.equal(expired.ok, false, `a programme expired by 300 days must give nothing away: ${JSON.stringify(expired)}`);
});

test("W2-MKT-04: a live programme in window is unaffected, and the frozen amount still applies", async () => {
  // Non-vacuity, and the deliberate limit of this fix: which AMOUNT applies is unchanged. The snapshot
  // still sets the discount for a live programme - re-pricing an outstanding claim would be a marketing
  // decision, not an engineering one.
  const { sqlite, prepare } = await referralRedemptionWorld();

  sqlite.prepare("UPDATE referral_programmes SET friend_discount=250 WHERE id='uat-referral-programme'").run();
  const stillLive = await prepare();
  assert.equal(stillLive.ok, true, `a live programme still redeems: ${JSON.stringify(stillLive)}`);
  assert.equal(stillLive.value.discountAmount, 500,
    "at the amount frozen into the claim, which this fix deliberately does not change");
});
