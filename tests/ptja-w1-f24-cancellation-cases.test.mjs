/**
 * Post-start cancellation: the approved PawSpace rule. [PTJA-W1-F24]
 *
 * Once a booking reaches EN_ROUTE (this platform calls it `on_the_way`), ARRIVED, IN_SERVICE or
 * COMPLETED, a customer cancellation request must not directly cancel the booking. It opens a reviewable
 * case and the operational state is preserved:
 *
 *   Cancellation requested -> Case opened -> Booking remains active -> Operations decision
 *   -> Finance decision if applicable -> Customer and provider notified -> Case closed
 *
 * The ten cases the business asked for are each named below. Two further things are asserted because
 * they were found by execution while building this:
 *
 *   - `on_the_way` had to be configured alongside `en_route`. With only the business's word for the
 *     state, a customer cancelling while the groomer was ALREADY DRIVING to the house fell through to
 *     the notice ladder and was auto-refunded the full Rs 2,000. Measured, then closed.
 *   - a stop writes a DISTINCT terminal status, never ordinary `cancelled`, so a job that ran and was
 *     halted is never confused with one that never happened. The configuration surface refuses to save
 *     `cancelled` as that status.
 *
 * Every case executes the real module or the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_CASE_DB__", "__PTJA_CASE_ENV__");

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

const HOUR = 3_600_000;
const readSource = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const statementsOf = (source) => [...source.matchAll(/db\.prepare\(\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((match) => match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\"));

const headers = (email) => ({
  "oai-authenticated-user-email": email,
  "oai-authenticated-user-full-name": "Case%20operator",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
});
const MANAGER = headers("case-manager@pawspace.test");   // bookings.manage - Operations/Manager
const ASSOCIATE = headers("case-associate@pawspace.test"); // bookings.view only
const FOUNDER = headers("case-founder@pawspace.test");

const call = async (modulePath, method, path, body, extra = {}) => {
  const route = await import(modulePath);
  const url = `https://uat.pawspace.in${path}`;
  const request = body
    ? new Request(url, { method, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) })
    : new Request(url, { method, headers: extra });
  const response = await route[method](request);
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
};

const CHANGE_ROUTE = "../app/api/grooming-booking-change/route.ts";
const CASE_ROUTE = "../app/api/booking-cancellation-case/route.ts";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_CASE_DB__ = db;
  globalThis.__PTJA_CASE_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };

  for (const path of ["app/api/grooming-booking-change/route.ts", "app/api/uat-scheduling/route.ts", "lib/grooming-policy-governance.ts", "lib/customer-account.ts"]) {
    for (const sql of statementsOf(readSource(path))) if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql)) { try { sqlite.exec(sql); } catch { /* owned elsewhere */ } }
  }
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL,channel TEXT NOT NULL,total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL,status TEXT NOT NULL,assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  // The records the approved rule says must not move when a case opens.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_payout_lines (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_service_evidence (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL)");

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const { seedDefaultGroomingPolicy } = await import("../lib/grooming-policy-governance.ts");
  await seedDefaultGroomingPolicy(db);
  // Created up front so "no case was opened" is an observation about an empty table, not about a missing one.
  const { ensureCancellationCaseTables } = await import("../lib/cancellation-case-governance.ts");
  await ensureCancellationCaseTables(db);
  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-CASE-MGR", "case-manager@pawspace.test", "manager"],
    ["USR-CASE-ASSOC", "case-associate@pawspace.test", "associate"],
    ["USR-CASE-FOUNDER", "case-founder@pawspace.test", "founder"],
  ]) {
    await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").bind(id, email, email, role, now, now).run();
  }

  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: "customer:CUST-CASE",
    subjectType: "customer", subjectId: "CUST-CASE", verificationState: "verified", actorId: "ptja-case", reason: "PTJA W1-F24 cases",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: "CUST-CASE",
  });
  const cookie = `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;

  const seed = (bookingId, status, { amount = 2000 } = {}) => {
    const start = new Date(Date.now() - HOUR).toISOString();
    sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("CUST-CASE", "blr", "Case customer", "9999900624", "customer_app", "{}", now, now);
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,'CUST-CASE','[]','[]','blr','blr-east','grooming','dog-basic','Bath & Basic',?,'groom_arun',?,?,?,'customer_app',?,'INR','{}','test',?,?)")
      .run(bookingId, `ik-${bookingId}`, `GRP-${bookingId}`, start, new Date(Date.parse(start) + 2 * HOUR).toISOString(), status, amount, now, now);
    sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,'groom_arun','Arun R.','full_time','grooming',?,?,1,?,'{}',?,?)")
      .run(`WO-${bookingId}`, bookingId, `GRP-${bookingId}`, start, new Date(Date.parse(start) + 2 * HOUR).toISOString(), status, now, now);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,'CUST-CASE',?,0,'INR','upi','prepaid','captured','uat_sandbox',?,'{}',?,?)")
      .run(`PAY-${bookingId}`, bookingId, amount, `pik-${bookingId}`, now, now);
    sqlite.prepare("INSERT INTO provider_payout_lines (id,booking_id,provider_id,amount,status,created_at) VALUES (?,?,'groom_arun',?, 'eligible',?)")
      .run(`PO-${bookingId}`, bookingId, amount * 0.7, now);
    sqlite.prepare("INSERT INTO booking_service_evidence (id,booking_id,kind,detail,created_at) VALUES (?,?,'arrival_otp','482913',?)")
      .run(`EV-${bookingId}`, bookingId, now);
  };

  const requestCancel = (bookingId, extra = {}) => call(CHANGE_ROUTE, "POST", "/api/grooming-booking-change",
    { bookingId, customerId: "CUST-CASE", action: "cancel", reason: "please stop the service", ...extra }, { cookie });
  const snapshot = (bookingId) => ({
    booking: sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status,
    work: sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(bookingId).status,
    payment: sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status,
    payout: sqlite.prepare("SELECT status,amount FROM provider_payout_lines WHERE booking_id=?").get(bookingId),
    evidence: sqlite.prepare("SELECT detail FROM booking_service_evidence WHERE booking_id=?").get(bookingId).detail,
    refundCases: sqlite.prepare("SELECT COUNT(*) n FROM booking_refund_cases WHERE booking_id=?").get(bookingId).n,
  });

  return { sqlite, db, seed, requestCancel, snapshot };
}

// 1 -----------------------------------------------------------------------------------------------
test("CASE-1: a cancellation requested during IN_SERVICE leaves the booking IN_SERVICE", async () => {
  const w = await world();
  w.seed("BK-CASE-1", "in_service");
  const before = w.snapshot("BK-CASE-1");

  const result = await w.requestCancel("BK-CASE-1");

  assert.equal(result.status, 409, JSON.stringify(result.body).slice(0, 300));
  assert.equal(result.body.code, "cancellation_requires_approval");
  assert.equal(w.snapshot("BK-CASE-1").booking, "in_service", "the booking is still in service");
  assert.equal(w.snapshot("BK-CASE-1").work, before.work, "and the provider's work order is untouched");
});

// 2 -----------------------------------------------------------------------------------------------
test("CASE-2: no automatic refund and no payout reversal occurs", async () => {
  const w = await world();
  w.seed("BK-CASE-2", "in_service");
  const before = w.snapshot("BK-CASE-2");

  const result = await w.requestCancel("BK-CASE-2");
  const after = w.snapshot("BK-CASE-2");

  assert.equal(result.body.refundPromised, false, "opening a case promises nothing");
  assert.equal(after.payment, before.payment, "the payment is not moved to refund_pending");
  assert.deepEqual(after.payout, before.payout, "the provider payout line is untouched - it is a calculation, not something a case erases");
  assert.equal(after.refundCases, 0, "and no refund case is created by the request alone");
});

// 3 and 4 -----------------------------------------------------------------------------------------
test("CASE-3/4: a case is created exactly once and a repeat request reuses it", async () => {
  const w = await world();
  w.seed("BK-CASE-3", "in_service");

  const first = await w.requestCancel("BK-CASE-3");
  const second = await w.requestCancel("BK-CASE-3");
  const third = await w.requestCancel("BK-CASE-3");

  assert.equal(first.body.duplicateOfOpenCase, false, "the first request opens the case");
  assert.equal(second.body.duplicateOfOpenCase, true, "the second reuses it");
  assert.equal(third.body.caseId, first.body.caseId, "and every repeat names the same case");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_cancellation_cases WHERE booking_id='BK-CASE-3'").get().n, 1,
    "exactly one case row exists");
  const repeats = w.sqlite.prepare("SELECT COUNT(*) n FROM booking_cancellation_case_events WHERE case_id=? AND event_type='duplicate_request_recorded'").get(first.body.caseId).n;
  assert.equal(repeats, 2, "but both repeats are recorded, so Operations can see the customer asked again");
});

// 5 -----------------------------------------------------------------------------------------------
test("CASE-5: the provider keeps progressing unless Operations stops the job", async () => {
  const w = await world();
  w.seed("BK-CASE-5", "arrived");
  await w.requestCancel("BK-CASE-5");

  // An open case does not freeze the job: the provider starts the service exactly as before.
  w.sqlite.prepare("UPDATE canonical_bookings SET status='in_service' WHERE id='BK-CASE-5'").run();
  w.sqlite.prepare("UPDATE provider_work_orders SET status='in_service' WHERE booking_id='BK-CASE-5'").run();

  assert.equal(w.snapshot("BK-CASE-5").booking, "in_service", "status progression is unaffected by an open case");
  const record = w.sqlite.prepare("SELECT status FROM booking_cancellation_cases WHERE booking_id='BK-CASE-5'").get();
  assert.equal(record.status, "open", "and the case is still waiting on an Operations decision");
});

// 6 -----------------------------------------------------------------------------------------------
test("CASE-6: an Operations stop records STOPPED_AFTER_START, not ordinary cancelled", async () => {
  const w = await world();
  w.seed("BK-CASE-6", "in_service");
  const opened = await w.requestCancel("BK-CASE-6");

  const stopped = await call(CASE_ROUTE, "POST", "/api/booking-cancellation-case", {
    caseId: opened.body.caseId, action: "ops_decision", decision: "stop",
    reason: "Customer reported the dog was distressed and asked us to stop",
    evidence: { photos: 2, providerStatement: "recorded" },
    communication: { customer: "called and informed", provider: "notified in app" },
  }, MANAGER);

  assert.equal(stopped.status, 200, JSON.stringify(stopped.body).slice(0, 300));
  assert.equal(stopped.body.data.stoppedStatus, "stopped_after_start");
  const after = w.snapshot("BK-CASE-6");
  assert.equal(after.booking, "stopped_after_start", "a job that ran and was halted is not recorded as one that never happened");
  assert.notEqual(after.booking, "cancelled");
  assert.equal(after.work, "stopped_after_start");
  assert.equal(stopped.body.data.refundPromised, false, "and stopping the job still promises no refund");
});

// 7 -----------------------------------------------------------------------------------------------
test("CASE-7: a refund requires a separate authorised approval", async () => {
  const w = await world();
  w.seed("BK-CASE-7", "in_service");
  const opened = await w.requestCancel("BK-CASE-7");
  await call(CASE_ROUTE, "POST", "/api/booking-cancellation-case", {
    caseId: opened.body.caseId, action: "ops_decision", decision: "stop", reason: "Operations stopped the job on request",
    evidence: { note: "recorded" }, communication: { customer: "informed" },
  }, MANAGER);

  assert.equal(w.snapshot("BK-CASE-7").payment, "captured", "the Operations stop did not move the money");
  const record = w.sqlite.prepare("SELECT refund_amount_approved,finance_decision FROM booking_cancellation_cases WHERE id=?").get(opened.body.caseId);
  assert.equal(record.refund_amount_approved, null, "and approved nothing");
  assert.equal(record.finance_decision, null);

  const refused = await call(CASE_ROUTE, "POST", "/api/booking-cancellation-case", {
    caseId: opened.body.caseId, action: "finance_decision", decision: "refund_partial", refundAmount: 800,
    reason: "Partial refund for the shortened service", communication: { customer: "informed" },
  }, ASSOCIATE);
  assert.equal(refused.status, 403, `an associate may not approve a refund: ${JSON.stringify(refused.body)}`);

  const approved = await call(CASE_ROUTE, "POST", "/api/booking-cancellation-case", {
    caseId: opened.body.caseId, action: "finance_decision", decision: "refund_partial", refundAmount: 800,
    reason: "Partial refund for the shortened service", communication: { customer: "informed" },
  }, MANAGER);
  assert.equal(approved.status, 200, `a Manager/Finance role may: ${JSON.stringify(approved.body)}`);
  assert.equal(approved.body.data.refundAmountApproved, 800);
  assert.equal(approved.body.data.case.status, "closed", "and the case closes on the Finance decision");
});

// 8 -----------------------------------------------------------------------------------------------
test("CASE-8: the customer cannot alter completion evidence or the provider payout", async () => {
  const w = await world();
  w.seed("BK-CASE-8", "in_service");
  const before = w.snapshot("BK-CASE-8");

  await w.requestCancel("BK-CASE-8");
  await w.requestCancel("BK-CASE-8");

  const after = w.snapshot("BK-CASE-8");
  assert.equal(after.evidence, before.evidence, "the arrival OTP and delivery evidence are untouched");
  assert.deepEqual(after.payout, before.payout, "and so is the provider payout line");
});

// 9 -----------------------------------------------------------------------------------------------
test("CASE-9: a completed booking creates a dispute, not a cancellation", async () => {
  const w = await world();
  w.seed("BK-CASE-9", "completed");

  const result = await w.requestCancel("BK-CASE-9");

  assert.equal(result.status, 409);
  assert.equal(result.body.caseType, "service_dispute", "cancellation is unavailable once the service is delivered");
  assert.equal(result.body.code, "dispute_case_opened");
  assert.equal(w.snapshot("BK-CASE-9").booking, "completed", "and the completed booking is unchanged");
});

// 10 ----------------------------------------------------------------------------------------------
test("CASE-10: every decision and communication is auditable", async () => {
  const w = await world();
  w.seed("BK-CASE-10", "in_service");
  const opened = await w.requestCancel("BK-CASE-10");
  await call(CASE_ROUTE, "POST", "/api/booking-cancellation-case", {
    caseId: opened.body.caseId, action: "ops_decision", decision: "stop", reason: "Stopped at the customer's request",
    evidence: { providerStatement: "recorded", photos: 1 }, communication: { customer: "called 18:42", provider: "app notification" },
  }, MANAGER);
  await call(CASE_ROUTE, "POST", "/api/booking-cancellation-case", {
    caseId: opened.body.caseId, action: "finance_decision", decision: "refund_partial", refundAmount: 500,
    reason: "Half the groom was completed", communication: { customer: "refund confirmed by SMS" },
  }, MANAGER);

  const events = w.sqlite.prepare("SELECT event_type,actor_id,reason,evidence_json,communication_json FROM booking_cancellation_case_events WHERE case_id=? ORDER BY occurred_at,rowid").all(opened.body.caseId);
  const types = events.map((row) => row.event_type);
  assert.deepEqual(types, ["case_opened", "ops_stop", "finance_refund_partial"], `the full trail: ${JSON.stringify(types)}`);
  for (const row of events.slice(1)) {
    assert.ok(row.actor_id, "every decision names its actor");
    assert.ok(String(row.reason).length >= 5, "and its reason");
    assert.notEqual(row.communication_json, "{}", "and the communication that went with it");
  }
  assert.match(String(events[1].evidence_json), /providerStatement/, "the Operations stop carries its evidence");
  // Asserted as a set: security_audit_events keys on a UUID, so row order is not decision order. The
  // decision ORDER is already proved by the event trail above, which is timestamped.
  const security = w.sqlite.prepare("SELECT action FROM security_audit_events WHERE action LIKE 'booking.cancellation_case%'").all().map((row) => row.action).sort();
  assert.deepEqual(security, ["booking.cancellation_case.finance_decision", "booking.cancellation_case.ops_decision"],
    "and the platform security log records both decisions");
});

// The two findings from building this ---------------------------------------------------------------
test("CASE: on_the_way is EN_ROUTE, and the STATUS blocks the refund regardless of the clock", async () => {
  /*
   * The approved rule names EN_ROUTE; this platform's lifecycle calls the same state `on_the_way`, and
   * only `en_route` was configured at first. Measured with that configuration, on a booking marked
   * on_the_way while 48 hours of notice remained: HTTP 200 and an automatic Rs 2,000 refund, because the
   * request fell past the status check and landed in the >24h band of the notice ladder.
   *
   * HONEST SCOPE, because the first version of this case proved nothing: with a start time close to now
   * the ladder answers 0% anyway and a case opens either way, so the gap only bites when a provider is
   * marked on_the_way well before the scheduled start. That is reachable - app/api/grooming-lifecycle
   * puts no clock guard on the transition - but it is not the everyday path. The far-future start below
   * is what makes the STATUS the only thing doing the work, and dropping `on_the_way` from the policy
   * now fails this case rather than passing for the wrong reason.
   */
  const w = await world();
  const start = new Date(Date.now() + 48 * HOUR).toISOString();
  w.seed("BK-CASE-ENROUTE", "on_the_way");
  w.sqlite.prepare("UPDATE canonical_bookings SET scheduled_start=?,scheduled_end=? WHERE id='BK-CASE-ENROUTE'")
    .run(start, new Date(Date.parse(start) + 2 * HOUR).toISOString());
  const before = w.snapshot("BK-CASE-ENROUTE");

  const result = await w.requestCancel("BK-CASE-ENROUTE");

  assert.equal(result.status, 409, `48h of notice would be a 100% band, so only the status can refuse this: ${result.status} ${JSON.stringify(result.body).slice(0, 240)}`);
  assert.equal(result.body.refundPromised, false);
  assert.equal(w.snapshot("BK-CASE-ENROUTE").payment, before.payment, "no money moved");
  assert.equal(w.snapshot("BK-CASE-ENROUTE").booking, "on_the_way", "and the provider is left to keep driving");
});

test("CASE: a provider already driving at short notice also opens a case", async () => {
  // The everyday shape of the same state, kept because it is the one that actually happens.
  const w = await world();
  w.seed("BK-CASE-ENROUTE-NOW", "on_the_way");

  const result = await w.requestCancel("BK-CASE-ENROUTE-NOW");

  assert.equal(result.status, 409);
  assert.equal(result.body.refundPromised, false);
});

test("CASE: Operations decisions are bounded by the status the request was made at", async () => {
  const w = await world();
  w.seed("BK-CASE-BOUND", "in_service");
  const opened = await w.requestCancel("BK-CASE-BOUND");

  // `return` is a decision for a provider still travelling or at the door, not one mid-service.
  const invalid = await call(CASE_ROUTE, "POST", "/api/booking-cancellation-case", {
    caseId: opened.body.caseId, action: "ops_decision", decision: "return", reason: "attempted return mid-service",
    evidence: { note: "x" }, communication: { customer: "x" },
  }, MANAGER);
  assert.equal(invalid.status, 409, `return is not available mid-service: ${JSON.stringify(invalid.body)}`);
  assert.deepEqual(invalid.body.allowed, ["proceed", "stop"], "and the refusal says what is");
});

test("CASE: a booking that has NOT started still cancels directly - no case is opened", async () => {
  // Non-vacuity. Routing every cancellation to a case would satisfy every assertion above and would
  // replace self-serve cancellation with a manual queue.
  const w = await world();
  const start = new Date(Date.now() + 48 * HOUR).toISOString();
  w.seed("BK-CASE-EARLY", "confirmed");
  w.sqlite.prepare("UPDATE canonical_bookings SET scheduled_start=?,scheduled_end=? WHERE id='BK-CASE-EARLY'")
    .run(start, new Date(Date.parse(start) + 2 * HOUR).toISOString());

  const result = await w.requestCancel("BK-CASE-EARLY");

  assert.equal(result.status, 200, `an early cancellation is still self-serve: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(w.snapshot("BK-CASE-EARLY").booking, "cancelled");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_cancellation_cases WHERE booking_id='BK-CASE-EARLY'").get().n, 0,
    "and no review case is opened for it");
});

test("CASE: a stop status of ordinary 'cancelled' cannot be configured", async () => {
  const { db } = await world();
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_CANCELLATION_CASE_POLICY } = await import("../lib/cancellation-case-governance.ts");
  await assert.rejects(
    () => writeServicePolicy(db, { domain: "cancellation_case_policy", serviceCode: "grooming", cityId: "blr",
      config: { ...APPROVED_CANCELLATION_CASE_POLICY, stoppedTerminalStatus: "cancelled" } }, "ops@pawspace.test", "attempt to blur the distinction"),
    (error) => { assert.ok(error instanceof Response); return true; },
    "a job stopped after it started must keep a distinct terminal status");

  await assert.rejects(
    () => writeServicePolicy(db, { domain: "cancellation_case_policy", serviceCode: "grooming", cityId: "blr",
      config: { ...APPROVED_CANCELLATION_CASE_POLICY, caseOnlyStatuses: ["en_route", "arrived", "in_service"] } }, "ops@pawspace.test", "attempt to drop on_the_way"),
    (error) => { assert.ok(error instanceof Response); return true; },
    "dropping on_the_way reopens the measured defect");
});
