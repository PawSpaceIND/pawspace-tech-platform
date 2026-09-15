/*
 * Can a partner get through the funnel, and get paid, on a deployment that has NOT provisioned its
 * optional third-party bindings?
 *
 * tests/w2f-provider-onboarding-funnel.test.mjs proves the funnel works when R2 and IDfy are both
 * present. Every deployment of this platform so far has had neither: no `r2_buckets` binding exists
 * in wrangler.toml or wrangler.e2e.toml, and IDfy has never been connected. This suite runs the SAME
 * real routes with those bindings absent, which is the configuration a runtime audit measured, and
 * asserts the three outcomes that were unreachable there:
 *
 *   B1  the applicant is told document upload is not switched on yet, in a governed refusal, and is
 *       never shown the name of an internal storage binding;
 *   B2  a provider can still be verified and ACTIVATED - by an explicitly attested, audited offline
 *       verification that is recorded as not-automated and carries the identity of the human who
 *       recorded it - and ends the funnel live on the service map;
 *   B3  a completed job's payment request answers the same governed configuration refusal the staff
 *       action already answers, instead of an anonymous 500.
 *
 * Every decision is taken from the screens' own exported predicates, so a screen that stops offering
 * a control fails this suite rather than passing it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__R3B_FUNNEL_DB__");

const STAFF = "r3b.ops@pawspace.in";
const PROVIDER = "prv_r3b_applicant";
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
    subjectType: "provider", subjectId: providerId, actorId: "test", reason: "r3b unprovisioned funnel fixture",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp", principalType: "identity_subject",
    principalKey: `uat-provider:${providerId}`, subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const staffPost = async (path, body, who = STAFF) => {
  const { POST } = await import(`../app/api${path}/route.ts`);
  return POST(new Request(`${ORIGIN}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": who },
    body: JSON.stringify(body),
  }));
};
const staffGet = async (path, who = STAFF) => {
  const { GET } = await import(`../app/api${path.split("?")[0]}/route.ts`);
  return GET(new Request(`${ORIGIN}/api${path}`, { headers: { "oai-authenticated-user-email": who } }));
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
const partnerView = async (cookie) => {
  const { partnerOnboardingControls } = await import("../app/partner/onboarding/page.tsx");
  const data = await ok(await partnerGet(cookie), "self-service snapshot");
  return { data, controls: partnerOnboardingControls(data) };
};

async function publishPolicyAndSla(quizVersionRef, who = STAFF) {
  const { policyDraftPayload } = await import("../app/control/provider-onboarding/page.tsx");
  const draft = await ok(await staffPost("/provider-onboarding-configuration", {
    action: "create_policy_draft",
    payload: policyDraftPayload({ verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", slaTemplateRef: "provider-sla" }, quizVersionRef || ""),
  }, who), "policy draft");
  for (const lifecycleAction of ["submit_review", "approve", "activate"]) {
    await ok(await staffPost("/provider-onboarding-configuration", { action: "transition_policy", policyId: draft.id, lifecycleAction }, who), `policy ${lifecycleAction}`);
  }
  const content = await ok(await staffPost("/provider-onboarding-configuration", {
    action: "create_content_draft",
    payload: { contentKey: "provider-sla", localeCode: "en", contentType: "legal", contentText: "PawSpace provider UAT service agreement.", aiAssisted: false },
  }, who), "legal content draft");
  for (const lifecycleAction of ["submit_review", "approve", "activate"]) {
    await ok(await staffPost("/provider-onboarding-configuration", { action: "transition_content", contentId: content.id, lifecycleAction, legalUseApproved: lifecycleAction === "approve" }, who), `content ${lifecycleAction}`);
  }
  return draft.id;
}

function quizQuestions() {
  return Array.from({ length: 20 }, (_, i) => ({
    questionId: `Q${i + 1}`, prompt: `Grooming safety scenario ${i + 1}?`, type: "multiple_choice", competency: "safety",
    correctAnswerId: "a", options: [{ id: "a", label: "Correct handling", value: "a" }, { id: "b", label: "Unsafe handling", value: "b" }],
  }));
}
const allCorrect = () => Object.fromEntries(quizQuestions().map((q) => [q.questionId, "a"]));

/**
 * A deployment with NO optional bindings: no R2 bucket, no IDfy keys, no Razorpay sandbox keys.
 * `storage` opts a single test back into R2 so it can walk past the document step.
 */
async function fixture({ storage = false, actors = [{ id: "U-R3B", email: STAFF, role: "superuser" }] } = {}) {
  // PAWSPACE_PAYMENT_ENV is declared - sandbox is switched on - and the API KEYS are the thing absent,
  // which is exactly the deployment the audit measured.
  const env = { PAWSPACE_PAYMENT_ENV: "sandbox", ...(storage ? { PAWSPACE_MEDIA_BUCKET: bucket() } : {}) };
  const { sqlite, db } = world("__R3B_FUNNEL_DB__", "__R3B_FUNNEL_DB___ENV", env);
  const auth = await import("../lib/server-auth.ts");
  const { ensurePlatformSessionTables } = await import("../lib/platform-session.ts");
  await auth.ensureSecurityTables(db);
  await ensurePlatformSessionTables(db);
  await seedActors(sqlite, db, actors);
  const cookie = await providerSession(db, PROVIDER);
  return { sqlite, db, cookie };
}

// --------------------------------------------------------------------------------------------------
// B1 - an unprovisioned bucket is a configuration state, not a server fault.
// --------------------------------------------------------------------------------------------------

test("R3B-1 with no document storage provisioned, the applicant gets a governed refusal that never names a binding", async () => {
  const { sqlite, cookie } = await fixture();
  await publishPolicyAndSla(null);
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;

  const refused = await partnerPost(cookie, { action: "upload_document", applicationId, documentType: "government_id", mimeType: "image/png", fileBase64: PNG.toString("base64") });
  const body = await refused.json();
  assert.ok(refused.status >= 400 && refused.status < 600 && refused.status !== 500,
    `an unprovisioned bucket is a configuration state, not a server fault - got ${refused.status}: ${JSON.stringify(body)}`);
  const shown = JSON.stringify(body);
  assert.doesNotMatch(shown, /PAWSPACE_MEDIA_BUCKET/, "an applicant must never be shown the name of an internal storage binding");
  assert.doesNotMatch(shown, /r2|bucket|binding/i, "nor any other internal storage vocabulary");
  assert.match(String(body.detail || body.error), /not available yet/i, "the applicant must be told upload is not switched on yet");
  assert.match(String(body.detail || body.error), /contact you/i, "and that somebody will come back to them");

  // The screen must not offer a control that cannot work, and must say why.
  const view = await partnerView(cookie);
  assert.equal(view.data.documentUpload.available, false, "the snapshot must report document upload as unavailable");
  assert.equal(view.controls.canUploadDocument, false, "the screen must not offer an upload button that can only fail");
  assert.match(String(view.controls.documentUploadNotice), /not available yet/i, "and must explain the standing state instead");

  // The refusal is recorded against the application, so an operator can see it happened.
  const audited = sqlite.prepare("SELECT outcome,detail_json FROM security_audit_events WHERE action='provider.onboarding.self_service.upload_document' ORDER BY created_at DESC LIMIT 1").get();
  assert.ok(audited, "the refusal must be audited");
  assert.equal(audited.outcome, "denied");

  // And the operator - who holds settings.manage - is told exactly what to provision.
  const configuration = await ok(await staffGet("/provider-onboarding-configuration"), "configuration snapshot");
  assert.equal(configuration.documentStorage.configured, false);
  assert.equal(configuration.documentStorage.requiredBinding, "PAWSPACE_MEDIA_BUCKET",
    "the staff-only configuration surface is where the binding to provision is named");
});

test("R3B-1a the storage boundary itself never puts a binding name in a thrown message", async () => {
  /*
   * The route refuses before reaching this function, so route-level sabotage alone leaves this layer
   * untested - and it is the layer that actually produced the sentence the applicant read. Asserted
   * directly, so the defence in depth is real rather than decorative.
   */
  const uploader = await import("../lib/provider-document-secure-upload.ts");
  assert.equal(uploader.providerDocumentStorageConfigured({}), false);
  assert.equal(uploader.providerDocumentStorageConfigured({ PAWSPACE_MEDIA_BUCKET: bucket() }), true);
  await assert.rejects(
    () => uploader.storeProviderDocumentSecurely({}, { applicationId: "POAPP-X", documentType: "government_id", mimeType: "image/png", fileBase64: PNG.toString("base64") }),
    (error) => {
      assert.doesNotMatch(error.message, /PAWSPACE_MEDIA_BUCKET/, "the thrown message must not carry an internal binding name");
      assert.doesNotMatch(error.message, /binding|bucket|r2/i);
      assert.match(error.message, /not available yet/i);
      return true;
    },
  );
  // The operator-facing constant is where the binding is named, and it is only read by staff surfaces.
  assert.equal(uploader.PROVIDER_DOCUMENT_STORAGE_BINDING, "PAWSPACE_MEDIA_BUCKET");
  assert.match(uploader.PROVIDER_DOCUMENT_STORAGE_OPERATOR_NOTE, /PAWSPACE_MEDIA_BUCKET/);
});

test("R3B-1b the identity document is NOT waived because storage is missing - the funnel stops, explicitly", async () => {
  const { cookie } = await fixture();
  await publishPolicyAndSla(null);
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;
  const blocked = await partnerPost(cookie, { action: "submit_application", applicationId });
  assert.equal(blocked.status, 409, "a missing government ID is still the applicant's own state");
  const reason = String((await blocked.json()).error);
  assert.match(reason, /government_id/, "it must still name the document the policy requires");
  assert.match(reason, /not available yet/i, "and, on a deployment with no storage, say why it cannot be supplied right now");
  assert.doesNotMatch(reason, /PAWSPACE_MEDIA_BUCKET/);
});

// --------------------------------------------------------------------------------------------------
// B2 - a provider can be verified and activated on a deployment with no IDfy.
// --------------------------------------------------------------------------------------------------

test("R3B-2 with IDfy not connected a provider reaches 'verified' and goes live, by attested offline verification", async () => {
  const { sqlite, cookie } = await fixture({ storage: true });
  const { lifecycleActionFor, quizDraftPayload } = await import("../app/team/provider-onboarding/page.tsx");
  const { verificationControlsFor } = await import("../app/team/provider-verification/page.tsx");

  await publishPolicyAndSla(null);
  const quiz = await ok(await staffPost("/provider-onboarding", { action: "create_quiz_draft", payload: quizDraftPayload({ verticalKey: "grooming", questions: quizQuestions() }) }), "create_quiz_draft");
  await ok(await staffPost("/provider-onboarding", { action: "approve_quiz", quizVersionId: quiz.id }), "approve_quiz");
  await publishPolicyAndSla(quiz.id);

  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;
  await ok(await partnerPost(cookie, { action: "upload_document", applicationId, documentType: "government_id", mimeType: "image/png", fileBase64: PNG.toString("base64") }), "upload_document");
  await ok(await partnerPost(cookie, { action: "submit_application", applicationId }), "submit_application");
  const verification = await ok(await staffPost("/provider-onboarding", { action: "create_verification", applicationId, adapterKey: "not_connected", manualReviewRequired: true }), "create_verification");
  await ok(await staffPost("/provider-onboarding", { action: "clear_manual_verification", verificationId: verification.id }), "clear_manual_verification");

  // The screen knows IDfy is not connected, because the route reports the capability (never the keys).
  const snapshot = await ok(await staffGet("/provider-verification"), "mandate snapshot");
  assert.equal(snapshot.idfyConnected, false, "the screen must be told automation is unavailable");

  // Running the automatable check through IDfy is still fail-closed: it does not pass itself.
  const attempted = await ok(await staffPost("/provider-verification", { action: "run", applicationId, category: "groomer", verificationType: "aadhaar" }), "run aadhaar via IDfy");
  assert.equal(attempted.status, "pending", "with IDfy absent an automatable check must never auto-pass");

  const before = await ok(await staffGet(`/provider-verification?applicationId=${applicationId}&category=groomer`), "mandate before");
  assert.equal(before.canTakeAssignments, false);
  for (const check of before.checks) {
    const controls = verificationControlsFor(check, { idfyConnected: false });
    const control = controls.find((c) => /verified/i.test(c.label));
    assert.ok(control, `the screen must offer a way to clear ${check.verificationType} when IDfy is absent`);
    // The evidence sentence is the operator's own input; the screen refuses to invent one for them.
    const payload = control.requiresNote ? { ...control.payload, note: `Saw the original ${check.verificationType} document in person at the Indiranagar hub.` } : control.payload;
    const run = await ok(await staffPost("/provider-verification", { ...payload, applicationId, category: "groomer" }), `clear ${check.verificationType}`);
    assert.equal(run.status, "verified", `${check.verificationType} must actually clear`);
  }
  const after = await ok(await staffGet(`/provider-verification?applicationId=${applicationId}&category=groomer`), "mandate after");
  assert.equal(after.canTakeAssignments, true, "every mandated check must be clearable without IDfy");

  // The record says, in the database, that a human decided this and which human.
  const row = sqlite.prepare("SELECT status,automated,updated_by,detail_json,verified_at FROM provider_verifications WHERE application_id=? AND verification_type='aadhaar'").get(applicationId);
  assert.equal(row.status, "verified");
  assert.equal(Number(row.automated), 0, "an offline attestation must never be recorded as automated");
  assert.equal(row.updated_by, STAFF, "the identity of the person who recorded it is the point");
  const detail = JSON.parse(row.detail_json);
  assert.equal(detail.offlineAttested, true, "and the record must be explicit that automation did not decide it");
  assert.ok(String(detail.note || "").length >= 8, "an attestation with no stated evidence is not an attestation");
  assert.ok(Number(row.verified_at) > 0);
  // The mandate view carries it forward, so nobody reads this as an IDfy pass.
  const aadhaar = after.checks.find((c) => c.verificationType === "aadhaar");
  assert.equal(aadhaar.automated, false);
  assert.equal(aadhaar.offlineAttested, true);

  // --- the rest of the funnel, and the outcome ----------------------------------------------------
  const offered = (await partnerView(cookie)).data.applications[0].quiz;
  await ok(await partnerPost(cookie, { action: "score_quiz", applicationId, quizVersionId: offered.id, answers: allCorrect() }), "score_quiz");
  const move = lifecycleActionFor(sqlite.prepare("SELECT status FROM provider_onboarding_applications WHERE id=?").get(applicationId).status);
  await ok(await staffPost("/provider-onboarding", { action: "transition_application", applicationId, applicationAction: move.action }), "ready_for_interview");
  const interview = await ok(await staffPost("/provider-onboarding", { action: "schedule_interview", applicationId, startAt: new Date(Date.now() + 86_400_000).toISOString(), opsEmail: STAFF }), "schedule_interview");
  await ok(await staffPost("/provider-onboarding", { action: "complete_interview", interviewId: interview.id, notes: "Completed the 15 minute UAT interview." }), "complete_interview");
  await ok(await staffPost("/provider-onboarding", { action: "record_human_decision", interviewId: interview.id, decision: "approved", decisionNotes: "Approved after interview." }), "record_human_decision");
  const agreement = await ok(await staffPost("/provider-onboarding", { action: "create_sla", applicationId, adapterKey: "not_connected" }), "create_sla");
  const awaiting = await partnerView(cookie);
  await ok(await partnerPost(cookie, { action: awaiting.controls.acceptAction, applicationId, agreementId: agreement.id }), "agreement acceptance");
  await ok(await partnerPost(cookie, {
    action: "save_profile", applicationId,
    payload: { displayName: "Asha R", businessName: "Asha Grooming", bio: "Gentle grooming", services: ["grooming"], serviceAreas: ["BLR"], languages: ["en"], businessDetails: { providerModel: "commission" }, packageDetails: [], facilityDetails: {}, references: [] },
  }), "save_profile");
  await ok(await partnerPost(cookie, { action: "add_profile_media", applicationId, mediaType: "provider_photo", mimeType: "image/png", fileBase64: PNG.toString("base64") }), "add_profile_media");

  const evaluation = await ok(await staffGet(`/provider-onboarding?mode=activation_evaluation&applicationId=${applicationId}`), "activation evaluation");
  assert.ok(evaluation.eligible, `activation must be reachable without IDfy: ${JSON.stringify(evaluation.checks.filter((c) => !c.passed))}`);
  await ok(await staffPost("/provider-onboarding", { action: "activate_provider_uat", applicationId }), "activate_provider_uat");
  const providerId = sqlite.prepare("SELECT provider_id FROM provider_onboarding_applications WHERE id=?").get(applicationId).provider_id;
  await ok(await staffPost("/provider-onboarding", { action: "add_to_service_map", providerId, zoneIds: ["blr-east"] }), "add_to_service_map");
  const capacity = sqlite.prepare("SELECT live,status FROM provider_capacity_profiles WHERE id=?").get(providerId);
  assert.equal(Number(capacity.live), 1, "the provider must end the funnel actually live on the service map");

  // --- B7: the post-activation profile edit must not overwrite real zones with a city code ---------
  // The partner form fills serviceAreas with the CITY CODE. That value reached zones_json unchecked,
  // which is what loadGovernedProviders matches on - so one edit removed the provider from matching
  // with nothing reported to anybody.
  const badZone = await partnerPost(cookie, {
    action: "update_activated_profile", applicationId,
    changes: { serviceAreas: ["BLR"] }, reason: "correcting my service area",
  });
  assert.equal(badZone.status, 400, "a city code is not a zone id and must be refused, not silently written");
  assert.match(String((await badZone.json()).error), /zone/i, "and the caller must be told what a service area is");
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT zones_json FROM provider_capacity_profiles WHERE id=?").get(providerId).zones_json), ["blr-east"],
    "a refused edit must leave the real zone ids exactly as they were");
  assert.equal(Number(sqlite.prepare("SELECT live FROM provider_capacity_profiles WHERE id=?").get(providerId).live), 1,
    "and must not take a live provider off the map on its way out");

  // A cosmetic edit still works, and a real zone id still moves the provider.
  await ok(await partnerPost(cookie, { action: "update_activated_profile", applicationId, changes: { bio: "Gentle grooming for anxious dogs" }, reason: "corrected my bio" }), "cosmetic edit");
  await ok(await partnerPost(cookie, { action: "update_activated_profile", applicationId, changes: { serviceAreas: ["blr-west"] }, reason: "I moved across the city" }), "real zone edit");
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT zones_json FROM provider_capacity_profiles WHERE id=?").get(providerId).zones_json), ["blr-west"],
    "a real zone id is still accepted");
});

test("R3B-2b an offline attestation is refused where IDfy IS connected, and record_manual still refuses automatable checks", async (t) => {
  const { cookie } = await fixture({ storage: true });
  const IDFY = { IDFY_API_KEY: "uat-idfy-key-not-a-live-key", IDFY_ACCOUNT_ID: "uat-account", IDFY_URL: "https://idfy.invalid/v3/tasks" };
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(IDFY.IDFY_URL)) return Response.json({ request_id: "idfy-x", status: "completed", result: { verification_status: "verified" } });
    return real(input, init);
  };
  t.after(() => { globalThis.fetch = real; });

  await publishPolicyAndSla(null);
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;

  // The forged-manual rule is unchanged: an automatable check may not be hand-recorded as ordinary work.
  const forged = await staffPost("/provider-verification", { action: "record_manual", applicationId, verificationType: "aadhaar", status: "verified" });
  assert.equal(forged.status, 409);
  assert.match((await forged.json()).error, /IDfy/);

  Object.assign(globalThis.__R3B_FUNNEL_DB___ENV, IDFY);
  const refused = await staffPost("/provider-verification", {
    action: "record_offline_verification", applicationId, category: "groomer", verificationType: "aadhaar",
    status: "verified", note: "Saw the original Aadhaar card in person on 2026-09-15.",
  });
  assert.equal(refused.status, 409, "where automation exists, a human may not bypass it");
  assert.match((await refused.json()).error, /IDfy/, "and must be told to use it");

  // A bare attestation with no stated evidence is refused even where IDfy is absent.
  for (const key of Object.keys(IDFY)) delete globalThis.__R3B_FUNNEL_DB___ENV[key];
  const bare = await staffPost("/provider-verification", {
    action: "record_offline_verification", applicationId, category: "groomer", verificationType: "aadhaar", status: "verified", note: "ok",
  });
  assert.equal(bare.status, 400);
  assert.match((await bare.json()).error, /evidence|note/i);
});

// --------------------------------------------------------------------------------------------------
// B3 - a completed job's payment request answers the same governed configuration refusal.
// --------------------------------------------------------------------------------------------------

test("R3B-3 the partner payment request reports configuration, not a server fault, when Razorpay sandbox keys are absent", async () => {
  const { sqlite, db } = await fixture();
  const bookingId = "BK-R3B-1";
  const { ensurePaymentReconciliationTables } = await import("../lib/grooming-payment-reconciliation.ts");
  await ensurePaymentReconciliationTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,status TEXT,provider_id TEXT,customer_id TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,currency TEXT,status TEXT,mode TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,status,provider_id,customer_id) VALUES (?,?,?,?)").run(bookingId, "completed", PROVIDER, "cus_r3b");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,amount,currency,status,mode) VALUES (?,?,?,?,?,?)").run("PAY-R3B-1", bookingId, 1349, "INR", "pending", "pay_after_service");
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id) VALUES (?,?,?)").run("WO-R3B-1", bookingId, PROVIDER);

  const { POST } = await import("../app/api/grooming-payment-sandbox/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/grooming-payment-sandbox`, {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": STAFF },
    body: JSON.stringify({ action: "request_after_service", bookingId }),
  }));
  const body = await response.json();
  assert.equal(response.status, 503, `missing gateway credentials is a configuration state: got ${response.status} ${JSON.stringify(body)}`);
  assert.equal(body.error, "configuration_required", "the partner path must answer with the same code the staff path already uses");
  assert.match(String(body.detail), /\S/, "and say what is missing, in words");
  assert.doesNotMatch(JSON.stringify(body), /RAZORPAY_KEY_SECRET|secret/i, "without naming a credential to a partner");
});

// --------------------------------------------------------------------------------------------------
// B4 - the funnel is closed until somebody publishes a policy, and only the founder could.
// --------------------------------------------------------------------------------------------------

test("R3B-4 an admin - not only the founder - can publish the onboarding policy that opens the funnel", async () => {
  const ADMIN = "r3b.admin@pawspace.in";
  const MANAGER = "r3b.manager@pawspace.in";
  const { cookie } = await fixture({ storage: true, actors: [
    { id: "U-R3B-ADMIN", email: ADMIN, role: "admin" },
    { id: "U-R3B-MANAGER", email: MANAGER, role: "manager" },
  ] });

  // Before any policy exists the applicant is refused, readably, and told nothing is wrong with them.
  const applicationId = (await ok(await partnerPost(cookie, {
    action: "create_application", payload: { verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", basicInfo: {} },
  }), "create_application")).id;
  const closed = await partnerPost(cookie, { action: "submit_application", applicationId });
  assert.equal(closed.status, 409);
  assert.match(String((await closed.json()).error), /not accepting caregiver applications/i);

  // An admin can now read and publish it. Both are settings.manage; before the permission change only
  // founder/superuser held that, so a real deployment had exactly one person who could open the funnel.
  const snapshot = await staffGet("/provider-onboarding-configuration", ADMIN);
  assert.equal(snapshot.status, 200, `an admin must be able to open the Control Center configuration: ${await snapshot.clone().text()}`);
  await publishPolicyAndSla(null, ADMIN);
  await ok(await partnerPost(cookie, { action: "upload_document", applicationId, documentType: "government_id", mimeType: "image/png", fileBase64: PNG.toString("base64") }), "upload_document");
  await ok(await partnerPost(cookie, { action: "submit_application", applicationId }), "submit_application once an admin has published a policy");

  // The Ops console behind /team/provider-onboarding is the same permission, so the admin can work it.
  assert.equal((await staffGet("/provider-onboarding", ADMIN)).status, 200, "an admin must be able to work the onboarding control room");
  // And the KYC screen is providers.manage, which a manager holds too.
  assert.equal((await staffGet("/provider-verification", MANAGER)).status, 200, "a manager must be able to work the KYC mandate");
  // A manager still cannot publish policy or work the control room - settings.manage is not theirs.
  assert.equal((await staffGet("/provider-onboarding-configuration", MANAGER)).status, 403, "publishing onboarding policy stays settings.manage");
  assert.equal((await staffGet("/provider-onboarding", MANAGER)).status, 403);
});

// --------------------------------------------------------------------------------------------------
// B5 - a finance control reported as a server fault teaches an operator nothing.
// --------------------------------------------------------------------------------------------------

test("R3B-5 commercial-terms refusals reach the finance operator as 4xx carrying their reason", async () => {
  const DRAFTER = "r3b.finance.maker@pawspace.in";
  const CHECKER_EMAIL = "r3b.finance.checker@pawspace.in";
  await fixture({ actors: [
    { id: "U-R3B-FIN1", email: DRAFTER, role: "superuser" },
    { id: "U-R3B-FIN2", email: CHECKER_EMAIL, role: "superuser" },
  ] });

  // A percentage where a fraction is required. The field is called providerSharePct, so 80 is the
  // obvious thing to send - and the sentence that says otherwise was being thrown away with a 500.
  const percent = await staffPost("/provider-commercial-terms", {
    action: "save_term", serviceCode: "boarding", engagementModel: "commission_standard",
    providerSharePct: 80, effectiveFrom: "2026-01-01", reason: "Boarding standard split",
  }, DRAFTER);
  assert.equal(percent.status, 400, `a bad input is the caller's, not the server's: got ${percent.status}`);
  const percentBody = String((await percent.json()).error);
  assert.match(percentBody, /fraction between 0 and 1/, "the operator must learn the format");
  assert.match(percentBody, /80/, "and see what they actually sent");

  const term = await ok(await staffPost("/provider-commercial-terms", {
    action: "save_term", serviceCode: "boarding", engagementModel: "commission_standard",
    providerSharePct: 0.7, effectiveFrom: "2026-01-01", reason: "Boarding standard split",
  }, DRAFTER), "save_term with a fraction");

  // Maker/checker is a working control, and was being reported as a platform outage.
  const selfActivate = await staffPost("/provider-commercial-terms", { action: "activate_term", termId: term.id, approvalReference: "FIN-2026-01" }, DRAFTER);
  assert.equal(selfActivate.status, 409, `a governance control is a 409, not a 500: got ${selfActivate.status}`);
  assert.match(String((await selfActivate.json()).error), /drafter cannot activate their own commercial term/);

  // And the control is satisfiable: a second approver activates it.
  await ok(await staffPost("/provider-commercial-terms", { action: "activate_term", termId: term.id, approvalReference: "FIN-2026-01" }, CHECKER_EMAIL), "activation by a second approver");
});

// --------------------------------------------------------------------------------------------------
// B6 - /partner/rates is empty until Finance publishes a term. It must not blame the partner for that.
// --------------------------------------------------------------------------------------------------

test("R3B-6 the empty rates screen names the missing agreement rather than the partner's eligibility", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: PartnerRates } = await import("../app/partner/rates/page.tsx");
  const html = renderToStaticMarkup(React.createElement(PartnerRates));
  assert.match(html, /nothing for you to price yet/i, "the empty state must describe the platform's state");
  assert.match(html, /ask the PawSpace team/i, "and give the partner somewhere to go");
  assert.doesNotMatch(html, /Only active commission Boarding\/Sitting partners can set rates/,
    "an unpublished commercial agreement is not the partner failing an eligibility test");
});
