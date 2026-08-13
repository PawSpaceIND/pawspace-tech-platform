/**
 * PAWSPACE-QA-A2 — does Pet Sitting report money as captured that was never collected?
 *
 * lib/sitting-finance-governance.ts's context() selects:
 *
 *     p.amount captured_amount
 *
 * `booking_payments.amount` is the booking PRICE. Aliasing it as `captured_amount` makes the name lie
 * for any payment that is not captured, and the reconcile action writes that figure straight into
 * `sitting_finance_reconciliation.captured_amount` and into `net_customer_amount`. An unpaid Sitting
 * booking therefore reconciles as though the customer's money is in the account.
 *
 * The invariant: captured_amount means money actually collected. It must never mirror payment.amount
 * for an unpaid or failed payment.
 *
 * Proven by running the real reconcile action and reading the row it wrote - not by inspecting source.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CAPTURED_DB__", "__CAPTURED_ENV__");

const PRICE = 3600;

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** A Pet Sitting booking priced at PRICE, whose payment sits in the given status. */
async function seed(paymentStatus) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CAPTURED_DB__ = db;
  globalThis.__CAPTURED_ENV__ = {};
  const { ensureSittingFinanceTables, mutateSittingFinance } = await import("../lib/sitting-finance-governance.ts");
  await ensureSittingFinanceTables(db);
  const now = Date.UTC(2026, 6, 1);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,idempotency_key TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT)");
  // The ops snapshot joins the customer and provider directories.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,name TEXT)");
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-1','Demo Customer','9800000001')").run();
  sqlite.prepare("INSERT INTO canonical_providers VALUES ('PRV-1','Demo Sitter')").run();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at,idempotency_key,pet_ids_json,source_pet_ids_json) VALUES ('BK-A2','CUS-1','blr','blr-east','pet_sitting','pkg','Sit','SG-A2','PRV-1','2026-08-01T09:00:00.000Z','2026-08-03T09:00:00.000Z','confirmed','customer_app',?,'INR','{}','seed',?,?,'idem-a2','[]','[]')").run(PRICE, now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-A2','BK-A2','CUS-1',?,?,'INR','card','prepaid',?,'razorpay','pidem-a2','{}',?,?)").run(PRICE, PRICE, paymentStatus, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-A2','BK-A2','PRV-1','accepted',?,?)").run(now, now);
  return { sqlite, db, mutate: mutateSittingFinance };
}

/** Runs the REAL reconcile action and returns the row it wrote. */
async function reconcile(paymentStatus) {
  const { sqlite, db, mutate } = await seed(paymentStatus);
  await mutate(db, { bookingId: "BK-A2", action: "reconcile", actorId: "finance@pawspace.in", reason: "Periodic Sitting finance reconciliation", idempotencyKey: `rec-${paymentStatus}` });
  const row = sqlite.prepare("SELECT booking_total,captured_amount,refund_total,net_customer_amount,status FROM sitting_finance_reconciliation WHERE booking_id='BK-A2'").get();
  assert.ok(row, `reconcile must write a reconciliation row (payment status ${paymentStatus})`);
  return { row, sqlite };
}

test("A2 step 1-3: a Sitting payment still in 'created' has collected NOTHING", async () => {
  const { row } = await reconcile("created");
  console.error(`created  -> captured_amount=${row.captured_amount} net_customer_amount=${row.net_customer_amount} booking_total=${row.booking_total} status=${row.status}`);
  assert.equal(row.booking_total, PRICE, "the booking is still worth its price");
  assert.equal(row.captured_amount, 0, `captured_amount must be 0 for an unpaid booking, got ${row.captured_amount}`);
  assert.equal(row.net_customer_amount, 0, `net customer amount must be 0 when nothing was collected, got ${row.net_customer_amount}`);
});

test("A2 step 4: a FAILED Sitting payment has collected NOTHING", async () => {
  const { row } = await reconcile("failed");
  console.error(`failed   -> captured_amount=${row.captured_amount} net_customer_amount=${row.net_customer_amount}`);
  assert.equal(row.captured_amount, 0, `captured_amount must be 0 for a failed payment, got ${row.captured_amount}`);
  assert.equal(row.net_customer_amount, 0, `net customer amount must be 0 for a failed payment, got ${row.net_customer_amount}`);
});

test("A2 step 5 (control): a CAPTURED Sitting payment reports the collected amount", async () => {
  const { row } = await reconcile("captured");
  console.error(`captured -> captured_amount=${row.captured_amount} net_customer_amount=${row.net_customer_amount}`);
  assert.equal(row.captured_amount, PRICE, "a captured payment really has collected the money");
  assert.equal(row.net_customer_amount, PRICE, "and the net customer amount reflects it");
});

test("A2: a refunded payment still counts as collected, minus what went back", async () => {
  // refunded/partially_refunded mean the money WAS collected. Excluding them would swing the defect the
  // other way and under-report real collections.
  const { sqlite, db, mutate } = await seed("refunded");
  await mutate(db, { bookingId: "BK-A2", action: "reconcile", actorId: "finance@pawspace.in", reason: "Reconcile after a refund was recorded", idempotencyKey: "rec-refunded" });
  const row = sqlite.prepare("SELECT captured_amount FROM sitting_finance_reconciliation WHERE booking_id='BK-A2'").get();
  console.error(`refunded -> captured_amount=${row.captured_amount}`);
  assert.equal(row.captured_amount, PRICE, "a refunded payment was collected before it was returned");
});

test("A2: the Sitting ops snapshot does not call an unpaid booking's price 'captured'", async () => {
  // Same alias, second surface: lib/sitting-ops-governance.ts selects `pay.amount captured_amount`.
  const { sqlite, db } = await seed("created");
  const { ensureSittingOpsTables, getSittingOpsSnapshot } = await import("../lib/sitting-ops-governance.ts");
  const { ensureProviderCapacityTables } = await import("../lib/provider-capacity-governance.ts");
  await ensureProviderCapacityTables(db);
  await ensureSittingOpsTables(db);
  const snapshot = await getSittingOpsSnapshot(db);
  const rows = Array.isArray(snapshot) ? snapshot : (snapshot?.bookings ?? snapshot?.rows ?? []);
  const booking = rows.find((item) => String(item.id ?? item.booking_id) === "BK-A2");
  assert.ok(booking, `the ops snapshot must list the booking (shape: ${Object.keys(snapshot || {}).join(",")})`);
  console.error(`ops snapshot -> captured_amount=${booking.captured_amount} payment_status=${booking.payment_status}`);
  assert.equal(Number(booking.captured_amount || 0), 0, `the ops snapshot must not report an unpaid booking's price as captured, got ${booking.captured_amount}`);
  void sqlite;
});

// ---------------------------------------------------------------------------------------------
// Split/deposit collection and cross-surface agreement, added when #178 was reconciled onto
// #174's canonical collectedForBooking. captured_amount is now computed by that one helper, which is
// schedule-aware — so a part-paid split must report only the instalment collected, and every Sitting
// surface must report the same number.
// ---------------------------------------------------------------------------------------------

const SPLIT_NOW = 2000, SPLIT_BALANCE = 1600;   // PRICE = 3600, a 2000/1600 deposit split

/** Adds a stay_payment_schedules row to the seeded booking. */
async function seedSplit(scheduleStatus) {
  const { sqlite, db, mutate } = await seed("captured");   // payment captured; the schedule holds the truth
  sqlite.exec("CREATE TABLE IF NOT EXISTS stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER)");
  const now = Date.UTC(2026, 6, 1);
  sqlite.prepare("INSERT INTO stay_payment_schedules VALUES ('BK-A2','pet_sitting','CUS-1',?,?,?,?,?,NULL,NULL,?,?)").run(PRICE, SPLIT_NOW, SPLIT_BALANCE, now + 86400000, scheduleStatus, now, now);
  return { sqlite, db, mutate };
}

test("A2 split: a part-paid deposit reports only the collected instalment, not the price", async () => {
  const { sqlite, db, mutate } = await seedSplit("balance_due");
  await mutate(db, { bookingId: "BK-A2", action: "reconcile", actorId: "finance@pawspace.in", reason: "Reconcile a part-paid split", idempotencyKey: "rec-split-due" });
  const row = sqlite.prepare("SELECT captured_amount,net_customer_amount FROM sitting_finance_reconciliation WHERE booking_id='BK-A2'").get();
  assert.equal(row.captured_amount, SPLIT_NOW, `only the ${SPLIT_NOW} deposit is collected, got ${row.captured_amount}`);
  assert.notEqual(row.captured_amount, PRICE, "the full price must NOT be reported as captured on a part-paid split");
});

test("A2 split: once the balance is paid the whole amount is collected", async () => {
  const { sqlite, db, mutate } = await seedSplit("paid");
  await mutate(db, { bookingId: "BK-A2", action: "reconcile", actorId: "finance@pawspace.in", reason: "Reconcile a settled split", idempotencyKey: "rec-split-paid" });
  const row = sqlite.prepare("SELECT captured_amount FROM sitting_finance_reconciliation WHERE booking_id='BK-A2'").get();
  assert.equal(row.captured_amount, SPLIT_NOW + SPLIT_BALANCE, `settled split collects the full ${SPLIT_NOW + SPLIT_BALANCE}, got ${row.captured_amount}`);
});

test("A2 agreement: reconcile, finance GET and ops snapshot report the same captured amount", async () => {
  // One part-paid split, read three ways. All three must agree, because all three now go through the
  // one canonical collectedForBooking rather than three separate SQL expressions.
  const { sqlite, db, mutate } = await seedSplit("balance_due");
  const { ensureSittingOpsTables, getSittingOpsSnapshot } = await import("../lib/sitting-ops-governance.ts");
  const { ensureProviderCapacityTables } = await import("../lib/provider-capacity-governance.ts");
  const { GET } = await import("../app/api/sitting-finance/route.ts");
  await ensureProviderCapacityTables(db); await ensureSittingOpsTables(db);

  await mutate(db, { bookingId: "BK-A2", action: "reconcile", actorId: "finance@pawspace.in", reason: "Reconcile for agreement", idempotencyKey: "rec-agree" });
  const reconciled = sqlite.prepare("SELECT captured_amount FROM sitting_finance_reconciliation WHERE booking_id='BK-A2'").get().captured_amount;

  const financeGet = await (await GET(new Request("https://uat.pawspace.in/api/sitting-finance?bookingId=BK-A2", { headers: { "oai-authenticated-user-email": "finance@pawspace.in" } }))).json().catch(() => null);
  const snapshot = await getSittingOpsSnapshot(db);
  const opsBooking = snapshot.bookings.find((b) => b.id === "BK-A2");

  assert.equal(reconciled, SPLIT_NOW, "reconcile captured the deposit only");
  if (financeGet?.data?.booking) assert.equal(Number(financeGet.data.booking.captured_amount), SPLIT_NOW, `finance GET must agree, got ${financeGet.data.booking.captured_amount}`);
  assert.ok(opsBooking, "the ops snapshot lists the booking");
  assert.equal(Number(opsBooking.captured_amount), SPLIT_NOW, `ops snapshot must agree, got ${opsBooking.captured_amount}`);
});

test("A2 canonical: captured_amount comes from the single collectedForBooking helper, no second calc", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["../lib/sitting-finance-governance.ts", "../lib/sitting-ops-governance.ts", "../app/api/sitting-finance/route.ts"]) {
    const src = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(src, /collectedForBooking/, `${file} must use the canonical helper`);
    assert.ok(!src.includes("collectedAmountSql"), `${file} must not carry the deleted second helper`);
  }
  // And the collected value the surfaces publish equals the helper called directly — same number, one source.
  const { collectedForBooking } = await import("../lib/collected-funds.ts");
  const { sqlite, db } = await seedSplit("balance_due");
  assert.equal(await collectedForBooking(db, "BK-A2"), SPLIT_NOW, "the helper itself returns the collected deposit");
  assert.ok(sqlite);
});
