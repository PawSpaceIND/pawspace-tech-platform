import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

// PR1261 discussion_r4173799793: testCoinPolicy accepted any finite earn percent and preview conversion. Reproduced
// on the real ledger (deliverable coins-bounds-repro-before.log): at 1e16 percent and above the earned row is
// stored as a non-safe or int64-saturated INTEGER that cannot be read back, while the JavaScript estimate floors
// a different double. The bounds asserted here are representability bounds derived from existing conventions
// (percent-of-value 0..100; paise rounding unit; safe-integer paise), never reward values. TEST-only, default off.
const ENABLED = { PAWSPACE_TEST_COINS: "on", FORBID_PRODUCTION: "true", APP_ENV: "test", PAWSPACE_TEST_COINS_EXPIRY_SECONDS: 3600 };
const policyModule = () => import("../lib/v2/test-coin-policy.ts");

test("invalid earn percent and preview conversion fail closed at policy load; the documented boundaries are accepted", async () => {
  const { testCoinPolicy, TEST_COIN_EARN_PERCENT_MAX, TEST_COIN_PREVIEW_RUPEES_MIN, TEST_COIN_PREVIEW_RUPEES_MAX } = await policyModule();
  assert.equal(TEST_COIN_EARN_PERCENT_MAX, 100); assert.equal(TEST_COIN_PREVIEW_RUPEES_MIN, 0.01); assert.equal(TEST_COIN_PREVIEW_RUPEES_MAX, Number.MAX_SAFE_INTEGER / 100);
  for (const percent of ["100.01", "101", "1000000", "1e16", "1e19", "1e300", "Infinity", "-Infinity", "NaN", "-0.5", "abc"])
    assert.throws(() => testCoinPolicy({ ...ENABLED, PAWSPACE_TEST_COINS_EARN_PERCENT: percent }), /Invalid TEST coin demonstration settings/, "percent " + percent);
  for (const conversion of ["0", "0.009", "0.001", "1e-300", "-1", String(Number.MAX_SAFE_INTEGER / 100 + 1), "1e300", "Infinity", "NaN"])
    assert.throws(() => testCoinPolicy({ ...ENABLED, PAWSPACE_TEST_COINS_PREVIEW_RUPEES: conversion }), /Invalid TEST coin demonstration settings/, "conversion " + conversion);
  for (const percent of ["0", "0.5", "7", "10", "99.99", "100"]) assert.equal(testCoinPolicy({ ...ENABLED, PAWSPACE_TEST_COINS_EARN_PERCENT: percent }).earnPercent, Number(percent));
  for (const conversion of ["0.01", "0.5", "1", String(Number.MAX_SAFE_INTEGER / 100)]) assert.equal(testCoinPolicy({ ...ENABLED, PAWSPACE_TEST_COINS_PREVIEW_RUPEES: conversion }).previewRupeesPerCoin, Number(conversion));
  // Defaults are unchanged: earn percent 10, conversion 1, expiry unset → null (fail closed for new grants).
  const d = testCoinPolicy({ ...ENABLED, PAWSPACE_TEST_COINS_EXPIRY_SECONDS: "" });
  assert.equal(d.earnPercent, 10); assert.equal(d.previewRupeesPerCoin, 1); assert.equal(d.expirySeconds, null);
});

async function world(policy) {
  const ctx = await setupJourney();
  Object.assign(globalThis.__GROOM_GOLDEN_ENV__, { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "x".repeat(32), PAWSPACE_UAT_ACCESS_CODE: "y".repeat(32) }, ENABLED, policy);
  const { ensureCanonicalBookingCoreTables } = await import("../lib/canonical-booking-core-schema.ts"); await ensureCanonicalBookingCoreTables(ctx.db);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts"); await ensureSecurityTables(ctx.db);
  return ctx;
}
function seedBooking(sqlite, id, customer, amount) {
  const now = Date.now();
  sqlite.prepare(`INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at)
    VALUES (?,?,?,'[]','[]','blr','z1','grooming','pkg','Synthetic package',?,'prov-1','2026-10-01T09:00:00Z','2026-10-01T10:00:00Z','completed','customer_app',?,'INR','{}','synthetic',?,?)`).run(id, "idem:" + id, customer, "sg:" + id, amount, now, now);
  sqlite.prepare(`INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at)
    VALUES (?,?,?,?,?,'INR','card','prepaid','captured','uat_sandbox',?,'{}',?,?)`).run("pay:" + id, id, customer, amount, amount, "pidem:" + id, now, now);
}

test("at the maximum percent the real ledger stores exactly floor(amount), reads it back as a safe integer, and agrees with the JavaScript estimate", async t => {
  const w = await world({ PAWSPACE_TEST_COINS_EARN_PERCENT: "100" }); t.after(w.close);
  const { testCoinPolicy } = await policyModule(); const policy = testCoinPolicy(globalThis.__GROOM_GOLDEN_ENV__);
  const { syncTestCoins, testCoinHistory } = await import("../lib/v2/test-coin-ledger.ts");
  const { testCoinEstimate } = await import("../lib/v2/test-coin-estimate.ts");
  const amounts = [0.01, 0.99, 1, 1200.25, 99999.99, 9999999.99];
  amounts.forEach((amount, i) => seedBooking(w.sqlite, "b" + i, "c-max", amount));
  const synced = await syncTestCoins(w.db, "c-max", policy, "customer:c-max");
  const rows = w.sqlite.prepare("SELECT source_id, coins, typeof(coins) t FROM v2_test_coin_ledger WHERE customer_id='c-max' AND entry_type='earned' ORDER BY source_id").all();
  const expected = amounts.map(a => Math.floor(a)).filter(c => c > 0);
  assert.deepEqual(rows.map(r => Number(r.coins)), expected, "one earned row per booking whose floor is positive, equal to floor(amount)");
  for (const r of rows) { assert.equal(r.t, "integer"); assert.ok(Number.isSafeInteger(Number(r.coins))); }
  const sum = expected.reduce((a, b) => a + b, 0);
  const history = await testCoinHistory(w.db, "c-max", policy);
  assert.equal(history.balance, sum); assert.equal(synced.balance, sum); assert.ok(Number.isSafeInteger(history.balance));
  assert.equal(w.sqlite.prepare("SELECT SUM(coins) s FROM v2_test_coin_ledger WHERE customer_id='c-max'").get().s, sum, "ledger sum round-trips");
  for (const amount of amounts) {
    const estimate = testCoinEstimate({ policy, eligibleAmount: amount, actualPayable: amount, requestedCoins: 0, grants: [], spendableCoins: 0, grantBalanceAdjustment: 0, currency: "INR" });
    const sql = w.sqlite.prepare("SELECT CAST(?*?/100 AS INTEGER) v").get(amount, policy.earnPercent).v;
    assert.equal(estimate.estimatedCoins, Math.floor(amount)); assert.equal(Number(sql), estimate.estimatedCoins, "SQL earn and JS estimate agree at " + amount);
  }
});

test("SQL earn and JavaScript estimate agree for every percent inside the bound", async t => {
  const w = await world({}); t.after(w.close);
  const { testCoinPolicy } = await policyModule(); const { testCoinEstimate } = await import("../lib/v2/test-coin-estimate.ts");
  for (const percent of [0, 0.01, 0.5, 1, 2.5, 7, 10, 12.5, 33.33, 50, 99.99, 100]) for (const amount of [0.01, 1, 19.99, 1200.25, 54321.1, 9999999.99]) {
    const policy = testCoinPolicy({ ...globalThis.__GROOM_GOLDEN_ENV__, PAWSPACE_TEST_COINS_EARN_PERCENT: percent });
    const js = testCoinEstimate({ policy, eligibleAmount: amount, actualPayable: amount, requestedCoins: 0, grants: [], spendableCoins: 0, grantBalanceAdjustment: 0, currency: "INR" }).estimatedCoins;
    const sql = Number(w.sqlite.prepare("SELECT CAST(?*?/100 AS INTEGER) v").get(amount, percent).v);
    assert.equal(js, sql, `percent ${percent} amount ${amount}`); assert.ok(Number.isSafeInteger(js)); assert.ok(js <= amount, "coins never exceed the eligible rupees");
  }
});

test("an out-of-bound percent fails closed at the real route for a signed-in customer: no success, no TEST tables, no rows", async t => {
  const w = await world({ PAWSPACE_TEST_COINS_EARN_PERCENT: "1e16" }); t.after(w.close);
  const route = await import("../app/api/v2/test-coins/route.ts");
  const cookie = await sessionCookie(w.db, "customer", "c-bad", "customer:c-bad");
  seedBooking(w.sqlite, "b-bad", "c-bad", 1200.25);
  for (const method of ["GET", "POST"]) {
    const request = new Request("https://uat.pawspace.in/api/v2/test-coins", { method, headers: { cookie, ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: JSON.stringify({ action: "sync" }) } : {}) });
    const response = await (method === "GET" ? route.GET(request) : route.POST(request));
    assert.ok(!response.ok, method + " status " + response.status); assert.equal((await response.json()).data, undefined, "no wallet data is returned");
  }
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'v2_test_coin%'").get().n, 0, "no TEST schema or rows are created under an invalid policy");
});

test("conversion bounds: the smallest conversion still yields an exact paise value and the largest stays a finite safe-integer number of paise", async () => {
  const { testCoinPolicy } = await policyModule(); const { testCoinEstimate } = await import("../lib/v2/test-coin-estimate.ts");
  const grants = [{ grant_id: "g", source_kind: "booking", source_id: "x", remaining: 500, expires_at: Date.now() + 1e6 }];
  const small = testCoinPolicy({ ...ENABLED, PAWSPACE_TEST_COINS_PREVIEW_RUPEES: "0.01" });
  const e1 = testCoinEstimate({ policy: small, eligibleAmount: 1000, actualPayable: 4, requestedCoins: 300, grants, spendableCoins: 500, grantBalanceAdjustment: 0, currency: "INR" });
  assert.equal(e1.maximumCoins, 400); assert.equal(e1.simulatedDiscount, 3); assert.ok(Number.isSafeInteger(Math.round(e1.simulatedDiscount * 100)));
  const large = testCoinPolicy({ ...ENABLED, PAWSPACE_TEST_COINS_PREVIEW_RUPEES: String(Number.MAX_SAFE_INTEGER / 100) });
  const e2 = testCoinEstimate({ policy: large, eligibleAmount: 1000, actualPayable: 500, requestedCoins: 1, grants, spendableCoins: 500, grantBalanceAdjustment: 0, currency: "INR" });
  assert.equal(e2.maximumCoins, 0, "no coin is redeemable when one coin exceeds the payable"); assert.equal(e2.requestEligible, false); assert.equal(e2.simulatedDiscount, 0);
  assert.ok(Number.isFinite(1 * large.previewRupeesPerCoin * 100)); assert.ok(Number.isSafeInteger(Math.round(large.previewRupeesPerCoin * 100)));
});

// Independent bounds review: percent<=100 bounds coins by the AMOUNT, and canonical_bookings.total_amount /
// booking_payments.amount are REAL with no upstream maximum. Reproduced (coins-bounds-repro-amount-edge.log): at
// percent 100 an amount of 2^53 or more is written to the ledger and cannot be read back. The guard below is the
// finance journal's money rule (paise must be a safe integer), applied at the source, the estimate and the read.
test("source guard: an amount outside safe paise precision earns nothing and estimates nothing; the largest representable amount still earns floor(amount)", async t => {
  const w = await world({ PAWSPACE_TEST_COINS_EARN_PERCENT: "100" }); t.after(w.close);
  const { testCoinPolicy, representableTestCoinAmount, TEST_COIN_MAX_PAISE } = await policyModule(); const policy = testCoinPolicy(globalThis.__GROOM_GOLDEN_ENV__);
  const { syncTestCoins, testCoinHistory, testCoinBookingPreview } = await import("../lib/v2/test-coin-ledger.ts");
  const { testCoinEstimate } = await import("../lib/v2/test-coin-estimate.ts");
  assert.equal(TEST_COIN_MAX_PAISE, Number.MAX_SAFE_INTEGER);
  const unrepresentable = [1e17, 1e300, 2 ** 53, 2 ** 53 + 2, 9007199254740992.5];
  const largest = 90071992547409.9; // paise 9007199254740990, a safe integer; .92 is not (see representable() below)
  for (const amount of unrepresentable) assert.equal(representableTestCoinAmount(amount), false, String(amount));
  for (const amount of [0, 0.01, 1200.25, largest]) assert.equal(representableTestCoinAmount(amount), true, String(amount));
  for (const bad of [-0.01, NaN, Infinity, "100", null]) assert.equal(representableTestCoinAmount(bad), false, String(bad));
  unrepresentable.forEach((amount, i) => seedBooking(w.sqlite, "u" + i, "c-edge", amount));
  seedBooking(w.sqlite, "ok", "c-edge", largest);
  const synced = await syncTestCoins(w.db, "c-edge", policy, "customer:c-edge");
  const rows = w.sqlite.prepare("SELECT source_id, CAST(coins AS TEXT) coins FROM v2_test_coin_ledger WHERE customer_id='c-edge'").all();
  assert.deepEqual(rows.map(r => ({ ...r })), [{ source_id: "ok", coins: String(Math.floor(largest)) }], "only the representable booking earns; nothing is written for the others");
  assert.equal(synced.balance, Math.floor(largest)); assert.ok(Number.isSafeInteger(synced.balance));
  assert.equal((await testCoinHistory(w.db, "c-edge", policy)).balance, Math.floor(largest));
  // JS and SQL apply the same predicate at the edge, so the estimate never promises what the ledger will not write.
  for (const amount of [...unrepresentable, largest, 90071992547409.92]) {
    const sql = w.sqlite.prepare("SELECT ROUND(?*100)<=? ok").get(amount, Number.MAX_SAFE_INTEGER).ok === 1;
    assert.equal(representableTestCoinAmount(amount), sql, "JS and SQL agree at " + amount);
    const estimate = testCoinEstimate({ policy, eligibleAmount: amount, actualPayable: amount, requestedCoins: 1, grants: [{ grant_id: "g", source_kind: "booking", source_id: "x", remaining: 5, expires_at: Date.now() + 1e6 }], spendableCoins: 5, grantBalanceAdjustment: 0, currency: "INR" });
    if (sql) { assert.equal(estimate.estimatedCoins, Math.floor(amount)); assert.ok(Number.isSafeInteger(estimate.estimatedCoins)); }
    else { assert.equal(estimate.estimatedCoins, null, "no estimate for " + amount); assert.equal(estimate.maximumCoins, 0); assert.equal(estimate.requestEligible, false); assert.equal(estimate.simulatedPayable, null); }
  }
  // Preview of an unrepresentable (captured, so nothing due) booking stays read-only truth: no earning, no discount.
  const preview = await testCoinBookingPreview(w.db, "c-edge", "booking", "u0", policy);
  assert.equal(preview.bookingTotal, 1e17); assert.equal(preview.actualPayable, 0); assert.equal(preview.simulatedDiscount, 0); assert.equal(preview.testCoinsRedeemed + 0, 0, "no redemption (the module yields -0 here, which serialises as 0)");
});

test("redeem against an unrepresentable payable is refused before any write, even with a representable balance", async t => {
  const w = await world({ PAWSPACE_TEST_COINS_EARN_PERCENT: "10" }); t.after(w.close);
  const { testCoinPolicy } = await policyModule(); const policy = testCoinPolicy(globalThis.__GROOM_GOLDEN_ENV__);
  const { syncTestCoins, redeemTestCoins } = await import("../lib/v2/test-coin-ledger.ts");
  seedBooking(w.sqlite, "earned", "c-pay", 1000); seedBooking(w.sqlite, "huge", "c-pay", 1e17);
  w.sqlite.prepare("UPDATE canonical_bookings SET status='confirmed' WHERE id='huge'").run(); w.sqlite.prepare("UPDATE booking_payments SET status='pending', amount_due_now=1e17 WHERE booking_id='huge'").run();
  assert.equal((await syncTestCoins(w.db, "c-pay", policy, "customer:c-pay")).balance, 100);
  await assert.rejects(redeemTestCoins(w.db, { customerId: "c-pay", source: "booking", id: "huge", coins: 1, actorId: "customer:c-pay" }, policy), error => error instanceof Response && error.status === 409);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE entry_type='redeemed'").get().n, 0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_allocations").get().n, 0);
});

test("read guard: a ledger whose sums pass 2^53 (many maximal grants) fails closed as 409 instead of showing a lossy balance", async t => {
  const w = await world({ PAWSPACE_TEST_COINS_EARN_PERCENT: "100" }); t.after(w.close);
  const { testCoinPolicy } = await policyModule(); const policy = testCoinPolicy(globalThis.__GROOM_GOLDEN_ENV__);
  const { syncTestCoins, testCoinHistory } = await import("../lib/v2/test-coin-ledger.ts");
  // 101 bookings at the largest representable amount: each coin count is safe, their SUM is not (> 2^53).
  for (let i = 0; i < 101; i++) seedBooking(w.sqlite, "m" + i, "c-many", 90071992547409.9);
  await assert.rejects(syncTestCoins(w.db, "c-many", policy, "customer:c-many"), error => error instanceof Response && error.status === 409);
  const stored = w.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE customer_id='c-many'").get().n;
  assert.equal(stored, 101, "each row is individually representable and stored");
  assert.equal(w.sqlite.prepare("SELECT CAST(SUM(coins) AS TEXT) s FROM v2_test_coin_ledger WHERE customer_id='c-many'").get().s, String(90071992547409n * 101n), "the true sum exceeds 2^53 (9007199254740992)");
  assert.ok(90071992547409n * 101n > 9007199254740992n);
  const refusal = await testCoinHistory(w.db, "c-many", policy).then(() => null, error => error);
  assert.ok(refusal instanceof Response, "history read is refused"); assert.equal(refusal.status, 409); assert.match((await refusal.json()).error, /representable precision/);
  // 100 such grants are still a safe sum and read normally.
  for (let i = 0; i < 100; i++) seedBooking(w.sqlite, "s" + i, "c-hundred", 90071992547409.9);
  assert.equal((await syncTestCoins(w.db, "c-hundred", policy, "customer:c-hundred")).balance, 100 * 90071992547409);
});
