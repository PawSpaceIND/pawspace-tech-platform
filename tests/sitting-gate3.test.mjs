import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SITTING_GATE3_DB__", "__SITTING_GATE3_ENV__");

async function seedFinance() {
  const { sqlite, db } = freshCountingD1();
  const finance = await import("../lib/sitting-finance-governance.ts");
  await finance.ensureSittingFinanceTables(db);
  const now = Date.UTC(2026, 7, 1);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,idempotency_key TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at,idempotency_key,pet_ids_json,source_pet_ids_json) VALUES ('BK-SG3','CUS-SG3','blr','blr-east','pet_sitting','pkg','Sit','GRP-SG3','PRV-SG3','2026-09-10T09:00:00.000Z','2026-09-12T09:00:00.000Z','confirmed','customer_app',5000,'INR','{}','seed',?,?,'idem-sg3','[]','[]')").run(now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-SG3','BK-SG3','CUS-SG3',5000,5000,'INR','card','prepaid','captured','razorpay','pay-sg3','{}',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-SG3','BK-SG3','PRV-SG3','accepted',?,?)").run(now, now);
  return { sqlite, db, finance };
}

test("Sitting Gate 3 executes request-only cancellation governance", async () => {
  const { sqlite, db, finance } = await seedFinance();
  const result = await finance.mutateSittingFinance(db, {
    bookingId: "BK-SG3", action: "request_cancel", actorId: "customer@pawspace.in", idempotencyKey: "sg3-cancel", reason: "Customer travel changed",
  });
  assert.equal(result.status, "policy_review_required");
  const row = sqlite.prepare("SELECT status,requested_by FROM sitting_cancellation_requests WHERE booking_id='BK-SG3'").get();
  assert.equal(row.status, "policy_review_required");
  assert.equal(row.requested_by, "customer@pawspace.in");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sitting_refund_ledger WHERE booking_id='BK-SG3'").get().n, 0, "requesting cancellation must not invent a refund");
});

test("Sitting Gate 3 cancellation requests are replay-safe", async () => {
  const { sqlite, db, finance } = await seedFinance();
  const input = { bookingId: "BK-SG3", action: "request_cancel", actorId: "customer@pawspace.in", idempotencyKey: "sg3-replay", reason: "Customer travel changed" };
  await finance.mutateSittingFinance(db, input);
  const replay = await finance.mutateSittingFinance(db, input);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sitting_cancellation_requests WHERE booking_id='BK-SG3'").get().n, 1);
});
