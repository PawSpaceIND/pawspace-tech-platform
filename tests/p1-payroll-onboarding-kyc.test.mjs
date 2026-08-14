/**
 * P1 RUNTIME CLOSURE TEST — payroll authorization + segregation, and provider onboarding KYC gate.
 *
 * Drives the REAL /api/payroll and /api/provider-onboarding handlers over a real D1, authenticating with
 * REAL forwarded staff identities on a NON-LOCALHOST host (so resolveActor never hands out a
 * development-preview superuser). No localhost shortcut, no source-regex.
 *
 * Payroll:
 *   - GET is gated on payroll.view: an associate (no payroll perms) is refused; finance is allowed;
 *     an anonymous caller is 401.
 *   - approve is gated on payroll.approve, which finance does NOT hold — running payroll and approving it
 *     are separated permissions.
 *   - Maker/checker: the approver cannot be the run's creator or reviewer (segregation of duties).
 * Provider onboarding:
 *   - the whole surface is gated on settings.manage: a manager (providers.manage only) is refused.
 *   - KYC-before-activation: a provider whose identity verification is not verified cannot be activated;
 *     the activation checklist blocks and no live capacity profile is created.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__PAYONB_DB__", "__PAYONB_ENV__");

const HOST = "https://app.pawspace.in";
const EMAIL = { finance: "finance@pawspace.in", manager: "manager@pawspace.in", associate: "associate@pawspace.in", founder: "founder@pawspace.in" };

async function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__PAYONB_DB__ = db;
  globalThis.__PAYONB_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db); // creates app_users + role_definitions and seeds the default role catalogue
  const ins = sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',0,0)");
  for (const [role, email] of Object.entries(EMAIL)) ins.run(`u-${role}`, email, role, role);
  return { sqlite, db };
}

const payrollGET = (email) => import("../app/api/payroll/route.ts").then(m => m.GET(new Request(`${HOST}/api/payroll`, email ? { headers: { "oai-authenticated-user-email": email } } : {})));
const payrollPOST = (email, body) => import("../app/api/payroll/route.ts").then(m => m.POST(new Request(`${HOST}/api/payroll`, { method: "POST", headers: { "oai-authenticated-user-email": email, "content-type": "application/json" }, body: JSON.stringify(body) })));
const onbGET = (email, qs = "") => import("../app/api/provider-onboarding/route.ts").then(m => m.GET(new Request(`${HOST}/api/provider-onboarding${qs}`, { headers: { "oai-authenticated-user-email": email } })));
const onbPOST = (email, body) => import("../app/api/provider-onboarding/route.ts").then(m => m.POST(new Request(`${HOST}/api/provider-onboarding`, { method: "POST", headers: { "oai-authenticated-user-email": email, "content-type": "application/json" }, body: JSON.stringify(body) })));

// ===================== PAYROLL authorization =====================

test("payroll GET is gated on payroll.view: associate refused, finance allowed, anonymous 401", async () => {
  await freshDb();
  assert.equal((await payrollGET(null)).status, 401, "anonymous -> 401");
  assert.equal((await payrollGET(EMAIL.associate)).status, 403, "an associate has no payroll.view");
  const fin = await payrollGET(EMAIL.finance);
  assert.notEqual(fin.status, 401, "finance authenticates");
  assert.notEqual(fin.status, 403, "finance holds payroll.view");
});

test("payroll approve is gated on payroll.approve, which finance does NOT hold (run vs approve are separated)", async () => {
  await freshDb();
  const res = await payrollPOST(EMAIL.finance, { action: "approve", runId: "whatever" });
  assert.equal(res.status, 403, `finance can run payroll but must not approve it: ${JSON.stringify(await res.json())}`);
});

test("SEGREGATION: the approver cannot be the run's own creator/reviewer, but a clean approver succeeds", async () => {
  const { sqlite, db } = await freshDb();
  const { ensurePayrollTables } = await import("../lib/payroll-engine.ts");
  await ensurePayrollTables(db);
  const seedRun = (id, createdBy, reviewedBy) => sqlite.prepare("INSERT INTO payroll_runs (id,idempotency_key,period_start,period_end,status,input_snapshot_json,created_by,created_at,reviewed_by,reviewed_at) VALUES (?,?,?,?, 'reviewed','{}',?,0,?,0)")
    .run(id, `ik-${id}`, 1, 2, createdBy, reviewedBy);

  // A run made and reviewed by other people: the founder (holds payroll.approve, and is neither) approves.
  seedRun("RUN-CLEAN", "maker@pawspace.in", "checker@pawspace.in");
  const clean = await payrollPOST(EMAIL.founder, { action: "approve", runId: "RUN-CLEAN" });
  assert.equal(clean.status, 200, `a clean approver must succeed: ${JSON.stringify(await clean.json())}`);
  assert.equal(sqlite.prepare("SELECT status FROM payroll_runs WHERE id='RUN-CLEAN'").get().status, "approved");

  // A run the founder themselves created: approving it is a segregation violation and must be refused.
  seedRun("RUN-SELF", EMAIL.founder, "checker@pawspace.in");
  const self = await payrollPOST(EMAIL.founder, { action: "approve", runId: "RUN-SELF" });
  assert.notEqual(self.status, 200, "self-approval must not succeed");
  assert.match(String((await self.json()).error), /Maker\/reviewer cannot approve their own payroll run/);
  assert.equal(sqlite.prepare("SELECT status FROM payroll_runs WHERE id='RUN-SELF'").get().status, "reviewed", "the run stays reviewed, not approved");
});

// ===================== PROVIDER ONBOARDING authorization + KYC =====================

test("provider onboarding is gated on settings.manage: a manager (providers.manage only) is refused; founder allowed", async () => {
  await freshDb();
  assert.equal((await onbGET(EMAIL.manager)).status, 403, "providers.manage does not open the onboarding surface");
  const founder = await onbGET(EMAIL.founder);
  assert.notEqual(founder.status, 401);
  assert.notEqual(founder.status, 403, "settings.manage (founder) opens it");
});

test("KYC gate: an unverified provider cannot progress past verification, and cannot be activated/go live", async () => {
  const { sqlite, db } = await freshDb();
  // GET as founder first: onboardingTransactionalSnapshot + onboardingHumanActivationSnapshot ensure the
  // onboarding tables exist before we seed an application row.
  await onbGET(EMAIL.founder);
  const now = Date.now();
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,region_code,city_code,status,locale_code,basic_info_json,verification_status,quiz_status,interview_status,created_by,created_at,updated_at) VALUES ('APP-1','PRV-1','grooming','IN','KA','blr','qualification','en','{}','not_started','not_started','not_started',?,?,?)")
    .run(EMAIL.founder, now, now);

  // (a) The direct KYC gate: progression past verification into the quiz stage is refused while identity
  //     verification is not 'verified'. This is the transactional guard that keeps an unverified provider
  //     out of the qualified funnel.
  const gate = await onbPOST(EMAIL.founder, { action: "transition_application", applicationId: "APP-1", applicationAction: "complete_quiz" });
  assert.notEqual(gate.status, 200, "an unverified provider must not advance past verification");
  assert.match(String((await gate.json()).error), /Verification must be explicitly verified before quiz/);

  // (b) Activation is gated too: a provider that has not cleared the checklist cannot be activated, and
  //     nothing goes live.
  const activate = await onbPOST(EMAIL.founder, { action: "activate_provider_uat", applicationId: "APP-1" });
  assert.notEqual(activate.status, 200, "activation must be blocked for a provider that has not cleared onboarding");
  const liveProfiles = (() => { try { return sqlite.prepare("SELECT COUNT(*) c FROM provider_capacity_profiles WHERE live=1").get().c; } catch { return 0; } })();
  assert.equal(liveProfiles, 0, "no provider went live from a blocked activation");

  // Control: once identity verification is explicitly recorded as verified, the verification gate no
  // longer blocks the quiz transition (it fails later in the funnel, not on KYC).
  sqlite.prepare("UPDATE provider_onboarding_applications SET verification_status='verified' WHERE id='APP-1'").run();
  const afterVerify = await onbPOST(EMAIL.founder, { action: "transition_application", applicationId: "APP-1", applicationAction: "complete_quiz" });
  const afterBody = await afterVerify.json();
  assert.doesNotMatch(String(afterBody.error || ""), /Verification must be explicitly verified/, "a verified identity clears the KYC gate specifically");
});
