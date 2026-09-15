/*
 * Three P1 defects that each killed a screen, executed against a real database rather than asserted
 * against source text.
 *
 *   A. /control "Approvals"        GET ?mode=approvals -> 500. buildControlCenterOperations selected
 *                                  board_approvals.status, a column that has never existed on that
 *                                  table (lib/statutory-compliance.ts owns its only definition).
 *                                  count() swallowed it and showed "n/c"; recent() had no guard, so
 *                                  the D1 error escaped and the whole tab - including four correct
 *                                  cards - rendered as an error string.
 *
 *   B. /team/provider-onboarding   "Clear to verified" could never succeed on a verification the
 *                                  console had just created: the row was written with a hardcoded
 *                                  status of 'not_connected' while binding manual_review_required=1,
 *                                  and the clear gates on the status. The refusal was a bare Error,
 *                                  so the operator got a 500 with the reason discarded.
 *
 *   C. /team/provider-onboarding   "Evaluate current application" 500'd for every application:
 *                                  pinnedPolicy() threw when policy_ref was null, and policy_ref is
 *                                  null for every application created while no policy is active.
 *
 * Every test below drives the real exported functions over node:sqlite through the shared D1 shim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const { buildControlCenterOperations } = await importLibModule("control-center-operations");
const { ensureStatutoryTables } = await importLibModule("statutory-compliance");
const { ensureProviderOnboardingTransactional, createVerification, clearManualVerificationReview } =
  await importLibModule("provider-onboarding-transactional");
const { evaluateProviderActivation } = await importLibModule("provider-onboarding-human-activation");
const { ensureProviderOnboardingConfiguration } = await importLibModule("provider-onboarding-configuration");
/* The same module instance the library throws from - governance is object identity in a WeakSet,
 * so importing a second copy would report every response as ungoverned. */
const { isGovernedHttpError } = await importLibModule("governed-http-error");

const MODES = ["approvals", "master", "inventory", "quality", "security", "health", "audit"];

/** Exactly what app/api/control-center-operations/route.ts does once the actor is authorized. */
async function callControlCenter(db, mode) {
  try {
    return { status: 200, body: { data: await buildControlCenterOperations(db, mode) } };
  } catch (error) {
    return { status: 500, body: { error: "Unable to load Control Center operations" }, error };
  }
}

const cardFor = (payload, label) => payload.cards.find((c) => c.label === label);

function boardApproval(sqlite, { id, period }) {
  sqlite.prepare(
    "INSERT INTO board_approvals (id,period,resolution_type,approved_by,approver_role,minutes_reference,resolution_text,approved_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, period, "monthly_accounts", "founder@pawspace.in", "director", `MIN-${period}`, "Accounts approved.", Date.now(), Date.now());
}

// --- A. the Approvals tab -----------------------------------------------------------------------

test("A1: approvals returns 200 against the canonical board_approvals schema (it used to be a 500)", async () => {
  const { sqlite, db } = freshCountingD1();
  await ensureStatutoryTables(db);
  boardApproval(sqlite, { id: "BA-1", period: "2026-07" });
  boardApproval(sqlite, { id: "BA-2", period: "2026-08" });

  const response = await callControlCenter(db, "approvals");
  assert.equal(response.status, 200, `approvals still throws: ${response.error?.message ?? ""}`);
  assert.equal(response.body.data.mode, "approvals");
});

test("A2: the Board card reports what the ledger actually holds, not a pending state it does not model", async () => {
  const { sqlite, db } = freshCountingD1();
  await ensureStatutoryTables(db);
  boardApproval(sqlite, { id: "BA-1", period: "2026-07" });
  boardApproval(sqlite, { id: "BA-2", period: "2026-08" });

  const { body } = await callControlCenter(db, "approvals");
  const board = cardFor(body.data, "Board");
  assert.equal(board.value, 2, "the card must count the rows that are there");
  assert.equal(board.connected, true, "a table that exists and answers must not read as not connected");
  assert.doesNotMatch(board.detail, /open board decision/i,
    "board_approvals records approvals that already happened - it has no open/pending column to filter on");
});

test("A3: the evidence rows carry real board resolutions", async () => {
  const { sqlite, db } = freshCountingD1();
  await ensureStatutoryTables(db);
  boardApproval(sqlite, { id: "BA-1", period: "2026-07" });

  const { body } = await callControlCenter(db, "approvals");
  assert.equal(body.data.rows.length, 1);
  const row = body.data.rows[0];
  assert.equal(row.period, "2026-07");
  assert.equal(row.resolution_type, "monthly_accounts");
  assert.equal(row.approver_role, "director");
  assert.ok(!("status" in row), "selecting a column board_approvals does not have is what caused the 500");
});

test("A4: every other card still answers, so one broken source cannot hide four working ones", async () => {
  const { db } = freshCountingD1();
  await ensureStatutoryTables(db);
  const { body } = await callControlCenter(db, "approvals");
  for (const label of ["Board", "Payments", "Partner payouts", "Provider onboarding", "Payroll"]) {
    assert.ok(cardFor(body.data, label), `the ${label} card disappeared`);
  }
});

test("A5: every mode returns 200 - the regression is a wrong column anywhere, not only this one", async () => {
  const { db } = freshCountingD1();
  await ensureStatutoryTables(db);
  for (const mode of MODES) {
    const response = await callControlCenter(db, mode);
    assert.equal(response.status, 200, `mode=${mode} threw: ${response.error?.message ?? ""}`);
    assert.ok(Array.isArray(response.body.data.cards) && Array.isArray(response.body.data.rows));
  }
});

test("A6: schema drift now degrades the evidence list instead of destroying the request", async () => {
  /* A table that exists but is missing the columns the evidence query names - the exact shape of the
   * original defect, reproduced on a different mode so it cannot pass just because A1 was fixed. */
  const { sqlite, db } = freshCountingD1();
  sqlite.exec("CREATE TABLE unified_cases (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
  const response = await callControlCenter(db, "quality");
  assert.equal(response.status, 200, "a drifted evidence table must not take the whole mode down");
  assert.deepEqual(response.body.data.rows, []);
  assert.equal(cardFor(response.body.data, "Safety cases").connected, false,
    "and the count for that same table must still read as not connected rather than as zero");
});

// --- B. clear-to-verified -----------------------------------------------------------------------

const OPS = "ops@pawspace.in";

async function applicationReadyForVerification(sqlite, db, { id = "POAPP-TEST", policyRef = null } = {}) {
  await ensureProviderOnboardingTransactional(db);
  sqlite.prepare(
    "INSERT INTO provider_onboarding_applications (id,vertical_key,country_code,city_code,status,locale_code,basic_info_json,policy_ref,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, "grooming", "IN", "BLR", "submitted", "en", "{}", policyRef, OPS, Date.now(), Date.now());
  return id;
}

/* node:sqlite hands back null-prototype rows, so compare the fields rather than the object. */
const verificationRow = (sqlite, id) => {
  const row = sqlite.prepare("SELECT status,manual_review_required FROM provider_onboarding_verifications WHERE id=?").get(id);
  return { status: row.status, manualReviewRequired: Number(row.manual_review_required) };
};

async function refusal(work) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

test("B1: a verification created with manualReviewRequired=true says so in its status as well as its flag", async () => {
  const { sqlite, db } = freshCountingD1();
  const applicationId = await applicationReadyForVerification(sqlite, db);

  const created = await createVerification(db, { applicationId, adapterKey: "not_connected", actorEmail: OPS, manualReviewRequired: true });
  const row = verificationRow(sqlite, created.id);
  assert.equal(row.manualReviewRequired, 1);
  assert.equal(row.status, "manual_review_required",
    "the row must not claim 'manual review required = yes' and 'not awaiting manual review' at the same time");
  assert.equal(created.status, "manual_review_required", "and the caller must be told the status that was written");

  const application = sqlite.prepare("SELECT verification_status FROM provider_onboarding_applications WHERE id=?").get(applicationId);
  assert.equal(application.verification_status, "manual_review_required", "the application mirror must agree with the verification row");
});

test("B2: the console's own 'Create UAT verification' can be cleared straight away", async () => {
  const { sqlite, db } = freshCountingD1();
  const applicationId = await applicationReadyForVerification(sqlite, db);
  /* manualReviewRequired:true is exactly what app/team/provider-onboarding/page.tsx posts. */
  const created = await createVerification(db, { applicationId, adapterKey: "not_connected", actorEmail: OPS, manualReviewRequired: true });

  const cleared = await clearManualVerificationReview(db, { verificationId: created.id, actorEmail: OPS, detail: { source: "staff_uat" } });
  assert.equal(cleared.status, "verified");
  assert.deepEqual(verificationRow(sqlite, created.id), { status: "verified", manualReviewRequired: 0 });
  assert.equal(
    sqlite.prepare("SELECT verification_status FROM provider_onboarding_applications WHERE id=?").get(applicationId).verification_status,
    "verified",
  );
});

test("B3: a verification created without manual review is left alone, and clearing it is refused", async () => {
  const { sqlite, db } = freshCountingD1();
  const applicationId = await applicationReadyForVerification(sqlite, db);
  const created = await createVerification(db, { applicationId, adapterKey: "not_connected", actorEmail: OPS, manualReviewRequired: false });
  assert.deepEqual(verificationRow(sqlite, created.id), { status: "not_connected", manualReviewRequired: 0 });

  const error = await refusal(() => clearManualVerificationReview(db, { verificationId: created.id, actorEmail: OPS }));
  assert.ok(error instanceof Response, "a wrong-state refusal must be an HTTP response, not a bare Error that becomes a 500");
  assert.equal(error.status, 409);
});

test("B4: a genuine wrong-state refusal is a governed, readable 4xx - not a 500 with the reason discarded", async () => {
  const { sqlite, db } = freshCountingD1();
  const applicationId = await applicationReadyForVerification(sqlite, db);
  const created = await createVerification(db, { applicationId, adapterKey: "not_connected", actorEmail: OPS, manualReviewRequired: true });
  await clearManualVerificationReview(db, { verificationId: created.id, actorEmail: OPS });

  const error = await refusal(() => clearManualVerificationReview(db, { verificationId: created.id, actorEmail: OPS }));
  assert.ok(error instanceof Response, "clearing an already-verified record is a business rule, not a server fault");
  assert.ok(error.status >= 400 && error.status < 500, `expected a 4xx, got ${error.status}`);
  assert.equal(isGovernedHttpError(error), true,
    "only a response marked through lib/governed-http-error may keep its body; an unmarked one is redacted to the generic string");
  const message = await error.text();
  assert.match(message, /verified/, "the message must name the state the record is actually in");
  assert.ok(message.length > 40 && !message.includes("{"), "the operator reads this sentence, so it must be a sentence");
});

test("B5: an unknown verification id is a governed 404, not an unhandled crash", async () => {
  const { db } = freshCountingD1();
  await ensureProviderOnboardingTransactional(db);
  const error = await refusal(() => clearManualVerificationReview(db, { verificationId: "POVER-NOPE", actorEmail: OPS }));
  assert.ok(error instanceof Response);
  assert.equal(error.status, 404);
  assert.equal(isGovernedHttpError(error), true);
});

test("B6: rows written before the fix - flag set, status not - can still be cleared", async () => {
  const { sqlite, db } = freshCountingD1();
  const applicationId = await applicationReadyForVerification(sqlite, db);
  const now = Date.now();
  sqlite.prepare(
    "INSERT INTO provider_onboarding_verifications (id,application_id,adapter_key,environment,status,manual_review_required,detail_json,created_by,created_at,updated_at) VALUES (?,?,?,'uat','not_connected',1,'{}',?,?,?)",
  ).run("POVER-LEGACY", applicationId, "not_connected", OPS, now, now);

  const cleared = await clearManualVerificationReview(db, { verificationId: "POVER-LEGACY", actorEmail: OPS });
  assert.equal(cleared.status, "verified", "the live database already holds these rows; the fix must not strand them");
});

test("B7: the console withholds \"Clear to verified\" in states where the server would refuse it", () => {
  /* The page is a React server-rendered surface, not an importable function, so this one is read
   * rather than run. It still pins behaviour: the console used to render the clear control for ANY
   * existing verification, so the operator was handed a button the server could only reject. */
  const ops = fs.readFileSync(new URL("../app/team/provider-onboarding/page.tsx", import.meta.url), "utf8");
  const card = ops.slice(ops.indexOf('<Card title="Verification / KYC boundary">'), ops.indexOf('<Card title="Quiz draft">'));
  assert.ok(card.length > 0, "the verification card must still exist");

  const guard = card.indexOf("awaitingManualReview?");
  const clear = card.indexOf(">Clear to verified</button>");
  const requireReview = card.indexOf(">Require manual review</button>");
  assert.ok(guard > 0, "the card must branch on whether a manual review is actually outstanding");
  assert.ok(clear > guard, "the clear control must live inside the awaiting-manual-review branch");
  assert.ok(requireReview > clear, "and the other branch - which offers 'Require manual review' instead - must come after it");
  assert.equal(card.split(">Clear to verified</button>").length - 1, 1, "exactly one clear control, on one branch");

  assert.match(ops, /awaitingManualReview=Boolean\(verification\)&&\(text\(verification\?\.status\)==="manual_review_required"\|\|Number\(verification\?\.manual_review_required\)===1\)/,
    "the branch must be derived from persisted server state, never assumed");
});

// --- C. activation evaluation -------------------------------------------------------------------

test("C1: evaluating an application with no pinned policy reports the gap instead of throwing", async () => {
  const { sqlite, db } = freshCountingD1();
  const applicationId = await applicationReadyForVerification(sqlite, db, { id: "POAPP-NOPOLICY", policyRef: null });

  const evaluation = await evaluateProviderActivation(db, { applicationId });
  const pinned = evaluation.checks.find((c) => c.code === "onboarding_policy_pinned");
  assert.ok(pinned, "the missing requirement must appear in the checklist the operator already reads");
  assert.equal(pinned.passed, false);
  assert.match(String(pinned.detail?.note ?? ""), /onboarding policy/i, "and it must say what is missing");
  assert.equal(evaluation.eligible, false, "an application with no policy is not activatable");
  assert.equal(evaluation.policyRef, null);
});

test("C2: the rest of the checklist is still computed - the report is not truncated at the first gap", async () => {
  const { sqlite, db } = freshCountingD1();
  const applicationId = await applicationReadyForVerification(sqlite, db, { id: "POAPP-NOPOLICY2", policyRef: null });

  const evaluation = await evaluateProviderActivation(db, { applicationId });
  const codes = evaluation.checks.map((c) => c.code);
  for (const code of ["verification_verified", "quiz_qualified", "interview_approved", "human_decision_approved", "sla_accepted", "profile_complete", "city_present"]) {
    assert.ok(codes.includes(code), `${code} is missing - the operator would not see the full picture`);
  }
  assert.equal(evaluation.checks.find((c) => c.code === "city_present").passed, true,
    "a check that genuinely passes must still pass alongside the failing policy check");
});

test("C3: a pinned, resolvable policy passes that same check - it is not hardcoded to fail", async () => {
  const { sqlite, db } = freshCountingD1();
  await ensureProviderOnboardingConfiguration(db);
  const now = Date.now();
  sqlite.prepare(
    "INSERT INTO provider_onboarding_policy_versions (id,policy_key,version,status,vertical_key,process_steps_json,package_config_json,verification_rules_json,verification_adapters_json,quiz_policy_json,interview_policy_json,media_requirements_json,sla_template_ref,activation_requirements_json,immutable_hash,created_by,created_at,updated_at) VALUES (?,?,1,'active','grooming','[]','{}','{}','{}','{}','{}','[]',NULL,'[]','hash',?,?,?)",
  ).run("POPOL-1", "grooming:IN", OPS, now, now);
  const applicationId = await applicationReadyForVerification(sqlite, db, { id: "POAPP-PINNED", policyRef: "POPOL-1" });

  const evaluation = await evaluateProviderActivation(db, { applicationId });
  assert.equal(evaluation.checks.find((c) => c.code === "onboarding_policy_pinned").passed, true);
  assert.equal(evaluation.policyRef, "POPOL-1");
});

test("C4: a policy_ref pointing at a policy that no longer resolves is reported, not thrown", async () => {
  const { sqlite, db } = freshCountingD1();
  await ensureProviderOnboardingConfiguration(db);
  const applicationId = await applicationReadyForVerification(sqlite, db, { id: "POAPP-DANGLING", policyRef: "POPOL-GONE" });

  const evaluation = await evaluateProviderActivation(db, { applicationId });
  const pinned = evaluation.checks.find((c) => c.code === "onboarding_policy_pinned");
  assert.equal(pinned.passed, false);
  assert.equal(pinned.detail.policyRef, "POPOL-GONE", "the operator needs the reference that failed to resolve");
});
