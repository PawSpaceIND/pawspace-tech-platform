import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
// CI runs tests/*.test.mjs under plain strip-types; the TEST coin modules import extension-less
// siblings (../governed-http-error, ../payment-stage-amount), so the repository resolver hooks must
// be installed before those modules are loaded. Same convention as every other lib-backed suite.
installWorkersHooks("__TEST_COINS_DB__", "__TEST_COINS_ENV__");
const { testCoinPolicy } = await import("../lib/v2/test-coin-policy.ts");
const { redeemTestCoins, syncTestCoins, testCoinHistory, testCoinBookingPreview } = await import("../lib/v2/test-coin-ledger.ts");
const { coinSourceQuery } = await import("../lib/v2/test-coin-sources.ts");
class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  runSync() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
  async run() { return this.runSync(); }
  async first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
class Db {
  sqlite = new DatabaseSync(":memory:");
  prepare(sql) { return new Statement(this.sqlite, sql); }
  async batch(statements) {
    if (this.beforeBatch) this.beforeBatch(statements);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const rows = statements.map(s => s.runSync()); this.sqlite.exec("COMMIT"); return rows; }
    catch (e) { this.sqlite.exec("ROLLBACK"); throw e; }
  }
}
const enabled = { PAWSPACE_TEST_COINS: "on", FORBID_PRODUCTION: "true", APP_ENV: "test", PAWSPACE_TEST_COINS_EXPIRY_SECONDS: 3600 };
const policy = testCoinPolicy(enabled);
function fixture() {
  const db = new Db();
  db.sqlite.exec(`CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL,currency TEXT);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,amount REAL,amount_due_now REAL,status TEXT,currency TEXT);
    CREATE TABLE paw_points_ledger(customer_id TEXT,booking_id TEXT,entry_type TEXT,points INTEGER);
    INSERT INTO paw_points_ledger VALUES ('alice','legacy','earned',100);
    CREATE TABLE accounting_journals(id TEXT,amount REAL); INSERT INTO accounting_journals VALUES ('sentinel',123);
    CREATE TABLE food_orders(id TEXT,customer_id TEXT,status TEXT,total_amount REAL,currency TEXT);
    CREATE TABLE food_order_payment_events(order_id TEXT,amount REAL,status TEXT);
    CREATE TABLE food_order_fulfilment(order_id TEXT,status TEXT);
    CREATE TABLE food_refund_ledger(order_id TEXT,amount REAL,status TEXT);
    CREATE TABLE relocation_cases(id TEXT,customer_id TEXT,status TEXT);
    CREATE TABLE relocation_payments(case_id TEXT,amount REAL,status TEXT);
    CREATE TABLE relocation_refunds(case_id TEXT,amount REAL,status TEXT);
    CREATE TABLE funeral_cases(id TEXT,customer_id TEXT,status TEXT);
    CREATE TABLE funeral_payments(case_id TEXT,amount REAL,status TEXT);
    CREATE TABLE funeral_refunds(case_id TEXT,amount REAL,status TEXT);`);
  return db;
}
function booking(db, id, { customer = "alice", service = "grooming", status = "completed", payment = "captured", amount = 100, due = amount } = {}) {
  db.sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?,?,'INR')").run(id, customer, service, status, amount);
  db.sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,?,'INR')").run(`pay:${id}`, id, customer, amount, due, payment);
}
const sync = db => syncTestCoins(db, "alice", policy, "alice");
const redeem = (db, id, coins = 10, customerId = "alice") => redeemTestCoins(db, { customerId, source: "booking", id, coins, actorId: customerId }, policy);
async function rejected(promise, status) { await assert.rejects(promise, e => e instanceof Response && e.status === status); }
function financialSnapshot(db) { return ["booking_payments", "canonical_bookings", "paw_points_ledger", "accounting_journals"].map(t => JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${t}`).all())); }
test("TEST policy defaults are labeled, configurable and fail closed outside test environments", async () => {
  assert.equal(policy.enabled, true); assert.match(policy.label, /TEST.*no cash/);
  for (const env of [{}, { ...enabled, APP_ENV: "production" }, { ...enabled, FORBID_PRODUCTION: "false" }, { ...enabled, PAWSPACE_TEST_COINS: "off" }]) {
    assert.equal(testCoinPolicy(env).enabled, false);
    await rejected(testCoinHistory(fixture(), "alice", testCoinPolicy(env)), 404);
  }
  assert.equal(testCoinPolicy({ ...enabled, PAWSPACE_TEST_COINS_EARN_PERCENT: 7 }).earnPercent, 7);
  assert.throws(() => testCoinPolicy({ ...enabled, PAWSPACE_TEST_COINS_EARN_PERCENT: -1 }));
  assert.throws(() => testCoinPolicy({ ...enabled, PAWSPACE_TEST_COINS_PREVIEW_RUPEES: "NaN" }));
});
test("earn across all canonical service codes only after completion and full captured payment; retries do not multiply", async () => {
  const db = fixture();
  for (const service of ["grooming", "boarding", "sitting", "walking", "training", "taxi", "vet_consult"]) booking(db, service, { service });
  booking(db, "unpaid", { payment: "created" }); booking(db, "upcoming", { status: "confirmed" });
  booking(db, "partial", { due: 50 }); booking(db, "zero", { amount: 0 }); booking(db, "other", { customer: "bob" });
  const before = financialSnapshot(db);
  assert.equal((await sync(db)).balance, 70); assert.equal((await sync(db)).balance, 70);
  assert.deepEqual(financialSnapshot(db), before);
  db.sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id='upcoming'").run();
  assert.equal((await sync(db)).balance, 80);
});
test("fully paid split bookings earn; outstanding stays/taxi balances do not", async () => {
  const db = fixture();
  db.sqlite.exec("CREATE TABLE stay_payment_schedules(booking_id TEXT,paid_now_amount REAL,balance_amount REAL,status TEXT); CREATE TABLE taxi_payment_schedules(booking_id TEXT,booking_fee_amount REAL,balance_amount REAL,status TEXT)");
  booking(db, "stay", { due: 50 }); booking(db, "taxi", { due: 20 });
  db.sqlite.exec("INSERT INTO stay_payment_schedules VALUES ('stay',50,50,'partially_paid'); INSERT INTO taxi_payment_schedules VALUES ('taxi',20,80,'partially_paid')");
  assert.equal((await sync(db)).balance, 0);
  db.sqlite.exec("UPDATE stay_payment_schedules SET status='paid'; UPDATE taxi_payment_schedules SET status='paid'");
  assert.equal((await sync(db)).balance, 20);
});
test("Food uses delivered plus canonical sandbox_paid event; special cases use actual delivered/closed and paid states", async () => {
  const db = fixture();
  db.sqlite.exec(`INSERT INTO food_orders VALUES ('food','alice','delivered',100,'INR'); INSERT INTO food_order_payment_events VALUES ('food',100,'due'); INSERT INTO food_order_fulfilment VALUES ('food','delivered');
    INSERT INTO relocation_cases VALUES ('relocation','alice','delivered'); INSERT INTO relocation_payments VALUES ('relocation',100,'paid');
    INSERT INTO funeral_cases VALUES ('funeral','alice','closed'); INSERT INTO funeral_payments VALUES ('funeral',100,'paid');`);
  assert.equal((await sync(db)).balance, 20);
  db.sqlite.exec("UPDATE food_order_payment_events SET status='sandbox_paid'");
  assert.equal((await sync(db)).balance, 30);
  db.sqlite.exec("INSERT INTO relocation_refunds VALUES ('relocation',5,'completed'); INSERT INTO funeral_refunds VALUES ('funeral',100,'completed'); INSERT INTO food_refund_ledger VALUES ('food',100,'sandbox_recorded')");
  assert.equal((await sync(db)).balance, 0); assert.equal((await sync(db)).balance, 0);
});
test("balance isolation, simulated redemption totals, exact retry and payload conflict", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "future", { status: "confirmed", payment: "created" });
  const before = financialSnapshot(db); const result = await redeem(db, "future");
  assert.equal(result.balance, 0); assert.equal(result.preview.actualPayable, 100);
  assert.equal(result.preview.simulatedDiscount, 10); assert.equal(result.preview.simulatedPayable, 90);
  assert.equal(result.preview.paymentAmountUnchanged, true);
  assert.equal((await redeem(db, "future")).duplicatePrevented, true);
  await rejected(redeem(db, "future", 5), 409);
  assert.deepEqual(financialSnapshot(db), before);
});
test("ownership, invalid amounts, insufficient balance, closed bookings, and excessive discounts fail", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "future", { status: "confirmed", payment: "created", amount: 5 });
  await rejected(redeem(db, "future", 10, "bob"), 404);
  for (const value of [0, -1, 1.5, Infinity, NaN]) await rejected(redeem(db, "future", value), 400);
  await rejected(redeem(db, "future", 10), 409);
  await rejected(redeem(db, "earned", 1), 409);
  booking(db, "large", { status: "confirmed", payment: "created" }); await rejected(redeem(db, "large", 11), 409);
});
test("concurrent redemptions across bookings cannot overdraw; identical concurrent retry posts once", async () => {
  const db = fixture(); booking(db, "earned");
  for (const id of ["future1", "future2"]) booking(db, id, { status: "confirmed", payment: "created" });
  const outcomes = await Promise.allSettled([redeem(db, "future1"), redeem(db, "future2")]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await testCoinHistory(db, "alice", policy)).balance, 0);
  const db2 = fixture(); booking(db2, "earned"); booking(db2, "future", { status: "confirmed", payment: "created" });
  const retries = await Promise.all([redeem(db2, "future"), redeem(db2, "future")]);
  assert.equal(retries.filter(r => r.duplicatePrevented).length, 1);
  assert.equal(db2.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE entry_type='redeemed'").get().n, 1);
});
test("cancel/full refund restores redemption once; partial refund reverses earn and may leave transparent TEST debt", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "future", { status: "confirmed", payment: "created" });
  await redeem(db, "future"); db.sqlite.exec("UPDATE booking_payments SET status='partially_refunded' WHERE booking_id='earned'");
  const reversed = await sync(db); assert.equal(reversed.balance, -10); assert.equal(reversed.spendableCoins, 0); assert.equal(reversed.reversalDebt, 10);
  db.sqlite.exec("UPDATE canonical_bookings SET status='cancelled' WHERE id='future'");
  assert.equal((await sync(db)).balance, 0); assert.equal((await sync(db)).balance, 0);
  const preview = await testCoinBookingPreview(db, "alice", "booking", "future", policy);
  assert.equal(preview.simulatedDiscount, 0); assert.equal(preview.redemptionRestored, true);
  db.sqlite.exec("UPDATE booking_payments SET status='captured' WHERE booking_id='earned'");
  assert.equal((await sync(db)).balance, 0); // never re-award a reversed earn
});
test("completed refunds are read from reconciliation even when payment status remains captured", async () => {
  const db = fixture(); booking(db, "earned"); await sync(db);
  db.sqlite.exec("CREATE TABLE payment_reconciliation_records(payment_id TEXT,captured_amount REAL,refunded_amount REAL); INSERT INTO payment_reconciliation_records VALUES ('pay:earned',100,10)");
  assert.equal((await sync(db)).balance, 0);
});
test("missing service sources are explicit; schema faults propagate", async () => {
  const db = new Db(); const result = await sync(db); assert.equal(result.gaps.length, 4);
  db.sqlite.exec("CREATE TABLE relocation_cases(id TEXT); CREATE TABLE relocation_payments(id TEXT)");
  await assert.rejects(sync(db), /no such column/);
});
test("actual canonical credits and payment stages are reused in TEST display; no test balance affects real amounts", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "future", { status: "confirmed", payment: "created" });
  db.sqlite.exec("INSERT INTO paw_points_ledger VALUES ('alice','future','redeemed',-20)");
  const result = await redeem(db, "future"); assert.equal(result.preview.actualPayable, 90); assert.equal(result.preview.simulatedPayable, 80);
});
test("route requires customer session and ownership; no client earn/grant or financial writes", async () => {
  const route = await readFile(new URL("../app/api/v2/test-coins/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireCustomerOwnership/); assert.match(route, /session\?\.subjectType === "customer"/);
  assert.match(route, /origin !== new URL\(request.url\).origin/);
  assert.match(route, /body.action !== "redeem"/);
  const ledger = await readFile(new URL("../lib/v2/test-coin-ledger.ts", import.meta.url), "utf8");
  assert.doesNotMatch(ledger, /(?:INSERT|UPDATE|DELETE).*\b(?:paw_points_ledger|booking_payments|canonical_bookings|accounting_journals)\b/);
  assert.equal((await coinSourceQuery(fixture(), "food")).available, true);
});
test("full refund restores simulated redemption, partial refund does not restore it", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "future", { status: "confirmed", payment: "created" });
  await redeem(db, "future");
  db.sqlite.exec("UPDATE booking_payments SET status='partially_refunded' WHERE booking_id='future'");
  assert.equal((await sync(db)).balance, 0);
  db.sqlite.exec("UPDATE booking_payments SET status='refunded' WHERE booking_id='future'");
  assert.equal((await sync(db)).balance, 10); assert.equal((await sync(db)).balance, 10);
  await rejected(redeem(db, "future", 5), 409);
});
test("policy changes apply only to new earns; old ledger values are not rewritten", async () => {
  const db = fixture(); booking(db, "earned"); await sync(db);
  const changed = testCoinPolicy({ ...enabled, PAWSPACE_TEST_COINS_EARN_PERCENT: 7, PAWSPACE_TEST_COINS_PREVIEW_RUPEES: 0.5 });
  assert.equal((await syncTestCoins(db, "alice", changed, "alice")).balance, 10);
  booking(db, "new-earn"); assert.equal((await syncTestCoins(db, "alice", changed, "alice")).balance, 17);
  booking(db, "future", { status: "confirmed", payment: "created" });
  const result = await redeemTestCoins(db, { customerId: "alice", source: "booking", id: "future", coins: 3, actorId: "alice" }, changed);
  assert.equal(result.preview.simulatedDiscount, 1.5); assert.equal(result.preview.simulatedPayable, 98.5);
});
test("reopened completion reverses its award once without mutating the service state", async () => {
  const db = fixture(); booking(db, "earned"); await sync(db);
  db.sqlite.exec("UPDATE canonical_bookings SET status='in_progress' WHERE id='earned'");
  const before = financialSnapshot(db);
  assert.equal((await sync(db)).balance, 0); assert.equal((await sync(db)).balance, 0);
  assert.deepEqual(financialSnapshot(db), before);
});
test("short actual capture is not a paid service; existing real credits may fund the remainder", async () => {
  const db = fixture(); booking(db, "earned");
  db.sqlite.exec("CREATE TABLE payment_reconciliation_records(payment_id TEXT,captured_amount REAL,refunded_amount REAL); INSERT INTO payment_reconciliation_records VALUES ('pay:earned',50,0)");
  assert.equal((await sync(db)).balance, 0);
  db.sqlite.exec("INSERT INTO paw_points_ledger VALUES ('alice','earned','redeemed',-100)");
  assert.equal((await sync(db)).balance, 10);
});
test("all special verticals support owned TEST simulation using their existing amount due; paid Food displays zero due", async () => {
  const db = fixture(); booking(db, "earned1"); booking(db, "earned2"); booking(db, "earned3");
  db.sqlite.exec(`INSERT INTO food_orders VALUES ('food','alice','delivered',100,'INR'); INSERT INTO food_order_payment_events VALUES ('food',100,'due'); INSERT INTO food_order_fulfilment VALUES ('food','delivered');
    INSERT INTO relocation_cases VALUES ('relocation','alice','payment_pending'); INSERT INTO relocation_payments VALUES ('relocation',100,'due');
    INSERT INTO funeral_cases VALUES ('funeral','alice','payment_pending'); INSERT INTO funeral_payments VALUES ('funeral',100,'due');`);
  for (const source of ["food", "relocation", "funeral"]) {
    const result = await redeemTestCoins(db, { customerId: "alice", source, id: source, coins: 10, actorId: "alice" }, policy);
    assert.equal(result.preview.actualPayable, 100); assert.equal(result.preview.simulatedPayable, 90);
  }
  db.sqlite.exec("UPDATE food_order_payment_events SET status='sandbox_paid'");
  const paid = await testCoinBookingPreview(db, "alice", "food", "food", policy);
  assert.equal(paid.actualPayable, 0); assert.equal(paid.simulatedDiscount, 0);
});
test("deferred/COD booking with zero original instalment earns after evidenced full collection", async () => {
  const db = fixture(); booking(db, "cod", { due: 0 });
  assert.equal((await sync(db)).balance, 0);
  db.sqlite.exec("CREATE TABLE payment_reconciliation_records(payment_id TEXT,captured_amount REAL,refunded_amount REAL); INSERT INTO payment_reconciliation_records VALUES ('pay:cod',100,0)");
  assert.equal((await sync(db)).balance, 10);
});
test("same source IDs across services stay separate and no customer can spend another customer's test ledger", async () => {
  const db = fixture(); booking(db, "shared"); booking(db, "bob-earned", { customer: "bob" });
  db.sqlite.exec("INSERT INTO relocation_cases VALUES ('shared','alice','delivered'); INSERT INTO relocation_payments VALUES ('shared',100,'paid')");
  assert.equal((await sync(db)).balance, 20);
  assert.equal((await syncTestCoins(db, "bob", policy, "bob")).balance, 10);
  booking(db, "alice-future", { status: "confirmed", payment: "created" });
  await rejected(redeem(db, "alice-future", 5, "bob"), 404);
  assert.equal((await testCoinHistory(db, "alice", policy)).balance, 20);
});
function mutateBeforeTestDebit(db, mutation) {
  let injected = false;
  db.beforeBatch = statements => {
    if (!injected && statements.some(s => s.sql.includes("s.status NOT IN"))) { injected = true; mutation(db.sqlite); }
  };
  return () => injected;
}
test("capture between preview and debit rejects without consuming TEST coins", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "target", { status: "confirmed", payment: "created" });
  const injected = mutateBeforeTestDebit(db, sqlite => sqlite.exec("UPDATE booking_payments SET status='captured' WHERE booking_id='target'"));
  await rejected(redeem(db, "target"), 409); assert.equal(injected(), true);
  assert.equal((await testCoinHistory(db, "alice", policy)).balance, 10);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE source_id='target'").get().n, 0);
  assert.equal((await testCoinBookingPreview(db, "alice", "booking", "target", policy)).actualPayable, 0);
  assert.equal(db.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id='target'").get().status, "captured");
});
test("real credits or payable shrink between preview and debit reject without TEST spend", async () => {
  for (const mutation of [
    sqlite => sqlite.exec("INSERT INTO paw_points_ledger VALUES ('alice','target','redeemed',-190)"),
    sqlite => sqlite.exec("UPDATE booking_payments SET amount_due_now=5 WHERE booking_id='target'")
  ]) {
    const db = fixture(); booking(db, "earned"); booking(db, "target", { status: "confirmed", payment: "created" });
    const injected = mutateBeforeTestDebit(db, mutation);
    await rejected(redeem(db, "target"), 409); assert.equal(injected(), true);
    assert.equal((await testCoinHistory(db, "alice", policy)).balance, 10);
    assert.equal((await testCoinBookingPreview(db, "alice", "booking", "target", policy)).actualPayable, 5);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE source_id='target'").get().n, 0);
  }
});
test("split payment settled between preview and debit rejects; still-outstanding capture remains redeemable", async () => {
  for (const settle of [true, false]) {
    const db = fixture(); booking(db, "earned"); booking(db, "target", { status: "confirmed", payment: "created", due: 50 });
    db.sqlite.exec("CREATE TABLE stay_payment_schedules(booking_id TEXT,paid_now_amount REAL,balance_amount REAL,status TEXT); INSERT INTO stay_payment_schedules VALUES ('target',50,50,'awaiting_payment')");
    mutateBeforeTestDebit(db, sqlite => sqlite.exec(`UPDATE booking_payments SET status='captured' WHERE booking_id='target'; UPDATE stay_payment_schedules SET status='${settle ? "paid" : "partially_paid"}' WHERE booking_id='target'`));
    if (settle) { await rejected(redeem(db, "target"), 409); assert.equal((await testCoinHistory(db, "alice", policy)).balance, 10); }
    else { const result = await redeem(db, "target"); assert.equal(result.preview.actualPayable, 50); assert.equal(result.preview.simulatedDiscount, 10); }
  }
});
test("special-service payment races cannot spend TEST coins against zero payable", async () => {
  for (const source of ["food", "relocation", "funeral"]) {
    const db = fixture(); booking(db, "earned");
    if (source === "food") db.sqlite.exec("INSERT INTO food_orders VALUES ('target','alice','delivered',100,'INR'); INSERT INTO food_order_payment_events VALUES ('target',100,'due'); INSERT INTO food_order_fulfilment VALUES ('target','delivered')");
    else db.sqlite.exec(`INSERT INTO ${source}_cases VALUES ('target','alice','payment_pending'); INSERT INTO ${source}_payments VALUES ('target',100,'due')`);
    mutateBeforeTestDebit(db, sqlite => sqlite.exec(source === "food" ? "UPDATE food_order_payment_events SET status='sandbox_paid' WHERE order_id='target'" : `UPDATE ${source}_payments SET status='paid' WHERE case_id='target'`));
    await rejected(redeemTestCoins(db, { customerId: "alice", source, id: "target", coins: 10, actorId: "alice" }, policy), 409);
    assert.equal((await testCoinHistory(db, "alice", policy)).balance, 10);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE source_id='target'").get().n, 0);
  }
});
test("atomic payable SQL agrees with existing staged payment resolver for instalments, reconciliation and credits", async () => {
  const { testCoinCanonicalPaymentSql } = await import("../lib/v2/test-coin-payable.ts");
  const { resolvePaymentStageAmount } = await import("../lib/payment-stage-amount.ts");
  for (const type of ["none", "stay", "taxi"]) for (const status of ["created", "captured", "partially_refunded"]) for (const schedulePaid of [false, true]) for (const credit of [0, 10, 90, 120]) for (const captured of [null, 0, 30, 50, 80, 100]) {
    const db = fixture(); booking(db, "target", { status: "confirmed", payment: status, due: type === "none" ? 100 : 50 });
    const payment = db.sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id='target'").get();
    const schedule = type === "none" ? null : { paid_now_amount: 50, balance_amount: 50, status: schedulePaid ? "paid" : "partially_paid" };
    if (type === "stay") db.sqlite.exec(`CREATE TABLE stay_payment_schedules(booking_id TEXT,paid_now_amount REAL,balance_amount REAL,status TEXT); INSERT INTO stay_payment_schedules VALUES ('target',50,50,'${schedule.status}')`);
    if (type === "taxi") db.sqlite.exec(`CREATE TABLE taxi_payment_schedules(booking_id TEXT,booking_fee_amount REAL,balance_amount REAL,status TEXT); INSERT INTO taxi_payment_schedules VALUES ('target',50,50,'${schedule.status}')`);
    db.sqlite.exec(`INSERT INTO paw_points_ledger VALUES ('alice','target','redeemed',${-credit * 2})`);
    if (captured !== null) db.sqlite.exec(`CREATE TABLE payment_reconciliation_records(payment_id TEXT,captured_amount REAL,refunded_amount REAL); INSERT INTO payment_reconciliation_records VALUES ('pay:target',${captured},0)`);
    const tables = new Set(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const actual = db.sqlite.prepare(`SELECT current_payable FROM (${testCoinCanonicalPaymentSql(tables)}) WHERE booking_id='target'`).get().current_payable;
    const needsRecon = type !== "none" && !schedulePaid && status !== "created" && credit > 0 && captured === null;
    if (needsRecon) assert.equal(actual, null, "missing reconciliation must refuse atomic debit");
    else assert.equal(actual, resolvePaymentStageAmount(payment, schedule, { totalApplied: credit, walletApplied: 0, pawPointsApplied: credit }, captured === null ? null : { captured_amount: captured }).dueNow, JSON.stringify({ type, status, schedulePaid, credit, captured }));
    db.sqlite.close();
  }
});
test("new real-credit table created after source discovery refuses stale atomic payable inputs", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "target", { status: "confirmed", payment: "created" });
  mutateBeforeTestDebit(db, sqlite => sqlite.exec("CREATE TABLE pawspace_wallet_ledger(source_id TEXT,entry_type TEXT,source_type TEXT,applied_value REAL); INSERT INTO pawspace_wallet_ledger VALUES ('target','redeem','booking',100)"));
  await rejected(redeem(db, "target"), 409);
  assert.equal((await testCoinHistory(db, "alice", policy)).balance, 10);
  assert.equal((await testCoinBookingPreview(db, "alice", "booking", "target", policy)).actualPayable, 0);
});
test("reconciliation disappearing between preview and debit cannot consume credit-funded split TEST coins", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "target", { status: "confirmed", payment: "captured", due: 50 });
  db.sqlite.exec("CREATE TABLE stay_payment_schedules(booking_id TEXT,paid_now_amount REAL,balance_amount REAL,status TEXT); INSERT INTO stay_payment_schedules VALUES ('target',50,50,'partially_paid'); CREATE TABLE payment_reconciliation_records(payment_id TEXT,captured_amount REAL,refunded_amount REAL); INSERT INTO payment_reconciliation_records VALUES ('pay:target',50,0); INSERT INTO paw_points_ledger VALUES ('alice','target','redeemed',-20)");
  mutateBeforeTestDebit(db, sqlite => sqlite.exec("DELETE FROM payment_reconciliation_records WHERE payment_id='pay:target'"));
  await rejected(redeem(db, "target"), 409);
  assert.equal((await testCoinHistory(db, "alice", policy)).balance, 10);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE source_id='target'").get().n, 0);
});
test("atomic payable uses the existing JavaScript money rounding for fractional stored amounts and wallet credits", async () => {
  const { testCoinCanonicalPaymentSql } = await import("../lib/v2/test-coin-payable.ts");
  const { resolvePaymentStageAmount } = await import("../lib/payment-stage-amount.ts");
  for (const due of [1.005, 2.675, 5.015, 10.555]) for (const wallet of [0, 1.005, 2.675]) {
    const db = fixture(); booking(db, "target", { status: "confirmed", payment: "created", amount: 100, due });
    db.sqlite.exec(`CREATE TABLE pawspace_wallet_ledger(source_id TEXT,entry_type TEXT,source_type TEXT,applied_value REAL); INSERT INTO pawspace_wallet_ledger VALUES ('target','redeem','booking',${wallet})`);
    const tables = new Set(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const actual = db.sqlite.prepare(`SELECT current_payable FROM (${testCoinCanonicalPaymentSql(tables)}) WHERE booking_id='target'`).get().current_payable;
    const payment = db.sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id='target'").get();
    const credit = Math.round(wallet * 100) / 100;
    assert.equal(actual, resolvePaymentStageAmount(payment, null, { totalApplied: credit, walletApplied: credit, pawPointsApplied: 0 }, null).dueNow, JSON.stringify({ due, wallet }));
    db.sqlite.close();
  }
});
test("10% earning uses governed eligible value across all services including Taxi and floors whole coins", async () => {
  const db = fixture();
  for (const service of ["grooming", "boarding", "sitting", "walking", "training", "taxi", "vet_consult"]) booking(db, service, { service, amount: 1234.56 });
  db.sqlite.exec("INSERT INTO food_orders VALUES ('food','alice','delivered',700,'INR'); INSERT INTO food_order_payment_events VALUES ('food',700,'sandbox_paid'); INSERT INTO food_order_fulfilment VALUES ('food','delivered'); INSERT INTO relocation_cases VALUES ('relocation','alice','delivered'); INSERT INTO relocation_payments VALUES ('relocation',80,'paid'); INSERT INTO funeral_cases VALUES ('funeral','alice','closed'); INSERT INTO funeral_payments VALUES ('funeral',80,'paid')");
  const result = await sync(db); assert.equal(result.balance, 7 * 123 + 70 + 8 + 8);
  assert.equal(result.grants.length, 10); assert.equal((await sync(db)).balance, result.balance);
  assert.equal(result.grants.find(g => g.source_id === "taxi").eligible_amount, 1234.56);
  db.sqlite.close();
});
test("earning basis is the canonical post-offer payment value, not a larger display total", async () => {
  const db = fixture(); booking(db, "discounted", { amount: 100 });
  db.sqlite.exec("UPDATE canonical_bookings SET total_amount=200 WHERE id='discounted'");
  assert.equal((await sync(db)).balance, 10);
  assert.equal(db.sqlite.prepare("SELECT eligible_amount FROM v2_test_coin_grants").get().eligible_amount, 100);
});
test("expiry duration has no default and unconfigured expiry cannot issue new grants", async () => {
  const db = fixture(); booking(db, "earned");
  const unset = testCoinPolicy({ ...enabled, PAWSPACE_TEST_COINS_EXPIRY_SECONDS: "" });
  assert.equal(unset.earnPercent, 10); assert.equal(unset.expirySeconds, null);
  const result = await syncTestCoins(db, "alice", unset, "alice");
  assert.equal(result.expiryConfigurationRequired, true); assert.equal(result.balance, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger").get().n, 0);
  for (const duration of [0, -1, 1.5, "bad"]) assert.throws(() => testCoinPolicy({ ...enabled, PAWSPACE_TEST_COINS_EXPIRY_SECONDS: duration }));
});
test("each grant retains its earning and expiry snapshots when configuration changes", async () => {
  const db = fixture(); booking(db, "first"); await sync(db);
  const original = db.sqlite.prepare("SELECT * FROM v2_test_coin_grants").get();
  const issued = db.sqlite.prepare("SELECT created_at FROM v2_test_coin_ledger WHERE entry_type='earned'").get().created_at;
  assert.equal(original.expires_at - issued, 3600 * 1000);
  const changed = testCoinPolicy({ ...enabled, PAWSPACE_TEST_COINS_EARN_PERCENT: 5, PAWSPACE_TEST_COINS_EXPIRY_SECONDS: 7200 });
  booking(db, "second"); const result = await syncTestCoins(db, "alice", changed, "alice");
  assert.equal(result.balance, 15); assert.deepEqual(db.sqlite.prepare("SELECT * FROM v2_test_coin_grants WHERE grant_id=?").get(original.grant_id), original);
  const second = db.sqlite.prepare("SELECT g.*,l.created_at FROM v2_test_coin_grants g JOIN v2_test_coin_ledger l ON l.id=g.grant_id WHERE l.source_id='second'").get();
  assert.equal(second.earn_percent, 5); assert.equal(second.expires_at - second.created_at, 7200 * 1000);
});
test("redemption consumes earliest-expiring grant lots; refund restoration cannot revive expired lots", async () => {
  const db = fixture(); booking(db, "first"); booking(db, "second"); booking(db, "future", { status: "confirmed", payment: "created" }); await sync(db);
  db.sqlite.exec("UPDATE v2_test_coin_grants SET expires_at=expires_at+60000 WHERE grant_id='test:booking:earn:second'");
  const result = await redeem(db, "future", 15); assert.equal(result.balance, 5);
  const rows = db.sqlite.prepare("SELECT grant_id,coins FROM v2_test_coin_allocations WHERE entry_type='spend' ORDER BY grant_id").all();
  assert.deepEqual(rows.map(r => [r.grant_id,r.coins]), [["test:booking:earn:first",10],["test:booking:earn:second",5]]);
  db.sqlite.exec("UPDATE v2_test_coin_grants SET expires_at=0 WHERE grant_id='test:booking:earn:first'; UPDATE canonical_bookings SET status='cancelled' WHERE id='future'");
  const restored = await sync(db); assert.equal(restored.balance, 10); assert.equal(restored.expiredCoins, 10);
  assert.equal((await sync(db)).balance, 10); assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_allocations WHERE entry_type='restore'").get().n, 2);
});
test("expiry and later earn reversal do not double-charge expired principal; spent reversal debt stays visible", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "future", { status: "confirmed", payment: "created" }); await redeem(db, "future", 4);
  db.sqlite.exec("UPDATE v2_test_coin_grants SET expires_at=0");
  assert.equal((await testCoinHistory(db, "alice", policy)).balance, 0);
  db.sqlite.exec("UPDATE booking_payments SET status='partially_refunded' WHERE booking_id='earned'");
  const reversed = await sync(db); assert.equal(reversed.balance, -4); assert.equal(reversed.reversalDebt, 4);
  booking(db, "next-earn"); const positive = await sync(db); assert.equal(positive.balance, 6); assert.equal(positive.grantBalanceAdjustment, -4); assert.equal(positive.customerId, "alice");
});
test("expiry between preview and debit is checked atomically and posts neither debit nor allocation", async () => {
  const db = fixture(); booking(db, "earned"); booking(db, "target", { status: "confirmed", payment: "created" });
  mutateBeforeTestDebit(db, sqlite => sqlite.exec("UPDATE v2_test_coin_grants SET expires_at=0"));
  await rejected(redeem(db, "target"), 409);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_ledger WHERE entry_type='redeemed'").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM v2_test_coin_allocations").get().n, 0);
  assert.equal((await testCoinHistory(db, "alice", policy)).spendableCoins, 0);
});
test("10% is the earn rate, not a redemption cap; concurrent retries allocate once", async () => {
  const db = fixture(); booking(db, "earned", { amount: 1000 }); booking(db, "future", { status: "confirmed", payment: "created" });
  const results = await Promise.all([redeem(db, "future", 80),redeem(db, "future", 80)]);
  assert.equal(results[0].preview.simulatedDiscount, 80); assert.equal(results[0].balance, 20);
  assert.equal(db.sqlite.prepare("SELECT SUM(coins) total FROM v2_test_coin_allocations WHERE entry_type='spend'").get().total, 80);
  assert.equal(results.filter(r => r.duplicatePrevented).length, 1);
});
test("legacy grants with no expiry snapshot are surfaced and do not become silently immortal", async () => {
  const db = fixture(); booking(db, "earned"); await sync(db);
  db.sqlite.exec("DELETE FROM v2_test_coin_grants");
  const result = await testCoinHistory(db, "alice", policy);
  assert.equal(result.balance, 0); assert.equal(result.expiryPendingCoins, 10);
});
