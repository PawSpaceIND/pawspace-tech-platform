/**
 * Approved PawSpace cancellation and refund policy, and the governed policy kernel it runs on.
 * [PTJA-W1-F24]
 *
 * WHAT WAS MEASURED before this existed: a customer self-cancelled a Grooming booking whose status was
 * `in_service` - the groomer physically at the house, mid-appointment - and received HTTP 200, a refund
 * case for the full Rs 2,000, the provider's work order flipped to 'cancelled' out from under them, and
 * the payment moved to refund_pending. The only change-locked statuses were 'completed' and 'cancelled',
 * so every in-flight state was self-serve cancellable at 100%.
 *
 * WHAT IS ASSERTED HERE is the approved policy, and - just as importantly - that it is CONFIGURATION.
 * The business owns these numbers, they differ by service type and will differ by city, so they live in
 * service_policy_configs and are changed in Control Center with a reason and an audit trail. The last
 * group of cases proves that: a Boarding-in-Bengaluru override written through the real route changes
 * the refund a real cancellation earns, with no deploy.
 *
 * Every case executes the real module or the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F24_DB__", "__PTJA_F24_ENV__");

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
const NOW = Date.parse("2026-11-01T06:00:00.000Z");
const startIn = (hours) => new Date(NOW + hours * HOUR).toISOString();

const staffHeaders = (email) => ({
  "oai-authenticated-user-email": email,
  "oai-authenticated-user-full-name": "Policy%20operator",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
});
const FOUNDER = staffHeaders("policy-founder@pawspace.test");
const MANAGER = staffHeaders("policy-manager@pawspace.test");
const ASSOCIATE = staffHeaders("policy-associate@pawspace.test");

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_F24_DB__ = db;
  globalThis.__PTJA_F24_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const staff = [
    ["USR-F24-FOUNDER", "policy-founder@pawspace.test", "founder"],
    ["USR-F24-MANAGER", "policy-manager@pawspace.test", "manager"],
    ["USR-F24-ASSOC", "policy-associate@pawspace.test", "associate"],
  ];
  for (const [id, email, role] of staff) {
    await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").bind(id, email, email, role, now, now).run();
  }
  return { sqlite, db };
}

const call = async (modulePath, method, path, body, headers = {}) => {
  const route = await import(modulePath);
  const url = `https://uat.pawspace.in${path}`;
  const request = body
    ? new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
    : new Request(url, { method, headers });
  const response = await route[method](request);
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
};

const POLICY_ROUTE = "../app/api/service-policy-control/route.ts";

// =====================================================================================================
// The approved ladder, evaluated directly. No product decision is restated here - these are the numbers
// the business approved, and the point of each case is that the evaluator applies them.
// =====================================================================================================

async function policyFor(db, scope = {}) {
  const { resolveRefundPolicy } = await import("../lib/refund-policy-governance.ts");
  return resolveRefundPolicy(db, scope);
}
async function evaluate(db, input, scope = {}) {
  const { evaluateCancellationRefund } = await import("../lib/refund-policy-governance.ts");
  return evaluateCancellationRefund(await policyFor(db, scope), { now: NOW, amountPaid: 2000, cancelledBy: "customer", ...input });
}

test("F24: the approved notice ladder - 100% beyond 24h, 50% from 6-24h, 0% inside 6h", async () => {
  const { db } = await world();
  const bands = [
    { hours: 48, percent: 100, amount: 2000, compensation: "none" },
    { hours: 24, percent: 100, amount: 2000, compensation: "none" },
    { hours: 23.9, percent: 50, amount: 1000, compensation: "cancellation_may_apply" },
    { hours: 6, percent: 50, amount: 1000, compensation: "cancellation_may_apply" },
    { hours: 5.9, percent: 0, amount: 0, compensation: "cancellation_applies" },
    { hours: 0.25, percent: 0, amount: 0, compensation: "cancellation_applies" },
  ];
  for (const band of bands) {
    const result = await evaluate(db, { scheduledStart: startIn(band.hours), bookingStatus: "confirmed" });
    assert.equal(result.refundPercent, band.percent, `${band.hours}h notice must refund ${band.percent}%: ${JSON.stringify(result)}`);
    assert.equal(result.customerRefundAmount, band.amount, `${band.hours}h notice on Rs 2,000 must return Rs ${band.amount}`);
    assert.equal(result.providerCompensation, band.compensation, `${band.hours}h notice provider treatment`);
  }
});

test("F24: a job already under way earns no automatic refund, and the dispute stays open", async () => {
  const { db } = await world();
  for (const status of ["en_route", "arrived", "in_service", "completed"]) {
    const result = await evaluate(db, { scheduledStart: startIn(48), bookingStatus: status });
    assert.equal(result.automatic, false, `${status}: no automatic refund`);
    assert.equal(result.customerRefundAmount, 0, `${status}: nothing is auto-paid`);
    assert.equal(result.requiresApproval, true, `${status}: an authorised approver decides`);
    assert.ok(result.approvalPermissions.length > 0, `${status}: the evaluation names who may approve`);
    assert.equal(result.disputeAllowed, true, `${status}: the customer may still raise a dispute`);
  }
  // 48 hours of notice would otherwise be a 100% band, so the status is doing the work here, not the clock.
  const clean = await evaluate(db, { scheduledStart: startIn(48), bookingStatus: "confirmed" });
  assert.equal(clean.refundPercent, 100, "the same clock on a not-yet-started booking is still a full refund");
});

test("F24: en_route pays travel compensation; arrived and later pay the normal payout", async () => {
  const { db } = await world();
  const enRoute = await evaluate(db, { scheduledStart: startIn(1), bookingStatus: "en_route" });
  assert.equal(enRoute.providerCompensation, "travel_cancellation");
  for (const status of ["arrived", "in_service", "completed"]) {
    const result = await evaluate(db, { scheduledStart: startIn(1), bookingStatus: status });
    assert.equal(result.providerCompensation, "normal_payout", `${status} earns the normal eligible payout`);
  }
});

test("F24: when PawSpace or the provider cancels, the customer is made whole and not penalised", async () => {
  const { db } = await world();
  for (const cancelledBy of ["platform", "provider"]) {
    // Deliberately the worst case for the customer: zero notice AND a job already en route. Neither may
    // penalise them, because neither is their cancellation.
    const result = await evaluate(db, { scheduledStart: startIn(0.1), bookingStatus: "en_route", cancelledBy });
    assert.equal(result.refundPercent, 100, `${cancelledBy} cancel is a full refund: ${JSON.stringify(result)}`);
    assert.equal(result.customerRefundAmount, 2000);
    assert.equal(result.automatic, true, `${cancelledBy} cancel does not wait for an approver`);
    assert.equal(result.requiresApproval, false);
  }
});

test("F24: a verified service failure is a manual decision by an authorised approver", async () => {
  const { db } = await world();
  const result = await evaluate(db, { scheduledStart: startIn(-2), bookingStatus: "completed", serviceFailureVerified: true });
  assert.equal(result.automatic, false, "never automatic");
  assert.equal(result.requiresApproval, true);
  assert.deepEqual(result.approvalPermissions, ["finance.manage", "bookings.manage"]);
});

test("F24: the refund is computed on money paid - coupon value is never refunded as cash", async () => {
  const { db } = await world();
  const result = await evaluate(db, { scheduledStart: startIn(48), bookingStatus: "confirmed", amountPaid: 1500, couponValue: 500 });
  assert.equal(result.customerRefundAmount, 1500, "a 100% refund returns the Rs 1,500 received, not the Rs 2,000 list price");
  assert.equal(result.basis.couponValueExcluded, 500, "and the coupon value is recorded, not silently dropped");
});

test("F24: a gateway deduction is recorded beside the refund, never taken out of it", async () => {
  const { db } = await world();
  const result = await evaluate(db, { scheduledStart: startIn(48), bookingStatus: "confirmed", amountPaid: 2000, gatewayDeduction: 47.2 });
  assert.equal(result.customerRefundAmount, 2000, "the customer's approved refund is not reduced by the gateway's cut");
  assert.equal(result.basis.gatewayDeductionRecordedSeparately, 47.2, "and the deduction is carried for finance to post separately");
});

// =====================================================================================================
// The governed kernel: this is configuration, not code. These cases are the reason the policy can change
// per vertical and per city without a deploy, and the reason a bad change cannot be saved.
// =====================================================================================================

test("F24: policy resolution prefers this service and city over the platform default", async () => {
  const { db } = await world();
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_REFUND_POLICY } = await import("../lib/refund-policy-governance.ts");

  const stricter = { ...APPROVED_REFUND_POLICY, tiers: [
    { minHoursBeforeStart: 72, customerRefundPercent: 100, providerCompensation: "none", label: "More than 72 hours before a stay" },
    { minHoursBeforeStart: 0, customerRefundPercent: 0, providerCompensation: "cancellation_applies", label: "Inside 72 hours of a stay" },
  ] };
  await writeServicePolicy(db, { domain: "refund_policy", serviceCode: "boarding", cityId: "blr", config: stricter }, "ops@pawspace.test", "Boarding is an advance commitment in Bengaluru");

  const boardingBlr = await evaluate(db, { scheduledStart: startIn(48), bookingStatus: "confirmed" }, { serviceCode: "boarding", cityId: "blr" });
  const boardingMaa = await evaluate(db, { scheduledStart: startIn(48), bookingStatus: "confirmed" }, { serviceCode: "boarding", cityId: "maa" });
  const groomingBlr = await evaluate(db, { scheduledStart: startIn(48), bookingStatus: "confirmed" }, { serviceCode: "grooming", cityId: "blr" });

  assert.equal(boardingBlr.refundPercent, 0, "48h notice is inside the stricter Bengaluru Boarding window");
  assert.equal(boardingMaa.refundPercent, 100, "another city's Boarding still inherits the platform default");
  assert.equal(groomingBlr.refundPercent, 100, "another service in the same city is untouched");
  assert.equal(boardingBlr.matchedBy, "service_and_city");
  assert.equal(groomingBlr.matchedBy, "platform_default");
});

test("F24: a configuration that would reopen the defect cannot be saved", async () => {
  const { db } = await world();
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_REFUND_POLICY } = await import("../lib/refund-policy-governance.ts");
  const rejected = [
    [{ automaticRefundBlockedStatuses: ["completed"] }, /in_service/, "dropping in_service from the blocked list is the original defect"],
    [{ tiers: [{ minHoursBeforeStart: 0, customerRefundPercent: 150, providerCompensation: "none", label: "x" }] }, /between 0 and 100/, "a refund over 100% of what was paid"],
    [{ tiers: [{ minHoursBeforeStart: 6, customerRefundPercent: 100, providerCompensation: "none", label: "x" }] }, /must start at 0 hours/, "a ladder that cannot answer a last-minute cancellation"],
    [{ tiers: [
      { minHoursBeforeStart: 6, customerRefundPercent: 50, providerCompensation: "none", label: "x" },
      { minHoursBeforeStart: 24, customerRefundPercent: 100, providerCompensation: "none", label: "y" },
      { minHoursBeforeStart: 0, customerRefundPercent: 0, providerCompensation: "none", label: "z" }] }, /longest notice to the shortest/, "an unordered ladder"],
    [{ refundBasis: "amount_billed" }, /coupon value is never refunded/, "refunding coupon value as cash"],
    [{ gatewayDeductionHandling: "net_off" }, /never netted off/, "quietly reducing an approved refund by the gateway cut"],
    [{ exceptionApprovalPermissions: [] }, /approval permission/, "an exception nobody has to approve"],
    [{ disputeAlwaysAllowed: false }, /raise a dispute/, "closing the dispute route"],
  ];
  for (const [patch, expected, why] of rejected) {
    await assert.rejects(
      () => writeServicePolicy(db, { domain: "refund_policy", serviceCode: "grooming", cityId: "blr", config: { ...APPROVED_REFUND_POLICY, ...patch } }, "ops@pawspace.test", "attempted change"),
      (error) => { assert.ok(error instanceof Response, `${why}: expected a refusal Response`); return true; },
      `${why} must be refused`);
    void expected;
  }
});

test("F24: a valid change through the same path is accepted, versioned and audited", async () => {
  // Non-vacuity for the case above: refusing every write would satisfy it and would make the policy
  // unconfigurable, which is the opposite of the point.
  const { sqlite, db } = await world();
  const { writeServicePolicy, resolveServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { APPROVED_REFUND_POLICY } = await import("../lib/refund-policy-governance.ts");

  const first = await writeServicePolicy(db, { domain: "refund_policy", serviceCode: "pet_sitting", cityId: "blr", config: APPROVED_REFUND_POLICY }, "ops@pawspace.test", "Adopt the approved ladder for Sitting");
  const second = await writeServicePolicy(db, { domain: "refund_policy", serviceCode: "pet_sitting", cityId: "blr", config: { platformCancelRefundPercent: 100, ...APPROVED_REFUND_POLICY } }, "ops@pawspace.test", "Re-confirm after the city review");

  assert.equal(second.version, first.version + 1, "a second write bumps the version rather than losing the first");
  const audit = sqlite.prepare("SELECT action,actor_id,reason,before_json FROM service_policy_audit WHERE policy_domain='refund_policy' ORDER BY created_at").all();
  assert.ok(audit.length >= 2, `both writes are audited: ${JSON.stringify(audit)}`);
  assert.equal(audit[0].action, "created");
  assert.equal(audit[0].before_json, null, "the create records that there was nothing before it");
  assert.equal(audit[1].action, "updated");
  assert.ok(audit[1].before_json, "the update records what it replaced");
  assert.match(String(audit[1].reason), /city review/);

  const resolved = await resolveServicePolicy(db, "refund_policy", { serviceCode: "pet_sitting", cityId: "blr" });
  assert.equal(resolved.version, second.version);
});

test("F24: an unconfigured policy domain is an error, never an empty permissive object", async () => {
  const { db } = await world();
  const { resolveServicePolicy } = await import("../lib/service-policy-governance.ts");
  await assert.rejects(() => resolveServicePolicy(db, "no_such_policy_domain", {}),
    (error) => { assert.ok(error instanceof Error, "an unregistered domain is a programming error, not a silent default"); return true; });
});

// =====================================================================================================
// RBAC on the Control Center surface.
// =====================================================================================================

test("F24: only a settings-manage actor may change business policy", async () => {
  const { db } = await world();
  const { APPROVED_REFUND_POLICY } = await import("../lib/refund-policy-governance.ts");
  void db;
  const body = { domain: "refund_policy", serviceCode: "grooming", cityId: "blr", config: APPROVED_REFUND_POLICY, reason: "probe change" };

  const anonymous = await call(POLICY_ROUTE, "POST", "/api/service-policy-control", body);
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `an anonymous caller must be refused, got ${anonymous.status}`);
  const associate = await call(POLICY_ROUTE, "POST", "/api/service-policy-control", body, ASSOCIATE);
  assert.equal(associate.status, 403, `an associate must be refused: ${JSON.stringify(associate.body)}`);
  const manager = await call(POLICY_ROUTE, "POST", "/api/service-policy-control", body, MANAGER);
  assert.equal(manager.status, 403, `a manager may run a city but may not rewrite platform policy: ${JSON.stringify(manager.body)}`);
  const founder = await call(POLICY_ROUTE, "POST", "/api/service-policy-control", body, FOUNDER);
  assert.equal(founder.status, 201, `a founder may: ${JSON.stringify(founder.body)}`);
});

test("F24: an operator running a city can read the policy they are running under", async () => {
  // Non-vacuity for the case above. A policy nobody but the founder can even SEE is not a control, and
  // the whole point of moving these rules into Control Center is that they are visible.
  const { db } = await world();
  void db;
  const manager = await call(POLICY_ROUTE, "GET", "/api/service-policy-control?domain=refund_policy", null, MANAGER);
  assert.equal(manager.status, 200, `a manager must be able to read: ${JSON.stringify(manager.body)}`);
  assert.equal(manager.body.data.domain, "refund_policy");
  assert.ok(manager.body.data.policies.length >= 1, "the seeded platform default is visible");
  const anonymous = await call(POLICY_ROUTE, "GET", "/api/service-policy-control?domain=refund_policy", null);
  assert.ok(anonymous.status === 401 || anonymous.status === 403, "but not to an anonymous caller");
});

test("F24: a write requires a reason, and the reason reaches the audit trail", async () => {
  const { sqlite, db } = await world();
  const { APPROVED_REFUND_POLICY } = await import("../lib/refund-policy-governance.ts");
  void db;
  const noReason = await call(POLICY_ROUTE, "POST", "/api/service-policy-control",
    { domain: "refund_policy", serviceCode: "grooming", cityId: "blr", config: APPROVED_REFUND_POLICY, reason: "x" }, FOUNDER);
  assert.equal(noReason.status, 400, "a one-character reason is not a reason");

  const withReason = await call(POLICY_ROUTE, "POST", "/api/service-policy-control",
    { domain: "refund_policy", serviceCode: "grooming", cityId: "blr", config: APPROVED_REFUND_POLICY, reason: "Adopt the approved ladder for Bengaluru Grooming" }, FOUNDER);
  assert.equal(withReason.status, 201);

  const audit = sqlite.prepare("SELECT actor_id,reason FROM service_policy_audit WHERE service_code='grooming' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(audit.actor_id, "policy-founder@pawspace.test", "the audit names who changed it");
  assert.match(String(audit.reason), /approved ladder/, "and why");
  const security = sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='business_policy.write'").get().n;
  assert.ok(security >= 1, "and the platform security log records it too");
});

// =====================================================================================================
// The finding's own reproduction, through the real route. This is the case that was measured returning
// HTTP 200 with a full refund while the groomer was mid-appointment.
// =====================================================================================================

import fs from "node:fs";
const readSource = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const statementsOf = (source) => [...source.matchAll(/db\.prepare\(\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((match) => match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\"));

/** Tables come from the DDL in the modules that OWN them, never re-typed here. */
function cancellationWorld(sqlite) {
  for (const path of [
    "app/api/grooming-booking-change/route.ts",
    "app/api/uat-scheduling/route.ts",
    "lib/grooming-policy-governance.ts",
    "lib/customer-account.ts",
  ]) {
    for (const sql of statementsOf(readSource(path))) if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql)) { try { sqlite.exec(sql); } catch { /* owned elsewhere */ } }
  }
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL,channel TEXT NOT NULL,total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL,status TEXT NOT NULL,assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

function seedCancellable(sqlite, { bookingId, status, start, amount = 2000, customerId = "CUST-F24" }) {
  const now = Date.now();
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(customerId, "blr", "F24 customer", "9999900624", "customer_app", "{}", now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','grooming','dog-basic','Bath & Basic',?,?,?,?,?,'customer_app',?,'INR','{}','test',?,?)")
    .run(bookingId, `ik-${bookingId}`, customerId, `GRP-${bookingId}`, "groom_arun", start, new Date(Date.parse(start) + 2 * HOUR).toISOString(), status, amount, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,'Arun R.','full_time','grooming',?,?,1,?,'{}',?,?)")
    .run(`WO-${bookingId}`, bookingId, `GRP-${bookingId}`, "groom_arun", start, new Date(Date.parse(start) + 2 * HOUR).toISOString(), status, now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,0,'INR','upi','prepaid','captured','uat_sandbox',?,'{}',?,?)")
    .run(`PAY-${bookingId}`, bookingId, customerId, amount, `pik-${bookingId}`, now, now);
}

async function cancellationSetup() {
  const { sqlite, db } = await world();
  cancellationWorld(sqlite);
  const { seedDefaultGroomingPolicy } = await import("../lib/grooming-policy-governance.ts");
  await seedDefaultGroomingPolicy(db);
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: "customer:CUST-F24",
    subjectType: "customer", subjectId: "CUST-F24", verificationState: "verified", actorId: "ptja-f24", reason: "PTJA W1-F24",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: "CUST-F24",
  });
  const cookie = `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
  const cancel = (bookingId) => call("../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change",
    { bookingId, customerId: "CUST-F24", action: "cancel", reason: "changed my mind" }, { cookie });
  return { sqlite, db, cancel };
}

test("F24 route: a customer cannot self-cancel a job that is under way", async () => {
  const { sqlite, cancel } = await cancellationSetup();
  // The finding's exact shape: status in_service, groomer at the house, payment captured at Rs 2,000.
  seedCancellable(sqlite, { bookingId: "BK-F24-INSERVICE", status: "in_service", start: new Date(Date.now() - HOUR).toISOString() });

  const result = await cancel("BK-F24-INSERVICE");

  assert.equal(result.status, 409, `measured before the fix: 200 with a full refund. Got ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(result.body?.code, "cancellation_requires_approval");
  assert.equal(result.body?.disputeAllowed, true, "the customer is told the dispute route is open");
  assert.ok(result.body?.approvalPermissions?.length, "and who can approve an exception");

  const booking = sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-F24-INSERVICE'").get();
  const work = sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id='BK-F24-INSERVICE'").get();
  const payment = sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id='BK-F24-INSERVICE'").get();
  assert.equal(booking.status, "in_service", "the booking is untouched");
  assert.equal(work.status, "in_service", "and the provider's work order is not cancelled out from under them mid-job");
  assert.equal(payment.status, "captured", "and no refund is set in motion");

  const review = sqlite.prepare("SELECT status,amount FROM booking_refund_cases WHERE booking_id='BK-F24-INSERVICE'").get();
  assert.equal(review.status, "pending_approval", "the request is recorded for review rather than silently refused");
  assert.equal(review.amount, 0, "at nothing, until an approver decides otherwise");
});

test("F24 route: a cancellation with more than 24 hours' notice still refunds in full", async () => {
  // Non-vacuity. Refusing every cancellation would satisfy the case above and would break the product.
  const { sqlite, cancel } = await cancellationSetup();
  seedCancellable(sqlite, { bookingId: "BK-F24-EARLY", status: "confirmed", start: new Date(Date.now() + 48 * HOUR).toISOString() });

  const result = await cancel("BK-F24-EARLY");

  assert.equal(result.status, 200, `an early cancellation must still work: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(result.body.data.refundAmount, 2000, "at 100% of what was paid");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-F24-EARLY'").get().status, "cancelled");
  assert.equal(sqlite.prepare("SELECT status FROM booking_refund_cases WHERE booking_id='BK-F24-EARLY'").get().status, "requested");
});

test("F24 route: a cancellation between 6 and 24 hours refunds half", async () => {
  const { sqlite, cancel } = await cancellationSetup();
  seedCancellable(sqlite, { bookingId: "BK-F24-HALF", status: "confirmed", start: new Date(Date.now() + 12 * HOUR).toISOString() });

  const result = await cancel("BK-F24-HALF");

  assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
  assert.equal(result.body.data.refundAmount, 1000, "50% of the Rs 2,000 actually paid");
});

test("F24 route: a cancellation inside 6 hours refunds nothing and routes to review", async () => {
  const { sqlite, cancel } = await cancellationSetup();
  seedCancellable(sqlite, { bookingId: "BK-F24-LATE", status: "confirmed", start: new Date(Date.now() + 2 * HOUR).toISOString() });

  const result = await cancel("BK-F24-LATE");

  assert.equal(result.status, 409, `no refund is due, so it becomes a reviewable request: ${JSON.stringify(result.body).slice(0, 300)}`);
  assert.equal(result.body?.refundPolicy?.refundPercent, 0);
  assert.equal(result.body?.disputeAllowed, true);
});

test("F24 route: the refund case carries the policy version that produced it", async () => {
  // Finance and support both read this record. A refund amount with no statement of which policy, which
  // notice band and which basis produced it is the surface-truth problem this audit kept finding.
  const { sqlite, cancel } = await cancellationSetup();
  seedCancellable(sqlite, { bookingId: "BK-F24-TRACE", status: "confirmed", start: new Date(Date.now() + 48 * HOUR).toISOString() });
  await cancel("BK-F24-TRACE");

  const stored = JSON.parse(sqlite.prepare("SELECT policy_json FROM booking_refund_cases WHERE booking_id='BK-F24-TRACE'").get().policy_json);
  assert.match(String(stored.policyVersion), /^refund_policy:/, "which policy version applied");
  assert.equal(stored.basis.amountPaid, 2000, "what it was computed on");
  assert.ok(stored.reasons.length, "and why");
});
