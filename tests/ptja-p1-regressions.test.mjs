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
  const { db } = await schedulingWorld();
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
