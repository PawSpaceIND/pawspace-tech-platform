import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function makeD1(sqlite) {
  function statement(sql, args = []) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: sql => statement(sql),
    batch: async statements => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function stack() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE canonical_customers (
      id TEXT PRIMARY KEY,
      primary_phone TEXT,
      email TEXT
    );
    CREATE TABLE canonical_bookings (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      service_code TEXT NOT NULL,
      city_id TEXT NOT NULL,
      package_code TEXT NOT NULL,
      status TEXT NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE booking_payments (
      booking_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      amount REAL NOT NULL
    );
  `);
  return { sqlite, db: makeD1(sqlite) };
}

function customer(sqlite, id, suffix) {
  sqlite.prepare("INSERT INTO canonical_customers (id,primary_phone,email) VALUES (?,?,?)")
    .run(id, `+91990000${suffix}`, `${id.toLowerCase()}@pawspace.test`);
}

function booking(sqlite, { id, customerId, service = "grooming", city = "blr", packageCode = "grooming-basic", status = "confirmed", createdAt = Date.now() }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,package_code,status,total_amount,created_at) VALUES (?,?,?,?,?,?,1200,?)")
    .run(id, customerId, service, city, packageCode, status, createdAt);
}

test("coupon quote, consumption and retry execute against persisted commercial truth", async () => {
  const { sqlite, db } = stack();
  const coupons = await import("../lib/coupon-governance.ts");
  booking(sqlite, { id: "BK-COUPON-A", customerId: "CUS-A", service: "boarding", packageCode: "boarding-24h" });

  const quote = await coupons.quoteCoupon(db, {
    code: "UATCARE100", customerId: "CUS-A", serviceCode: "boarding", cityId: "blr",
    channel: "customer_app", packageCode: "boarding-24h", orderValue: 1200,
    paymentMode: "full", isSubscription: false,
  });
  assert.equal(quote.valid, true);
  assert.equal(quote.discount, 100);
  assert.equal(quote.finalAmount, 1100);

  const input = { quoteId: quote.quoteId, bookingId: "BK-COUPON-A", customerId: "CUS-A", idempotencyKey: "coupon-consume-a" };
  const consumed = await coupons.consumeCouponQuote(db, input);
  assert.equal(consumed.duplicatePrevented, false);
  const replay = await coupons.consumeCouponQuote(db, input);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM coupon_redemptions").get().count, 1);
});

test("coupon expiry, unsupported city and cross-payload idempotency reuse fail closed", async () => {
  const { sqlite, db } = stack();
  const coupons = await import("../lib/coupon-governance.ts");
  booking(sqlite, { id: "BK-COUPON-A", customerId: "CUS-A" });
  booking(sqlite, { id: "BK-COUPON-B", customerId: "CUS-B" });
  const base = {
    code: "UATCARE100", customerId: "CUS-A", serviceCode: "grooming", cityId: "blr",
    channel: "customer_app", packageCode: "grooming-basic", orderValue: 1200,
    paymentMode: "full", isSubscription: false,
  };
  const unsupported = await coupons.quoteCoupon(db, { ...base, cityId: "unknown-city" });
  assert.equal(unsupported.valid, false);
  assert.match(unsupported.error, /not eligible in this city/i);

  const expired = await coupons.quoteCoupon(db, base);
  sqlite.prepare("UPDATE coupon_quotes SET expires_at=? WHERE id=?").run(Date.now() - 1, expired.quoteId);
  await assert.rejects(
    coupons.consumeCouponQuote(db, { quoteId: expired.quoteId, bookingId: "BK-COUPON-A", customerId: "CUS-A", idempotencyKey: "expired-coupon" }),
    /expired/i,
  );

  const valid = await coupons.quoteCoupon(db, base);
  await coupons.consumeCouponQuote(db, { quoteId: valid.quoteId, bookingId: "BK-COUPON-A", customerId: "CUS-A", idempotencyKey: "bound-coupon-key" });
  await assert.rejects(
    coupons.consumeCouponQuote(db, { quoteId: valid.quoteId, bookingId: "BK-COUPON-B", customerId: "CUS-B", idempotencyKey: "bound-coupon-key" }),
    /different redemption/i,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM coupon_redemptions").get().count, 1);
});

test("referral claim qualifies from the first completed paid booking in governed Chennai", async () => {
  const { sqlite, db } = stack();
  const referrals = await import("../lib/referral-governance.ts");
  customer(sqlite, "CUS-REFERRER", "0001");
  customer(sqlite, "CUS-FRIEND", "0002");
  const now = Date.now();
  await referrals.saveReferralProgramme(db, {
    id: "lane1-referral", name: "Lane 1 governed referral", status: "active",
    eligibleServices: ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking"],
    cityIds: ["blr", "maa"],
    rewardUseServices: ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking"],
    friendDiscount: 200, referrerReward: 300, perReferrerMonthlyLimit: 5,
    rewardValidityDays: 30, oneRewardPerFriend: true, reversalOnRefund: true,
    validFrom: now - 86_400_000, validUntil: now + 30 * 86_400_000,
  });
  const code = await referrals.ensureReferralCode(db, { programmeId: "lane1-referral", customerId: "CUS-REFERRER" });
  const claimInput = { code: code.code, referredCustomerId: "CUS-FRIEND", serviceCode: "dog_walking", cityId: "maa", idempotencyKey: "claim-maa" };
  const claim = await referrals.claimReferral(db, claimInput);
  assert.equal(claim.matched, true);
  assert.equal(claim.friendDiscount, 200);
  assert.equal((await referrals.claimReferral(db, claimInput)).duplicatePrevented, true);

  booking(sqlite, { id: "BK-FIRST-MAA", customerId: "CUS-FRIEND", service: "dog_walking", city: "maa", packageCode: "walking-30", status: "completed", createdAt: now });
  sqlite.prepare("INSERT INTO booking_payments (booking_id,status,amount) VALUES ('BK-FIRST-MAA','captured',1000)").run();
  const qualified = await referrals.qualifyReferralClaim(db, { claimId: claim.claimId, bookingId: "BK-FIRST-MAA", idempotencyKey: "qualify-maa", actorId: "ops@pawspace.in" });
  assert.equal(qualified.qualified, true);
  assert.equal(qualified.reward.amount, 300);
  assert.equal((await referrals.qualifyReferralClaim(db, { claimId: claim.claimId, bookingId: "BK-FIRST-MAA", idempotencyKey: "qualify-retry", actorId: "ops@pawspace.in" })).duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM referral_rewards").get().count, 1);
});

test("referral self-use, unsupported city and cross-customer retry keys are refused", async () => {
  const { sqlite, db } = stack();
  const referrals = await import("../lib/referral-governance.ts");
  customer(sqlite, "CUS-A", "0101");
  customer(sqlite, "CUS-B", "0102");
  customer(sqlite, "CUS-C", "0103");
  const now = Date.now();
  await referrals.saveReferralProgramme(db, {
    id: "lane1-refusal", name: "Lane 1 refusal proof", status: "active",
    eligibleServices: ["grooming"], cityIds: ["blr"], rewardUseServices: ["grooming"],
    friendDiscount: 100, referrerReward: 200, perReferrerMonthlyLimit: 2,
    rewardValidityDays: 10, oneRewardPerFriend: true, reversalOnRefund: false,
    validFrom: now - 1_000, validUntil: now + 86_400_000,
  });
  const code = await referrals.ensureReferralCode(db, { programmeId: "lane1-refusal", customerId: "CUS-A" });
  assert.match((await referrals.claimReferral(db, { code: code.code, referredCustomerId: "CUS-A", serviceCode: "grooming", cityId: "blr", idempotencyKey: "self" })).error, /self-referral/i);
  assert.match((await referrals.claimReferral(db, { code: code.code, referredCustomerId: "CUS-B", serviceCode: "grooming", cityId: "maa", idempotencyKey: "wrong-city" })).error, /not eligible in this city/i);

  const accepted = await referrals.claimReferral(db, { code: code.code, referredCustomerId: "CUS-B", serviceCode: "grooming", cityId: "blr", idempotencyKey: "claim-bound" });
  assert.ok(accepted.claimId);
  const collision = await referrals.claimReferral(db, { code: code.code, referredCustomerId: "CUS-C", serviceCode: "grooming", cityId: "blr", idempotencyKey: "claim-bound" });
  assert.match(collision.error, /different claim context/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM referral_claims").get().count, 1);
});

function seedSubscription(sqlite, { id, customerId, expiresAt, total = 3 }) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?,?,?,?,0,0,'active',?,?,?,?,?,?)")
    .run(id, customerId, "grooming-3", "grooming-basic", total, now - 86_400_000, expiresAt, `SOURCE-${id}`, "v1", now, now);
  sqlite.prepare("INSERT INTO grooming_subscription_purchase_snapshots (subscription_id,booking_id,city_id,zone_id,plan_code,catalogue_version,config_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, `SOURCE-${id}`, "blr", "blr-east", "grooming-3", "v1", JSON.stringify({ graceDays: 0, pauseDays: 5, renewalWindowDays: 7, familyWallet: true }), now);
}

test("subscription wallet reserves, consumes and releases credits exactly once", async () => {
  const { sqlite, db } = stack();
  const wallet = await import("../lib/subscription-wallet.ts");
  await wallet.ensureSubscriptionWalletTables(db);
  seedSubscription(sqlite, { id: "SUB-A", customerId: "CUS-A", expiresAt: Date.now() + 30 * 86_400_000 });
  booking(sqlite, { id: "BK-SUB-CONSUME", customerId: "CUS-A" });
  booking(sqlite, { id: "BK-SUB-RELEASE", customerId: "CUS-A" });

  const reserve = { subscriptionId: "SUB-A", action: "reserve", bookingId: "BK-SUB-CONSUME", credits: 1, idempotencyKey: "sub-reserve", actorId: "customer:CUS-A" };
  assert.equal((await wallet.mutateSubscriptionWallet(db, reserve)).duplicatePrevented, false);
  assert.equal((await wallet.mutateSubscriptionWallet(db, reserve)).duplicatePrevented, true);
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id='BK-SUB-CONSUME'").run();
  await wallet.mutateSubscriptionWallet(db, { ...reserve, action: "consume", idempotencyKey: "sub-consume" });

  await wallet.mutateSubscriptionWallet(db, { ...reserve, bookingId: "BK-SUB-RELEASE", action: "reserve", idempotencyKey: "sub-reserve-release" });
  sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='BK-SUB-RELEASE'").run();
  await wallet.mutateSubscriptionWallet(db, { ...reserve, bookingId: "BK-SUB-RELEASE", action: "release", idempotencyKey: "sub-release" });
  const state = await wallet.readSubscriptionWallet(db, "SUB-A");
  assert.deepEqual(state.balances, { total: 3, reserved: 0, consumed: 1, available: 2 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM booking_subscription_usage").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM subscription_wallet_events").get().count, 4);
});

test("subscription expiry, customer mismatch and idempotency key collisions fail closed", async () => {
  const { sqlite, db } = stack();
  const wallet = await import("../lib/subscription-wallet.ts");
  await wallet.ensureSubscriptionWalletTables(db);
  seedSubscription(sqlite, { id: "SUB-A", customerId: "CUS-A", expiresAt: Date.now() + 86_400_000 });
  seedSubscription(sqlite, { id: "SUB-B", customerId: "CUS-B", expiresAt: Date.now() + 86_400_000 });
  seedSubscription(sqlite, { id: "SUB-EXPIRED", customerId: "CUS-A", expiresAt: Date.now() - 1 });
  booking(sqlite, { id: "BK-A", customerId: "CUS-A" });
  booking(sqlite, { id: "BK-B", customerId: "CUS-B" });

  await wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-A", action: "reserve", bookingId: "BK-A", idempotencyKey: "wallet-bound", actorId: "customer:CUS-A" });
  await assert.rejects(
    wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-B", action: "reserve", bookingId: "BK-B", idempotencyKey: "wallet-bound", actorId: "customer:CUS-B" }),
    /different mutation/i,
  );
  await assert.rejects(
    wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-A", action: "reserve", bookingId: "BK-A", credits: 2, idempotencyKey: "wallet-bound", actorId: "customer:CUS-A" }),
    /different mutation/i,
  );
  await assert.rejects(
    wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-A", action: "reserve", bookingId: "BK-B", idempotencyKey: "wrong-customer", actorId: "customer:CUS-A" }),
    /customer do not match/i,
  );
  await assert.rejects(
    wallet.mutateSubscriptionWallet(db, { subscriptionId: "SUB-EXPIRED", action: "reserve", bookingId: "BK-A", idempotencyKey: "expired-wallet", actorId: "customer:CUS-A" }),
    /expired/i,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM subscription_wallet_events").get().count, 1);
});
