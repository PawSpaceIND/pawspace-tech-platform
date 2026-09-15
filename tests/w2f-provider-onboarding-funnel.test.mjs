/*
 * Can a real caregiver actually get through provider onboarding, end to end, using only the controls
 * the screens expose?
 *
 * Before this suite the answer was no, and it was no for five independent reasons, each proved by
 * walking the funnel through the real route handlers:
 *
 *   1. /partner/onboarding had NO document control - the button was hard-disabled behind a notice
 *      saying secure storage was not provisioned - while the active onboarding policy requires a
 *      government_id and transitionProviderApplication("submit") refuses without one. First stop.
 *   2. Nothing anywhere posted create_quiz_draft or approve_quiz, and the Control Center policy form
 *      never named an activeQuizVersionRef - so quiz_version_ref was always NULL, the applicant was
 *      never offered a qualification, and scoreOwnedProviderQuiz refused. Second stop.
 *   3. Nothing anywhere posted transition_application, so an application that passed its quiz sat in
 *      'qualification' and scheduleProviderInterview refused it forever. Third stop.
 *   4. /team/provider-verification could look a KYC mandate up and could not move one, so
 *      `category_verification_mandate` - a hard activation gate - could never be satisfied.
 *   5. The Control Center published activationRequirements the evaluator does not implement, so every
 *      application pinned to a policy from that screen carried five permanently failing
 *      `unsupported_policy_requirement:*` checks.
 *
 * The test asserts the OUTCOME - that the caregiver ends up live on the service map - and takes every
 * decision from the screens themselves (their exported predicates and constants), so a screen that
 * stops offering a control fails this suite rather than passing it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__W2F_ONBOARDING_DB__");

const STAFF = "onboarding.ops@pawspace.in";
const PROVIDER = "prv_w2f_applicant";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");

/** An in-memory R2 stand-in: the same put/head surface storeProviderDocumentSecurely uses. */
function bucket() {
  const objects = new Map();
  return {
    put: async (key, value, options) => { objects.set(key, { size: value.byteLength ?? 0, httpMetadata: options?.httpMetadata }); return { key }; },
    head: async (key) => objects.get(key) ?? null,
    objects,
  };
}

async function providerSession(db, providerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey: `uat-provider:${providerId}`,
    subjectType: "provider", subjectId: providerId, actorId: "test", reason: "w2f onboarding funnel fixture",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp", principalType: "identity_subject",
    principalKey: `uat-provider:${providerId}`, subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const staffPost = async (path, body) => {
  const { POST } = await import(`../app/api${path}/route.ts`);
  return POST(new Request(`${ORIGIN}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": STAFF },
    body: JSON.stringify(body),
  }));
};
const staffGet = async (path) => {
  const { GET } = await import(`../app/api${path.split("?")[0]}/route.ts`);
  return GET(new Request(`${ORIGIN}/api${path}`, { headers: { "oai-authenticated-user-email": STAFF } }));
};
const partnerPost = async (cookie, body) => {
  const { POST } = await import("../app/api/provider-onboarding-self-service/route.ts");
  return POST(new Request(`${ORIGIN}/api/provider-onboarding-self-service`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));
};
const partnerGet = async (cookie) => {
  const { GET } = await import("../app/api/provider-onboarding-self-service/route.ts");
  return GET(new Request(`${ORIGIN}/api/provider-onboarding-self-service`, { headers: { cookie } }));
};

const ok = async (response, what) => {
  assert.ok(response.ok, `${what} must succeed, got ${response.status}: ${await response.clone().text()}`);
  return (await response.clone().json()).data;
};
/** The snapshot /partner/onboarding itself reads, handed to the screen's own predicate. */
const partnerView = async (cookie) => {
  const { partnerOnboardingControls } = await import("../app/partner/onboarding/page.tsx");
  const data = await ok(await partnerGet(cookie), "self-service snapshot");
  return { data, controls: partnerOnboardingControls(data) };
};

/** Control Center: an active onboarding policy and an active legal SLA localization. */
async function publishPolicyAndSla(quizVersionRef) {
  const { policyDraftPayload } = await import("../app/control/provider-onboarding/page.tsx");
  const draft = await ok(await staffPost("/provider-onboarding-configuration", {
    action: "create_policy_draft",
    // Exactly the payload the Control Center screen sends, including the assessment it names.
    payload: policyDraftPayload({ verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", slaTemplateRef: "provider-sla" }, quizVersionRef || ""),
  }), "policy draft");
  for (const lifecycleAction of ["submit_review", "approve", "activate"]) {
    await ok(await staffPost("/provider-onboarding-configuration", { action: "transition_policy", policyId: draft.id, lifecycleAction }), `policy ${lifecycleAction}`);
  }
  const content = await ok(await staffPost("/provider-onboarding-configuration", {
    action: "create_content_draft",
    payload: { contentKey: "provider-sla", localeCode: "en", contentType: "legal", contentText: "PawSpace provider UAT service agreement.", aiAssisted: false },
  }), "legal content draft");
  for (const lifecycleAction of ["submit_review", "approve", "activate"]) {
    await ok(await staffPost("/provider-onboarding-configuration", { action: "transition_content", contentId: content.id, lifecycleAction, legalUseApproved: lifecycleAction === "approve" }), `content ${lifecycleAction}`);
  }
  return draft.id;
}

function quizQuestions() {
  return Array.from({ length: 20 }, (_, i) => ({
    questionId: `Q${i + 1}`,
    prompt: `Grooming safety scenario ${i + 1}?`,
    type: "multiple_choice",
    competency: "safety",
    correctAnswerId: "a",
    options: [{ id: "a", label: "Correct handling", value: "a" }, { id: "b", label: "Unsafe handling", value: "b" }],
  }));
}
const allCorrect = () => Object.fromEntries(quizQuestions().map((q) => [q.questionId, "a"]));

/*
 * IDfy is the ONLY way an automatable check (aadhaar, pan) can reach 'verified', and the activation
 * checklist hard-requires them. Its HTTP call is the one thing stubbed here - the adapter, its
 * fail-closed gate and every rule around it run for real.
 */
const IDFY_ENV = { IDFY_API_KEY: "uat-idfy-key-not-a-live-key", IDFY_ACCOUNT_ID: "uat-account", IDFY_URL: "https://idfy.invalid/v3/tasks" };
function stubIdfy(t) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(IDFY_ENV.IDFY_URL)) return Response.json({ request_id: `idfy-${Math.random().toString(16).slice(2)}`, status: "completed", result: { verification_status: "verified" } });
    return real(input, init);
  };
  t.after(() => { globalThis.fetch = real; });
}

async function fixture() {
  const { sqlite, db } = world("__W2F_ONBOARDING_DB__", "__W2F_ONBOARDING_DB___ENV", { PAWSPACE_MEDIA_BUCKET: bucket(), ...IDFY_ENV });
  const auth = await import("../lib/server-auth.ts");
  const { ensurePlatformSessionTables } = await import("../lib/platform-session.ts");
  await auth.ensureSecurityTables(db);
  await ensurePlatformSessionTables(db);
  await seedActors(sqlite, db, [{ id: "U-ONB", email: STAFF, role: "superuser" }]);
  const cookie = await providerSession(db, PROVIDER);
  return { sqlite, db, cookie };
}

// --------------------------------------------------------------------------------------------------
// The outcome: a caregiver goes from "no application" to "live on the service map".
// --------------------------------------------------------------------------------------------------

test("W2F-1 a caregiver completes onboarding end to end through the controls the screens expose", async (t) => {
  const { sqlite, cookie } = await fixture();
  stubIdfy(t);
  const { lifecycleActionFor } = await import("../app/team/provider-onboarding/page.tsx");

  await publishPolicyAndSla(null);

  // The Ops console authors and approves the 20-question qualification, then Control Center names it
  // on the live policy. Without both, no applicant is ever offered a quiz.
  const { quizDraftPayload, approvableQuizVersions } = await import("../app/team/provider-onboarding/page.tsx");
  const quiz = await ok(await staffPost("/provider-onboarding", { action: "create_quiz_draft", payload: quizDraftPayload({ verticalKey: "grooming", questions: quizQuestions() }) }), "create_quiz_draft");
  const pending = approvableQuizVersions((await ok(await staffGet("/provider-onboarding"), "ops snapshot")).quizVersions);
  assert.deepEqual(pending, [{ quizVersionId: quiz.id }], "the Ops screen must offer to approve the draft it just created");
  await ok(await staffPost("/provider-onboarding", { action: "approve_quiz", ...pending[0] }), "approve_quiz");
  await publishPolicyAndSla(quiz.id);

  // --- the applicant -----------------------------------------------------------------------------
  const empty = await partnerView(cookie);
  assert.equal(empty.controls.canStartApplication, true);
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application",
    payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;

  const draft = await partnerView(cookie);
  assert.equal(draft.controls.canUploadDocument, true, "the screen must offer a document control while the application is a draft");
  await ok(await partnerPost(cookie, {
    action: "upload_document", applicationId, documentType: "government_id", mimeType: "image/png", fileBase64: PNG.toString("base64"),
  }), "upload_document");
  await ok(await partnerPost(cookie, { action: "submit_application", applicationId }), "submit_application");

  // --- staff verification ------------------------------------------------------------------------
  const verification = await ok(await staffPost("/provider-onboarding", { action: "create_verification", applicationId, adapterKey: "not_connected", manualReviewRequired: true }), "create_verification");
  await ok(await staffPost("/provider-onboarding", { action: "clear_manual_verification", verificationId: verification.id, detail: { source: "staff_uat" } }), "clear_manual_verification");

  // The per-category KYC mandate, driven the way /team/provider-verification now drives it.
  const { verificationControlsFor } = await import("../app/team/provider-verification/page.tsx");
  const mandate = await ok(await staffGet(`/provider-verification?applicationId=${applicationId}&category=groomer`), "mandate lookup");
  assert.ok(mandate.checks.length, "the mandate must name what this vertical requires");
  for (const check of mandate.checks) {
    const [control] = verificationControlsFor(check);
    assert.ok(control, `/team/provider-verification must offer a way to clear ${check.verificationType}`);
    const run = await ok(await staffPost("/provider-verification", { ...control.payload, applicationId, category: "groomer" }), `clear ${check.verificationType}`);
    assert.equal(run.status, "verified", `${check.verificationType} must actually clear`);
  }
  assert.equal((await ok(await staffGet(`/provider-verification?applicationId=${applicationId}&category=groomer`), "mandate re-read")).canTakeAssignments, true);

  // --- the qualification the applicant can now see ------------------------------------------------
  const qualifying = await partnerView(cookie);
  assert.equal(qualifying.controls.canTakeQuiz, true, "the applicant must be offered the approved assessment frozen onto their application");
  const offered = qualifying.data.applications[0].quiz;
  assert.equal(offered.questions.length, 20);
  await ok(await partnerPost(cookie, { action: "score_quiz", applicationId, quizVersionId: offered.id, answers: allCorrect() }), "score_quiz");

  // --- the lifecycle move the Ops screen offers ---------------------------------------------------
  const status = sqlite.prepare("SELECT status FROM provider_onboarding_applications WHERE id=?").get(applicationId).status;
  const move = lifecycleActionFor(status);
  assert.ok(move, `the Ops screen must offer a lifecycle move from '${status}'`);
  assert.equal(move.action, "ready_for_interview");
  await ok(await staffPost("/provider-onboarding", { action: "transition_application", applicationId, applicationAction: move.action }), `transition_application ${move.action}`);

  const interview = await ok(await staffPost("/provider-onboarding", { action: "schedule_interview", applicationId, startAt: new Date(Date.now() + 86_400_000).toISOString(), opsEmail: STAFF }), "schedule_interview");
  await ok(await staffPost("/provider-onboarding", { action: "complete_interview", interviewId: interview.id, notes: "Completed the 15 minute UAT interview with the applicant." }), "complete_interview");
  await ok(await staffPost("/provider-onboarding", { action: "save_interview_ai_summary_draft", interviewId: interview.id, summary: "Handled the restraint scenario well; references check out." }), "save_interview_ai_summary_draft");
  await ok(await staffPost("/provider-onboarding", { action: "record_human_decision", interviewId: interview.id, decision: "approved", decisionNotes: "Approved after the UAT interview." }), "record_human_decision");

  // --- agreement, acceptance, profile --------------------------------------------------------------
  const agreement = await ok(await staffPost("/provider-onboarding", { action: "create_sla", applicationId, adapterKey: "not_connected" }), "create_sla");
  const awaiting = await partnerView(cookie);
  assert.equal(awaiting.controls.canAcceptAgreement, true);
  assert.equal(awaiting.controls.acceptAvailable, true);
  await ok(await partnerPost(cookie, { action: awaiting.controls.acceptAction, applicationId, agreementId: agreement.id }), `agreement acceptance (${awaiting.controls.acceptAction})`);

  const profiling = await partnerView(cookie);
  assert.equal(profiling.controls.canSaveProfile, true);
  assert.equal(profiling.controls.canAddMedia, true, "an applicant must be able to add the photos a policy can require");
  await ok(await partnerPost(cookie, {
    action: "save_profile", applicationId,
    payload: { displayName: "Asha R", businessName: "Asha Grooming", bio: "Gentle grooming", services: ["grooming"], serviceAreas: ["BLR"], languages: ["en"], businessDetails: { providerModel: "commission" }, packageDetails: [], facilityDetails: {}, references: [] },
  }), "save_profile");
  await ok(await partnerPost(cookie, { action: "add_profile_media", applicationId, mediaType: "provider_photo", mimeType: "image/png", fileBase64: PNG.toString("base64") }), "add_profile_media");

  // --- activation -----------------------------------------------------------------------------------
  const evaluation = await ok(await staffGet(`/provider-onboarding?mode=activation_evaluation&applicationId=${applicationId}`), "activation evaluation");
  assert.ok(evaluation.eligible, `every activation gate must be satisfiable through the product: ${JSON.stringify(evaluation.checks.filter((c) => !c.passed))}`);
  await ok(await staffPost("/provider-onboarding", { action: "activate_provider_uat", applicationId }), "activate_provider_uat");

  const providerId = sqlite.prepare("SELECT provider_id FROM provider_onboarding_applications WHERE id=?").get(applicationId).provider_id;
  await ok(await staffPost("/provider-onboarding", { action: "add_to_service_map", providerId, zoneIds: ["blr-east"] }), "add_to_service_map");

  const capacity = sqlite.prepare("SELECT live,status,services_json FROM provider_capacity_profiles WHERE id=?").get(providerId);
  assert.equal(Number(capacity.live), 1, "the caregiver must end the funnel actually live on the service map");
  assert.equal(capacity.status, "active");
  assert.deepEqual(JSON.parse(capacity.services_json), ["grooming"]);

  // --- and the post-activation edit is the governed one ---------------------------------------------
  const activated = await partnerView(cookie);
  assert.equal(activated.controls.canEditActivatedProfile, true, "an activated partner must have a governed way to correct their own profile");
  await ok(await partnerPost(cookie, { action: "update_activated_profile", applicationId, changes: { bio: "Gentle grooming for anxious dogs" }, reason: "corrected my bio" }), "update_activated_profile");
  const audit = sqlite.prepare("SELECT action,reason FROM provider_onboarding_profile_audit WHERE application_id=? ORDER BY created_at DESC LIMIT 1").get(applicationId);
  assert.equal(audit.reason, "corrected my bio", "the post-activation edit must be recorded with the reason the partner gave");
});

// --------------------------------------------------------------------------------------------------
// The stops, each on its own, so a regression names itself.
// --------------------------------------------------------------------------------------------------

test("W2F-1b with production e-sign configured, the screen posts the real signature action and it works", async (t) => {
  /*
   * `accept_sla_uat` is refused with a 409 wherever the deployment is production, and nothing told
   * /partner/onboarding which acceptance it was looking at - so it hard-coded the UAT one and a
   * production applicant could not accept their agreement at all. The screen now asks the server.
   */
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const b64 = async (format, key) => Buffer.from(await crypto.subtle.exportKey(format, key)).toString("base64");
  const { sqlite, cookie } = await fixture();
  stubIdfy(t);
  globalThis.__W2F_ONBOARDING_DB___ENV.PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64 = await b64("pkcs8", keys.privateKey);
  globalThis.__W2F_ONBOARDING_DB___ENV.PROVIDER_AGREEMENT_ESIGN_PUBLIC_KEY_SPKI_B64 = await b64("spki", keys.publicKey);
  globalThis.__W2F_ONBOARDING_DB___ENV.PROVIDER_AGREEMENT_ESIGN_KEY_ID = "w2f-uat-key";

  const { quizDraftPayload } = await import("../app/team/provider-onboarding/page.tsx");
  const { verificationControlsFor } = await import("../app/team/provider-verification/page.tsx");
  await publishPolicyAndSla(null);
  const quiz = await ok(await staffPost("/provider-onboarding", { action: "create_quiz_draft", payload: quizDraftPayload({ verticalKey: "grooming", questions: quizQuestions() }) }), "create_quiz_draft");
  await ok(await staffPost("/provider-onboarding", { action: "approve_quiz", quizVersionId: quiz.id }), "approve_quiz");
  await publishPolicyAndSla(quiz.id);

  const applicationId = (await ok(await partnerPost(cookie, { action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} } }), "create_application")).id;
  await ok(await partnerPost(cookie, { action: "upload_document", applicationId, documentType: "government_id", mimeType: "image/png", fileBase64: PNG.toString("base64") }), "upload_document");
  await ok(await partnerPost(cookie, { action: "submit_application", applicationId }), "submit_application");
  const verification = await ok(await staffPost("/provider-onboarding", { action: "create_verification", applicationId, adapterKey: "not_connected", manualReviewRequired: true }), "create_verification");
  await ok(await staffPost("/provider-onboarding", { action: "clear_manual_verification", verificationId: verification.id }), "clear_manual_verification");
  for (const check of (await ok(await staffGet(`/provider-verification?applicationId=${applicationId}&category=groomer`), "mandate")).checks) {
    await ok(await staffPost("/provider-verification", { ...verificationControlsFor(check)[0].payload, applicationId, category: "groomer" }), check.verificationType);
  }
  const offered = (await partnerView(cookie)).data.applications[0].quiz;
  await ok(await partnerPost(cookie, { action: "score_quiz", applicationId, quizVersionId: offered.id, answers: allCorrect() }), "score_quiz");
  await ok(await staffPost("/provider-onboarding", { action: "transition_application", applicationId, applicationAction: "ready_for_interview" }), "ready_for_interview");
  const interview = await ok(await staffPost("/provider-onboarding", { action: "schedule_interview", applicationId, startAt: new Date(Date.now() + 86_400_000).toISOString(), opsEmail: STAFF }), "schedule_interview");
  await ok(await staffPost("/provider-onboarding", { action: "complete_interview", interviewId: interview.id, notes: "Completed the 15 minute UAT interview." }), "complete_interview");
  await ok(await staffPost("/provider-onboarding", { action: "record_human_decision", interviewId: interview.id, decision: "approved", decisionNotes: "Approved after interview." }), "record_human_decision");
  const agreement = await ok(await staffPost("/provider-onboarding", { action: "create_sla", applicationId, adapterKey: "not_connected" }), "create_sla");

  const view = await partnerView(cookie);
  assert.equal(view.controls.acceptAction, "accept_sla", "with signing keys present the screen must post the real e-sign acceptance");
  assert.equal(view.controls.acceptAvailable, true);
  await ok(await partnerPost(cookie, { action: view.controls.acceptAction, applicationId, agreementId: agreement.id }), "production agreement acceptance");
  const signature = sqlite.prepare("SELECT key_id,algorithm,verified FROM provider_agreement_signatures WHERE agreement_id=?").get(agreement.id);
  assert.equal(signature.key_id, "w2f-uat-key", "the acceptance must be recorded with a real verified signature, not a UAT stub");
  assert.equal(Number(signature.verified), 1);
  assert.equal(sqlite.prepare("SELECT status FROM provider_onboarding_agreements WHERE id=?").get(agreement.id).status, "accepted");
});

test("W2F-2 an application cannot be submitted until its required document is on file", async (t) => {
  const { cookie } = await fixture();
  stubIdfy(t);
  await publishPolicyAndSla(null);
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;

  const blocked = await partnerPost(cookie, { action: "submit_application", applicationId });
  assert.equal(blocked.status, 409, "a missing document is the applicant's own state, not a server fault");
  assert.match((await blocked.json()).error, /government_id/, "and it must say which document is missing");

  // The screen offers the control that clears it, and clearing it clears the refusal.
  const { partnerOnboardingControls } = await import("../app/partner/onboarding/page.tsx");
  assert.equal(partnerOnboardingControls(await ok(await partnerGet(cookie), "snapshot")).canUploadDocument, true);
  await ok(await partnerPost(cookie, { action: "upload_document", applicationId, documentType: "government_id", mimeType: "image/png", fileBase64: PNG.toString("base64") }), "upload_document");
  await ok(await partnerPost(cookie, { action: "submit_application", applicationId }), "submit_application after upload");
});

test("W2F-3 the Control Center publishes activation requirements the evaluator can actually satisfy", async () => {
  const { ACTIVATION_REQUIREMENTS } = await import("../app/control/provider-onboarding/page.tsx");
  const source = await (await import("node:fs/promises")).readFile(new URL("../lib/provider-onboarding-human-activation.ts", import.meta.url), "utf8");
  assert.ok(ACTIVATION_REQUIREMENTS.length >= 5);
  for (const code of ACTIVATION_REQUIREMENTS) {
    assert.match(source, new RegExp(`check\\("${code}"`), `${code} must be a check evaluateProviderActivation computes, or it fails closed as unsupported_policy_requirement forever`);
  }
});

test("W2F-4 every onboarding business rule reaches the caller as a 4xx carrying its reason", async (t) => {
  const { cookie } = await fixture();
  stubIdfy(t);
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;

  const refusals = [
    ["staff", { action: "transition_application", applicationId, applicationAction: "ready_for_interview" }, 409, /Quiz must be completed before interview/],
    ["staff", { action: "create_verification", applicationId, adapterKey: "not_connected" }, 409, /must be submitted before verification/],
    ["staff", { action: "approve_quiz", quizVersionId: "POQUIZ-NOPE" }, 409, /20-question draft/],
    ["staff", { action: "create_quiz_draft", payload: { verticalKey: "grooming", questions: [] } }, 400, /exactly 20 questions/],
    ["staff", { action: "schedule_interview", applicationId, startAt: new Date(Date.now() + 8.64e7).toISOString(), opsEmail: STAFF }, 409, /ready for interview scheduling/],
    ["staff", { action: "create_sla", applicationId }, 409, /human approval is required/i],
    ["staff", { action: "activate_provider_uat", applicationId }, 409, /Activation checklist is blocked/],
    ["staff", { action: "add_to_service_map", providerId: "PROV-NOPE", zoneIds: ["blr-east"] }, 404, /activate the provider first/],
    ["partner", { action: "save_profile", applicationId, payload: { displayName: "A", businessName: "B" } }, 409, /Human approval is required/],
    ["partner", { action: "update_activated_profile", applicationId, changes: { bio: "x" }, reason: "correcting" }, 409, /activated UAT provider/],
    ["partner", { action: "submit_application", applicationId: "POAPP-NOPE" }, 404, /Application not found/],
  ];
  for (const [who, payload, status, reason] of refusals) {
    const response = who === "staff" ? await staffPost("/provider-onboarding", payload) : await partnerPost(cookie, payload);
    const body = await response.json();
    assert.equal(response.status, status, `${payload.action} must be ${status}, got ${response.status}: ${JSON.stringify(body)}`);
    assert.match(String(body.error), reason, `${payload.action} must carry its own reason, not a redacted fallback`);
  }
});

test("W2F-5 the KYC mandate is clearable from the product, and IDfy still decides the automatable checks", async (t) => {
  const { cookie } = await fixture();
  stubIdfy(t);
  await publishPolicyAndSla(null);
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;

  // A manual outcome may not be forged onto an automatable check.
  const forged = await staffPost("/provider-verification", { action: "record_manual", applicationId, verificationType: "aadhaar", status: "verified" });
  assert.equal(forged.status, 409, "an automatable check must not be recordable by hand");
  assert.match((await forged.json()).error, /IDfy/, "and the operator must be told what to press instead");

  const { verificationControlsFor } = await import("../app/team/provider-verification/page.tsx");
  const before = await ok(await staffGet(`/provider-verification?applicationId=${applicationId}&category=groomer`), "mandate before");
  assert.equal(before.canTakeAssignments, false);
  for (const check of before.checks) {
    const [control] = verificationControlsFor(check);
    assert.ok(control, `the screen must offer a control for the outstanding ${check.verificationType}`);
    await ok(await staffPost("/provider-verification", { ...control.payload, applicationId, category: "groomer" }), check.verificationType);
  }
  assert.deepEqual(verificationControlsFor({ verificationType: "aadhaar", status: "verified", automatable: true }), [], "a cleared check offers nothing further");
  assert.equal((await ok(await staffGet(`/provider-verification?applicationId=${applicationId}&category=groomer`), "mandate after")).canTakeAssignments, true);
});
