import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// The second half of the provider closure: ACTIVATION and READINESS.
//
// tests/provider-identity-onboarding-closure.test.mjs proves identity, onboarding ownership, KYC with
// the verifier disconnected, and availability authority. This file takes the same executed approach to
// the questions that come after them — who may promote a provider, what blocks activation, whether a
// repeated submit does anything, and whether a readiness surface will claim readiness it cannot support.
//
// Executed against real SQLite. No source-text matching for anything behavioural.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const OPS = "ops.one@pawspace.in";
const NOW = 1770000000000;

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "not-a-real-uat-signing-secret-for-tests" };
  return { sqlite, db };
}

/** A provider that exists because the real OTP flow created it — never a hand-written row. */
async function signUpProvider(db, { phone, name, cityId = "blr" }) {
  const otp = await import("../lib/partner-otp.ts");
  const challenge = await otp.requestPartnerOtp(db, { phone });
  const verified = await otp.verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode, name, cityId });
  return verified.providerId;
}

/**
 * An application that has cleared every activation gate, built through the modules' own DDL. Options
 * knock out exactly one gate at a time so a blocked activation names the gate that blocked it.
 */
async function readyApplication(db, sqlite, options = {}) {
  const activation = await import("../lib/provider-onboarding-human-activation.ts");
  const config = await import("../lib/provider-onboarding-configuration.ts");
  await activation.ensureProviderOnboardingHumanActivation(db);
  await config.ensureProviderOnboardingConfiguration(db);

  const verticalKey = "boarding";
  const applicationId = options.applicationId ?? "POAPP-ACT-1";
  const policyId = "POCFG-ACT-1";

  sqlite.prepare("INSERT INTO provider_onboarding_policy_versions (id,policy_key,version,status,vertical_key,country_code,region_code,city_code,process_steps_json,package_config_json,verification_rules_json,verification_adapters_json,quiz_policy_json,interview_policy_json,media_requirements_json,sla_template_ref,activation_requirements_json,pricing_policy_ref,effective_from,effective_to,immutable_hash,created_by,created_at,updated_at) VALUES (?,?,1,'active',?,?,NULL,NULL,'[]','{}','{}','[]',?,?,?,?,'[]',NULL,NULL,NULL,?,?,?,?)")
    .run(policyId, `${verticalKey}:IN`, verticalKey, "IN", JSON.stringify({ defaultQuestionCount: 20 }), JSON.stringify({ durationMinutes: 15 }), JSON.stringify([{ mediaType: "provider_photo", minCount: 1 }]), "sla_provider_v1", `hash-${policyId}`, OPS, NOW, NOW);

  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,region_code,city_code,status,locale_code,basic_info_json,policy_ref,quiz_version_ref,verification_status,quiz_status,interview_status,human_decision,created_by,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?,'{}',?,NULL,?,?,?,?,?,?,?)")
    .run(applicationId, options.providerId ?? null, verticalKey, "IN", "BLR", "interview", "en", policyId,
      options.verificationStatus ?? "verified", options.quizStatus ?? "passed", "completed",
      ("humanDecision" in options ? options.humanDecision : "approved"), OPS, NOW, NOW);

  if (options.interview !== "none") {
    sqlite.prepare("INSERT INTO provider_onboarding_interviews (id,application_id,start_at,end_at,duration_minutes,ops_email,status,notes,ai_summary_draft,ai_provider_ref,ai_model_ref,outcome,decision_notes,decision_actor,decision_at,created_by,created_at,updated_at) VALUES (?,?,?,?,15,?,?,NULL,NULL,NULL,NULL,?,NULL,?,?,?,?,?)")
      .run("POINT-ACT-1", applicationId, "2026-01-01T10:00:00.000Z", "2026-01-01T10:15:00.000Z", OPS, "completed", options.interviewOutcome ?? "approved", OPS, NOW, OPS, NOW, NOW);
  }
  if (options.sla !== "none") {
    sqlite.prepare("INSERT INTO provider_onboarding_agreements (id,application_id,agreement_version,template_ref,content_id,content_version,locale_code,esign_adapter,environment,external_connected,status,accepted_by,accepted_at,acceptance_ref,created_by,created_at,updated_at) VALUES (?,?,1,?,?,1,?,?,?,0,?,?,?,NULL,?,?,?)")
      .run("POSLA-ACT-1", applicationId, "sla_provider_v1", "POCONTENT-SLA-1", "en", "sandbox", "uat", options.slaStatus ?? "accepted", "provider", NOW, OPS, NOW, NOW);
  }
  if (options.profile !== "none") {
    sqlite.prepare("INSERT INTO provider_onboarding_profiles (application_id,provider_id,status,display_name,bio,business_name,business_details_json,services_json,service_areas_json,languages_json,package_details_json,facility_details_json,references_json,profile_completion_json,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(applicationId, options.providerId ?? null, "complete", "Asha Boarding", "Home boarding in Bengaluru.", "Asha Boarding", JSON.stringify({ providerModel: "commission" }), JSON.stringify(["boarding"]), JSON.stringify(["blr-east"]), JSON.stringify(["en"]), "{}", "{}", "[]", JSON.stringify({ complete: true }), OPS, OPS, NOW, NOW);
  }
  if (options.media !== "none") {
    sqlite.prepare("INSERT INTO provider_onboarding_profile_media (id,application_id,media_type,file_ref,classification,status,publish_approved,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?,?)")
      .run("POMEDIA-ACT-1", applicationId, "provider_photo", "r2://photo", "public", "uploaded", OPS, NOW, NOW);
  }

  const mandate = await import("../lib/provider-verification-mandate.ts");
  await mandate.ensureVerificationMandateTables(db);
  if (options.mandate !== "unmet") {
    // Every mandated check for the category, recorded as satisfied through the real recording paths.
    await mandate.setCategoryMandate(db, { category: "host", verificationTypes: ["house_verification"], actorId: OPS });
    await mandate.recordManualVerification(db, { applicationId, verificationType: "house_verification", status: "verified", note: "premises inspected", actorId: OPS });
  } else {
    await mandate.setCategoryMandate(db, { category: "host", verificationTypes: ["house_verification"], actorId: OPS });
  }

  return { applicationId, policyId, activation };
}

// --- activation: the full gate set, executed ---------------------------------------------------

test("ACTIVATION — a fully cleared application is eligible, and activation is UAT-only", async () => {
  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite);

  const evaluation = await activation.evaluateProviderActivation(db, { applicationId });
  assert.equal(evaluation.eligible, true, `blocked by: ${evaluation.checks.filter((c) => !c.passed).map((c) => c.code).join(", ")}`);

  // Clearing every gate does NOT make the provider a live marketplace participant.
  assert.equal(evaluation.productionMarketplaceReady, false, "activation must never claim production readiness");
  assert.equal(evaluation.autonomousDecision, false, "activation is a human decision, and says so");
});

test("ACTIVATION — NEGATIVE: a rejected KYC check blocks activation by name", async () => {
  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite, { verificationStatus: "failed" });

  const evaluation = await activation.evaluateProviderActivation(db, { applicationId });
  assert.equal(evaluation.eligible, false);
  const blocked = evaluation.checks.filter((c) => !c.passed).map((c) => c.code);
  assert.ok(blocked.includes("verification_verified"), `expected the verification gate to block, saw ${blocked.join(", ")}`);

  await assert.rejects(() => activation.activateProviderUat(db, { applicationId, actorEmail: OPS }),
    /Activation checklist is blocked/, "and the activation itself must refuse, not just the evaluation");
});

test("ACTIVATION — NEGATIVE: an unmet category mandate blocks activation even when every other gate is clear", async () => {
  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite, { mandate: "unmet" });

  const evaluation = await activation.evaluateProviderActivation(db, { applicationId });
  assert.equal(evaluation.eligible, false, "an unverified mandated check cannot be activated past");
  const blocked = evaluation.checks.filter((c) => !c.passed).map((c) => c.code);
  assert.ok(blocked.some((code) => code.includes("mandate")), `expected a mandate gate, saw ${blocked.join(", ")}`);
});

test("ACTIVATION — NEGATIVE: missing mandatory onboarding data blocks readiness, one gate at a time", async () => {
  // Each case removes exactly one prerequisite, so a pass here cannot come from a different gate.
  const cases = [
    ["no accepted SLA", { slaStatus: "pending" }, "sla_accepted"],
    ["no completed profile", { profile: "none" }, "profile_complete"],
    ["no required media", { media: "none" }, null],
    ["no human decision", { humanDecision: null }, "human_decision_approved"],
    ["interview not approved", { interviewOutcome: "rejected" }, "interview_approved"],
  ];
  for (const [label, options, expectedGate] of cases) {
    const { sqlite, db } = fresh();
    const { applicationId, activation } = await readyApplication(db, sqlite, options);
    const evaluation = await activation.evaluateProviderActivation(db, { applicationId });
    const blocked = evaluation.checks.filter((c) => !c.passed).map((c) => c.code);
    assert.equal(evaluation.eligible, false, `${label}: activation must be blocked`);
    if (expectedGate) assert.ok(blocked.includes(expectedGate), `${label}: expected ${expectedGate}, saw ${blocked.join(", ")}`);
  }
});

test("ACTIVATION — NEGATIVE: a provider has no way to promote itself", async () => {
  // The self-service surface is everything a provider may do to its own application. Activation is not
  // among those things, and this asserts the exported surface rather than a comment claiming so.
  const selfService = await import("../lib/provider-onboarding-self-service.ts");
  const exported = Object.keys(selfService).sort();
  assert.ok(exported.length > 0);
  for (const name of exported) {
    assert.ok(!/^activate/i.test(name), `provider-facing module must expose no activation action, found ${name}`);
  }
  assert.ok(!exported.includes("recordProviderHumanDecision"), "the human decision is not a provider-facing action");
  assert.ok(!exported.includes("activateProviderUat"), "activation is not a provider-facing action");

  // And the provider-facing route must not reach the activation module at all.
  const route = read("app/api/provider-onboarding-self-service/route.ts");
  assert.ok(!/human-activation/.test(route), "the self-service route must not import the activation module");
});

// --- repeated submission -----------------------------------------------------------------------

test("ONBOARDING — a repeated submit changes nothing and records nothing new", async () => {
  const { sqlite, db } = fresh();
  const selfService = await import("../lib/provider-onboarding-self-service.ts");
  const providerId = await signUpProvider(db, { phone: "9000000201", name: "Asha Partner" });

  const application = await selfService.createOwnedProviderApplication(db, {
    providerId, actorId: providerId,
    payload: { verticalKey: "boarding", countryCode: "IN", cityCode: "BLR", localeCode: "en", basicInfo: { name: "Asha Partner" } },
  });

  const statusOf = () => sqlite.prepare("SELECT status FROM provider_onboarding_applications WHERE id=?").get(application.id).status;
  const eventCount = () => sqlite.prepare("SELECT COUNT(*) n FROM provider_onboarding_events WHERE application_id=?").get(application.id).n;

  // With no active policy the submit fails closed — a submission that cannot be governed is refused.
  const before = { status: statusOf(), events: eventCount() };
  await assert.rejects(() => selfService.submitOwnedProviderApplication(db, { providerId, actorId: providerId, applicationId: application.id }),
    /active onboarding policy/, "an ungoverned submission must be refused rather than accepted and sorted out later");
  await assert.rejects(() => selfService.submitOwnedProviderApplication(db, { providerId, actorId: providerId, applicationId: application.id }),
    /active onboarding policy/, "and the second attempt must behave identically");

  assert.equal(statusOf(), before.status, "a refused submit must not advance the application");
  assert.equal(eventCount(), before.events, "nor accumulate an event trail for work that did not happen");
});

// --- training / SOP readiness --------------------------------------------------------------------

test("TRAINING — NEGATIVE: readiness is not claimed for a provider whose services cannot be resolved", async () => {
  // A provider that has not been activated has no capacity profile, so its service set resolves to
  // empty — and "every required module for zero services is complete" is vacuously true. Reporting that
  // as ready tells staff a provider who has completed no training is cleared to work.
  const { db } = fresh();
  const lms = await import("../lib/provider-lms.ts");
  await lms.ensureLmsTables(db);
  const providerId = await signUpProvider(db, { phone: "9000000202", name: "Asha Partner" });

  const readiness = await lms.providerTrainingReadiness(db, providerId);
  assert.deepEqual(readiness.services, [], "precondition: this provider has no resolvable services yet");
  assert.equal(readiness.servicesResolved, false, "and the surface must say it could not resolve them");
  assert.equal(readiness.trainingReady, false, "an unknown service set is not a satisfied training requirement");
  assert.equal(readiness.readinessReason, "provider_services_unknown", "with the reason stated, not inferred");
});

test("TRAINING — a provider with real services and no outstanding modules is ready, and the reason says so", async () => {
  const { sqlite, db } = fresh();
  const lms = await import("../lib/provider-lms.ts");
  await lms.ensureLmsTables(db);
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);

  const providerId = await signUpProvider(db, { phone: "9000000203", name: "Asha Partner" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(providerId, "blr", "Asha Partner", "commission", JSON.stringify(["pet_sitting"]), JSON.stringify(["blr-east"]), "2020-01-01", OPS, NOW);

  const readiness = await lms.providerTrainingReadiness(db, providerId);
  assert.deepEqual(readiness.services, ["pet_sitting"]);
  assert.equal(readiness.servicesResolved, true);
  assert.equal(readiness.requiredTotal, 0, "no modules are published for this service in this fixture");
  assert.equal(readiness.trainingReady, true, "a known service set with nothing outstanding is genuinely ready");
  assert.equal(readiness.readinessReason, "required_modules_complete");
});

test("TRAINING — an outstanding required module blocks readiness, and staleness is reported as its own state", async () => {
  const { sqlite, db } = fresh();
  const lms = await import("../lib/provider-lms.ts");
  await lms.ensureLmsTables(db);
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);

  const providerId = await signUpProvider(db, { phone: "9000000204", name: "Asha Partner" });
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(providerId, "blr", "Asha Partner", "commission", JSON.stringify(["pet_sitting"]), JSON.stringify(["blr-east"]), "2020-01-01", OPS, NOW);

  const sopModule = await lms.saveLmsModule(db, {
    title: "Pet sitting SOP", serviceCode: "pet_sitting", summary: "How sitting visits run",
    sections: ["Arrive on time"], quiz: [{ question: "Do you arrive on time?", options: ["No", "Yes"], answerIndex: 1 }],
    passPct: 100, actorId: `staff:${OPS}`,
  });
  await lms.setLmsModuleStatus(db, { moduleId: sopModule.moduleId, status: "published", actorId: `staff:${OPS}` });

  const outstanding = await lms.providerTrainingReadiness(db, providerId);
  assert.equal(outstanding.requiredTotal, 1);
  assert.equal(outstanding.trainingReady, false, "a published required module nobody has passed blocks readiness");
  assert.equal(outstanding.readinessReason, "required_modules_outstanding");
  assert.equal(outstanding.modules[0].state, "not_started");
});

// --- the readiness surface is not consulted by activation, and that is recorded ------------------

test("SCOPE — training readiness is not currently an activation gate, and this is asserted rather than assumed", async () => {
  // Stated plainly so it cannot change silently in either direction: the activation checklist today does
  // not consult training readiness. Wiring it in would block providers who are activatable today, which
  // is a product decision rather than a defect fix, so it is recorded here instead of introduced.
  const activationSource = read("lib/provider-onboarding-human-activation.ts");
  assert.ok(!/provider-lms/.test(activationSource),
    "if activation starts consulting the LMS, this assertion should be replaced by an executed gate test");

  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite);
  const evaluation = await activation.evaluateProviderActivation(db, { applicationId });
  assert.ok(!evaluation.checks.some((check) => /training|lms|sop/i.test(check.code)),
    `activation currently has no training gate; gates are: ${evaluation.checks.map((c) => c.code).join(", ")}`);
});
