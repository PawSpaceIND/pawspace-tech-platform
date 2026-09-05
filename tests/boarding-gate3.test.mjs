import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_GATE3_DB__", "__BOARDING_GATE3_ENV__");

async function seedFinance() {
  const { sqlite, db } = freshCountingD1();
  const finance = await import("../lib/boarding-finance-governance.ts");
  await finance.ensureBoardingFinanceTables(db);
  const now = Date.UTC(2026, 7, 1);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,idempotency_key TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at,idempotency_key,pet_ids_json,source_pet_ids_json) VALUES ('BK-BG3','CUS-BG3','blr','blr-east','boarding','pkg','Stay','GRP-BG3','PRV-BG3','2026-09-10T09:00:00.000Z','2026-09-12T09:00:00.000Z','confirmed','customer_app',5000,'INR','{}','seed',?,?,'idem-bg3','[]','[]')").run(now, now);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-BG3','BK-BG3','CUS-BG3',5000,5000,'INR','card','prepaid','captured','razorpay','pay-bg3','{}',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES ('STAY-BG3','BK-BG3','CUS-BG3','PRV-BG3','blr','blr-east','pkg','2026-09-10T09:00:00.000Z','2026-09-12T09:00:00.000Z',2,1,'confirmed','ready','pending','pending','none',?,?)").run(now, now);
  return { sqlite, db, finance };
}

test("Boarding Gate 3 executes request-only cancellation governance", async () => {
  const { sqlite, db, finance } = await seedFinance();
  const result = await finance.mutateBoardingFinance(db, {
    bookingId: "BK-BG3", action: "request_cancel", actorId: "customer@pawspace.in", idempotencyKey: "bg3-cancel", reason: "Customer travel changed",
  });
  assert.equal(result.status, "policy_review_required");
  const row = sqlite.prepare("SELECT status,requested_by FROM boarding_cancellation_requests WHERE booking_id='BK-BG3'").get();
  assert.equal(row.status, "policy_review_required");
  assert.equal(row.requested_by, "customer@pawspace.in");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM boarding_refund_ledger WHERE booking_id='BK-BG3'").get().n, 0, "requesting cancellation must not invent a refund");
});

test("Boarding Gate 3 cancellation requests are replay-safe", async () => {
  const { sqlite, db, finance } = await seedFinance();
  const input = { bookingId: "BK-BG3", action: "request_cancel", actorId: "customer@pawspace.in", idempotencyKey: "bg3-replay", reason: "Customer travel changed" };
  await finance.mutateBoardingFinance(db, input);
  const replay = await finance.mutateBoardingFinance(db, input);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM boarding_cancellation_requests WHERE booking_id='BK-BG3'").get().n, 1);
});
