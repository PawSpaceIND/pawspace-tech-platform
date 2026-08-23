import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Task 21 audit — provider lifecycle (onboarding -> verification -> activation
// -> service map -> post-activation edits). Real execution over real SQLite.
// The property that matters most: a provider who has not cleared every mandated
// check for their category can never be activated, and an activated provider is
// invisible to discovery and matching until a human puts them on the service map.
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

const NOW = 1770000000000;
const OPS = "ops.one@pawspace.in";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  return { sqlite, db };
}

// Build a real application that has cleared every gate EXCEPT the ones a test
// wants to poke at. The onboarding wizard itself (documents, quiz, e-sign) is
// covered by the existing onboarding tests; this harness cares about the
// activation gate, so the upstream rows are seeded against the modules' own DDL.
async function readyApplication(db, sqlite, options = {}) {
  const activation = await import("../lib/provider-onboarding-human-activation.ts");
  const config = await import("../lib/provider-onboarding-configuration.ts");
  await activation.ensureProviderOnboardingHumanActivation(db);
  await config.ensureProviderOnboardingConfiguration(db);

  const verticalKey = options.verticalKey ?? "boarding";
  const applicationId = `POAPP-${verticalKey.toUpperCase()}-1`;

  // Frozen policy: one required media type, no extra activation requirements.
  const policyId = `POCFG-${verticalKey.toUpperCase()}-1`;
  sqlite.prepare("INSERT INTO provider_onboarding_policy_versions (id,policy_key,version,status,vertical_key,country_code,region_code,city_code,process_steps_json,package_config_json,verification_rules_json,verification_adapters_json,quiz_policy_json,interview_policy_json,media_requirements_json,sla_template_ref,activation_requirements_json,pricing_policy_ref,effective_from,effective_to,immutable_hash,created_by,created_at,updated_at) VALUES (?,?,1,'active',?,?,NULL,NULL,'[]','{}','{}','[]',?,?,?,?,'[]',NULL,NULL,NULL,?,?,?,?)")
    .run(policyId, `${verticalKey}:IN`, verticalKey, "IN", JSON.stringify({ defaultQuestionCount: 20 }), JSON.stringify({ durationMinutes: 15 }), JSON.stringify([{ mediaType: "provider_photo", minCount: 1 }]), "sla_provider_v1", `hash-${policyId}`, OPS, NOW, NOW);

  // Active, legally approved SLA localization (createProviderSla requires one).
  sqlite.prepare("INSERT INTO provider_onboarding_content_versions (id,content_key,locale_code,version,status,content_type,content_text,source_locale,source_content_id,ai_assisted,provider_ref,model_ref,semantic_hash,scoring_hash,legal_use_approved,effective_from,effective_to,immutable_hash,created_by,created_at,updated_at) VALUES (?,?,?,1,'active','legal',?,NULL,NULL,0,NULL,NULL,NULL,NULL,1,NULL,NULL,?,?,?,?)")
    .run(`POCONTENT-SLA-${verticalKey}`, "sla_provider_v1", "en", "Partner services agreement (UAT).", `hash-sla-${verticalKey}`, OPS, NOW, NOW);

  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,region_code,city_code,status,locale_code,basic_info_json,policy_ref,quiz_version_ref,verification_status,quiz_status,interview_status,human_decision,created_by,created_at,updated_at) VALUES (?,NULL,?,?,NULL,?,?,?,'{}',?,NULL,?,?,?,?,?,?,?)")
    .run(applicationId, verticalKey, "IN", "BLR", options.status ?? "interview", "en", policyId, options.verificationStatus ?? "verified", "passed", "completed", options.humanDecision ?? null, OPS, NOW, NOW);

  return { applicationId, policyId, verticalKey, activation };
}

async function completeInterviewAndProfile(db, sqlite, applicationId, activation) {
  const interviewId = `POINT-${applicationId}`;
  sqlite.prepare("INSERT INTO provider_onboarding_interviews (id,application_id,start_at,end_at,duration_minutes,ops_email,status,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,15,?,'completed',?,?,?,?)")
    .run(interviewId, applicationId, new Date(NOW).toISOString(), new Date(NOW + 900000).toISOString(), OPS, "Interviewed the partner about handling nervous dogs at length.", OPS, NOW, NOW);
  const decision = await activation.recordProviderHumanDecision(db, { interviewId, decision: "approved", decisionNotes: "Strong candidate, approved for onboarding", actorEmail: OPS });
  const sla = await activation.createProviderSla(db, { applicationId, actorEmail: OPS });
  await activation.acceptProviderSla(db, { agreementId: sla.id, acceptedBy: "partner@example.test", actorEmail: OPS });
  await activation.saveProviderProfile(db, {
    applicationId,
    payload: { displayName: "Meera's Home Boarding", businessName: "Meera Pet Care", bio: "Home boarding with a fenced garden.", services: ["boarding"], serviceAreas: ["blr-east"], languages: ["en", "kn"] },
    actorEmail: OPS,
  });
  await activation.addProviderProfileMedia(db, { applicationId, mediaType: "provider_photo", fileRef: "r2://provider/photo-1.jpg", actorEmail: OPS });
  return { interviewId, decision };
}

// ---------------------------------------------------------------------------
// 1. Verification mandate: fail-closed while IDfy is not connected.
// ---------------------------------------------------------------------------
test("verification mandate: automatable checks never auto-pass while IDfy is not connected", async () => {
  const { db } = fresh();
  const mandate = await import("../lib/provider-verification-mandate.ts");
  const status0 = await mandate.verificationMandateStatus(db, { applicationId: "APP-H", category: "host" });
  assert.deepEqual(status0.required.sort(), ["aadhaar", "house_verification", "pan", "pet_proofing_photo"]);
  assert.equal(status0.allVerified, false);
  assert.equal(status0.canTakeAssignments, false, "a provider with nothing verified cannot take assignments");

  const aadhaar = await mandate.runProviderVerification(db, {}, { applicationId: "APP-H", category: "host", verificationType: "aadhaar", actorId: OPS });
  assert.equal(aadhaar.status, "pending", "no IDfy credentials means the check waits, it does not pass");
  assert.equal(aadhaar.automated, false);

  const house = await mandate.runProviderVerification(db, {}, { applicationId: "APP-H", category: "host", verificationType: "house_verification", actorId: OPS });
  assert.equal(house.status, "manual_review", "physical checks wait for a human agent");

  await assert.rejects(
    () => mandate.recordManualVerification(db, { applicationId: "APP-H", verificationType: "aadhaar", status: "verified", actorId: OPS }),
    /automatable check/,
    "an agent cannot hand-wave an Aadhaar check that belongs to IDfy",
  );
  await assert.rejects(() => mandate.runProviderVerification(db, {}, { applicationId: "APP-H", category: "host", verificationType: "astrology", actorId: OPS }), /Unknown verification type/);

  const midway = await mandate.verificationMandateStatus(db, { applicationId: "APP-H", category: "host" });
  assert.equal(midway.allVerified, false);
  assert.deepEqual(midway.pending.sort(), ["aadhaar", "house_verification", "pan", "pet_proofing_photo"]);
});

test("verification mandate: category mandates are configurable and vertical-mapped", async () => {
  const { db } = fresh();
  const mandate = await import("../lib/provider-verification-mandate.ts");
  assert.equal(mandate.verificationCategoryForVertical("boarding"), "host");
  assert.equal(mandate.verificationCategoryForVertical("grooming"), "groomer");
  assert.equal(mandate.verificationCategoryForVertical("dog_training"), "trainer");
  assert.equal(mandate.verificationCategoryForVertical("pet_sitting"), "pet_sitter");
  assert.equal(mandate.verificationCategoryForVertical("dog_walking"), null, "verticals with no mandate defined are reported as such, not silently mapped");

  await assert.rejects(() => mandate.setCategoryMandate(db, { category: "astrologer", verificationTypes: ["pan"], actorId: OPS }), /Unknown category/);
  await assert.rejects(() => mandate.setCategoryMandate(db, { category: "groomer", verificationTypes: ["nonsense"], actorId: OPS }), /Unknown verification type\(s\): nonsense/);
  // A recognised type alongside an unrecognised one used to succeed with the unknown one silently
  // dropped, so an operator was told a check was mandated that nothing would ever require.
  await assert.rejects(() => mandate.setCategoryMandate(db, { category: "groomer", verificationTypes: ["aadhaar", "nonsense"], actorId: OPS }), /Unknown verification type\(s\): nonsense/);
  const updated = await mandate.setCategoryMandate(db, { category: "groomer", verificationTypes: ["aadhaar", "pan", "police_verification"], actorId: OPS });
  assert.deepEqual(updated.verificationTypes, ["aadhaar", "pan", "police_verification"]);
  const status = await mandate.verificationMandateStatus(db, { applicationId: "APP-G", category: "groomer" });
  assert.ok(status.required.includes("police_verification"), "the replacement set is what the mandate now enforces");
});

// ---------------------------------------------------------------------------
// 2. Activation gate: every mandated check must be verified.
// ---------------------------------------------------------------------------
test("activation is blocked while any mandated category check is unverified", async () => {
  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite, { verticalKey: "boarding" });
  await completeInterviewAndProfile(db, sqlite, applicationId, activation);
  const mandate = await import("../lib/provider-verification-mandate.ts");

  // Application-level verification says 'verified', but the host's mandated house/pet-proofing
  // checks have not been done. This is exactly the gap the audit closed.
  const blocked = await activation.evaluateProviderActivation(db, { applicationId });
  const mandateCheck = blocked.checks.find((check) => check.code === "category_verification_mandate");
  assert.ok(mandateCheck, "the checklist consults the category verification mandate");
  assert.equal(mandateCheck.passed, false);
  assert.equal(mandateCheck.detail.category, "host");
  assert.equal(blocked.eligible, false);
  await assert.rejects(() => activation.activateProviderUat(db, { applicationId, actorEmail: OPS }), /category_verification_mandate/);

  // Clear all four mandated checks the way each type actually allows.
  for (const type of ["aadhaar", "pan"]) {
    sqlite.prepare("UPDATE provider_verifications SET status='verified' WHERE application_id=? AND verification_type=?").run(applicationId, type);
    await mandate.runProviderVerification(db, {}, { applicationId, category: "host", verificationType: type, actorId: OPS });
    sqlite.prepare("UPDATE provider_verifications SET status='verified' WHERE application_id=? AND verification_type=?").run(applicationId, type);
  }
  for (const type of ["house_verification", "pet_proofing_photo"]) {
    await mandate.recordManualVerification(db, { applicationId, verificationType: type, status: "verified", note: "Agent visited the home and confirmed", actorId: OPS });
  }
  const cleared = await activation.evaluateProviderActivation(db, { applicationId });
  assert.equal(cleared.checks.find((check) => check.code === "category_verification_mandate").passed, true);
  assert.equal(cleared.eligible, true, `still blocked: ${cleared.checks.filter((c) => !c.passed).map((c) => c.code).join(", ")}`);
});

test("activation is blocked by each individual gate: verification, approval, SLA, profile, media", async () => {
  const cases = [
    { name: "verification_verified", mutate: (sqlite, id) => sqlite.prepare("UPDATE provider_onboarding_applications SET verification_status='manual_review_required' WHERE id=?").run(id) },
    { name: "sla_accepted", mutate: (sqlite, id) => sqlite.prepare("UPDATE provider_onboarding_agreements SET status='awaiting_acceptance' WHERE application_id=?").run(id) },
    { name: "profile_complete", mutate: (sqlite, id) => sqlite.prepare("UPDATE provider_onboarding_profiles SET services_json='[]' WHERE application_id=?").run(id) },
    { name: "media:provider_photo", mutate: (sqlite, id) => sqlite.prepare("DELETE FROM provider_onboarding_profile_media WHERE application_id=?").run(id) },
    { name: "city_present", mutate: (sqlite, id) => sqlite.prepare("UPDATE provider_onboarding_applications SET city_code='' WHERE id=?").run(id) },
  ];
  for (const scenario of cases) {
    const { sqlite, db } = fresh();
    const { applicationId, activation } = await readyApplication(db, sqlite, { verticalKey: "dog_walking" });
    await completeInterviewAndProfile(db, sqlite, applicationId, activation);
    const before = await activation.evaluateProviderActivation(db, { applicationId });
    assert.equal(before.eligible, true, `baseline should be activatable, blocked by: ${before.checks.filter((c) => !c.passed).map((c) => c.code).join(", ")}`);
    scenario.mutate(sqlite, applicationId);
    const after = await activation.evaluateProviderActivation(db, { applicationId });
    assert.equal(after.eligible, false, `${scenario.name} must block activation`);
    assert.equal(after.checks.find((check) => check.code === scenario.name)?.passed, false, `${scenario.name} is the failing check`);
  }
});

// ---------------------------------------------------------------------------
// 3. Activated but not live: invisible to discovery and matching.
// ---------------------------------------------------------------------------
test("an activated provider is invisible to matching until a human adds them to the service map", async () => {
  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite, { verticalKey: "dog_walking" });
  await completeInterviewAndProfile(db, sqlite, applicationId, activation);
  const activated = await activation.activateProviderUat(db, { applicationId, actorEmail: OPS });
  assert.equal(activated.marketplaceLive, false);
  assert.equal(activated.orderEligible, false);
  const profile = sqlite.prepare("SELECT live,status,zones_json FROM provider_capacity_profiles WHERE id=?").get(activated.providerId);
  assert.equal(profile.live, 0, "activation alone never makes a provider live");
  assert.equal(profile.status, "uat_ready");

  const capacity = await import("../lib/provider-capacity-governance.ts");
  const beforeLive = await capacity.loadGovernedProviders(db, "blr", "blr-east", "boarding");
  assert.ok(!beforeLive.some((p) => p.id === activated.providerId), "the scheduler cannot see a non-live provider");

  await assert.rejects(() => activation.addProviderToServiceMap(db, { providerId: activated.providerId, zoneIds: [], actorEmail: OPS }), /at least one real zone/i);
  await assert.rejects(() => activation.addProviderToServiceMap(db, { providerId: "PROV-NOPE", zoneIds: ["blr-east"], actorEmail: OPS }), /activate the provider first/);

  const live = await activation.addProviderToServiceMap(db, { providerId: activated.providerId, zoneIds: ["blr-east", "blr-central"], actorEmail: OPS });
  assert.equal(live.live, true);
  const afterLive = sqlite.prepare("SELECT live,status,zones_json FROM provider_capacity_profiles WHERE id=?").get(activated.providerId);
  assert.equal(afterLive.live, 1);
  assert.equal(afterLive.status, "active");
  assert.deepEqual(JSON.parse(afterLive.zones_json), ["blr-east", "blr-central"]);

  // The provider's real services drive matching: they onboarded for boarding.
  const matched = await capacity.loadGovernedProviders(db, "blr", "blr-east", "boarding");
  assert.ok(matched.some((p) => p.id === activated.providerId), "once live and zoned, the scheduler can match them");
  const wrongService = await capacity.loadGovernedProviders(db, "blr", "blr-east", "grooming");
  assert.ok(!wrongService.some((p) => p.id === activated.providerId), "they are not offered for a service they never onboarded for");
  const wrongZone = await capacity.loadGovernedProviders(db, "blr", "blr-west", "boarding");
  assert.ok(!wrongZone.some((p) => p.id === activated.providerId), "they are not offered outside their real zones");
});

test("boarding discovery only ever returns live, active, verified hosts", async () => {
  const { sqlite, db } = fresh();
  const boarding = await import("../lib/boarding-governance.ts");
  await boarding.ensureBoardingGovernanceTables(db);
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);

  const host = (id, live, status) => {
    sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,4,5,2,30,6,3,?,1,?,NULL,?,?)")
      .run(id, "blr", `Host ${id}`, "home_boarder", JSON.stringify(["boarding"]), JSON.stringify(["blr-east"]), live, status, "2026-01-01", OPS, NOW);
    sqlite.prepare("INSERT INTO boarding_host_profiles (provider_id,city_id,zone_id,area,species_json,max_guest_pets,one_family_only,medication_support,resident_pets,home_verified,kyc_status,background_check_status,active,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,0,1,'none',1,'verified','verified',1,1,?,?)")
      .run(id, "blr", "blr-east", "Indiranagar", JSON.stringify(["dog"]), 2, OPS, NOW);
  };
  host("PROV-LIVE", 1, "active");
  host("PROV-ACTIVATED-NOT-LIVE", 0, "uat_ready");
  host("PROV-SUSPENDED", 1, "suspended");

  // ensureBoardingGovernanceTables also seeds the demo UAT hosts; assert on the three this test owns.
  const hosts = await boarding.listBoardingHosts(db, { cityId: "blr", zoneId: "blr-east" });
  const mine = hosts.map((h) => h.providerId).filter((id) => id.startsWith("PROV-"));
  assert.deepEqual(mine, ["PROV-LIVE"], "the activated-but-not-live and the suspended host are both undiscoverable");
});

// ---------------------------------------------------------------------------
// 4. Post-activation edits: sensitive changes drop the provider off the map.
// ---------------------------------------------------------------------------
test("changing service areas after activation takes the provider off the live map for re-review", async () => {
  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite, { verticalKey: "dog_walking" });
  await completeInterviewAndProfile(db, sqlite, applicationId, activation);
  const activated = await activation.activateProviderUat(db, { applicationId, actorEmail: OPS });
  await activation.addProviderToServiceMap(db, { providerId: activated.providerId, zoneIds: ["blr-east"], actorEmail: OPS });

  await assert.rejects(
    () => activation.updateActivatedProviderProfile(db, { applicationId, changes: { verificationStatus: "verified" }, reason: "Trying to self-verify", actorEmail: OPS }),
    /No permitted post-activation profile fields supplied/,
  );
  await assert.rejects(
    () => activation.updateActivatedProviderProfile(db, { applicationId, changes: { bio: "New bio" }, reason: "x", actorEmail: OPS }),
    /clear edit reason is required/,
  );

  // A cosmetic edit keeps them live.
  await assert.rejects(
    () => activation.updateActivatedProviderProfile(db, { applicationId, changes: { bio: "New bio", verificationStatus: "verified" }, reason: "Sneaking a protected field alongside a permitted one", actorEmail: OPS }),
    /protected onboarding fields cannot be edited/,
  );
  const cosmetic = await activation.updateActivatedProviderProfile(db, { applicationId, changes: { bio: "Now with a bigger garden for the dogs." }, reason: "Partner asked to refresh their bio", actorEmail: OPS });
  assert.equal(cosmetic.reviewRequired, false);
  assert.equal(sqlite.prepare("SELECT live FROM provider_capacity_profiles WHERE id=?").get(activated.providerId).live, 1);

  // Changing where they work needs re-review AND re-verification: off the map immediately.
  const sensitive = await activation.updateActivatedProviderProfile(db, { applicationId, changes: { serviceAreas: ["blr-west"] }, reason: "Partner moved to a different part of the city", actorEmail: OPS });
  assert.equal(sensitive.reviewRequired, true);
  assert.equal(sensitive.reverificationRequired, true);
  const row = sqlite.prepare("SELECT live,status FROM provider_capacity_profiles WHERE id=?").get(activated.providerId);
  assert.equal(row.live, 0, "a provider under re-review takes no new bookings");
  assert.equal(row.status, "uat_review");
  assert.equal(sqlite.prepare("SELECT status FROM provider_onboarding_applications WHERE id=?").get(applicationId).status, "post_activation_review");

  const capacity = await import("../lib/provider-capacity-governance.ts");
  const visible = await capacity.loadGovernedProviders(db, "blr", "blr-east", "boarding");
  assert.ok(!visible.some((p) => p.id === activated.providerId));
  // Selected by the flag rather than by timestamp: the cosmetic edit above can share a millisecond
  // with this one, so ordering by created_at would pick either row.
  const audits = sqlite.prepare("SELECT action,reason,review_required,reverification_required FROM provider_onboarding_profile_audit WHERE application_id=? AND reverification_required=1").all(applicationId);
  assert.equal(audits.length, 1, "the service-area change is auditable exactly once");
  assert.equal(audits[0].action, "post_activation_profile_edit");
  assert.equal(audits[0].reason, "Partner moved to a different part of the city", "the audit carries the real reason given");
});

// ---------------------------------------------------------------------------
// 5. Human authority: interview decisions and SLA order cannot be skipped.
// ---------------------------------------------------------------------------
test("the human decision gate cannot be skipped or made by the AI summary", async () => {
  const { sqlite, db } = fresh();
  const { applicationId, activation } = await readyApplication(db, sqlite, { verticalKey: "dog_walking" });
  const interviewId = `POINT-${applicationId}`;
  sqlite.prepare("INSERT INTO provider_onboarding_interviews (id,application_id,start_at,end_at,duration_minutes,ops_email,status,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,15,?,'scheduled',NULL,?,?,?)")
    .run(interviewId, applicationId, new Date(NOW).toISOString(), new Date(NOW + 900000).toISOString(), OPS, OPS, NOW, NOW);

  // No SLA before a human approval, no profile before an accepted SLA.
  await assert.rejects(() => activation.createProviderSla(db, { applicationId, actorEmail: OPS }), /human approval is required/i);
  await assert.rejects(() => activation.saveProviderProfile(db, { applicationId, payload: { displayName: "X", businessName: "Y" }, actorEmail: OPS }), /human approval is required/i);

  // Only the assigned interviewer can complete the interview, and notes are required.
  await assert.rejects(() => activation.completeProviderInterview(db, { interviewId, notes: "Looked fine", actorEmail: "someone.else@pawspace.in" }), /assigned Ops interviewer/);
  await assert.rejects(() => activation.completeProviderInterview(db, { interviewId, notes: "short", actorEmail: OPS }), /notes are required/);
  const completed = await activation.completeProviderInterview(db, { interviewId, notes: "Discussed dog handling, vaccinations and availability in detail.", actorEmail: OPS });
  assert.equal(completed.finalDecisionRecorded, false, "completing an interview is not itself a decision");

  // An AI summary draft is explicitly a draft, with human decision authority.
  const draft = await activation.saveInterviewAiSummaryDraft(db, { interviewId, summary: "Candidate appears experienced.", actorEmail: OPS, providerRef: "stub", modelRef: "stub-v1" });
  assert.equal(draft.autoDecision, false);
  assert.equal(draft.decisionAuthority, "human_ops");
  assert.equal(sqlite.prepare("SELECT human_decision FROM provider_onboarding_applications WHERE id=?").get(applicationId).human_decision, null, "the AI draft did not decide anything");

  await assert.rejects(() => activation.recordProviderHumanDecision(db, { interviewId, decision: "approved", decisionNotes: "ok", actorEmail: OPS }), /Decision notes are required/);
  await assert.rejects(() => activation.recordProviderHumanDecision(db, { interviewId, decision: "hired", decisionNotes: "Unsupported decision word", actorEmail: OPS }), /Unsupported human interview decision/);
  const rejected = await activation.recordProviderHumanDecision(db, { interviewId, decision: "rejected", decisionNotes: "Not a fit for our safety standards", actorEmail: OPS });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.aiDecision, false);
  await assert.rejects(() => activation.createProviderSla(db, { applicationId, actorEmail: OPS }), /human approval is required/i, "a rejected application cannot proceed to an SLA");
});

test("interview scheduling refuses double-booking the same Ops interviewer", async () => {
  const { sqlite, db } = fresh();
  const first = await readyApplication(db, sqlite, { verticalKey: "boarding", status: "interview" });
  const activation = first.activation;
  const start = new Date(NOW + 3600000).toISOString();
  await activation.scheduleProviderInterview(db, { applicationId: first.applicationId, startAt: start, opsEmail: OPS, actorEmail: OPS });
  // The same Ops person in the same slot is caught by the overlap guard first.
  await assert.rejects(
    () => activation.scheduleProviderInterview(db, { applicationId: first.applicationId, startAt: start, opsEmail: OPS, actorEmail: OPS }),
    /overlapping interview/,
  );
  // A different, non-overlapping slot still refuses a second live interview for one application.
  await assert.rejects(
    () => activation.scheduleProviderInterview(db, { applicationId: first.applicationId, startAt: new Date(NOW + 5 * 3600000).toISOString(), opsEmail: "ops.two@pawspace.in", actorEmail: OPS }),
    /already has a scheduled interview/,
  );

  // A different application overlapping the same Ops slot is refused too.
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,region_code,city_code,status,locale_code,basic_info_json,policy_ref,quiz_version_ref,verification_status,quiz_status,interview_status,human_decision,created_by,created_at,updated_at) VALUES (?,NULL,?,?,NULL,?,?,?,'{}',?,NULL,'verified','passed','not_started',NULL,?,?,?)")
    .run("POAPP-SECOND", "boarding", "IN", "BLR", "interview", "en", first.policyId, OPS, NOW, NOW);
  await assert.rejects(
    () => activation.scheduleProviderInterview(db, { applicationId: "POAPP-SECOND", startAt: new Date(NOW + 3600000 + 300000).toISOString(), opsEmail: OPS, actorEmail: OPS }),
    /overlapping interview/,
  );
  await assert.rejects(
    () => activation.scheduleProviderInterview(db, { applicationId: "POAPP-SECOND", startAt: "not-a-date", opsEmail: OPS, actorEmail: OPS }),
    /Valid interview start time/,
  );
});

test("provider lifecycle modules do not fabricate values or use banned DB access", () => {
  for (const path of [
    "lib/provider-onboarding-human-activation.ts", "lib/provider-onboarding-transactional.ts",
    "lib/provider-verification-mandate.ts", "lib/provider-capacity-governance.ts",
    "lib/provider-public-profile.ts", "lib/provider-onboarding-configuration.ts",
  ]) {
    const source = read(path);
    assert.ok(!/Math\.random/.test(source), `${path} must not fabricate values with Math.random`);
    assert.ok(!/globalThis\.__D1__/.test(source), `${path} must not use the banned globalThis D1 pattern`);
  }
});
