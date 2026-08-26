/**
 * The verification expiry / revocation assignment gate. [PTJA-W1-F53 part 2]
 *
 * Part 1 made the approved requirements real at ACTIVATION. This is the other half: a document that was
 * valid on the day someone was activated does not stay valid, and nothing consulted verification state
 * again after that moment. A walker whose police verification expired last month, or whose licence was
 * revoked this morning, kept receiving work.
 *
 * The authoritative rules, as supplied:
 *
 *   4. Every currently mandatory verification must be verified AND unexpired before a provider can
 *      receive any new assignment, reassignment or offer.
 *   5. Rejected, failed, revoked, pending or expired mandatory verification removes the provider from
 *      new matching immediately.
 *   6. Already-started work is never cancelled or corrupted - booking, payment, work order, proof and
 *      customer history are preserved, and the provider is flagged for Operations review.
 *   7. Scheduled but not-started work keeps the booking and the customer commitment, stops further
 *      provider acceptance, and routes to Operations recovery.
 *   8. Non-mandatory document expiry must not block assignment.
 *   9. Re-verification returns a provider to the pool through the existing controlled remapping, never
 *      automatically.
 *
 * The gate is applied at WRITE time, in the reservation insert and the offer insert, not only in the
 * matching read - a read-side filter alone loses the race against a concurrent assignment, which the
 * last case here proves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F53X_DB__", "__PTJA_F53X_ENV__");

function makeD1(sqlite, hooks = {}) {
  const statement = (sql, args = []) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      if (hooks.beforeBatch) await hooks.beforeBatch(items);
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
const DAY = 24 * HOUR;
const OPS = "verification-ops@pawspace.test";
const STAFF = {
  "oai-authenticated-user-email": OPS,
  "oai-authenticated-user-full-name": "Verification%20ops",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

/** A walker whose approved checks are all recorded, live on the service map, ready to take work. */
async function world({ hooks = {} } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite, hooks);
  globalThis.__PTJA_F53X_DB__ = db;
  globalThis.__PTJA_F53X_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat" };

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  const { seedApprovedVerificationPolicies } = await import("../lib/provider-verification-policy.ts");
  const { ensureVerificationMandateTables } = await import("../lib/provider-verification-mandate.ts");
  await ensureSecurityTables(db);
  await seedProviderCapacityDefaults(db);
  await seedApprovedVerificationPolicies(db);
  await ensureVerificationMandateTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,vertical_key TEXT NOT NULL,country_code TEXT,region_code TEXT,city_code TEXT,status TEXT NOT NULL,locale_code TEXT,basic_info_json TEXT,policy_ref TEXT,quiz_version_ref TEXT,verification_status TEXT,quiz_status TEXT,interview_status TEXT,human_decision TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");

  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-F53X',?,?,'founder','active',?,?)").bind(OPS, OPS, now, now).run();

  /** A walker on the live service map, with a linked onboarding application. */
  const provider = async ({ providerId = "walk_nisha", vertical = "dog_walking", service = "dog_walking" } = {}) => {
    sqlite.prepare("INSERT OR REPLACE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,4.7,90,1,20,6,3,'active',1,?,NULL,?,?)")
      .run(providerId, "blr", "Nisha W.", "commission", JSON.stringify([service]), JSON.stringify(["blr-east"]), "2026-01-01", OPS, now);
    sqlite.prepare("INSERT OR REPLACE INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,city_code,status,created_by,created_at,updated_at) VALUES (?,?,?,'IN','BLR','activated_uat',?,?,?)")
      .run(`APP-${providerId}`, providerId, vertical, OPS, now, now);
    return { providerId, applicationId: `APP-${providerId}` };
  };

  /** Records a verification outcome with an explicit validity window. */
  const record = async (applicationId, type, status, { expiresAt = null } = {}) => {
    const mandate = await import("../lib/provider-verification-mandate.ts");
    await mandate.recordVerificationValidity(db, { applicationId, verificationType: type, status, expiresAt, actorId: OPS });
  };

  /** Everything the vertical currently requires, verified and valid for a year. */
  const clearAll = async (applicationId, vertical = "dog_walking", { expiresAt = now + 365 * DAY } = {}) => {
    const { resolveProviderVerificationPolicy } = await import("../lib/provider-verification-policy.ts");
    const policy = await resolveProviderVerificationPolicy(db, vertical, "blr");
    for (const type of policy.config.requiredTypes) await record(applicationId, type, "verified", { expiresAt });
    return policy.config.requiredTypes;
  };

  return { sqlite, db, now, provider, record, clearAll };
}

/** Reserves through the REAL scheduling route - the authoritative assignment write path. */
async function reserve(w, { group, providerId = "walk_nisha", service = "dog_walking", hoursAhead = 48, customerId = "CUST-F53X" }) {
  const route = await import("../app/api/uat-scheduling/route.ts");
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(w.db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${customerId}`,
    subjectType: "customer", subjectId: customerId, verificationState: "verified", actorId: "f53x", reason: "F53 expiry gate",
  });
  const issued = await issuePlatformSession(w.db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: customerId,
  });
  const start = new Date(Date.now() + hoursAhead * HOUR);
  // 10:00-11:00 IST, inside every seeded roster window.
  start.setUTCHours(4, 30, 0, 0);
  const response = await route.POST(new Request("https://uat.pawspace.in/api/uat-scheduling", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` },
    body: JSON.stringify({
      clientRequestId: group, customerId, petIds: [`PET-${customerId}`], serviceCode: service,
      cityId: "blr", zoneId: "blr-east", scheduledStart: start.toISOString(),
      scheduledEnd: new Date(start.getTime() + HOUR).toISOString(),
      customRules: [{ code: "ONLY", field: "providerId", operator: "eq", value: providerId }],
    }),
  }));
  let body = null;
  try { body = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, provider: body?.data?.provider?.id, error: body?.error, body };
}

const reservationCount = (w, providerId = "walk_nisha") =>
  w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE provider_id=? AND status!='cancelled'").get(providerId).n;

// =====================================================================================================
// Rules 4 and 5: every mandatory check must be verified AND unexpired at write time.
// =====================================================================================================

test("F53X-1: an EXPIRED mandatory verification blocks a new assignment", async () => {
  const w = await world();
  const { applicationId } = await w.provider();
  await w.clearAll(applicationId);
  // Police verification lapsed yesterday. Everything else is valid.
  await w.record(applicationId, "police_verification", "verified", { expiresAt: w.now - DAY });

  const result = await reserve(w, { group: "F53X-EXPIRED" });

  assert.notEqual(result.status, 200, `an expired police check must stop new work: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(reservationCount(w), 0, "and nothing may be written");
});

test("F53X-2: a REVOKED mandatory verification blocks a new assignment", async () => {
  const w = await world();
  const { applicationId } = await w.provider();
  await w.clearAll(applicationId);
  await w.record(applicationId, "driving_licence", "verified", { expiresAt: w.now + 365 * DAY });
  await w.record(applicationId, "police_verification", "revoked");

  const result = await reserve(w, { group: "F53X-REVOKED" });

  assert.notEqual(result.status, 200, `a revoked police check must stop new work: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(reservationCount(w), 0);
});

test("F53X-3: a PENDING mandatory verification blocks a new assignment", async () => {
  const w = await world();
  const { applicationId } = await w.provider();
  await w.clearAll(applicationId);
  await w.record(applicationId, "emergency_safety_training", "pending");

  const result = await reserve(w, { group: "F53X-PENDING" });

  assert.notEqual(result.status, 200, `a pending mandatory check must stop new work: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(reservationCount(w), 0);
});

test("F53X-4: a NON-mandatory document expiring does not block", async () => {
  // Non-vacuity for 1-3, and rule 8. If any expiry blocked, these cases would pass for the wrong reason
  // and the platform would stop assigning work over an advisory document.
  const w = await world();
  const { applicationId } = await w.provider();
  await w.clearAll(applicationId);
  // `pan` is not in the approved Dog Walking requirements. Expired a year ago; irrelevant to assignment.
  await w.record(applicationId, "pan", "verified", { expiresAt: w.now - 365 * DAY });

  const result = await reserve(w, { group: "F53X-NONMANDATORY" });

  assert.equal(result.status, 200, `an advisory document must not stop work: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(reservationCount(w), 1);
});

test("F53X-5: a fully valid provider still receives assignments", async () => {
  // The control that makes every block above meaningful.
  const w = await world();
  const { applicationId } = await w.provider();
  await w.clearAll(applicationId);

  const result = await reserve(w, { group: "F53X-VALID" });

  assert.equal(result.status, 200, `a valid walker must still be assignable: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(result.provider, "walk_nisha");
});

// =====================================================================================================
// Rules 6 and 7: what happens to work that already exists.
// =====================================================================================================

test("F53X-6: an already IN-PROGRESS booking survives a revocation unchanged", async () => {
  const w = await world();
  const { applicationId, providerId } = await w.provider();
  await w.clearAll(applicationId);
  const now = Date.now();
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,schedule_group_id TEXT,scheduled_start TEXT NOT NULL,status TEXT NOT NULL,total_amount REAL NOT NULL,updated_at INTEGER)");
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER,status TEXT NOT NULL,assignment_json TEXT,created_at INTEGER,updated_at INTEGER)");
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL,status TEXT NOT NULL,updated_at INTEGER)");
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,service_code,city_id,zone_id,schedule_group_id,scheduled_start,status,total_amount,updated_at) VALUES ('BK-LIVE','CUST-L',?,'dog_walking','blr','blr-east','GRP-LIVE',?,'in_service',600,?)")
    .run(providerId, new Date(now - HOUR).toISOString(), now);
  w.sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,service_code,status,created_at,updated_at) VALUES ('WO-LIVE','BK-LIVE','GRP-LIVE',?,'dog_walking','in_service',?,?)").run(providerId, now, now);
  w.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,updated_at) VALUES ('PAY-LIVE','BK-LIVE','CUST-L',600,'captured',?)").run(now);

  const { revokeProviderVerification } = await import("../lib/provider-assignment-eligibility.ts");
  await revokeProviderVerification(w.db, { providerId, verificationType: "police_verification", reason: "Police clearance withdrawn", actorId: OPS });

  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-LIVE'").get().status, "in_service", "the booking under way is untouched");
  assert.equal(w.sqlite.prepare("SELECT status FROM provider_work_orders WHERE id='WO-LIVE'").get().status, "in_service", "the work order is untouched");
  assert.equal(w.sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-LIVE'").get().status, "captured", "the payment is untouched");
  const recovery = w.sqlite.prepare("SELECT reason_code,status FROM provider_recovery_cases WHERE failed_provider_id=? AND booking_id='BK-LIVE'").get(providerId);
  assert.ok(recovery, "and Operations is given a review case rather than the job disappearing");
  assert.equal(recovery.status, "open");
});

test("F53X-7: a SCHEDULED but not-started job is preserved and routed to Operations recovery", async () => {
  const w = await world();
  const { applicationId, providerId } = await w.provider();
  await w.clearAll(applicationId);
  const scheduled = await reserve(w, { group: "F53X-FUTURE" });
  assert.equal(scheduled.status, 200, "the job is booked while the walker is valid");

  const { revokeProviderVerification } = await import("../lib/provider-assignment-eligibility.ts");
  const outcome = await revokeProviderVerification(w.db, { providerId, verificationType: "police_verification", reason: "Clearance withdrawn", actorId: OPS });

  const reservation = w.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id='F53X-FUTURE'").get();
  assert.ok(reservation, "the customer's booking still exists");
  assert.notEqual(reservation.status, "cancelled", "the customer commitment is not thrown away");
  const recovery = w.sqlite.prepare("SELECT reason_code,status FROM provider_recovery_cases WHERE failed_provider_id=? AND group_id='F53X-FUTURE'").get(providerId);
  assert.ok(recovery, "and it is routed to Operations recovery");
  assert.ok(outcome.recoveryCases >= 1);
  // Rule 5: removed from new matching immediately, not at the next sweep.
  assert.equal(w.sqlite.prepare("SELECT live FROM provider_capacity_profiles WHERE id=?").get(providerId).live, 0);
});

test("F53X-8: further provider acceptance is stopped - no new offer may be created", async () => {
  const w = await world();
  const { applicationId, providerId } = await w.provider();
  await w.clearAll(applicationId);
  await w.record(applicationId, "police_verification", "revoked");

  const { createAssignmentOffer } = await import("../lib/provider-capacity-governance.ts");
  await assert.rejects(() => createAssignmentOffer(w.db, { groupId: "GRP-OFFER", providerId }),
    "an offer is an assignment write and must be gated the same way");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_assignment_offers WHERE provider_id=?").get(providerId).n, 0);
});

// =====================================================================================================
// Rule 9: coming back is governed, never automatic.
// =====================================================================================================

test("F53X-9: re-verification alone does not put a provider back on the map", async () => {
  const w = await world();
  const { applicationId, providerId } = await w.provider();
  await w.clearAll(applicationId);
  const { revokeProviderVerification } = await import("../lib/provider-assignment-eligibility.ts");
  await revokeProviderVerification(w.db, { providerId, verificationType: "police_verification", reason: "Clearance withdrawn", actorId: OPS });

  // Operations cannot lift the hold while the check is still revoked.
  const { clearProviderVerificationHold: tryClear } = await import("../lib/provider-assignment-eligibility.ts");
  await assert.rejects(() => tryClear(w.db, { providerId, actorId: OPS, reason: "attempting an early release" }),
    "a hold cannot be lifted while the mandatory check is still not current");

  // The check is renewed and valid again.
  await w.record(applicationId, "police_verification", "verified", { expiresAt: Date.now() + 365 * DAY });

  assert.equal(w.sqlite.prepare("SELECT live FROM provider_capacity_profiles WHERE id=?").get(providerId).live, 0,
    "a renewed document does not silently re-list a provider - a human re-maps them");
  const blocked = await reserve(w, { group: "F53X-RETURN-AUTO" });
  assert.notEqual(blocked.status, 200, "and until they do, no new work reaches them");

  // Coming back is TWO governed steps, neither automatic: Operations lifts the verification hold, and a
  // human re-lists the provider through the same remapping they already perform.
  const { clearProviderVerificationHold } = await import("../lib/provider-assignment-eligibility.ts");
  const { addProviderToServiceMap } = await import("../lib/provider-onboarding-human-activation.ts");
  await assert.rejects(() => addProviderToServiceMap(w.db, { providerId, zoneIds: ["blr-east"], actorEmail: OPS }),
    "a provider on a verification hold cannot be re-listed until the hold is lifted");

  await clearProviderVerificationHold(w.db, { providerId, actorId: OPS, reason: "Police clearance renewed and checked" });
  assert.equal(w.sqlite.prepare("SELECT live FROM provider_capacity_profiles WHERE id=?").get(providerId).live, 0,
    "lifting the hold makes them eligible to be re-listed - it does not re-list them");
  const stillBlocked = await reserve(w, { group: "F53X-RETURN-HOLD-LIFTED" });
  assert.notEqual(stillBlocked.status, 200, "so no work reaches them yet");

  await addProviderToServiceMap(w.db, { providerId, zoneIds: ["blr-east"], actorEmail: OPS });
  const restored = await reserve(w, { group: "F53X-RETURN-GOVERNED" });
  assert.equal(restored.status, 200, `after the governed remap the walker is assignable again: ${JSON.stringify(restored.body).slice(0, 300)}`);
});

// =====================================================================================================
// Rules 1-3: the requirement floors, and the operator's authority within them.
// =====================================================================================================

test("F53X-10: Walking and Pet Taxi must require police verification", async () => {
  const w = await world();
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_VERIFICATION_BY_VERTICAL, PROVIDER_VERIFICATION_DOMAIN } = await import("../lib/provider-verification-policy.ts");
  for (const vertical of ["dog_walking", "pet_taxi"]) {
    const base = APPROVED_VERIFICATION_BY_VERTICAL[vertical];
    await assert.rejects(
      () => writeServicePolicy(w.db, { domain: PROVIDER_VERIFICATION_DOMAIN, serviceCode: vertical, cityId: "blr",
        config: { ...base, requiredTypes: base.requiredTypes.filter((type) => type !== "police_verification") } },
        OPS, "attempt to drop the police check"),
      (error) => { assert.ok(error instanceof Response); return true; },
      `${vertical} must not be configurable without police verification`);
  }
});

test("F53X-11: Grooming, Sitting and Boarding are not silently given new universal requirements", async () => {
  const w = await world();
  const { resolveProviderVerificationPolicy } = await import("../lib/provider-verification-policy.ts");
  const expected = {
    grooming: ["aadhaar", "pan"],
    pet_sitting: ["aadhaar", "pan", "address"],
    boarding: ["aadhaar", "pan", "house_verification", "pet_proofing_photo"],
  };
  for (const [vertical, types] of Object.entries(expected)) {
    const policy = await resolveProviderVerificationPolicy(w.db, vertical, "blr");
    assert.deepEqual(policy.config.requiredTypes.slice().sort(), types.slice().sort(),
      `${vertical} keeps exactly its existing mandate - no police check and no new universal requirement was added`);
  }
});

test("F53X-12: an operator-narrowed mandate stays narrowed and stays authoritative", async () => {
  const w = await world();
  const mandate = await import("../lib/provider-verification-mandate.ts");
  const { resolveProviderVerificationPolicy } = await import("../lib/provider-verification-policy.ts");
  // Narrowed to the police check plus identity - fewer requirements than the approved default.
  await mandate.setCategoryMandate(w.db, { category: "dog_walker", verificationTypes: ["aadhaar", "police_verification"], actorId: OPS });

  const policy = await resolveProviderVerificationPolicy(w.db, "dog_walking", "blr");
  assert.deepEqual(policy.config.requiredTypes.slice().sort(), ["aadhaar", "police_verification"],
    "the operator's decision is what the gate enforces");

  // And the gate follows it: clearing only the narrowed set is now enough to take work.
  const { applicationId } = await w.provider();
  await w.record(applicationId, "aadhaar", "verified", { expiresAt: Date.now() + 365 * DAY });
  await w.record(applicationId, "police_verification", "verified", { expiresAt: Date.now() + 365 * DAY });
  const result = await reserve(w, { group: "F53X-NARROWED" });
  assert.equal(result.status, 200, `the narrowed mandate is satisfied: ${JSON.stringify(result.body).slice(0, 300)}`);
});

// =====================================================================================================
// The race. A matching-read filter alone cannot answer this, which is why the gate is at write time.
// =====================================================================================================

test("F53X-13: a concurrent assignment cannot slip through immediately after revocation", async () => {
  let revokeDuringWrite = null;
  const w = await world({ hooks: { beforeBatch: async (items) => {
    if (revokeDuringWrite && items.some((item) => /INSERT INTO scheduling_reservations/.test(item.sql))) {
      const pending = revokeDuringWrite; revokeDuringWrite = null; await pending();
    }
  } } });
  const { applicationId, providerId } = await w.provider();
  await w.clearAll(applicationId);

  // The walker is valid when the request is read and decided, and revoked in the instant before the
  // reservation is committed - the ordinary interleaving of two concurrent requests.
  const { revokeProviderVerification } = await import("../lib/provider-assignment-eligibility.ts");
  revokeDuringWrite = async () => {
    await revokeProviderVerification(w.db, { providerId, verificationType: "police_verification", reason: "Clearance withdrawn mid-request", actorId: OPS });
  };
  const result = await reserve(w, { group: "F53X-RACE" });

  assert.notEqual(result.status, 200, `the commit must re-check, not trust the decision: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(reservationCount(w), 0, "no reservation may survive a revocation that landed before the write");
});
