import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__COUPON_AUTHORITY_DB__", "__COUPON_AUTHORITY_ENV__");
const { customerFacts, quoteCoupon, saveCouponCampaign, prepareCouponBooking, consumeCouponQuote } = await import("../lib/coupon-governance.ts");

async function world(t) {
  const harness = freshCountingD1();
  t.after(() => harness.sqlite.close());
  harness.sqlite.exec(`CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT);
    CREATE TABLE customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT);`);
  return harness;
}
function campaign(overrides = {}) {
  return { id: "authority", code: "AUTHORITY", name: "Coupon authority test", status: "active",
    serviceCodes: ["grooming"], cityIds: ["blr"], channels: ["website"], customerKinds: ["new", "existing", "subscriber"],
    packageScope: "all", packageCodes: [], crossSellFromServices: [], firstOrderOnly: false,
    minOrder: 0, maxOrder: null, subscriptionEligible: false, fullPaymentOnly: false,
    discountType: "fixed", discountValue: 100, maxDiscount: null, perCustomerLimit: 2, totalLimit: 10,
    validFrom: Date.now() - 60_000, validUntil: Date.now() + 3_600_000, ...overrides };
}
const basket = (overrides = {}) => ({ code: "AUTHORITY", customerId: "C1", serviceCode: "grooming", cityId: "blr", channel: "website", packageCode: "dog-basic", orderValue: 1349, paymentMode: "full", isSubscription: false, ...overrides });
function readOverride(db, match, replacement) {
  return { ...db, prepare(sql) {
    const wrap = statement => new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args) => wrap(target.bind(...args));
      if ((key === "first" || key === "all") && match.test(sql)) return async () => replacement();
      return target[key];
    }});
    return wrap(db.prepare(sql));
  }};
}
for (const [label, orders, subscription, expected] of [["new", 0, null, "new"], ["returning", 2, null, "existing"], ["active subscriber", 0, "active", "subscriber"], ["paused subscriber", 2, "paused", "subscriber"]]) {
  test(`customer facts preserve existing classification: ${label}`, async t => {
    const { db, sqlite } = await world(t);
    for (let i = 0; i < orders; i++) sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?)").run(`B${i}`, "C1", "grooming", "completed");
    if (subscription) sqlite.prepare("INSERT INTO customer_grooming_subscriptions VALUES (?,?,?)").run("S1", "C1", subscription);
    const result = await customerFacts(db, "C1");
    assert.equal(result.kind, expected); assert.equal(result.orderCount, orders);
  });
}
test("cross-sell facts contain only completed services belonging to this customer", async t => {
  const { db, sqlite } = await world(t);
  sqlite.exec("INSERT INTO canonical_bookings VALUES ('1','C1','grooming','completed'),('2','C1','dog_training','cancelled'),('3','C2','boarding','completed')");
  assert.deepEqual((await customerFacts(db, "C1")).previousServices, ["grooming"]);
});
for (const [name, sql] of [["booking history", /COUNT\(\*\) count FROM canonical_bookings/], ["subscriptions", /FROM customer_grooming_subscriptions/], ["cross-sell history", /SELECT DISTINCT service_code/]]) {
  test(`unavailable ${name} never becomes an eligible first-order coupon`, async t => {
    const { db, sqlite } = await world(t);
    await saveCouponCampaign(db, campaign({ firstOrderOnly: true }));
    const fault = readOverride(db, sql, () => { throw new Error("private database failure detail"); });
    await assert.rejects(quoteCoupon(fault, basket()), /Coupon customer eligibility is temporarily unavailable/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n, 0);
  });
}
for (const value of [null, {}, { count: null }, { count: -1 }, { count: 1.5 }, { count: "invalid" }, { count: Number.MAX_SAFE_INTEGER + 1 }]) {
  test(`malformed authoritative count is refused: ${JSON.stringify(value)}`, async t => {
    const { db } = await world(t);
    const fault = readOverride(db, /COUNT\(\*\) count FROM canonical_bookings/, () => value);
    await assert.rejects(customerFacts(fault, "C1"), /Coupon customer eligibility is temporarily unavailable/);
  });
}
for (const [amount, rate, cap, discount, final] of [[1349, 10, null, 134.9, 1214.1], [100.05, 10, null, 10.01, 90.04], [0.05, 10, null, 0.01, 0.04], [1349, 12.5, 100.25, 100.25, 1248.75], [0.3, 100, null, 0.3, 0]]) {
  test(`percentage coupon is exact in paise: ${amount} at ${rate}%`, async t => {
    const { db, sqlite } = await world(t);
    await saveCouponCampaign(db, campaign({ discountType: "percent", discountValue: rate, maxDiscount: cap }));
    const result = await quoteCoupon(db, basket({ orderValue: amount }));
    assert.equal(result.valid, true); assert.equal(result.discount, discount); assert.equal(result.finalAmount, final);
    const row = sqlite.prepare("SELECT discount_amount,final_amount FROM coupon_quotes WHERE id=?").get(result.quoteId);
    assert.equal(row.discount_amount, discount); assert.equal(row.final_amount, final);
  });
}
test("fixed paise discounts preserve exact final amount", async t => {
  const { db } = await world(t);
  await saveCouponCampaign(db, campaign({ discountValue: 0.1 }));
  const result = await quoteCoupon(db, basket({ orderValue: 0.3 }));
  assert.equal(result.discount, 0.1); assert.equal(result.finalAmount, 0.2);
});
for (const value of [-1, NaN, Infinity, 10.001, "100"]) {
  test(`invalid/sub-paise order never produces a coupon quote: ${String(value)}`, async t => {
    const { db, sqlite } = await world(t); await saveCouponCampaign(db, campaign());
    const result = await quoteCoupon(db, basket({ orderValue: value }));
    assert.equal(result.valid, false); assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n, 0);
  });
}
test("privately targeted campaign persists its owner and rejects other customers", async t => {
  const { db, sqlite } = await world(t);
  const saved = await saveCouponCampaign(db, campaign({ customerIds: ["C1"] }));
  assert.deepEqual(saved.customerIds, ["C1"]);
  assert.equal((await quoteCoupon(db, basket())).valid, true);
  const refused = await quoteCoupon(db, basket({ customerId: "C2" }));
  assert.equal(refused.valid, false); assert.match(refused.error, /another account/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes WHERE customer_id='C2'").get().n, 0);
});
test("editing campaign without a customerIds field preserves its restriction", async t => {
  const { db } = await world(t);
  await saveCouponCampaign(db, campaign({ customerIds: ["C1"] }));
  const edited = await saveCouponCampaign(db, campaign({ name: "Edited title" }));
  assert.deepEqual(edited.customerIds, ["C1"]);
  assert.equal((await quoteCoupon(db, basket({ customerId: "C2" }))).valid, false);
});
test("explicit staff scope update changes the eligible customer", async t => {
  const { db } = await world(t); await saveCouponCampaign(db, campaign({ customerIds: ["C1"] }));
  const edited = await saveCouponCampaign(db, campaign({ customerIds: ["C2"] }));
  assert.deepEqual(edited.customerIds, ["C2"]);
  assert.equal((await quoteCoupon(db, basket())).valid, false);
  assert.equal((await quoteCoupon(db, basket({ customerId: "C2" }))).valid, true);
});
for (const customerIds of [null, "C1", [""], [1], ["C1", null]]) {
  test(`malformed targeted scope is never saved as an unrestricted coupon: ${JSON.stringify(customerIds)}`, async t => {
    const { db, sqlite } = await world(t);
    await assert.rejects(saveCouponCampaign(db, campaign({ customerIds })), /Coupon customer scope is invalid/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_campaigns WHERE id='authority'").get().n, 0);
  });
}


function transactional(db, sqlite, beforeBatch = () => {}) {
  return { ...db, batch: async statements => {
    beforeBatch(statements);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(statement => ({ success: true, meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.args).changes) } }));
      sqlite.exec("COMMIT"); return result;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }};
}
async function redemptionWorld(t) {
  const ctx = await world(t);
  ctx.sqlite.exec("ALTER TABLE canonical_bookings ADD COLUMN city_id TEXT; ALTER TABLE canonical_bookings ADD COLUMN package_code TEXT; ALTER TABLE canonical_bookings ADD COLUMN total_amount REAL;");
  ctx.db = transactional(ctx.db, ctx.sqlite);
  await saveCouponCampaign(ctx.db, campaign({ customerIds: ["C1"] }));
  const quote = await quoteCoupon(ctx.db, basket());
  assert.equal(quote.valid, true);
  const input = { quoteId: quote.quoteId, bookingId: "B-REDEEM", customerId: "C1", serviceCode: "grooming", cityId: "blr", packageCode: "dog-basic", submittedTotal: quote.finalAmount, submittedDiscount: quote.discount, idempotencyKey: "REDEEM-1", now: Date.now() };
  const booking = ctx.db.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,city_id,package_code,total_amount) VALUES (?,'C1','grooming','payment_pending','blr','dog-basic',?)").bind(input.bookingId, input.submittedTotal);
  return { ...ctx, quote, input, booking };
}
test("positive control: owned coupon commits with its booking and stays exactly-once", async t => {
  const { db, sqlite, input, booking } = await redemptionWorld(t);
  const prepared = await prepareCouponBooking(db, input);
  await db.batch([booking, prepared.redemptionStatement, prepared.claimStatement]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM coupon_quotes WHERE id=?").get(input.quoteId).status, "consumed");
  assert.equal((await consumeCouponQuote(db, input)).duplicatePrevented, true);
});
test("a revoked customer-specific quote is refused before booking preparation", async t => {
  const { db, sqlite, input } = await redemptionWorld(t);
  await saveCouponCampaign(db, campaign({ customerIds: ["C2"] }));
  await assert.rejects(prepareCouponBooking(db, input), /customer mismatch/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n, 0);
});
for (const scope of ['["C2"]', 'null', '{}', 'not json', '["C1",null]', '[""]']) {
  test(`scope changed after preparation cannot grant an unauthorized discount: ${scope}`, async t => {
    const { db, sqlite, input, booking } = await redemptionWorld(t);
    const prepared = await prepareCouponBooking(db, input);
    sqlite.prepare("UPDATE coupon_campaigns SET customer_ids_json=? WHERE id='authority'").run(scope);
    await assert.rejects(db.batch([booking, prepared.redemptionStatement, prepared.claimStatement]));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 0, "booking rolls back with the coupon");
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n, 0);
    const row = sqlite.prepare("SELECT status,booking_id FROM coupon_quotes WHERE id=?").get(input.quoteId);
    assert.equal(row.status, "open"); assert.equal(row.booking_id, null);
  });
}
test("consume rejects revoked scope before touching an existing booking", async t => {
  const { db, sqlite, input, booking } = await redemptionWorld(t);
  await booking.run(); await saveCouponCampaign(db, campaign({ customerIds: ["C2"] }));
  await assert.rejects(consumeCouponQuote(db, input), /customer mismatch/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM coupon_quotes WHERE id=?").get(input.quoteId).status, "open");
});
test("consume transaction catches a customer scope change after its preliminary read", async t => {
  const { db, sqlite, input, booking } = await redemptionWorld(t);
  await booking.run(); let injected = false;
  const racingDb = transactional(db, sqlite, statements => {
    if (!injected && statements.some(statement => statement.sql.startsWith("UPDATE coupon_quotes SET status='consumed'"))) {
      injected = true; sqlite.exec(`UPDATE coupon_campaigns SET customer_ids_json='["C2"]' WHERE id='authority'`);
    }
  });
  await assert.rejects(consumeCouponQuote(racingDb, input));
  assert.equal(injected, true, "the intended race, not an unrelated failure, must execute");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n, 0);
  const row = sqlite.prepare("SELECT status,booking_id FROM coupon_quotes WHERE id=?").get(input.quoteId);
  assert.equal(row.status, "open"); assert.equal(row.booking_id, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 1);
});
test("positive control: separate consumption succeeds and replay is idempotent", async t => {
  const { db, sqlite, input, booking } = await redemptionWorld(t);
  await booking.run(); assert.equal((await consumeCouponQuote(db, input)).duplicatePrevented, false);
  assert.equal((await consumeCouponQuote(db, input)).duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n, 1);
});
for (const table of ["canonical_bookings", "customer_grooming_subscriptions"]) {
  test(`missing authority table is not an empty customer history: ${table}`, async t => {
    const { db, sqlite } = await world(t); await saveCouponCampaign(db, campaign()); await customerFacts(db, "C1"); sqlite.exec(`DROP TABLE ${table}`);
    await assert.rejects(quoteCoupon(db, basket()), /temporarily unavailable/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n, 0);
  });
}
for (const value of ['null', '{}', 'not json', '["C1",null]', '[""]']) {
  test(`corrupt stored customer scope never becomes public: ${value}`, async t => {
    const { db, sqlite } = await world(t); await saveCouponCampaign(db, campaign({ customerIds: ["C1"] }));
    sqlite.prepare("UPDATE coupon_campaigns SET customer_ids_json=? WHERE id='authority'").run(value);
    await assert.rejects(quoteCoupon(db, basket()), /customer scope is invalid/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n, 0);
  });
}


test("fresh database initializes real history schemas before determining eligibility", async t => {
  const { db, sqlite } = freshCountingD1(); t.after(() => sqlite.close());
  await saveCouponCampaign(db, campaign({ firstOrderOnly: true }));
  assert.equal((await quoteCoupon(db, basket())).valid, true);
  const columns = name => sqlite.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
  assert.ok(columns("canonical_bookings").includes("pricing_json"));
  assert.ok(columns("customer_grooming_subscriptions").includes("sessions_reserved"));
  assert.equal((await customerFacts(db, "C1")).orderCount, 0);
});
test("failed cold-start schema setup cannot create an eligible coupon", async t => {
  const { db, sqlite } = await world(t); await saveCouponCampaign(db, campaign());
  const failed = { ...db, batch: async statements => {
    if (statements.some(item => item.sql.includes("CREATE TABLE IF NOT EXISTS canonical_bookings"))) throw new Error("private initialization failure");
    return db.batch(statements);
  }};
  await assert.rejects(quoteCoupon(failed, basket()), /temporarily unavailable/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n, 0);
});
