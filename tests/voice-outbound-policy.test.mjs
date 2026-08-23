import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, OTHER_PHONE, FOUNDER_PERMISSIONS, PROVIDER_PERMISSIONS, AUDITOR_PERMISSIONS, DAYTIME, QUIET_TIME } from "./helpers/voice-harness.mjs";

// ---------------------------------------------------------------------------
// The pre-dial policy gate, EXECUTED, with every refusal asserted against the database.
//
// What existed before: startAiVoiceUatCall took `consent: boolean` from the request body and wrote
// 'verified' into the row. That is the entire consent model - the caller asserting it. There was no
// opt-out check, no quiet-hours check, no frequency cap, no allow-list, no environment gate, and no
// provider to dial with.
//
// Every case below drives requestOutboundVoiceCall for real and then reads voice_call_orders,
// voice_call_state_transitions and voice_call_policy_decisions to prove what happened. The assertion
// that matters in each refusal case is `dialed_at IS NULL` plus a terminal blocked_* state: the state
// machine makes blocked_* reachable only from policy_check, so those two facts together are proof that
// the gate ran BEFORE any dial rather than after it.
// ---------------------------------------------------------------------------

installWorkersHooks("__VOG_DB__", "__VOG_ENV__");
const gov = await import("../lib/voice-outbound-governance.ts");

async function fresh(envOverrides = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__VOG_DB__ = db;
  globalThis.__VOG_ENV__ = { ...uatVoiceEnv(), ...envOverrides };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await gov.ensureVoiceCallTables(db);
  await gov.seedVoiceCallScripts(db);
  const seeded = seedRecipient(sqlite);
  return { sqlite, db, env: globalThis.__VOG_ENV__, ...seeded };
}

const order = (sqlite, callId) => sqlite.prepare("SELECT * FROM voice_call_orders WHERE id=?").get(callId);
const transitions = (sqlite, callId) => sqlite.prepare("SELECT sequence,from_state,to_state,reason_class FROM voice_call_state_transitions WHERE call_id=? ORDER BY sequence").all(callId);
const decisions = (sqlite, callId) => Object.fromEntries(sqlite.prepare("SELECT check_code,passed FROM voice_call_policy_decisions WHERE call_id=?").all(callId).map(row => [row.check_code, row.passed === 1]));

function callInput(overrides = {}) {
  return {
    idempotencyKey: `voice-test-${Math.random().toString(36).slice(2)}`,
    useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr",
    customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1",
    actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS,
    asOf: DAYTIME, ...overrides,
  };
}

/** Every refusal must look the same in the ledger: terminal blocked state, no dial, gate ran first. */
function assertRefused(sqlite, result, expectedState, expectedCheck) {
  assert.equal(result.dialled, false, "no dial");
  assert.equal(result.state, expectedState, `landed in ${expectedState}`);
  assert.equal(result.blockedBy, expectedCheck, `blocked by ${expectedCheck}`);
  const row = order(sqlite, result.callId);
  assert.equal(row.state, expectedState);
  assert.equal(row.dialed_at, null, "dialed_at was never stamped");
  assert.equal(row.provider_call_id, null, "no provider call id exists");
  assert.equal(row.failure_reason_class, "policy_blocked");
  const trail = transitions(sqlite, result.callId);
  assert.deepEqual(trail.map(step => step.to_state), ["policy_check", expectedState], "the gate ran before the refusal, and nothing followed it");
  assert.equal(decisions(sqlite, result.callId)[expectedCheck], false, `${expectedCheck} is recorded as failed`);
}

test("voice is OFF by default: an unconfigured environment refuses and records why", async () => {
  const { sqlite, db, env } = await fresh({ PAWSPACE_VOICE_ENV: "", PAWSPACE_VOICE_UAT_APPROVED: "" });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput());
  assertRefused(sqlite, result, "blocked_disabled", "voice_enabled");
  assert.match(result.blockedDetail, /PAWSPACE_VOICE_ENV/, "the refusal names the environment variable, not a secret");
});

test("an approved environment still refuses without the explicit approval flag", async () => {
  const { sqlite, db, env } = await fresh({ PAWSPACE_VOICE_UAT_APPROVED: "" });
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput()), "blocked_disabled", "voice_enabled");
});

test("UAT with credentials but no allow-list refuses - an unbounded approved environment is the accident this prevents", async () => {
  const { sqlite, db, env } = await fresh({ PAWSPACE_VOICE_UAT_ALLOWLIST: "" });
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput()), "blocked_disabled", "voice_enabled");
});

test("no client-supplied field can turn voice on", async () => {
  const { sqlite, db, env } = await fresh({ PAWSPACE_VOICE_ENV: "" });
  // Every plausible client-side lever, all in one request. None of them is read by the gate.
  const result = await gov.requestOutboundVoiceCall(db, env, callInput({
    voiceEnabled: true, PAWSPACE_VOICE_ENV: "uat", PAWSPACE_VOICE_UAT_APPROVED: "true",
    mode: "live", force: true, override: "enable", env: { PAWSPACE_VOICE_ENV: "uat" },
  }));
  assertRefused(sqlite, result, "blocked_disabled", "voice_enabled");
});

test("a caller without the authority to launch a dialler is refused", async () => {
  const { sqlite, db, env } = await fresh();
  // service_provider holds communications.call but not customers.manage: it may phone a customer itself,
  // not point an automated dialler at one.
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput({ actorPermissions: PROVIDER_PERMISSIONS })), "blocked_permission", "caller_authority");
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput({ actorPermissions: AUDITOR_PERMISSIONS })), "blocked_permission", "caller_authority");
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput({ actorPermissions: [] })), "blocked_permission", "caller_authority");
});

test("outbound sales/pitch calling stays disabled while it is unapproved, even though it is implemented", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "lead", subjectId: "LEAD-V1", granted: true, source: "enquiry_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  for (const useCase of ["sales_pitch", "lead_qualification"]) {
    const result = await gov.requestOutboundVoiceCall(db, env, callInput({ useCase, bookingId: null }));
    assertRefused(sqlite, result, "blocked_use_case", "use_case_approved");
    assert.match(result.blockedDetail, /PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED/);
  }
  // With the business approval present the same request passes the use-case check - so the capability is
  // genuinely built, and genuinely off.
  const approved = await fresh({ PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: "true" });
  await gov.recordVoiceConsent(approved.db, { phone: ALLOWLISTED_PHONE, subjectType: "lead", subjectId: "LEAD-V1", granted: true, source: "enquiry_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const allowed = await gov.requestOutboundVoiceCall(approved.db, approved.env, callInput({ useCase: "sales_pitch", bookingId: null }));
  assert.equal(decisions(approved.sqlite, allowed.callId).use_case_approved, true);
  assert.equal(allowed.dialled, true);
});

test("an unrecognised use case is refused rather than dialled on a free-text string", async () => {
  const { sqlite, db, env } = await fresh();
  const result = await gov.requestOutboundVoiceCall(db, env, callInput({ useCase: "win_back_blast" }));
  assertRefused(sqlite, result, "blocked_use_case", "use_case_approved");
  assert.match(result.blockedDetail, /Unsupported voice use case/);
});

test("a use case that must be about a booking cannot be pointed at nobody's booking", async () => {
  const { sqlite, db, env } = await fresh();
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput({ bookingId: null })), "blocked_use_case", "use_case_approved");
});

test("a recipient who is not on the approved allow-list is refused", async () => {
  const { sqlite, db, env } = await fresh();
  seedRecipient(sqlite, { contactId: "CON-V2", leadId: "LEAD-V2", phone: OTHER_PHONE });
  await gov.recordVoiceConsent(db, { phone: OTHER_PHONE, subjectType: "customer", subjectId: "CON-V2", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput({ phone: OTHER_PHONE, customerId: "CON-V2", leadId: "LEAD-V2" })), "blocked_not_allowlisted", "uat_allowlist");
});

test("consent is proved from a stored record - the caller cannot assert it", async () => {
  const { sqlite, db, env } = await fresh();
  // No consent row: refused, whatever the request says about consent.
  const claimed = await gov.requestOutboundVoiceCall(db, env, callInput({ consent: true, consentVerified: true, consentStatus: "verified" }));
  assertRefused(sqlite, claimed, "blocked_consent", "voice_consent");
  assert.equal(order(sqlite, claimed.callId).consent_decision, "missing");

  // A real consent record, and the same request now passes the consent check.
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const allowed = await gov.requestOutboundVoiceCall(db, env, callInput());
  assert.equal(decisions(sqlite, allowed.callId).voice_consent, true);
  assert.equal(order(sqlite, allowed.callId).consent_decision, "granted");
});

test("revoked consent is refused, not treated as consent that once existed", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: false, source: "customer_withdrew_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput());
  assertRefused(sqlite, result, "blocked_consent", "voice_consent");
  assert.equal(order(sqlite, result.callId).consent_decision, "revoked");
});

test("an opted-out number is refused, and an opt-out also revokes consent", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  await gov.recordVoiceOptOut(db, { phone: ALLOWLISTED_PHONE, source: "customer_call", reason: "do not call", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput());
  // Opt-out is checked after consent, and the opt-out revoked the consent - so the consent check is what
  // refuses first. Either way the call does not happen; both decisions are on the record.
  assert.equal(result.dialled, false);
  assert.ok(["blocked_consent", "blocked_opt_out"].includes(result.state), `refused as ${result.state}`);
  const recorded = decisions(sqlite, result.callId);
  assert.equal(recorded.opt_out_clear, false, "the opt-out is recorded as failing");
  assert.equal(order(sqlite, result.callId).opt_out_decision, "opted_out");
  assert.equal(order(sqlite, result.callId).dialed_at, null);
});

test("a CRM opt-out on the lead blocks the call even with voice consent on the number", async () => {
  const { sqlite, db, env } = await fresh();
  seedRecipient(sqlite, { contactId: "CON-V1", leadId: "LEAD-V1", phone: ALLOWLISTED_PHONE, optOut: 1 });
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  assertRefused(sqlite, await gov.requestOutboundVoiceCall(db, env, callInput()), "blocked_opt_out", "opt_out_clear");
});

test("quiet hours block the dial, and the same request outside them does not", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const blocked = await gov.requestOutboundVoiceCall(db, env, callInput({ asOf: QUIET_TIME }));
  assertRefused(sqlite, blocked, "blocked_quiet_hours", "quiet_hours");
  assert.equal(order(sqlite, blocked.callId).quiet_hours_decision, "inside");
  const allowed = await gov.requestOutboundVoiceCall(db, env, callInput({ asOf: DAYTIME }));
  assert.equal(allowed.dialled, true);
  assert.equal(order(sqlite, allowed.callId).quiet_hours_decision, "outside");
});

test("a city with no policy of its own gets the conservative default, not free rein", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput({ cityId: "maa" }));
  const recorded = sqlite.prepare("SELECT detail FROM voice_call_policy_decisions WHERE call_id=? AND check_code='quiet_hours'").get(result.callId);
  assert.match(recorded.detail, /conservative_default/, "an unknown city falls back to the strict default");
});

test("the frequency cap counts real dials only, and blocks the one over the line", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  // booking_confirmation allows 2 attempts; the city policy allows 5, so 2 is the binding cap.
  const first = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "cap-1" }));
  const second = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "cap-2" }));
  assert.equal(first.dialled, true);
  assert.equal(second.dialled, true);
  const third = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "cap-3" }));
  assertRefused(sqlite, third, "blocked_frequency_cap", "frequency_cap");
  assert.match(third.blockedDetail, /2\/2 in 24h/);
  // A refused call never reached the recipient, so it must not consume the allowance. Proven by counting
  // what the gate actually counted.
  assert.equal(order(sqlite, third.callId).frequency_attempts_24h, 2, "the blocked attempts are not counted");
  // And the cap is a window, not a lifetime ban.
  const later = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "cap-4", asOf: DAYTIME + 25 * 3600_000 }));
  assert.equal(later.dialled, true, "the window rolls");
});

test("with no telephony provider configured the call refuses rather than reporting success", async () => {
  const { sqlite, db, env } = await fresh({ PAWSPACE_VOICE_TRANSPORT: "", EXOTEL_API_KEY: "", EXOTEL_API_TOKEN: "", EXOTEL_SID: "", EXOTEL_CALLER_ID: "", EXOTEL_VOICE_APP_ID: "", EXOTEL_WEBHOOK_SECRET: "" });
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput());
  // The environment gate catches the absent credentials first and names them; nothing dialled either way.
  assert.equal(result.dialled, false);
  assert.equal(order(sqlite, result.callId).dialed_at, null);
  assert.match(result.blockedDetail, /EXOTEL_API_KEY/);
  assert.doesNotMatch(JSON.stringify(result), /test-key|test-token|test-webhook-secret/, "no secret value appears in the result");
});

test("a provider that refuses the dial lands in provider_unavailable, not a fake dialing state", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput({ simulatedOutcome: "failed" }));
  assert.equal(result.dialled, false);
  assert.equal(result.state, "provider_unavailable");
  assert.equal(order(sqlite, result.callId).dialed_at, null);
  assert.deepEqual(transitions(sqlite, result.callId).map(step => step.to_state), ["policy_check", "queued", "provider_unavailable"]);
});

test("a permitted call dials through the labelled non-production transport and never claims otherwise", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput());
  assert.equal(result.dialled, true);
  assert.equal(result.state, "dialing");
  assert.equal(result.productionCall, false, "the simulator never reports a production call");
  assert.equal(result.provider, "local_simulator_non_production");
  assert.match(result.openingDisclosure, /PawSpace/);
  const row = order(sqlite, result.callId);
  assert.ok(row.dialed_at, "dialed_at is stamped only when the provider accepted");
  assert.ok(row.provider_call_id);
  assert.equal(row.production_call, 0);
  assert.deepEqual(transitions(sqlite, result.callId).map(step => step.to_state), ["policy_check", "queued", "dialing"]);
  // Every check is on the record for a permitted call too, not only for a refused one.
  const recorded = decisions(sqlite, result.callId);
  for (const check of ["voice_enabled", "caller_authority", "use_case_approved", "script_ready", "uat_allowlist", "voice_consent", "opt_out_clear", "quiet_hours", "frequency_cap", "provider_configured"]) {
    assert.equal(recorded[check], true, `${check} passed and was recorded`);
  }
  const audit = await gov.voiceCallAudit(db, result.callId);
  assert.equal(audit.truth.rawProviderPayloadsStored, false);
  assert.equal(audit.truth.productionCallExecuted, false);
});

test("replaying a call request does not dial twice", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const input = callInput({ idempotencyKey: "same-key" });
  const first = await gov.requestOutboundVoiceCall(db, env, input);
  const replay = await gov.requestOutboundVoiceCall(db, env, input);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.callId, first.callId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_orders").get().c, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_state_transitions WHERE call_id=?").get(first.callId).c, 3);
});

test("a call must name the customer or lead it is about, and a real number", async () => {
  const { db, env } = await fresh();
  await assert.rejects(() => gov.requestOutboundVoiceCall(db, env, callInput({ customerId: null, leadId: null })), /must name the customer or lead/);
  await assert.rejects(() => gov.requestOutboundVoiceCall(db, env, callInput({ phone: "123" })), /real recipient phone number/);
  await assert.rejects(() => gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "" })), /idempotency key/);
});

test("a retry re-proves the whole gate, is correlated, and is bounded", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const first = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "retry-root" }));
  await gov.transitionVoiceCall(db, { callId: first.callId, to: "ringing", reason: "provider", actor: "test", asOf: DAYTIME });
  await gov.transitionVoiceCall(db, { callId: first.callId, to: "no_answer", reason: "provider", actor: "test", asOf: DAYTIME });

  const retry = await gov.retryVoiceCall(db, env, { callId: first.callId, actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME });
  assert.equal(retry.retryOf, first.callId, "correlated to the original");
  assert.equal(retry.retryAttempt, 1);
  assert.equal(retry.dialled, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_policy_decisions WHERE call_id=?").get(retry.callId).c, 10, "the retry re-ran every check");

  // booking_confirmation allows 2 attempts total, so a second retry has none left.
  await gov.transitionVoiceCall(db, { callId: retry.callId, to: "busy", reason: "provider", actor: "test", asOf: DAYTIME });
  await assert.rejects(() => gov.retryVoiceCall(db, env, { callId: retry.callId, actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME }), /no retry remains/);
});

test("a policy refusal is never retryable - the decision would just be re-made", async () => {
  const { db, env } = await fresh();
  const blocked = await gov.requestOutboundVoiceCall(db, env, callInput());
  assert.equal(blocked.state, "blocked_consent");
  await assert.rejects(() => gov.retryVoiceCall(db, env, { callId: blocked.callId, actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS }), /state blocked_consent may not be retried/);
});

test("a retry after the customer opts out is refused, so one approved dial never licenses a later one", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const first = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "optout-root" }));
  await gov.transitionVoiceCall(db, { callId: first.callId, to: "no_answer", reason: "provider", actor: "test", asOf: DAYTIME });
  await gov.recordVoiceOptOut(db, { phone: ALLOWLISTED_PHONE, source: "customer_sms", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const retry = await gov.retryVoiceCall(db, env, { callId: first.callId, actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME });
  assert.equal(retry.dialled, false);
  assert.equal(order(sqlite, retry.callId).dialed_at, null);
  assert.equal(decisions(sqlite, retry.callId).opt_out_clear, false);
});

test("an impossible transition is refused by the ledger, not just by the pure state machine", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(db, env, callInput());
  await assert.rejects(() => gov.transitionVoiceCall(db, { callId: call.callId, to: "completed", reason: "x", actor: "test" }), /Illegal voice call transition dialing -> completed/);
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "test", asOf: DAYTIME });
  await gov.completeVoiceCall(db, { callId: call.callId, reason: "done", actorId: "test", asOf: DAYTIME });
  assert.equal(order(sqlite, call.callId).state, "ended");
  // A terminal call cannot be revived, reopened or re-failed.
  for (const to of ["connected", "dialing", "no_answer", "completed", "blocked_consent"]) {
    await assert.rejects(() => gov.transitionVoiceCall(db, { callId: call.callId, to, reason: "x", actor: "test" }), /Illegal voice call transition ended ->/);
  }
  // policy_check, queued, dialing, connected, completed, ended - and nothing for the six refused attempts.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_state_transitions WHERE call_id=?").get(call.callId).c, 6, "no refused transition was recorded");
});

test("a call that asks for a human gets a real case in the queue Ops works", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(db, env, callInput());
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "test", asOf: DAYTIME });
  const handoff = await gov.requestVoiceHumanHandoff(db, { callId: call.callId, reason: "Customer asked for a person", actorId: "bot@pawspace.in", asOf: DAYTIME });
  assert.equal(handoff.handedOff, true);
  assert.ok(handoff.caseId, "a real case id, not a tag nobody sees");
  assert.equal(order(sqlite, call.callId).state, "ai_handoff");
  assert.equal(order(sqlite, call.callId).handoff_case_id, handoff.caseId);
  assert.deepEqual(transitions(sqlite, call.callId).map(step => step.to_state), ["policy_check", "queued", "dialing", "connected", "handoff_requested", "ai_handoff"]);
});

test("a speech-stack failure mid-call can still reach a human", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  for (const kind of ["stt", "tts"]) {
    const call = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: `speech-${kind}`, asOf: DAYTIME + (kind === "tts" ? 1 : 0) }));
    await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "test", asOf: DAYTIME });
    await gov.recordVoiceSpeechFailure(db, { callId: call.callId, kind, reason: `${kind} provider timed out`, actorId: "bot@pawspace.in", asOf: DAYTIME });
    const row = order(sqlite, call.callId);
    assert.equal(row.state, `${kind}_failed`);
    assert.equal(row.failure_reason_class, "speech_stack_failure");
    const handoff = await gov.requestVoiceHumanHandoff(db, { callId: call.callId, reason: `${kind} failure`, actorId: "bot@pawspace.in", asOf: DAYTIME });
    assert.equal(handoff.handedOff, true);
  }
});

test("an opt-out spoken during the call is honoured immediately and blocks the next one", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "live-optout" }));
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "test", asOf: DAYTIME });
  const result = await gov.recordVoiceOptOutDuringCall(db, { callId: call.callId, reason: "Customer said do not call", actorId: "bot@pawspace.in", asOf: DAYTIME });
  assert.equal(result.optedOut, true);
  assert.equal(order(sqlite, call.callId).state, "ended");
  assert.ok(sqlite.prepare("SELECT recorded_at FROM voice_call_opt_outs WHERE phone_key=?").get(ALLOWLISTED_PHONE), "the opt-out is a stored record");
  const next = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "after-optout" }));
  assert.equal(next.dialled, false);
  assert.equal(order(sqlite, next.callId).dialed_at, null);
});

test("a transcript reference is attached to the call, not the transcript itself", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(db, env, callInput());
  await gov.attachVoiceTranscript(db, { callId: call.callId, transcriptRef: "AIVCALL-ABC123", aiCallId: "AIVCALL-ABC123", asOf: DAYTIME });
  const row = order(sqlite, call.callId);
  assert.equal(row.transcript_ref, "AIVCALL-ABC123");
  assert.equal(row.ai_call_id, "AIVCALL-ABC123", "the conversation stays on the existing governed AI layer");
  await assert.rejects(() => gov.attachVoiceTranscript(db, { callId: "VCALL-NOPE", transcriptRef: "x" }), /Voice call not found/);
});

test("scripts are governed configuration, and a script that promises money is rejected", async () => {
  const { db } = await fresh();
  const base = { useCase: "booking_confirmation", actorId: "ops@pawspace.in" };
  const compliant = 'Hello, this is PawSpace’s automated assistant about your booking. Say "agent" for a team member, or "do not call" to stop calling.';
  await assert.doesNotReject(() => gov.setVoiceCallScript(db, { ...base, openingDisclosure: compliant }));

  for (const [disclosure, expected] of [
    ['Hi, automated assistant here about your booking. Say "agent" for a human or "do not call" to opt out.', /identify PawSpace by name/],
    ['Hello, this is PawSpace calling about your booking. Say "agent" for a human or "do not call" to opt out.', /state that the call is automated/],
    ['Hello, this is PawSpace’s automated assistant about your booking. Say "do not call" to opt out anytime.', /route to a human/],
    ['Hello, this is PawSpace’s automated assistant about your booking. Say "agent" for a team member at any time.', /offer an opt-out/],
    ["short", /actually introduce the call/],
  ]) await assert.rejects(() => gov.setVoiceCallScript(db, { ...base, openingDisclosure: disclosure }), expected);

  // A price, refund or offer claim needs an explicit human approval on that script - a bot promising a
  // discount is a commitment nobody authorised.
  await assert.rejects(() => gov.setVoiceCallScript(db, { ...base, openingDisclosure: compliant, body: ["We can offer you a 20% discount today"] }), /need explicit approval/);
  await assert.rejects(() => gov.setVoiceCallScript(db, { ...base, openingDisclosure: compliant, body: ["Your refund is guaranteed"] }), /need explicit approval/);
  await assert.doesNotReject(() => gov.setVoiceCallScript(db, { ...base, openingDisclosure: compliant, body: ["We can offer you a 20% discount today"], claimsApproved: true }));
});

test("a use case whose script has been deactivated cannot be called on", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const compliant = 'Hello, this is PawSpace’s automated assistant about your booking. Say "agent" for a team member, or "do not call" to stop calling.';
  await gov.setVoiceCallScript(db, { useCase: "booking_confirmation", openingDisclosure: compliant, active: false, actorId: "ops@pawspace.in" });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput());
  assertRefused(sqlite, result, "blocked_use_case", "script_ready");
});

test("the readiness surface reports zero production calls and leaks no secret", async () => {
  const { db, env } = await fresh();
  const readiness = await gov.voiceOutboundReadiness(db, env);
  assert.equal(readiness.productionCallsPlaced, 0);
  assert.equal(readiness.gate.enabled, true);
  assert.equal(readiness.gate.truth.productionCallsExecuted, false);
  assert.equal(readiness.gate.truth.clientCannotEnableVoice, true);
  assert.equal(readiness.transport.productionCapable, false, "the simulator is never reported as production-capable");
  assert.equal(readiness.transport.truth.verifiedAgainstLiveProvider, false);
  assert.equal(readiness.useCases.find(entry => entry.code === "sales_pitch").availableNow, false);
  const serialised = JSON.stringify(readiness);
  for (const secret of ["test-key", "test-token", "test-sid", "test-webhook-secret", "9876543210"]) {
    assert.ok(!serialised.includes(secret), `${secret} must not appear in readiness output`);
  }
});

test("the ledger stores a recipient reference, not a full contact record, and audits every decision", async () => {
  const { db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(db, env, callInput());
  const audit = await gov.voiceCallAudit(db, call.callId);
  assert.equal(audit.call.phoneLast4.length, 4);
  assert.equal(audit.policyDecisions.length, 10, "every check is in the audit, passed or failed");
  assert.ok(audit.transitions.every(step => step.actor), "every transition names who caused it");
  assert.equal(audit.providerEvents.length, 0);
  const ledger = await gov.voiceCallLedger(db, { limit: 10 });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].callId, call.callId);
  assert.ok(!Object.keys(ledger[0]).includes("phone_key"), "the ledger view does not hand back the dialled number");
});

test("a dry-run policy preview creates nothing and dials nothing", async () => {
  const { sqlite, db, env } = await fresh();
  const preview = await gov.evaluateVoiceCallPolicy(db, env, callInput());
  assert.equal(preview.allowed, false);
  assert.equal(preview.blockedBy, "voice_consent");
  assert.equal(preview.checks.length, 10);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_orders").get().c, 0, "a preview writes no call");
});

// ---------------------------------------------------------------------------
// Concurrency and last-look checks. Every case below covers a check-then-act window that a review of
// this PR flagged: the gate read a record, then the caller dialled, with nothing holding the decision
// still in between.
// ---------------------------------------------------------------------------

test("concurrent requests for the same recipient cannot exceed the frequency cap", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  // booking_confirmation allows 2 attempts in 24h. Five requests fired without awaiting each other all
  // read the same advisory count, so only the atomic dial-slot claim can bound them.
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: `race-${index}` }))));
  const dialled = results.filter(result => result.dialled);
  assert.equal(dialled.length, 2, `exactly the cap was dialled, got ${dialled.length}`);
  const refused = results.filter(result => !result.dialled);
  assert.equal(refused.length, 3);
  assert.ok(refused.every(result => result.state === "blocked_frequency_cap"), refused.map(r => r.state).join(","));
  // Proved against the database, not the return values.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_orders WHERE dialed_at IS NOT NULL").get().c, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_dial_reservations WHERE released_at IS NULL").get().c, 2);
});

test("a dial the provider refused gives the recipient's allowance back", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const failed = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "release-1", simulatedOutcome: "failed" }));
  assert.equal(failed.state, "provider_unavailable");
  assert.equal(sqlite.prepare("SELECT released_at FROM voice_call_dial_reservations WHERE call_id=?").get(failed.callId).released_at != null, true);
  // The failed attempt never reached the recipient, so both real attempts are still available.
  for (const key of ["release-2", "release-3"]) {
    assert.equal((await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: key }))).dialled, true, key);
  }
  assert.equal((await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "release-4" }))).state, "blocked_frequency_cap");
});

test("concurrent requests with one idempotency key produce one call, not a raw SQL error", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const input = callInput({ idempotencyKey: "one-key" });
  const results = await Promise.all([
    gov.requestOutboundVoiceCall(db, env, input),
    gov.requestOutboundVoiceCall(db, env, input),
    gov.requestOutboundVoiceCall(db, env, input),
  ]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_orders").get().c, 1, "one call row");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_orders WHERE dialed_at IS NOT NULL").get().c, 1, "one dial");
  // The losers of the race get the documented duplicate result, not a UNIQUE constraint failure.
  assert.equal(results.filter(result => result.duplicatePrevented).length, 2);
  assert.equal(new Set(results.map(result => result.callId)).size, 1);
});

test("consent withdrawn between the gate and the dial is honoured, not ignored", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  // Withdraw consent in the exact gap the gate cannot see: after its snapshot, before the dial. The hook
  // fires immediately before the pre-dial re-read, so without that re-read this call would go out.
  db.onSql("SELECT granted,revoked_at FROM voice_call_consents", () => {
    sqlite.prepare("UPDATE voice_call_consents SET granted=0,revoked_at=? WHERE phone_key=?").run(DAYTIME, ALLOWLISTED_PHONE);
  });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "late-revoke" }));
  assert.equal(result.dialled, false, "the withdrawal was seen before the provider was contacted");
  assert.equal(result.state, "blocked_consent");
  const row = order(sqlite, result.callId);
  assert.equal(row.dialed_at, null);
  assert.equal(row.provider_call_id, null);
  // The gate itself had recorded consent as granted, which is what proves the refusal came from the
  // last look rather than from the snapshot.
  assert.equal(decisions(sqlite, result.callId).voice_consent, true);
  const last = sqlite.prepare("SELECT detail_json,to_state FROM voice_call_state_transitions WHERE call_id=? ORDER BY sequence DESC LIMIT 1").get(result.callId);
  assert.equal(last.to_state, "blocked_consent");
  assert.equal(JSON.parse(last.detail_json).revalidatedBeforeDial, true);
  // And no dial slot was consumed by a call that never went out.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_dial_reservations").get().c, 0);
});

test("an opt-out recorded between the gate and the dial is honoured", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  db.onSql("SELECT recorded_at FROM voice_call_opt_outs", () => {
    sqlite.prepare("INSERT INTO voice_call_opt_outs (phone_key,source,reason,recorded_by,recorded_at) VALUES (?,?,?,?,?)")
      .run(ALLOWLISTED_PHONE, "customer_sms", "stop calling", "ops@pawspace.in", DAYTIME);
  });
  const result = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "late-optout" }));
  assert.equal(result.dialled, false);
  assert.equal(result.state, "blocked_opt_out");
  assert.equal(order(sqlite, result.callId).dialed_at, null);
  assert.equal(decisions(sqlite, result.callId).opt_out_clear, true, "the gate's snapshot said clear; the last look did not");
});

test("voice refuses to dial without a https provider callback configured", async () => {
  // Without one, a provider accepts the dial and we never learn the outcome - the call sits in dialing.
  for (const callback of ["", "http://uat.pawspace.in/api/voice-provider-webhook", "not-a-url"]) {
    const { sqlite, db, env } = await fresh({ PAWSPACE_VOICE_STATUS_CALLBACK_URL: callback });
    await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
    const result = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: `cb-${callback || "empty"}` }));
    assertRefused(sqlite, result, "blocked_disabled", "voice_enabled");
    assert.match(result.blockedDetail, /PAWSPACE_VOICE_STATUS_CALLBACK_URL/, callback);
  }
});

test("one canonical E.164 number is stored, dialled and reused by every retry", async () => {
  const gate = await import("../lib/voice-call-gate.ts");
  // The policy key is the last 10 digits; the DIAL number is E.164. Before, every written form of the
  // same number was checked as one recipient and then dialled as a different string.
  for (const written of ["9876543210", "+91 98765 43210", "09876543210", "+919876543210", "919876543210", "(987) 654-3210"]) {
    assert.equal(gate.canonicalDialNumber({}, written), "+919876543210", written);
    assert.equal(gate.normalisedDialKey(written), ALLOWLISTED_PHONE, written);
  }
  // Unreadable input is refused rather than guessed at.
  for (const bad of ["", "12345", "not-a-number", "+", "++919876543210", "98765x43210"]) {
    assert.equal(gate.canonicalDialNumber({}, bad), null, JSON.stringify(bad));
  }
  assert.equal(gate.canonicalDialNumber({ PAWSPACE_VOICE_DIAL_COUNTRY_CODE: "44" }, "7700900123"), "+447700900123", "the country code is configuration, not a constant");

  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const first = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "canon-1", phone: "+91 98765 43210" }));
  assert.equal(first.dialled, true);
  assert.equal(order(sqlite, first.callId).dial_number, "+919876543210");
  assert.equal(order(sqlite, first.callId).phone_key, ALLOWLISTED_PHONE, "the audit key stays the 10-digit form");

  // A retry must dial exactly what the original dialled, not the stored audit key.
  await gov.transitionVoiceCall(db, { callId: first.callId, to: "no_answer", reason: "provider", actor: "test", asOf: DAYTIME });
  const retry = await gov.retryVoiceCall(db, env, { callId: first.callId, actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME });
  assert.equal(retry.dialled, true);
  assert.equal(order(sqlite, retry.callId).dial_number, "+919876543210");

  await assert.rejects(() => gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "canon-bad", phone: "98765x43210" })), /dialable number/);
});

test("two DTMF presses on one call are both recorded, and a redelivery still is not", async () => {
  const { sqlite, db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(db, env, callInput({ idempotencyKey: "dtmf-1" }));
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "test", asOf: DAYTIME });

  const secret = env.EXOTEL_WEBHOOK_SECRET;
  const sign = async (bodyText) => {
    const timestamp = Date.now();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${bodyText}`));
    const hex = Array.from(new Uint8Array(mac)).map(byte => byte.toString(16).padStart(2, "0")).join("");
    return new Headers({ "x-pawspace-voice-timestamp": String(timestamp), "x-pawspace-voice-signature": hex });
  };
  const press = (digits) => new URLSearchParams({ CallSid: `EX-${call.callId}`, CustomField: call.callId, EventType: "dtmf", Digits: digits }).toString();

  // A carrier's event id for a status callback is the CALL id, constant for the whole call - so both
  // presses used to carry the identical identity and the second was dropped as a duplicate.
  const one = press("1"), two = press("2");
  assert.equal((await gov.recordVoiceProviderEvent(db, env, { rawBody: one, headers: await sign(one) })).duplicate, false);
  assert.equal((await gov.recordVoiceProviderEvent(db, env, { rawBody: two, headers: await sign(two) })).duplicate, false);
  const recorded = sqlite.prepare("SELECT curated_json FROM voice_call_provider_events WHERE event_kind='dtmf' ORDER BY created_at").all();
  assert.deepEqual(recorded.map(row => JSON.parse(row.curated_json).dtmfDigits), ["1", "2"], "both presses are on the record");

  // An exact redelivery is still a duplicate - it is indistinguishable from a repeat by definition.
  assert.equal((await gov.recordVoiceProviderEvent(db, env, { rawBody: two, headers: await sign(two) })).duplicate, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_provider_events WHERE event_kind='dtmf'").get().c, 2);
  // And a redelivered STATUS event must stay deduplicated, or the state machine could advance twice.
  const status = new URLSearchParams({ CallSid: `EX-${call.callId}`, CustomField: call.callId, CallStatus: "completed", CallDuration: "30" }).toString();
  assert.equal((await gov.recordVoiceProviderEvent(db, env, { rawBody: status, headers: await sign(status) })).duplicate, false);
  assert.equal((await gov.recordVoiceProviderEvent(db, env, { rawBody: status, headers: await sign(status) })).duplicate, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_state_transitions WHERE call_id=? AND to_state='completed'").get(call.callId).c, 1);
});
