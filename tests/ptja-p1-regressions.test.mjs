/**
 * PawSpace Total Journey Audit — permanent behavioural regressions for the confirmed P1 defects.
 *
 * Same rule as the P0 file: nothing here reads a source file, every assertion executes the real module
 * or the real route, and every case records the failure it locks out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_P1_DB__", "__PTJA_P1_ENV__");

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

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_P1_DB__ = db;
  globalThis.__PTJA_P1_ENV__ = env;
  return { sqlite, db };
}

async function customerCookie(db, customerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${customerId}`,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "ptja-p1", reason: "PTJA P1 executable regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const STAFF_HEADERS = {
  "oai-authenticated-user-email": "ops-scheduler@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20scheduler",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

async function post(modulePath, path, body, headers = {}) {
  const route = await import(modulePath);
  const response = await route.POST(new Request(`https://uat.pawspace.in${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

// =====================================================================================================
// PTJA-P1-F36 — /api/uat-scheduling's privileged actions have no authorization in the route itself
//
// SEVERITY CORRECTED DOWN, and the correction matters more than the fix. The finding was raised as a
// live cross-tenant write: a plain customer session cancelling and reassigning another customer's
// scheduling group. It reproduces exactly that way against the exported POST handler - but that is not
// how a request reaches this route in production. worker/index.ts sends every /api/ request through
// authorizePlatformSessionRequest and then authorizeApiRequest, and lib/api-gateway.ts already maps
// this path to `scheduling.manage` for any action other than reserve. Executed against that chain with
// the same customer session, all four actions are refused 403 "Permission denied" (asserted below).
//
// So this is a defence-in-depth gap, not a live exposure: the route handler is the SECOND gate and it
// has none, while the reserve branch right beside it calls requireCustomerOwnership. Every comparable
// route in this repository carries that second gate deliberately - app/api/location-recovery/route.ts
// says so in as many words: "the gateway is the first gate, this is the second". This one did not.
// =====================================================================================================

async function schedulingWorld() {
  const { sqlite, db } = world({ PAWSPACE_PAYMENT_ENV: "sandbox" });
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  const { ensureSchedulingTables } = await import("../lib/scheduling-store.ts").catch(() => ({ ensureSchedulingTables: null }));
  await ensureSecurityTables(db);
  await seedProviderCapacityDefaults(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-PTJA-SCHED','ops-scheduler@pawspace.test','Ops scheduler','founder','active',?,?)").bind(now, now).run();
  if (ensureSchedulingTables) await ensureSchedulingTables(db);
  return { sqlite, db };
}

const PRIVILEGED_ACTIONS = ["cancel", "reassign", "assign", "manual"];

test("P1-F36: the production gateway chain already refuses a customer these actions", async () => {
  // Recorded because it is the reason this finding is not a P0, and because if the gateway mapping ever
  // regresses this test says so before the route's own gate is the only thing left.
  const { db } = await schedulingWorld();
  const cookie = await customerCookie(db, "CUST-ATTACKER-B");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  for (const action of PRIVILEGED_ACTIONS) {
    const make = () => new Request("https://uat.pawspace.in/api/uat-scheduling", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ action, groupId: "GRP-VICTIM-001", providerId: "groom_arun", reason: "probe" }),
    });
    const sessionAccess = await authorizePlatformSessionRequest(make(), db);
    const access = sessionAccess ?? await authorizeApiRequest(make(), { DB: db });
    assert.ok(access instanceof Response, `${action}: the gateway must answer, not pass through`);
    assert.equal(access.status, 403, `${action}: refused by the gateway`);
  }
});

test("P1-F36: the route itself now refuses a customer these actions - the second gate exists", async () => {
  // Measured before the fix, calling the exported handler directly: 200 for all four, with the victim's
  // provider shortlist and scoring explanation in the response body, and security_audit_events recording
  // the cross-tenant writes as outcome 'completed'.
  const { db } = await schedulingWorld();
  const cookie = await customerCookie(db, "CUST-ATTACKER-B");
  for (const action of PRIVILEGED_ACTIONS) {
    const result = await post("../app/api/uat-scheduling/route.ts", "/api/uat-scheduling",
      { action, groupId: "GRP-VICTIM-001", providerId: "groom_arun", reason: "attacker probe" }, { cookie });
    assert.equal(result.status, 403, `${action}: a customer session must be refused by the route too, got ${result.status} ${JSON.stringify(result.body)}`);
  }
});

test("P1-F36: a staff actor holding scheduling.manage is not refused by the new gate", async () => {
  // Non-vacuity. Refusing everyone would satisfy the case above and would break Ops entirely.
  await schedulingWorld();
  for (const action of PRIVILEGED_ACTIONS) {
    const result = await post("../app/api/uat-scheduling/route.ts", "/api/uat-scheduling",
      { action, groupId: "GRP-DOES-NOT-EXIST", providerId: "groom_arun", reason: "ops probe" }, STAFF_HEADERS);
    assert.notEqual(result.status, 403, `${action}: staff must pass the authorization gate (got 403 ${JSON.stringify(result.body)})`);
  }
});

test("P1-F36: the customer's own reserve path is untouched", async () => {
  // The reserve branch is the one a customer legitimately uses, and it authorizes by ownership rather
  // than by permission. A gate on the privileged actions must not touch it.
  const { db } = await schedulingWorld();
  const cookie = await customerCookie(db, "CUST-SELF-01");
  const result = await post("../app/api/uat-scheduling/route.ts", "/api/uat-scheduling", {
    clientRequestId: "GRP-SELF-01", customerId: "CUST-SELF-01", petIds: ["PET-S1"], serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", scheduledStart: "2026-11-26T04:30:00.000Z", scheduledEnd: "2026-11-26T06:30:00.000Z",
  }, { cookie });
  assert.notEqual(result.status, 403, `a customer reserving for themselves must not be refused: ${JSON.stringify(result.body)}`);
});

// =====================================================================================================
// PTJA-P1-F51 — the automated 'run' path overwrites a human's recorded verification FAILURE
//
// Reproduced by execution through the real POST /api/provider-verification with a real non-preview admin
// identity. runProviderVerification's ON CONFLICT(application_id,verification_type) DO UPDATE sets
// status and detail_json unconditionally, so re-running the automated path over a NON-automatable type
// that a human had already resolved replaced 'failed' with 'manual_review' and replaced the inspector's
// note with the generic "Manual/agent verification required (photo or physical check)".
//
// Measured: record_manual house_verification -> failed with the note "Unsafe balcony; dog escaped during
// the visit. REJECT." -> 201. Then action 'run' for the same application and type -> 201 with
// {"status":"manual_review"}, no warning and no conflict. There is no verification history table, and
// the security-audit detail for record_manual carries only {verificationType,status}, never the note, so
// the recorded failure and the reason for it are gone from the database entirely.
//
// It does not by itself create eligibility - 'manual_review' is not 'verified', so the mandate still
// blocks activation. The damage is evidence destruction: a failed physical inspection becomes an
// innocuous "awaiting review", and the next agent can record 'verified' in good faith.
//
// The rule applied is the platform's own, from lib/idfy-callback-boundary.ts: a NON-decision may not
// overwrite a decision. Nothing here decides what a failure means or how long it stands.
// =====================================================================================================

async function verificationWorld() {
  const { sqlite, db } = world();
  const mandate = await import("../lib/provider-verification-mandate.ts");
  await mandate.ensureVerificationMandateTables(db);
  const rowFor = (type) => sqlite.prepare("SELECT status,detail_json,updated_by FROM provider_verifications WHERE application_id='APP-F51' AND verification_type=?").get(type);
  return { sqlite, db, mandate, rowFor };
}

test("P1-F51: an automated re-run cannot erase a human's recorded FAILURE or the inspector's note", async () => {
  const { db, mandate, rowFor } = await verificationWorld();
  await mandate.recordManualVerification(db, { applicationId: "APP-F51", verificationType: "house_verification", status: "failed", note: "Unsafe balcony; dog escaped during the visit. REJECT.", actorId: "inspector@pawspace.test" });
  assert.equal(rowFor("house_verification").status, "failed");

  const rerun = await mandate.runProviderVerification(db, {}, { applicationId: "APP-F51", category: "host", verificationType: "house_verification", actorId: "ops@pawspace.test" });
  assert.equal(rerun.status, "failed", "the run must report the decision that stands, not the one it wanted to write");

  const row = rowFor("house_verification");
  assert.equal(row.status, "failed", "a human decision is not overwritten by a re-run");
  assert.match(String(row.detail_json), /dog escaped during the visit/, "and the inspector's note survives");
});

test("P1-F51: a human's recorded PASS is equally protected", async () => {
  const { db, mandate, rowFor } = await verificationWorld();
  await mandate.recordManualVerification(db, { applicationId: "APP-F51", verificationType: "pet_proofing_photo", status: "verified", note: "Photos reviewed, home is pet-proofed", actorId: "inspector@pawspace.test" });
  await mandate.runProviderVerification(db, {}, { applicationId: "APP-F51", category: "host", verificationType: "pet_proofing_photo", actorId: "ops@pawspace.test" });
  const row = rowFor("pet_proofing_photo");
  assert.equal(row.status, "verified");
  assert.match(String(row.detail_json), /Photos reviewed/);
});

test("P1-F51: an UNDECIDED check can still be queued for review - the fix is not a freeze", async () => {
  // Non-vacuity. Refusing every re-run would break the ordinary submit path, where 'run' is exactly how
  // a manual check is put in front of an agent in the first place.
  const { db, mandate, rowFor } = await verificationWorld();
  const first = await mandate.runProviderVerification(db, {}, { applicationId: "APP-F51", category: "host", verificationType: "house_verification", actorId: "ops@pawspace.test" });
  assert.equal(first.status, "manual_review", "an undecided physical check is queued for a human");
  assert.equal(rowFor("house_verification").status, "manual_review");

  // And a human can still change their own mind afterwards - recordManualVerification is unaffected.
  await mandate.recordManualVerification(db, { applicationId: "APP-F51", verificationType: "house_verification", status: "failed", note: "Rejected on the second visit", actorId: "inspector@pawspace.test" });
  assert.equal(rowFor("house_verification").status, "failed");
  await mandate.recordManualVerification(db, { applicationId: "APP-F51", verificationType: "house_verification", status: "verified", note: "Remediated and re-inspected", actorId: "inspector@pawspace.test" });
  assert.equal(rowFor("house_verification").status, "verified", "a human may still revise a human decision");
});

// =====================================================================================================
// PTJA-P1-F29 / F35 — a provider's configured capacity numbers are not what the scheduler uses
//
// Two halves of one defect: nothing between the operator's keystroke and the scheduler treats these
// columns as numbers.
//
// F29 (severity confirmed, TITLE CORRECTED). rowToProvider built every numeric field with a JavaScript
// ||-fallback - Number(row.max_daily_jobs||6), Number(row.capacity||1),
// Number(row.travel_buffer_minutes||30) - so 0, the one value an operator uses to stand a provider
// DOWN, is falsy and was silently replaced by the hardcoded default. Measured: a driver PATCHed to
// max_daily_jobs 0 (accepted 200, stored as integer 0, audited) was handed SIX jobs by the scheduler,
// which then refused the seventh with "Daily job limit 6 reached" - quoting a number the row does not
// contain. The frozen title said a limit of 4 yields more than 4; that half is REFUTED by execution: 4
// reads back as 4 and yields exactly four. The defect is specific to 0 and to any falsy value.
//
// F35 (confirmed). The capacity-control PATCH validated numbers only with Number(value)<0, which NaN
// does not trip, so capacity:'four' was written as TEXT and read back as NaN. NaN comparisons are false,
// so the host stayed eligible and was selected, then the atomic guard bound NaN, matched zero rows, and
// the customer was told "Another reservation took this provider/slot a moment ago" - twice,
// deterministically, with no competing reservation in the table. One typo removed a boarding host from
// the platform behind a message that invited a retry.
//
// The correction is that a capacity column is a number: rejected at the write if it is not one, and read
// as one - present-but-zero included - if it is. No default changes and no limit is invented.
// =====================================================================================================

const CAPACITY_NUMERIC_FIELDS = ["capacity", "travel_buffer_minutes", "max_daily_jobs", "acceptance_timeout_minutes"];

async function capacityWorld() {
  const { sqlite, db } = world();
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-PTJA-CAP','ops-capacity@pawspace.test','Ops capacity','founder','active',?,?)").bind(now, now).run();
  const staff = {
    "oai-authenticated-user-email": "ops-capacity@pawspace.test",
    "oai-authenticated-user-full-name": "Ops%20capacity",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
  const patch = async (providerId, changes) => {
    const route = await import("../app/api/provider-capacity-control/route.ts");
    const response = await route.PATCH(new Request("https://uat.pawspace.in/api/provider-capacity-control", {
      method: "PATCH", headers: { "content-type": "application/json", ...staff },
      body: JSON.stringify({ providerId, changes, reason: "PTJA capacity regression" }),
    }));
    let parsed = null; try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
    return { status: response.status, body: parsed };
  };
  return { sqlite, db, capacity, patch };
}

test("P1-F29: standing a provider down to zero means zero, not the default", async () => {
  // Measured before the fix: max_daily_jobs 0 stored, read back as 6, and six jobs assigned.
  const { db, capacity, patch } = await capacityWorld();
  assert.equal((await patch("taxi_rahul", { max_daily_jobs: 0 })).status, 200);
  const provider = await capacity.getGovernedProvider(db, "taxi_rahul");
  assert.equal(provider.maxDailyJobs, 0, "a stand-down of 0 must not read back as 6");
});

test("P1-F29: zero capacity and zero travel buffer are equally respected", async () => {
  const { db, capacity, patch } = await capacityWorld();
  assert.equal((await patch("taxi_imran", { capacity: 0, travel_buffer_minutes: 0, max_daily_jobs: 0 })).status, 200);
  const provider = await capacity.getGovernedProvider(db, "taxi_imran");
  assert.equal(provider.capacity, 0, "a host with zero units has zero, not one");
  assert.equal(provider.travelBufferMinutes, 0, "an explicit zero buffer is a decision, not an absence");
  assert.equal(provider.maxDailyJobs, 0);
});

test("P1-F29: a configured non-zero limit is unchanged, and an unusable value still defaults", async () => {
  // Non-vacuity in both directions. The frozen title claimed 4 was broken; executed, it never was, and
  // the fix must not disturb it. And a column that is genuinely absent must still fall back.
  const { sqlite, db, capacity, patch } = await capacityWorld();
  assert.equal((await patch("taxi_rahul", { max_daily_jobs: 4 })).status, 200);
  assert.equal((await capacity.getGovernedProvider(db, "taxi_rahul")).maxDailyJobs, 4, "a configured 4 is 4");

  // The "absent" branch cannot arise in this table at all, which is worth recording rather than
  // simulating: every capacity column is NOT NULL, so there is no way to store an absence. The default
  // survives in the reader for callers that build a Provider from somewhere else, and for a legacy row
  // holding a non-number - reading THAT as 0 would silently make a live provider unbookable instead of
  // merely mis-limited, which is the failure F35 describes from the other direction.
  assert.throws(
    () => sqlite.prepare("UPDATE provider_capacity_profiles SET capacity=NULL WHERE id='taxi_meera'").run(),
    /NOT NULL constraint failed/,
    "a capacity column cannot be absent",
  );
  sqlite.prepare("UPDATE provider_capacity_profiles SET max_daily_jobs='not a number' WHERE id='taxi_meera'").run();
  assert.equal((await capacity.getGovernedProvider(db, "taxi_meera")).maxDailyJobs, 6, "a legacy non-number still reads as the documented default");
});

test("P1-F35: a capacity column that is not a number is refused at the write", async () => {
  // Measured before the fix: 200, 'four' stored as TEXT, read back NaN, and the host became permanently
  // unbookable behind a false SLOT_TAKEN.
  const { sqlite, db, capacity, patch } = await capacityWorld();
  for (const field of CAPACITY_NUMERIC_FIELDS) {
    const result = await patch("host_maya_rohan", { [field]: "four" });
    assert.equal(result.status, 400, `${field}: a non-numeric value must be refused, got ${result.status} ${JSON.stringify(result.body)}`);
    assert.match(String(result.body.error), /number/i);
  }
  const row = sqlite.prepare("SELECT capacity,typeof(capacity) t FROM provider_capacity_profiles WHERE id='host_maya_rohan'").get();
  assert.equal(row.t, "integer", "the stored column is still a number");
  assert.ok(Number.isFinite((await capacity.getGovernedProvider(db, "host_maya_rohan")).capacity), "and it still reads back as one");
});

test("P1-F35: legitimate numeric edits still go through - the fix is not a blanket refusal", async () => {
  const { db, capacity, patch } = await capacityWorld();
  assert.equal((await patch("host_maya_rohan", { capacity: 6, travel_buffer_minutes: 15, max_daily_jobs: 9 })).status, 200);
  const provider = await capacity.getGovernedProvider(db, "host_maya_rohan");
  assert.equal(provider.capacity, 6);
  assert.equal(provider.travelBufferMinutes, 15);
  assert.equal(provider.maxDailyJobs, 9);
  assert.equal((await patch("host_maya_rohan", { capacity: -1 })).status, 400, "and the existing negative check still holds");
});

// =====================================================================================================
// PTJA-P1-F23 — a lifecycle idempotency key is not bound to the entity or the action it acted on
//
// Every lifecycle module records booking_id (or stay_id / session_id) and action alongside the key, and
// then never reads them back: the lookup was "SELECT result_json FROM <table> WHERE idempotency_key=?"
// and it ran BEFORE the entity was loaded. So a second caller reusing a key - a DIFFERENT provider,
// acting on a DIFFERENT customer's booking - was answered HTTP 200, had its mutation silently discarded,
// and received the FIRST caller's bookingId, status and providerId in the response body.
//
// Measured through the real POST /api/walking-lifecycle with two real provider sessions:
//   WALKER-P1 accept BKG-A1 key IDEM-SHARED -> 200 {bookingId:BKG-A1,status:assigned,providerId:P1}
//   WALKER-P2 accept BKG-B2 key IDEM-SHARED -> 200 {bookingId:BKG-A1,...,duplicatePrevented:true}
//                                              BKG-B2 was never accepted; P2 got A1's identifiers.
//   WALKER-P1 DECLINE BKG-A1, same key       -> 200 with the accept result; no recovery case, no ops
//                                              escalation, no customer notification, and the security
//                                              audit recorded it as completed.
//
// Two failures in one: cross-tenant identifier disclosure, and a silently lost lifecycle transition -
// a walker's decline swallowed with a 200 so nobody is told the walk has no walker.
//
// A key identifies ONE mutation of ONE entity. Reused for a different entity or a different action it is
// a conflict, not a duplicate, and is refused rather than answered with somebody else's record. The
// columns needed to tell the difference were already being written.
// =====================================================================================================

async function walkingWorld() {
  const { sqlite, db } = world();
  const lifecycle = await import("../lib/walking-lifecycle.ts");
  const capacity = await import("../lib/provider-capacity-governance.ts");
  const stays = await import("../lib/boarding-stay-lifecycle.ts");
  await lifecycle.ensureWalkingLifecycleTables(db);
  // provider_assignment_offers and booking_customer_notifications belong to other modules; created
  // through their own ensures so this world uses the real schemas rather than a test-local guess.
  await capacity.ensureProviderCapacityTables(db);
  await stays.ensureBoardingStayLifecycleTables(db).catch(() => {});
  // The lifecycle module owns its own tables; the canonical booking and work order it reads belong to
  // the booking routes, so they are created here with the same shape those routes declare.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  const now = Date.now();
  const seed = (bookingId, customerId, providerId, groupId) => {
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','dog_walking','walk-30','Walk',?,?,?,?,'confirmed','customer_app',499,'INR','{}','seed',?,?)")
      .run(bookingId, `seed:${bookingId}`, customerId, groupId, providerId, "2026-11-26T04:30:00.000Z", "2026-11-26T05:00:00.000Z", now, now);
    sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,'commission','dog_walking',?,?,1,'assigned','{}',?,?)")
      .run(`WO-${bookingId}`, bookingId, groupId, providerId, `Walker ${providerId}`, "2026-11-26T04:30:00.000Z", "2026-11-26T05:00:00.000Z", now, now);
  };
  return { sqlite, db, lifecycle, seed };
}

test("P1-F23: a key reused on a DIFFERENT booking is refused, not answered with the first booking's record", async () => {
  const { sqlite, db, lifecycle, seed } = await walkingWorld();
  seed("BKG-A1", "CUST-A", "WALKER-P1", "GRP-A1");
  seed("BKG-B2", "CUST-B", "WALKER-P2", "GRP-B2");

  const first = await lifecycle.mutateWalkingBooking(db, { bookingId: "BKG-A1", action: "accept", actorId: "WALKER-P1", idempotencyKey: "IDEM-SHARED" });
  assert.equal(first.bookingId, "BKG-A1");

  await assert.rejects(
    () => lifecycle.mutateWalkingBooking(db, { bookingId: "BKG-B2", action: "accept", actorId: "WALKER-P2", idempotencyKey: "IDEM-SHARED" }),
    (error) => error instanceof Response && error.status === 409,
    "a key that belongs to another booking must be refused, never answered with that booking's record",
  );
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BKG-B2'").get().status), "confirmed",
    "and B2 is unchanged - the caller is told, rather than silently losing its mutation");
});

test("P1-F23: a key reused for a DIFFERENT action on the same booking is refused", async () => {
  // The lost-transition half. A walker's decline used to be swallowed with the accept result, so no
  // recovery case opened and nobody learned the walk had no walker.
  const { sqlite, db, lifecycle, seed } = await walkingWorld();
  seed("BKG-A1", "CUST-A", "WALKER-P1", "GRP-A1");
  await lifecycle.mutateWalkingBooking(db, { bookingId: "BKG-A1", action: "accept", actorId: "WALKER-P1", idempotencyKey: "IDEM-SHARED" });
  await assert.rejects(
    () => lifecycle.mutateWalkingBooking(db, { bookingId: "BKG-A1", action: "decline", actorId: "WALKER-P1", idempotencyKey: "IDEM-SHARED", reason: "walker is ill and cannot attend" }),
    (error) => error instanceof Response && error.status === 409,
    "a decline must not be answered with the accept it is trying to reverse",
  );
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM walking_recovery_cases").get().n), 0, "the refused decline opens no case");
});

test("P1-F23: a genuine replay - same key, same booking, same action - is still a duplicate", async () => {
  // Non-vacuity. Refusing every second use of a key would break retry handling, which is the entire
  // reason the key exists.
  const { sqlite, db, lifecycle, seed } = await walkingWorld();
  seed("BKG-A1", "CUST-A", "WALKER-P1", "GRP-A1");
  const first = await lifecycle.mutateWalkingBooking(db, { bookingId: "BKG-A1", action: "accept", actorId: "WALKER-P1", idempotencyKey: "IDEM-SAME" });
  sqlite.prepare("UPDATE canonical_bookings SET status='confirmed' WHERE id='BKG-A1'").run();
  const replay = await lifecycle.mutateWalkingBooking(db, { bookingId: "BKG-A1", action: "accept", actorId: "WALKER-P1", idempotencyKey: "IDEM-SAME" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.bookingId, first.bookingId);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BKG-A1'").get().status), "confirmed",
    "a true replay re-applies nothing");
});

// =====================================================================================================
// PTJA-P1-F16 / F3 — the same unscoped-key defect in the stay balance path and the lead engine
//
// F16 (money). stay_payment_events.idempotency_key is TEXT UNIQUE GLOBALLY, and payStayBalance flipped
// the schedule to 'paid' first and inserted the capture event second, swallowing a UNIQUE collision as
// "the same request already recorded its capture". Reused across two bookings, the second booking was
// marked PAID and its balance_captured event silently discarded. Measured: Rs 12,000 and Rs 15,000
// settled with no capture event, across two different customers. Keys are client-supplied, so two
// customers both sending "pay-balance" collide by accident.
//
// F3 (cross-lead disclosure and a silently starved lead). assignLead opened with
// "SELECT * FROM lead_assignments WHERE idempotency_key=?" and returned that row BEFORE leadContext()
// was ever called. Measured: assigning LEAD-B with LEAD-A's key returned 200 carrying LEAD-A's
// assignment row - its lead_id, the assigned employee's email, team and policy - while LEAD-B was never
// assigned and stayed unowned; and the same call for a lead id that does not exist returned the same
// 200. security_audit_events recorded all three as completed.
//
// Same correction as the lifecycle modules: a key identifies one mutation of one record. Reused
// elsewhere it is a conflict and is refused.
// =====================================================================================================

test("P1-F16: a stay balance key belonging to another booking is refused, and settles nothing", async () => {
  const { sqlite, db } = world();
  const split = await import("../lib/stay-split-payments.ts");
  await split.ensureStayPaymentTables(db);
  const now = Date.now();
  const seed = (bookingId, customerId, total) => sqlite.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending_balance',?,?)")
    .run(bookingId, "boarding", customerId, total, total / 2, total / 2, now + 86_400_000, now, now);
  seed("BKG-STAY-A", "CUST-A", 24000);
  seed("BKG-STAY-B", "CUST-B", 30000);

  const first = await split.payStayBalance(db, { bookingId: "BKG-STAY-A", idempotencyKey: "pay-balance", actorId: "CUST-A" });
  assert.equal(first.schedule.status, "paid");

  await assert.rejects(
    () => split.payStayBalance(db, { bookingId: "BKG-STAY-B", idempotencyKey: "pay-balance", actorId: "CUST-B" }),
    (error) => error instanceof Response && error.status === 409,
    "a key that already settled another booking must be refused",
  );
  const b = sqlite.prepare("SELECT status FROM stay_payment_schedules WHERE booking_id='BKG-STAY-B'").get();
  assert.equal(String(b.status), "pending_balance", "and booking B is NOT marked paid");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM stay_payment_events WHERE booking_id='BKG-STAY-B'").get().n), 0);
  // Every settled schedule has a capture event behind it - which is the invariant the defect broke.
  const paid = sqlite.prepare("SELECT booking_id FROM stay_payment_schedules WHERE status='paid'").all();
  for (const row of paid) {
    assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM stay_payment_events WHERE booking_id=? AND event_type='balance_captured'").get(row.booking_id).n), 1,
      `${row.booking_id} is paid, so it must have exactly one capture event`);
  }
});

test("P1-F16: the same booking replaying its own key is still a duplicate", async () => {
  // Non-vacuity: refusing every reuse would break the customer's own retry.
  const { sqlite, db } = world();
  const split = await import("../lib/stay-split-payments.ts");
  await split.ensureStayPaymentTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES ('BKG-STAY-A','boarding','CUST-A',24000,12000,12000,?,'pending_balance',?,?)").run(now + 86_400_000, now, now);
  const first = await split.payStayBalance(db, { bookingId: "BKG-STAY-A", idempotencyKey: "pay-balance", actorId: "CUST-A" });
  assert.equal(first.duplicatePrevented, false);
  const replay = await split.payStayBalance(db, { bookingId: "BKG-STAY-A", idempotencyKey: "pay-balance", actorId: "CUST-A" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.schedule.status, "paid");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM stay_payment_events WHERE booking_id='BKG-STAY-A'").get().n), 1, "one capture, not two");
});

test("P1-F3: a lead assignment key belonging to another lead is refused, not answered with that lead's record", async () => {
  const { sqlite, db } = world();
  const leads = await import("../lib/lead-assignment-governance.ts");
  await leads.ensureLeadAssignmentTables(db);
  const now = Date.now();
  // lead_work_items is owned by lib/lead-conversion-attribution.ts; created through its own ensure so
  // this world uses the real schema rather than a test-local guess.
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  await attribution.ensureLeadWorkItemsTable(db).catch(() => {});
  const columns = new Set(sqlite.prepare("PRAGMA table_info(lead_work_items)").all().map((c) => c.name));
  assert.ok(columns.has("owner") && columns.has("customer_id"), "the real lead table is present");
  const insertLead = (id, customerId) => sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,'App Inbound','grooming','Unassigned','Unassigned',?,?,?,?,?)").run(id, customerId, now, now + 600_000, now + 1_200_000, now, now);
  insertLead("LEAD-A", "CRM-A");
  insertLead("LEAD-B", "CRM-B");
  sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,detail_json,created_by,created_at) VALUES ('LAS-A','LEAD-IDEM-SHARED','LEAD-A','sales1@pawspace.test','SALES','POL-1',1,'new_lead','current',?,'{}','ops@pawspace.test',?)").run(now, now);

  await assert.rejects(
    () => leads.assignLead(db, { leadId: "LEAD-B", idempotencyKey: "LEAD-IDEM-SHARED", reason: "new_lead", actorId: "ops@pawspace.test" }),
    /already used for a different/i,
    "a key that belongs to another lead must be refused, never answered with that lead's assignment",
  );
  assert.equal(String(sqlite.prepare("SELECT owner FROM lead_work_items WHERE id='LEAD-B'").get().owner), "Unassigned",
    "and LEAD-B is still visibly unassigned rather than silently reported as done");

  await assert.rejects(
    () => leads.assignLead(db, { leadId: "LEAD-DOES-NOT-EXIST", idempotencyKey: "LEAD-IDEM-SHARED", reason: "new_lead", actorId: "ops@pawspace.test" }),
    /already used for a different/i,
    "and a lead that does not exist is certainly not assigned",
  );
});

test("P1-F3: a lead replaying its own key is still a duplicate", async () => {
  const { sqlite, db } = world();
  const leads = await import("../lib/lead-assignment-governance.ts");
  await leads.ensureLeadAssignmentTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,detail_json,created_by,created_at) VALUES ('LAS-A','LEAD-IDEM-A','LEAD-A','sales1@pawspace.test','SALES','POL-1',1,'new_lead','current',?,'{}','ops@pawspace.test',?)").run(now, now);
  const replay = await leads.assignLead(db, { leadId: "LEAD-A", idempotencyKey: "LEAD-IDEM-A", reason: "new_lead", actorId: "ops@pawspace.test" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(String(replay.assignment.lead_id), "LEAD-A");
});

// =====================================================================================================
// PTJA-P1-F28 — a second reserve under the same clientRequestId is answered "assigned" for a date that
// was never reserved, and the booking built on it is confirmed and PAID
//
// Measured end to end with one real non-preview customer session:
//   reserve 2026-11-20 04:00-06:00, clientRequestId GRP -> 200 {status:"assigned", provider groom_arun}
//   reserve 2026-11-27 04:00-06:00, SAME clientRequestId -> 200 {status:"assigned", provider groom_arun}
//   scheduling_reservations for GRP                      -> ONE row, still 2026-11-20
//   POST /api/canonical-bookings scheduledStart 11-27    -> 201 confirmed
//   canonical_bookings.scheduled_start                   -> 2026-11-27
//   booking_payments                                     -> 1899 captured
//
// So the customer holds a confirmed, paid booking for a day on which no capacity is held, against a
// provider whose slot is reserved a week earlier. It cannot be delivered, and nothing anywhere reports
// a problem.
//
// Two gaps, one invariant. The reserve replay path returned the stored decision without ever comparing
// the window it was asked about - the same unbound-key shape as PTJA-P1-F23/F16/F3, so it gets the same
// answer: a key reused for a DIFFERENT request is a conflict, not a duplicate. And canonical-bookings
// checked the booking window against the reservation for dog_training and for boarding but not for
// anything else, so the mismatch had a second door. Both are closed with the checks those two verticals
// already carry.
// =====================================================================================================

const F28_DAY = (day, hour) => new Date(Date.UTC(2026, 10, day, hour, 0, 0)).toISOString();

async function reserveWorld() {
  const { sqlite, db } = await schedulingWorld();
  const customerId = "CUST-F28";
  const cookie = await customerCookie(db, customerId);
  const reserve = (group, startDay, extra = {}) => post("../app/api/uat-scheduling/route.ts", "/api/uat-scheduling", {
    clientRequestId: group, customerId, petIds: ["PET-F28"], serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", scheduledStart: F28_DAY(startDay, 4), scheduledEnd: F28_DAY(startDay, 6), ...extra,
  }, { cookie });
  const book = (group, startDay, provider) => post("../app/api/canonical-bookings/route.ts", "/api/canonical-bookings", {
    idempotencyKey: `f28:${group}:${startDay}`, scheduleGroupId: group,
    customer: { id: customerId, name: "F28 customer", primaryPhone: "+919800000028" },
    pets: [{ sourceId: "PET-F28", name: "Rex", species: "dog", vaccinationStatus: "verified" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic",
    scheduledStart: F28_DAY(startDay, 4), scheduledEnd: F28_DAY(startDay, 6),
    provider: { id: String(provider.id), name: String(provider.name), model: String(provider.model) },
    totalAmount: 1899, amountDueNow: 1899,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "f28" }, pricing: { discount: 0 },
  }, { cookie });
  return { sqlite, db, cookie, customerId, reserve, book };
}

test("P1-F28: reusing a scheduling group for a DIFFERENT date is refused, not answered 'assigned'", async () => {
  const { sqlite, reserve } = await reserveWorld();
  const first = await reserve("GRP-F28", 20);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.status, "assigned");

  const second = await reserve("GRP-F28", 27);
  assert.equal(second.status, 409, `a different window under the same group must not be answered assigned: ${second.status} ${JSON.stringify(second.body)}`);

  const rows = sqlite.prepare("SELECT scheduled_start FROM scheduling_reservations WHERE group_id='GRP-F28'").all();
  assert.deepEqual(rows.map((r) => String(r.scheduled_start)), [F28_DAY(20, 4)], "the real reservation is untouched");
});

test("P1-F28: a booking window that does not match the reservation is refused, and nothing is charged", async () => {
  // The second door. Even reaching canonical-bookings with a mismatched window - which the reserve
  // refusal above now prevents, but an internal caller or a stale client could still do - must not
  // produce a confirmed, paid booking for a day nobody holds.
  const { sqlite, reserve, book } = await reserveWorld();
  const first = await reserve("GRP-F28B", 20);
  const provider = first.body.data.provider;

  const mismatched = await book("GRP-F28B", 27, provider);
  assert.equal(mismatched.status, 409, `a 27 Nov booking on a 20 Nov reservation must be refused: ${mismatched.status} ${JSON.stringify(mismatched.body)}`);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n), 0, "no booking is created");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM booking_payments").get().n), 0, "and nothing is charged");
});

test("P1-F28: the matching booking still confirms, and a true replay is still a duplicate", async () => {
  // Non-vacuity in both directions: refusing every window would block all booking, and refusing every
  // repeat reserve would break the retry the group id exists for.
  const { sqlite, reserve, book } = await reserveWorld();
  const first = await reserve("GRP-F28C", 20);
  const provider = first.body.data.provider;

  const replay = await reserve("GRP-F28C", 20);
  assert.equal(replay.status, 200, "the same group asked about the same window is still a replay");
  assert.equal(replay.body.data.duplicatePrevented, true);

  const booked = await book("GRP-F28C", 20, provider);
  assert.equal(booked.status, 201, `the matching booking must still confirm: ${JSON.stringify(booked.body)}`);
  const row = sqlite.prepare("SELECT scheduled_start FROM canonical_bookings WHERE schedule_group_id='GRP-F28C'").get();
  assert.equal(String(row.scheduled_start), F28_DAY(20, 4), "and it is booked for the day that is actually reserved");
});

// =====================================================================================================
// PTJA-P1-F31 — recovery offers the FAILING provider as its own "capacity safe replacement"
//
// selectCapacitySafeReplacement skips a candidate only when `p.id===input.excludeProviderId`. The
// booking row it has already loaded carries provider_id - the provider that just failed - but the
// exclusion was driven entirely by what the caller passed. With excludeProviderId absent, undefined or
// blank, `p.id===undefined` is never true, so the provider being recovered FROM is a candidate for
// recovering TO, and it is returned with checks {service:true, zone:true, availability:true,
// collisionFree:true, capacity:true} - a full clean bill of health for the provider that just declined
// or no-showed.
//
// The correction invents nothing: the booking's own provider_id is authoritative about who is being
// replaced, so it is always excluded, whatever the caller passed. A replacement that is the same
// provider is not a replacement.
// =====================================================================================================

async function recoveryWorld() {
  const { sqlite, db } = world();
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.seedProviderCapacityDefaults(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const START = "2026-11-20T04:00:00.000Z", END = "2026-11-20T06:00:00.000Z", now = Date.now();
  // Every live grooming provider in the zone is available for the window, so the ONLY thing that can
  // keep the failing provider out of the result is the exclusion under test.
  for (const providerId of ["groom_arun", "groom_kiran", "groom_sanjay"]) {
    sqlite.prepare("INSERT OR REPLACE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,'operations',?)")
      .run(`av-${providerId}`, providerId, "blr", "blr-east", "2026-11-20", JSON.stringify(["09:00-19:00"]), now);
  }
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,total_amount,created_by,created_at,updated_at) VALUES ('BK-F31','f31','CUST-F31','[]','[]','blr','blr-east','grooming','dog-basic','Bath','GRP-F31','groom_arun',?,?,1899,'seed',?,?)")
    .run(START, END, now, now);
  const recovery = await import("../lib/universal-replacement-recovery.ts");
  return { sqlite, db, recovery };
}

test("P1-F31: recovery never offers the failing provider as its own replacement", async () => {
  // Measured before the fix: with excludeProviderId absent, groom_arun - the provider being recovered
  // FROM - was returned with every check true.
  const { db, recovery } = await recoveryWorld();
  for (const [label, input] of [
    ["absent", { bookingId: "BK-F31" }],
    ["undefined", { bookingId: "BK-F31", excludeProviderId: undefined }],
    ["blank", { bookingId: "BK-F31", excludeProviderId: "" }],
  ]) {
    const result = await recovery.selectCapacitySafeReplacement(db, input);
    assert.ok(result, `${label}: a real alternative exists, so recovery must find one`);
    assert.notEqual(result.provider.id, "groom_arun", `${label}: the failing provider must never be its own replacement`);
  }
});

test("P1-F31: an explicit exclusion still works, and a real replacement is still returned", async () => {
  // Non-vacuity. Returning null always would satisfy the case above and would break recovery entirely.
  const { db, recovery } = await recoveryWorld();
  const chosen = await recovery.selectCapacitySafeReplacement(db, { bookingId: "BK-F31", excludeProviderId: "groom_arun" });
  assert.ok(chosen, "recovery still finds a capacity-safe replacement");
  assert.ok(["groom_kiran", "groom_sanjay"].includes(chosen.provider.id), `unexpected replacement ${chosen.provider.id}`);
  assert.equal(chosen.checks.capacity, true);

  const narrowed = await recovery.selectCapacitySafeReplacement(db, { bookingId: "BK-F31", excludeProviderId: "groom_kiran" });
  assert.ok(narrowed && narrowed.provider.id !== "groom_kiran" && narrowed.provider.id !== "groom_arun",
    "the caller's own exclusion is still honoured on top of the booking's provider");
});

// =====================================================================================================
// PTJA-P1-F1 — a booking is credited to the NEWEST open lead regardless of service
//
// attributeBookingToOpenLead selects "... WHERE customer_id=? AND converted_booking_id IS NULL AND
// status NOT IN ('closed','converted') ORDER BY assigned_at DESC LIMIT 1" and never looks at what was
// booked. A customer with an older Grooming enquiry and a newer Boarding enquiry who then books
// GROOMING has the conversion written onto the Boarding lead: the rep who worked the grooming enquiry
// loses the credit, the boarding lead is closed as converted by a booking that has nothing to do with
// it, and the lead that actually converted stays open and keeps chasing a customer who has already
// bought.
//
// The correction uses data both rows already carry - lead_work_items.service and
// canonical_bookings.service_code - to prefer the lead for the service that was actually booked. When
// no open lead matches the service, the existing newest-open-lead behaviour is unchanged: crediting
// nobody would be a product decision, not an engineering one.
// =====================================================================================================

async function attributionWorld() {
  const { sqlite, db } = world();
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  await attribution.ensureLeadWorkItemsTable(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT,status TEXT NOT NULL DEFAULT 'confirmed',created_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,status TEXT NOT NULL,amount REAL NOT NULL DEFAULT 0)");
  const now = Date.now();
  const lead = (id, service, assignedAt, owner) => sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,'CUST-F1','App Inbound',?,?,'Manager',?,?,?,?,?)")
    .run(id, service, owner, assignedAt, assignedAt + 600_000, assignedAt + 1_200_000, assignedAt, assignedAt);
  const booking = (id, serviceCode, captured = true) => {
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,created_at) VALUES (?,'CUST-F1',?,?)").run(id, serviceCode, now);
    if (captured) sqlite.prepare("INSERT INTO booking_payments (id,booking_id,status,amount) VALUES (?,?,'captured',1899)").run(`PAY-${id}`, id);
  };
  const leadRow = (id) => sqlite.prepare("SELECT status,converted_booking_id,owner FROM lead_work_items WHERE id=?").get(id);
  return { sqlite, db, attribution, lead, booking, leadRow, now };
}

test("P1-F1: a booking is credited to the lead for the service that was actually booked", async () => {
  // Measured before the fix: the newest lead - Boarding - was credited with a Grooming booking.
  const { db, attribution, lead, booking, leadRow, now } = await attributionWorld();
  lead("LEAD-GROOM", "grooming", now - 5 * 86_400_000, "rep.grooming@pawspace.test");
  lead("LEAD-BOARD", "boarding", now - 1 * 86_400_000, "rep.boarding@pawspace.test");
  booking("BK-GROOM", "grooming");

  const result = await attribution.attributeBookingToOpenLead(db, { customerId: "CUST-F1", bookingId: "BK-GROOM" });
  assert.equal(result?.leadId, "LEAD-GROOM", "the grooming enquiry is what converted");
  assert.equal(String(leadRow("LEAD-GROOM").status), "converted");
  assert.equal(String(leadRow("LEAD-GROOM").converted_booking_id), "BK-GROOM");
  assert.equal(String(leadRow("LEAD-BOARD").status), "active", "the boarding enquiry is untouched and still open");
  assert.equal(leadRow("LEAD-BOARD").converted_booking_id, null);
});

test("P1-F1: with no service match the existing newest-open-lead behaviour is unchanged", async () => {
  // Non-vacuity, and a deliberate limit: crediting NOBODY when no lead matches would be a product
  // decision. A customer who enquired about boarding and bought grooming still converts their open lead.
  const { db, attribution, lead, booking, leadRow, now } = await attributionWorld();
  lead("LEAD-OLD", "boarding", now - 5 * 86_400_000, "rep.a@pawspace.test");
  lead("LEAD-NEW", "dog_training", now - 1 * 86_400_000, "rep.b@pawspace.test");
  booking("BK-GROOM", "grooming");
  const result = await attribution.attributeBookingToOpenLead(db, { customerId: "CUST-F1", bookingId: "BK-GROOM" });
  assert.equal(result?.leadId, "LEAD-NEW", "the newest open lead still takes it when nothing matches");
  assert.equal(String(leadRow("LEAD-NEW").status), "converted");
});

test("P1-F1: among several leads for the SAME service the newest still wins", async () => {
  const { db, attribution, lead, booking, leadRow, now } = await attributionWorld();
  lead("LEAD-G1", "grooming", now - 9 * 86_400_000, "rep.a@pawspace.test");
  lead("LEAD-G2", "grooming", now - 2 * 86_400_000, "rep.b@pawspace.test");
  lead("LEAD-BOARD", "boarding", now - 1 * 86_400_000, "rep.c@pawspace.test");
  booking("BK-GROOM", "grooming");
  const result = await attribution.attributeBookingToOpenLead(db, { customerId: "CUST-F1", bookingId: "BK-GROOM" });
  assert.equal(result?.leadId, "LEAD-G2", "recency still decides within the matching service");
  assert.equal(String(leadRow("LEAD-G1").status), "active");
  assert.equal(String(leadRow("LEAD-BOARD").status), "active");
});

// =====================================================================================================
// PTJA-P1-F2 — a breached SLA clock is counted as BOTH met and breached in the productivity report
//
// recordLeadSlaAction closes a clock with "UPDATE lead_sla_clocks SET status='met',met_at=? ... WHERE id=?
// AND status IN ('running','breached','paused')" - so a late first response flips a BREACHED clock to
// 'met' while breached_at stays set. lib/sales-productivity-governance.ts then aggregates:
//
//   SUM(CASE WHEN c.status='met' THEN 1 ELSE 0 END)          met
//   SUM(CASE WHEN c.breached_at IS NOT NULL THEN 1 ELSE 0 END) breached
//
// One clock satisfies both, so met + breached exceeds total: the report contradicts itself, and a rep who
// missed the SLA and answered late is credited with having met it.
//
// This fixes the COUNT, not the state machine. breached_at is the record that the deadline passed, so a
// clock carrying it did not meet its SLA whatever its later status. What a late answer should mean
// operationally - whether it stops auto-reassignment, whether it belongs in some third bucket - is a
// product decision and is deliberately not made here; the clock's status is untouched.
// =====================================================================================================

test("P1-F2: a clock that breached is never counted as met, and the buckets never exceed the total", async () => {
  const { sqlite, db } = world();
  const productivity = await import("../lib/sales-productivity-governance.ts");
  const sla = await import("../lib/lead-sla-governance.ts");
  await productivity.ensureSalesProductivityTables(db);
  await sla.ensureLeadSlaTables(db);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const leads = await import("../lib/lead-assignment-governance.ts");
  await leads.ensureLeadAssignmentTables(db);

  const now = Date.now(), periodStart = now - 86_400_000, periodEnd = now + 86_400_000, EMAIL = "rep.f2@pawspace.test";
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-F2',?,'Rep F2','sales','active',?,?)").bind(EMAIL, now, now).run();
  const membershipColumns = sqlite.prepare("PRAGMA table_info(lead_assignment_memberships)").all().map((c) => c.name);
  const membershipValues = { employee_email: EMAIL, team_code: "team-f2", service_codes_json: "[]", city_ids_json: "[]", language_codes_json: "[]", active: 1, workload_cap_override: null, updated_by: "ops", created_by: "ops", updated_at: now, created_at: now };
  const useCols = membershipColumns.filter((c) => c in membershipValues);
  sqlite.prepare(`INSERT INTO lead_assignment_memberships (${useCols.join(",")}) VALUES (${useCols.map(() => "?").join(",")})`).run(...useCols.map((c) => membershipValues[c]));
  const assignment = (id, leadId) => sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,detail_json,created_by,created_at) VALUES (?,?,?,?,?,'POL-F2',1,'new_lead','current',?,'{}','ops',?)")
    .run(id, `k-${id}`, leadId, EMAIL, "team-f2", now, now);
  // Clock A: breached, then answered late - the shape under test. Clock B: cleanly met.
  const clock = (id, leadId, assignmentId, status, breachedAt, metAt) => sqlite.prepare("INSERT INTO lead_sla_clocks (id,idempotency_key,lead_id,assignment_id,policy_id,policy_version,clock_type,cycle,status,started_at,due_at,manager_escalation_due_at,reassignment_due_at,met_at,breached_at,detail_json,created_by,created_at,updated_at) VALUES (?,?,?,?,'SLAPOL-F2',1,'first_response',1,?,?,?,?,?,?,?,'{}','ops',?,?)")
    .run(id, `ck-${id}`, leadId, assignmentId, status, now, now, now, now, metAt, breachedAt, now, now);
  assignment("LAS-F2-A", "LEAD-F2-A"); assignment("LAS-F2-B", "LEAD-F2-B");
  clock("CLK-A", "LEAD-F2-A", "LAS-F2-A", "met", now, now);   // breached, then a late action flipped it
  clock("CLK-B", "LEAD-F2-B", "LAS-F2-B", "met", null, now);  // met on time

  const policy = await productivity.saveSalesProductivityPolicy(db, {
    name: "F2 productivity policy", teamCode: "team-f2", timezone: "Asia/Kolkata",
    meaningfulActionTypes: ["call"], qualifiedOutcomes: ["interested"], revenueBasis: "net_collected",
    requireCanonicalLeadBookingLink: false, effectiveFrom: periodStart - 1000, effectiveUntil: null,
    reason: "PTJA F2 executable regression", actorId: "ops@pawspace.test",
  });
  await productivity.activateSalesProductivityPolicy(db, { policyId: policy.id, approvalReference: "PTJA-F2", reason: "Activate for the regression", actorId: "ops@pawspace.test" });
  const run = await productivity.generateSalesProductivityFacts(db, { periodStart, periodEnd, idempotencyKey: "f2-run", actorId: "ops@pawspace.test" });
  const fact = run.facts.find((f) => String(f.employeeEmail ?? f.employee_email) === EMAIL);
  assert.ok(fact, `the rep must appear in the run: ${JSON.stringify(run.facts)}`);

  const total = Number(fact.firstResponseClocks ?? fact.first_response_clocks), met = Number(fact.firstResponseMet ?? fact.first_response_met), breached = Number(fact.firstResponseBreached ?? fact.first_response_breached);
  assert.equal(total, 2, "two first-response clocks in the period");
  assert.equal(breached, 1, "the breached clock is still reported as breached");
  assert.equal(met, 1, "and only the clock that actually met its deadline is counted as met");
  assert.ok(met + breached <= total, `a clock must be counted once: met ${met} + breached ${breached} > total ${total}`);
});

// =====================================================================================================
// PTJA-P1-F40 — two concurrent city-coverage saves both claim the same version
//
// saveCityLaunchConfig computes `const version = before ? before.version+1 : 1` in JavaScript from a read
// taken earlier in the function, then writes `version=excluded.version`. Two operators saving the same
// city concurrently both read version N and both write N+1, so two DIFFERENT states carry the same
// version number and the audit trail cannot distinguish them or order them.
//
// PARTIAL FIX, and the limit is stated rather than hidden. The version bump moves into SQL, so
// concurrent saves get distinct, monotonic versions and the audit's version means something. The LOST
// UPDATE itself - operator A's coverage silently replaced by operator B's, with no one told - is not
// fixed here: refusing a save whose base version has moved requires the caller to send the version it
// read, which is an API contract change and a product decision about what the operator sees on conflict.
// That half is reported, not invented.
// =====================================================================================================

test("P1-F40: concurrent city saves get distinct monotonic versions", async () => {
  const { sqlite, db } = world();
  const city = await import("../lib/city-governance.ts");
  await city.seedDefaultCityLaunchConfigs(db);
  const existing = sqlite.prepare("SELECT id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version FROM city_launch_configs WHERE city_code='blr'").get();
  assert.ok(existing, "the seeded city is the baseline");
  const baseVersion = Number(existing.version);

  const save = (pincodes) => city.saveCityLaunchConfig(db, {
    id: String(existing.id), cityCode: String(existing.city_code), city: String(existing.city), state: String(existing.state),
    status: String(existing.status), centre: String(existing.centre), radiusKm: Number(existing.radius_km),
    pincodes, gstIncluded: Number(existing.gst_included) === 1, services: JSON.parse(String(existing.services_json)),
  }, "ops@pawspace.test");

  const [a, b] = await Promise.all([save("560001,560002"), save("560003,560004")]);
  assert.notEqual(a.version, b.version, `two concurrent saves must not both claim version ${a.version}`);
  assert.deepEqual([a.version, b.version].sort((x, y) => x - y), [baseVersion + 1, baseVersion + 2],
    "the versions are consecutive and monotonic from the version they started at");
  assert.equal(Number(sqlite.prepare("SELECT version FROM city_launch_configs WHERE id=?").get(String(existing.id)).version), baseVersion + 2,
    "and the stored row carries the later of the two");
});

test("P1-F40: a serial save still increments by exactly one", async () => {
  // Non-vacuity. A version that jumped arbitrarily would satisfy the case above.
  const { sqlite, db } = world();
  const city = await import("../lib/city-governance.ts");
  await city.seedDefaultCityLaunchConfigs(db);
  const existing = sqlite.prepare("SELECT id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version FROM city_launch_configs WHERE city_code='blr'").get();
  const base = Number(existing.version);
  const input = (pincodes) => ({
    id: String(existing.id), cityCode: String(existing.city_code), city: String(existing.city), state: String(existing.state),
    status: String(existing.status), centre: String(existing.centre), radiusKm: Number(existing.radius_km),
    pincodes, gstIncluded: Number(existing.gst_included) === 1, services: JSON.parse(String(existing.services_json)),
  });
  const first = await city.saveCityLaunchConfig(db, input("560001"), "ops@pawspace.test");
  assert.equal(first.version, base + 1);
  const second = await city.saveCityLaunchConfig(db, input("560002"), "ops@pawspace.test");
  assert.equal(second.version, base + 2);
  assert.equal(String(sqlite.prepare("SELECT pincodes FROM city_launch_configs WHERE id=?").get(String(existing.id)).pincodes), "560002");
});
