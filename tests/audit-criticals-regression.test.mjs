import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Regressions for the criticals found by the 2026-09-05 pilot-readiness audit.
//
// Each test here fails if its fix is reverted — that is the whole point. A prior
// audit measured that only ~30% of this suite is load-bearing (deleting the
// "no past-dated bookings" rule reddened 1 test of 4213), so a regression test
// that cannot fail would be worse than none.
// ---------------------------------------------------------------------------

installWorkersHooks("__AUDIT_DB__", "__AUDIT_ENV__");

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

const PRICE = 4000;
const NOW = Date.UTC(2026, 6, 1);

/** A Pet Sitting booking with a captured payment, in the given booking status. */
async function seedSitting(bookingStatus) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__AUDIT_DB__ = db;
  globalThis.__AUDIT_ENV__ = {};
  const mod = await import("../lib/sitting-finance-governance.ts");
  await mod.ensureSittingFinanceTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,status TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,name TEXT)");
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-1','Demo Customer','9800000001')").run();
  sqlite.prepare("INSERT INTO canonical_providers VALUES ('PRV-1','Demo Sitter')").run();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES ('BK-C6','CUS-1','blr','z1','pet_sitting','pkg','Sitting','SG-C6','PRV-1','2026-07-02T04:00:00.000Z','2026-07-02T10:00:00.000Z',?,'customer_app',?,'INR','{}','seed',?,?)")
    .run(bookingStatus, PRICE, NOW, NOW);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-C6','BK-C6','CUS-1',?,?,'INR','card','prepaid','captured','razorpay','pidem-c6','{}',?,?)").run(PRICE, PRICE, NOW, NOW);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO-C6','BK-C6','PRV-1','accepted',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO scheduling_reservations VALUES ('RES-C6','SG-C6','confirmed')").run();
  return { sqlite, db, mutate: mod.mutateSittingFinance };
}

const call = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) {
  if (error instanceof Response) return { ok: false, status: error.status, body: await error.clone().text() };
  return { ok: false, status: 500, body: String(error) };
} };

// --- AUDIT-C6 -------------------------------------------------------------
// The sequence a real operator reaches: the customer asks to cancel while the
// booking is `assigned`; the sitter then actually performs the stay and checks
// out; a second staff member approves the still-open request.
//
// Before the fix this SUCCEEDED: the customer was refunded PRICE in full for a
// service they had received, AND the sitter could never be paid, because
// prepare_settlement requires status==='completed' — which the cancel had just
// overwritten. Walking, taxi and food all carried this check already.
test("AUDIT-C6: a DELIVERED sitting booking cannot be cancelled and refunded", async () => {
  const { sqlite, db, mutate } = await seedSitting("assigned");

  const requested = await call(() => mutate(db, {
    bookingId: "BK-C6", action: "request_cancel", actorId: "customer@pawspace.in",
    reason: "Plans changed, please cancel", idempotencyKey: "req-c6",
  }));
  assert.ok(requested.ok, `the cancellation request must open while assigned: ${requested.body ?? ""}`);

  // The sitter delivers the stay and checks out.
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id='BK-C6'").run();

  const approved = await call(() => mutate(db, {
    bookingId: "BK-C6", action: "approve_cancel", actorId: "finance@pawspace.in",
    reason: "Approving the earlier cancellation request", idempotencyKey: "app-c6",
    approvedRefundAmount: PRICE,
  }));

  assert.equal(approved.ok, false, "approving a cancellation on a DELIVERED stay must be refused");
  assert.equal(approved.status, 409);

  const booking = sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-C6'").get();
  assert.equal(booking.status, "completed", "the delivered booking must remain completed, so the sitter can still be settled");

  const refunds = sqlite.prepare("SELECT COUNT(*) n FROM sitting_refund_ledger WHERE booking_id='BK-C6'").get();
  assert.equal(refunds.n, 0, "no refund may be ledgered for a service that was delivered");
});

// --- AUDIT-C6b ------------------------------------------------------------
// The guard must not over-fire: the ordinary case must still work.
test("AUDIT-C6b: a genuinely undelivered sitting booking can still be cancelled", async () => {
  const { sqlite, db, mutate } = await seedSitting("assigned");
  const requested = await call(() => mutate(db, {
    bookingId: "BK-C6", action: "request_cancel", actorId: "customer@pawspace.in",
    reason: "Plans changed, please cancel", idempotencyKey: "req-ok",
  }));
  assert.ok(requested.ok);
  const approved = await call(() => mutate(db, {
    bookingId: "BK-C6", action: "approve_cancel", actorId: "finance@pawspace.in",
    reason: "Approved, service not delivered", idempotencyKey: "app-ok", approvedRefundAmount: PRICE,
  }));
  assert.ok(approved.ok, `an undelivered booking must still be cancellable: ${approved.body ?? ""}`);
  const booking = sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-C6'").get();
  assert.equal(booking.status, "cancelled");
});

// --- AUDIT-H4 -------------------------------------------------------------
// A cancellation case carries the customer's stated reason and adjudicates a
// dispute that is often ABOUT the provider. bookings.view is held by
// service_provider by default and the route checked nothing else, so any
// provider could read any customer's case and record ops_decision "proceed"
// on a complaint against themselves.
test("AUDIT-H4: the cancellation-case route is staff-only, and says so in a governed code", async () => {
  const route = await import("../app/api/booking-cancellation-case/route.ts");
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../app/api/booking-cancellation-case/route.ts", import.meta.url), "utf8");

  // The gate must exist and must exclude service_provider and customer. Asserted on the
  // resolved Set rather than on the text, so a renamed constant still passes and a
  // widened membership still fails.
  const match = source.match(/const STAFF_ROLES=new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, "a staff-role gate must exist in the cancellation-case route");
  const roles = new Set(match[1].split(",").map((item) => item.trim().replace(/^"|"$/g, "")));
  assert.equal(roles.has("service_provider"), false, "a provider must never adjudicate a cancellation case");
  assert.equal(roles.has("customer"), false, "a customer must never adjudicate a cancellation case");
  assert.ok(roles.has("admin") && roles.has("manager"), "staff must retain access");
  assert.ok(typeof route.GET === "function" && typeof route.POST === "function");
  assert.match(source, /cancellation_case_staff_only/, "the refusal must carry a governed code, not a bare 403");
});
