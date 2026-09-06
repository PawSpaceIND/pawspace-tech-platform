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
/* --- AUDIT-H4 -------------------------------------------------------------
 *
 * CONTRACT STRENGTHENED. The first version of this test asserted only the SOURCE TEXT: that a
 * STAFF_ROLES set existed, excluded service_provider, and that the string
 * "cancellation_case_staff_only" appeared somewhere in the file. That pins the DECLARATION of the
 * gate, never that it is CALLED - deleting both `requireStaff(...)` call sites left the test green,
 * which I verified by doing exactly that. A gate that is declared and never invoked is the bug.
 *
 * It now drives the real GET and POST handlers with a real service_provider actor.
 *
 * The role matters: `service_provider` holds "bookings.view" (lib/platform-security.ts), which is the
 * permission this route authorizes on - so the permission check ALONE lets a contractor read the
 * customer's stated cancellation reason and adjudicate the refund. requireStaff is the only thing
 * standing between them and a dispute they are a party to.
 *
 * ORIGIN is deliberately a real https host, not localhost: lib/development-preview.ts grants
 * superuser ["*"] on localhost/127.0.0.1/terminal.local, and the suite runs with
 * PAWSPACE_LOCAL_PREVIEW=on, so a localhost origin here would make this test pass for the wrong
 * reason.
 */
const CASE_ORIGIN = "https://app.pawspace.in";
const CASE_STAFF = "manager.cancellation-case@pawspace.in";
const CASE_PROVIDER = "provider.cancellation-case@pawspace.in";

async function cancellationCaseWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__AUDIT_DB__ = db;
  globalThis.__AUDIT_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-CASE-MANAGER", CASE_STAFF, "manager"],
    ["USR-CASE-PROVIDER", CASE_PROVIDER, "service_provider"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(id, email, role, role, now, now);
  }
  return await import("../app/api/booking-cancellation-case/route.ts");
}

const asActor = (email, init = {}) =>
  new Request(`${CASE_ORIGIN}/api/booking-cancellation-case?caseId=CASE-1`, {
    headers: { "oai-authenticated-user-email": email, "content-type": "application/json" },
    ...init,
  });

test("AUDIT-H4: a service_provider cannot read a cancellation case, despite holding bookings.view", async () => {
  const route = await cancellationCaseWorld();
  const response = await route.GET(asActor(CASE_PROVIDER));
  assert.equal(response.status, 403, "a provider must never read a dispute they are a party to");
  assert.match(await response.text(), /cancellation_case_staff_only/,
    "the refusal must carry a governed code, not a bare 403");
});

test("AUDIT-H4b: a service_provider cannot adjudicate a cancellation case", async () => {
  const route = await cancellationCaseWorld();
  const response = await route.POST(asActor(CASE_PROVIDER, {
    method: "POST",
    body: JSON.stringify({ caseId: "CASE-1", action: "finance_decision", decision: "full_refund", reason: "self-serve" }),
  }));
  assert.equal(response.status, 403, "a provider must never decide the refund on their own job");
  assert.match(await response.text(), /cancellation_case_staff_only/);
});

test("AUDIT-H4c: staff are NOT refused by the same gate", async () => {
  /* Non-vacuity. `return 403 always` would satisfy both assertions above. Staff must get past the
   * gate; the route then fails on its own missing fixture data, which is a DIFFERENT refusal - the
   * only thing asserted here is that it is not the staff-only 403. */
  const route = await cancellationCaseWorld();
  const response = await route.GET(asActor(CASE_STAFF));
  const body = await response.text();
  assert.doesNotMatch(body, /cancellation_case_staff_only/,
    "a manager must pass the staff gate");
});

// --- AUDIT-H6 -------------------------------------------------------------
// The refund overage was measured against what the booking was BILLED, not against what was actually
// COLLECTED. On a booking where the gateway captured less than the invoice (a partial capture, or a
// capture that never settled), refunding the full invoice moved more money out than ever came in and
// the ledger computed the overage as 0 and certified the row "matched" - the one case it must scream
// about was the case it called clean.
test("AUDIT-H6: a refund larger than the money actually captured is flagged as an overage", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__AUDIT_DB__ = db;
  globalThis.__AUDIT_ENV__ = {};
  const mod = await import("../lib/grooming-payment-reconciliation.ts");
  await mod.ensurePaymentReconciliationTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,amount REAL,status TEXT,gateway_reference TEXT,created_at INTEGER,updated_at INTEGER)");

  // Billed 4000. The gateway only ever captured 1000.
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-H6','BK-H6','CUS-H6',4000,4000,'INR','card','prepaid','captured','razorpay','idem-h6','{}',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,updated_at) VALUES ('PAY-H6','BK-H6','razorpay','sandbox',4000,1000,0,'INR','captured','matched',0,?)").run(now);
  sqlite.prepare("INSERT INTO booking_refund_cases VALUES ('RFD-H6','BK-H6','PAY-H6',4000,'approved',NULL,?,?)").run(now, now);

  await mod.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-h6-refund",
    eventType: "refund.processed", bookingId: "BK-H6", amountSubunits: 400000,
    gatewayRefundId: "rfnd_h6", payloadHash: "sha256:h6", signatureVerified: true,
  });

  const row = sqlite.prepare("SELECT reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='PAY-H6'").get();
  assert.equal(row.reconciliation_status, "refund_overage",
    "refunding 4000 against 1000 captured must not be certified as matched");
  assert.equal(Math.round(Number(row.variance_amount)), 3000,
    "the overage must be measured against money COLLECTED, not money billed");

  const exceptions = sqlite.prepare("SELECT exception_type FROM payment_reconciliation_exceptions WHERE payment_id='PAY-H6'").all();
  assert.ok(exceptions.some((item) => String(item.exception_type) === "refund_overage"),
    "an overage must raise a payment exception a human will see");
});

test("AUDIT-H6b: an ordinary full refund against a full capture stays matched", async () => {
  /* Non-vacuity. Flagging EVERY refund as an overage would satisfy the test above. When captured
   * equals expected - the ordinary path - the ceiling changes nothing and the row must stay clean. */
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__AUDIT_DB__ = db;
  globalThis.__AUDIT_ENV__ = {};
  const mod = await import("../lib/grooming-payment-reconciliation.ts");
  await mod.ensurePaymentReconciliationTables(db);
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,amount REAL,status TEXT,gateway_reference TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-H6B','BK-H6B','CUS-H6B',4000,4000,'INR','card','prepaid','captured','razorpay','idem-h6b','{}',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,updated_at) VALUES ('PAY-H6B','BK-H6B','razorpay','sandbox',4000,4000,0,'INR','captured','matched',0,?)").run(now);
  sqlite.prepare("INSERT INTO booking_refund_cases VALUES ('RFD-H6B','BK-H6B','PAY-H6B',4000,'approved',NULL,?,?)").run(now, now);

  await mod.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "evt-h6b-refund",
    eventType: "refund.processed", bookingId: "BK-H6B", amountSubunits: 400000,
    gatewayRefundId: "rfnd_h6b", payloadHash: "sha256:h6b", signatureVerified: true,
  });

  const row = sqlite.prepare("SELECT reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='PAY-H6B'").get();
  assert.notEqual(row.reconciliation_status, "refund_overage",
    "a full refund of fully captured money is not an overage");
  assert.equal(Math.round(Number(row.variance_amount)), 0);
});

// --- AUDIT-H2 -------------------------------------------------------------
// POST returned operateAssignment's promise WITHOUT awaiting it. `return somePromise` inside a
// try/catch leaves the try block immediately, so a rejection raised inside operateAssignment was
// never seen by the catch below it — skipping governedRefusal entirely and rejecting the handler
// instead of producing the governed status. Reverting `return await` to `return` reddened ZERO of
// 4293 tests before this one existed; I measured that rather than assuming it.
test("AUDIT-H2: an async refusal inside operateAssignment is converted, not left to reject", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const base = makeD1(sqlite);
  // Throws only for the one read that happens AFTER operateAssignment's first await, so the failure
  // is genuinely asynchronous — which is the whole point. Everything else behaves normally.
  const db = {
    ...base,
    prepare: (sql) => /FROM scheduling_assignment_decisions/.test(sql)
      ? { bind: () => ({ first: async () => { throw new Response("Assignment lookup refused", { status: 409 }); } }) }
      : base.prepare(sql),
  };
  globalThis.__AUDIT_DB__ = db;
  globalThis.__AUDIT_ENV__ = {};
  const route = await import("../app/api/uat-scheduling/route.ts");

  // localhost deliberately: lib/development-preview.ts grants the scheduling.manage permission this
  // path needs, and authorization is not what is under test here — error conversion is.
  const request = new Request("http://localhost/api/uat-scheduling", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reassign", groupId: "SG-H2", providerId: "PRV-H2" }),
  });

  const response = await route.POST(request);
  assert.ok(response instanceof Response, "POST must resolve to a Response, not reject");
  assert.equal(response.status, 409, "the governed 409 must survive, not become an unhandled rejection");
});
