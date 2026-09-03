import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, FOUNDER_PERMISSIONS, DAYTIME } from "./helpers/voice-harness.mjs";

// ---------------------------------------------------------------------------
// The telephony callback receiver, executed.
//
// A provider callback is an unauthenticated HTTP request from the public internet that moves a call's
// state. Three things therefore have to hold, in order: it must be cryptographically attributable, it
// must not be replayable, and it must not be able to force a state the call cannot be in.
//
// Providers redeliver aggressively on any non-2xx, so a duplicate is a NORMAL event: it is answered 200
// and changes nothing. Out-of-order delivery is normal too (a 'completed' can overtake a 'connected'),
// so the receiver records the event and declines to apply it rather than forcing an impossible history.
//
// Also asserted: the stored event carries a digest of the provider body and the handful of normalised
// fields, never the body itself - "do not persist uncontrolled sensitive raw provider payloads".
// ---------------------------------------------------------------------------

installWorkersHooks("__VPW_DB__", "__VPW_ENV__");
const gov = await import("../lib/voice-outbound-governance.ts");
const telephony = await import("../lib/voice-telephony-provider.ts");

const SECRET = "test-webhook-secret";

async function fresh(envOverrides = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__VPW_DB__ = db;
  globalThis.__VPW_ENV__ = { ...uatVoiceEnv(), ...envOverrides };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await gov.ensureVoiceCallTables(db);
  await gov.seedVoiceCallScripts(db);
  seedRecipient(sqlite);
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  return { sqlite, db, env: globalThis.__VPW_ENV__ };
}

async function dial(db, env, key = "wh-1") {
  return gov.requestOutboundVoiceCall(db, env, {
    idempotencyKey: key, useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr",
    customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1",
    actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME,
  });
}

const bytes = (value) => new TextEncoder().encode(value);
async function sign(secret, timestamp, body) {
  const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, bytes(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(mac)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function signedHeaders(body, { secret = SECRET, timestamp = Date.now(), signature } = {}) {
  return new Headers({ "x-pawspace-voice-timestamp": String(timestamp), "x-pawspace-voice-signature": signature ?? await sign(secret, timestamp, body) });
}
const basicHeaders = (password) => new Headers({ authorization: `Basic ${btoa(`voice:${password}`)}` });
const eventBody = (callId, extra = {}) => new URLSearchParams({ CallSid: `EX-${callId}`, CustomField: callId, ...extra }).toString();

const state = (sqlite, callId) => sqlite.prepare("SELECT state FROM voice_call_orders WHERE id=?").get(callId).state;
const events = (sqlite) => sqlite.prepare("SELECT * FROM voice_call_provider_events").all();
const stepCount = (sqlite, callId) => sqlite.prepare("SELECT COUNT(*) c FROM voice_call_state_transitions WHERE call_id=?").get(callId).c;

test("an unsigned callback is refused and changes nothing", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  const before = state(sqlite, call.callId), steps = stepCount(sqlite, call.callId);
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: eventBody(call.callId, { CallStatus: "in-progress" }), headers: new Headers() });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 401);
  assert.match(result.reason, /No webhook signature or Basic credentials/);
  assert.equal(state(sqlite, call.callId), before, "no state change");
  assert.equal(stepCount(sqlite, call.callId), steps);
  assert.equal(events(sqlite).length, 0, "an unverified payload is not even recorded");
});

test("a forged signature is refused", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  const body = eventBody(call.callId, { CallStatus: "in-progress" });
  for (const headers of [
    await signedHeaders(body, { secret: "wrong-secret" }),
    await signedHeaders(body, { signature: "deadbeef" }),
    await signedHeaders(body, { signature: "0".repeat(64) }),
    basicHeaders("wrong-secret"),
    new Headers({ authorization: "Basic not-base64!!" }),
    new Headers({ authorization: "Bearer sometoken" }),
  ]) {
    const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers });
    assert.equal(result.accepted, false, `refused: ${JSON.stringify([...headers])}`);
    assert.equal(result.status, 401);
  }
  assert.equal(state(sqlite, call.callId), "dialing");
  assert.equal(events(sqlite).length, 0);
});

test("a signature over a DIFFERENT body is refused - the body itself is what is signed", async () => {
  const { db, env } = await fresh();
  const call = await dial(db, env);
  const timestamp = Date.now();
  const signature = await sign(SECRET, timestamp, eventBody(call.callId, { CallStatus: "in-progress" }));
  const tampered = eventBody(call.callId, { CallStatus: "completed" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: tampered, headers: new Headers({ "x-pawspace-voice-timestamp": String(timestamp), "x-pawspace-voice-signature": signature }) });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /Signature does not match/);
});

test("a correctly-signed but stale or malformed timestamp is refused", async () => {
  const { db, env } = await fresh();
  const call = await dial(db, env);
  const body = eventBody(call.callId, { CallStatus: "in-progress" });
  const stale = Date.now() - 600_000;
  const staleResult = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body, { timestamp: stale }) });
  assert.equal(staleResult.accepted, false);
  assert.match(staleResult.reason, /freshness window/);
  const future = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body, { timestamp: Date.now() + 600_000 }) });
  assert.equal(future.accepted, false);
  const noStamp = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: new Headers({ "x-pawspace-voice-signature": await sign(SECRET, "abc", body) }) });
  assert.equal(noStamp.accepted, false);
  assert.match(noStamp.reason, /timestamp is missing or malformed/);
});

test("with no webhook secret configured, every callback is refused", async () => {
  const { db, env } = await fresh({ EXOTEL_WEBHOOK_SECRET: "", PAWSPACE_VOICE_SIMULATOR_SECRET: "" });
  const body = eventBody("VCALL-X", { CallStatus: "in-progress" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /Webhook secret is not configured/);
});

test("both accepted mechanisms verify and advance the call", async () => {
  for (const mechanism of ["hmac", "basic"]) {
    const { sqlite, db, env } = await fresh();
    const call = await dial(db, env);
    const body = eventBody(call.callId, { CallStatus: "in-progress" });
    const headers = mechanism === "hmac" ? await signedHeaders(body) : basicHeaders(SECRET);
    const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers });
    assert.equal(result.accepted, true, mechanism);
    assert.equal(result.stateChanged, true);
    assert.deepEqual([result.from, result.to], ["dialing", "connected"]);
    assert.equal(state(sqlite, call.callId), "connected");
    assert.equal(events(sqlite)[0].signature_mechanism, mechanism);
  }
});

test("a redelivered callback is answered 200 and applies exactly once", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  const body = eventBody(call.callId, { CallStatus: "in-progress" });
  const headers = await signedHeaders(body);
  const first = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers });
  assert.equal(first.stateChanged, true);
  const steps = stepCount(sqlite, call.callId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const replay = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
    assert.equal(replay.accepted, true, "answered 200 so the provider stops retrying");
    assert.equal(replay.status, 200);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.applied, false);
  }
  assert.equal(stepCount(sqlite, call.callId), steps, "the state machine did not advance again");
  assert.equal(events(sqlite).length, 1, "one row per provider event, enforced by the unique index");
  assert.equal(state(sqlite, call.callId), "connected");
});

test("progress, no-answer, busy and failure events each land in their own state", async () => {
  for (const [status, expected] of [["ringing", "ringing"], ["no-answer", "no_answer"], ["busy", "busy"], ["failed", "provider_error"]]) {
    const { sqlite, db, env } = await fresh();
    const call = await dial(db, env);
    const body = eventBody(call.callId, { CallStatus: status });
    const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
    assert.equal(result.accepted, true, status);
    assert.equal(state(sqlite, call.callId), expected, `${status} -> ${expected}`);
  }
});

test("a JSON callback body is accepted as well as a form-encoded one", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  const body = JSON.stringify({ CallSid: `EX-${call.callId}`, CustomField: call.callId, CallStatus: "in-progress" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, true);
  assert.equal(state(sqlite, call.callId), "connected");
});

test("a body that is not a parseable event is refused 400, verified or not", async () => {
  const { db, env } = await fresh();
  for (const body of ["{not json", "", "CallStatus=completed"]) {
    const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
    assert.equal(result.accepted, false, JSON.stringify(body));
    assert.equal(result.status, 400);
  }
});

test("a lone terminal callback completes the call by inferring the hop the carrier did not report", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  const body = eventBody(call.callId, { CallStatus: "completed", CallDuration: "42" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, true);
  assert.equal(result.applied, true);
  assert.equal(result.inferred, "connected", "the missing hop is named, not silently skipped");
  assert.equal(state(sqlite, call.callId), "completed");
  const trail = sqlite.prepare("SELECT to_state,reason,detail_json FROM voice_call_state_transitions WHERE call_id=? ORDER BY sequence").all(call.callId);
  assert.deepEqual(trail.map(step => step.to_state), ["policy_check", "queued", "dialing", "connected", "completed"]);
  const inferredStep = trail.find(step => step.to_state === "connected");
  assert.equal(JSON.parse(inferredStep.detail_json).inferred, true);
  assert.match(inferredStep.reason, /Inferred connected from provider event/);
  assert.equal(JSON.parse(trail.at(-1).detail_json).inferred, undefined, "the observed step is not marked inferred");
});

test("a connected event overtaking the dial confirmation is bridged too", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "ringing", reason: "provider", actor: "test" });
  const body = eventBody(call.callId, { CallStatus: "completed", CallDuration: "10" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.inferred, "connected");
  assert.equal(state(sqlite, call.callId), "completed");
});

test("an event with no unambiguous path is still refused rather than forced", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "no_answer", reason: "provider", actor: "test" });
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "ended", reason: "closed", actor: "test" });
  const body = eventBody(call.callId, { CallStatus: "completed", CallDuration: "42" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, true, "the provider is not made to retry forever");
  assert.equal(result.applied, false);
  assert.match(result.reason, /Illegal voice call transition ended -> completed/);
  assert.equal(state(sqlite, call.callId), "ended", "the outcome was not rewritten");
  assert.equal(events(sqlite).find(row => row.event_kind === "completed").applied, 0, "but it is on the record");
  const readiness = await gov.voiceOutboundReadiness(db, env);
  assert.equal(readiness.unappliedProviderEvents, 1);
});

test("the bridge only ever infers one unambiguous hop", () => {
  assert.equal(gov.inferredBridgeState("dialing", "completed"), "connected");
  assert.equal(gov.inferredBridgeState("ringing", "completed"), "connected");
  assert.equal(gov.inferredBridgeState("queued", "connected"), "dialing");
  assert.equal(gov.inferredBridgeState("connected", "completed"), null, "a legal transition needs no bridge");
  assert.equal(gov.inferredBridgeState("ended", "completed"), null);
  assert.equal(gov.inferredBridgeState("no_answer", "completed"), null);
  assert.equal(gov.inferredBridgeState("blocked_consent", "connected"), null, "a refused call is never bridged into a dial");
  assert.equal(gov.inferredBridgeState("dialing", "dialing"), null);
  assert.equal(gov.inferredBridgeState("policy_check", "connected"), null, "the gate cannot be skipped by inference");
});

test("a DTMF event is recorded without moving the call", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  const connect = eventBody(call.callId, { CallStatus: "in-progress" });
  await gov.recordVoiceProviderEvent(db, env, { rawBody: connect, headers: await signedHeaders(connect) });
  const body = eventBody(call.callId, { EventType: "dtmf", Digits: "1#abc*" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, true);
  assert.equal(result.stateChanged, false);
  assert.equal(state(sqlite, call.callId), "connected");
  const dtmf = events(sqlite).find(row => row.event_kind === "dtmf");
  assert.equal(JSON.parse(dtmf.curated_json).dtmfDigits, "1#*", "only DTMF characters are kept");
});

test("only curated fields and a digest of the body are stored - never the provider payload", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await dial(db, env);
  const body = eventBody(call.callId, {
    CallStatus: "in-progress",
    From: "+919876543210", To: "+918000000000",
    RecordingUrl: "https://recordings.exotel.example/secret-recording.mp3",
    SomeVendorField: "an-internal-vendor-token-we-never-asked-for",
  });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, true);
  const stored = events(sqlite)[0];
  assert.equal(stored.payload_sha256.length, 64, "the body is reduced to a digest");
  const serialised = JSON.stringify(stored);
  for (const leak of ["an-internal-vendor-token-we-never-asked-for", "+918000000000", "secret-recording.mp3"]) {
    assert.ok(!serialised.includes(leak), `${leak} must not be persisted`);
  }
  assert.deepEqual(Object.keys(JSON.parse(stored.curated_json)).sort(), ["dtmfDigits", "durationSeconds", "hasRecording", "kind", "locale", "providerStatus"]);
});

test("a recording reference is only retained when recording was approved for that call", async () => {
  const recordingUrl = "https://recordings.exotel.example/call.mp3";
  const withoutApproval = await fresh();
  const denied = await dial(withoutApproval.db, withoutApproval.env);
  const bodyA = eventBody(denied.callId, { EventType: "recording", RecordingUrl: recordingUrl });
  await gov.recordVoiceProviderEvent(withoutApproval.db, withoutApproval.env, { rawBody: bodyA, headers: await signedHeaders(bodyA) });
  assert.equal(withoutApproval.sqlite.prepare("SELECT recording_ref FROM voice_call_orders WHERE id=?").get(denied.callId).recording_ref, null, "an unapproved recording URL is discarded");
  const approved = await fresh({ PAWSPACE_VOICE_RECORDING_APPROVED: "true" });
  const allowed = await dial(approved.db, approved.env);
  assert.equal(approved.sqlite.prepare("SELECT recording_allowed FROM voice_call_orders WHERE id=?").get(allowed.callId).recording_allowed, 1);
  const bodyB = eventBody(allowed.callId, { EventType: "recording", RecordingUrl: recordingUrl });
  await gov.recordVoiceProviderEvent(approved.db, approved.env, { rawBody: bodyB, headers: await signedHeaders(bodyB) });
  assert.equal(approved.sqlite.prepare("SELECT recording_ref FROM voice_call_orders WHERE id=?").get(allowed.callId).recording_ref, recordingUrl);
});

test("an event for an unknown call is acknowledged without inventing one", async () => {
  const { sqlite, db, env } = await fresh();
  const body = eventBody("VCALL-DOES-NOT-EXIST", { CallStatus: "in-progress" });
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, true);
  assert.equal(result.applied, false);
  assert.match(result.reason, /unknown call/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_orders").get().c, 0, "a callback cannot conjure a call into the ledger");
  assert.equal(events(sqlite).length, 1, "the orphan event is still recorded for investigation");
});

test("an event with no call reference is acknowledged and parked", async () => {
  const { db, env } = await fresh();
  const body = new URLSearchParams({ CallSid: "EX-ORPHAN", CallStatus: "in-progress" }).toString();
  const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(result.accepted, true);
  assert.equal(result.status, 202);
  assert.match(result.reason, /no call reference/);
});

test("the disconnected provider refuses every callback and every dial", async () => {
  const provider = telephony.disconnectedTelephony;
  assert.equal(provider.productionCapable, false);
  assert.deepEqual(await provider.verifyWebhook({ rawBody: "x", headers: new Headers() }), { verified: false, mechanism: null, reason: "Telephony provider is not connected" });
  await assert.rejects(() => provider.createCall({ callRef: "x", toNumber: "9", statusCallbackUrl: "", recordingAllowed: false }), /not connected/);
  assert.throws(() => provider.parseEvent("{}"), /not connected/);
});

test("provider selection is fail-closed and never picks the simulator in live mode", () => {
  assert.equal(telephony.selectTelephonyProvider({}).provider, "not_connected");
  assert.equal(telephony.selectTelephonyProvider(uatVoiceEnv()).provider, telephony.LOCAL_SIMULATOR_PROVIDER);
  assert.equal(telephony.selectTelephonyProvider(uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT: "" })).provider, "exotel");
  assert.equal(telephony.selectTelephonyProvider(uatVoiceEnv({ PAWSPACE_VOICE_ENV: "live" })).provider, "exotel");
  const partial = uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT: "", EXOTEL_WEBHOOK_SECRET: "" });
  assert.equal(telephony.selectTelephonyProvider(partial).provider, "not_connected", "a half-configured provider is not connected");
  const status = telephony.telephonyProviderStatus(partial);
  assert.deepEqual(status.missingSecretNames, ["EXOTEL_WEBHOOK_SECRET"]);
  assert.equal(status.truth.callsPlaced, 0);
  assert.ok(!JSON.stringify(status).includes("test-token"), "readiness names secrets, never their values");
});

test("the signature verifier is not fooled by a length-matched wrong signature", async () => {
  const body = "CallSid=EX-1&CustomField=VCALL-1&CallStatus=completed";
  const timestamp = Date.now();
  const real = await sign(SECRET, timestamp, body);
  const flipped = `${real[0] === "a" ? "b" : "a"}${real.slice(1)}`;
  const headers = new Headers({ "x-pawspace-voice-timestamp": String(timestamp), "x-pawspace-voice-signature": flipped });
  assert.equal((await telephony.verifyVoiceWebhookSignature(SECRET, body, headers)).verified, false);
  const good = new Headers({ "x-pawspace-voice-timestamp": String(timestamp), "x-pawspace-voice-signature": real.toUpperCase() });
  assert.equal((await telephony.verifyVoiceWebhookSignature(SECRET, body, good)).verified, true, "case-insensitive hex is accepted");
});

test("the stale INT-VOICE-01 seed is advanced on an already-seeded database, but operator edits are not", async () => {
  const registry = await import("../lib/integration-readiness.ts");
  const untouched = await fresh();
  await registry.ensureIntegrationReadinessTables(untouched.db);
  untouched.sqlite.prepare("UPDATE integration_registry SET code_boundary_status='partial',notes='old stale note' WHERE integration_code='INT-VOICE-01'").run();
  await registry.ensureIntegrationReadinessTables(untouched.db);
  const advanced = untouched.sqlite.prepare("SELECT code_boundary_status,notes,readiness_state FROM integration_registry WHERE integration_code='INT-VOICE-01'").get();
  assert.equal(advanced.code_boundary_status, "code_ready");
  assert.match(advanced.notes, /No credentials in any environment/);
  assert.equal(advanced.readiness_state, "sandbox_setup_required", "the operational state is NOT advanced - there are still no credentials");
  const edited = await fresh();
  await registry.ensureIntegrationReadinessTables(edited.db);
  edited.sqlite.prepare("UPDATE integration_registry SET code_boundary_status='partial',notes='ops reviewed: do not change',updated_by='ops@pawspace.in' WHERE integration_code='INT-VOICE-01'").run();
  await registry.ensureIntegrationReadinessTables(edited.db);
  const kept = edited.sqlite.prepare("SELECT code_boundary_status,notes FROM integration_registry WHERE integration_code='INT-VOICE-01'").get();
  assert.equal(kept.code_boundary_status, "partial", "an operator's assessment is not overwritten by a seed");
  assert.equal(kept.notes, "ops reviewed: do not change");
});

test("the telephony credential list has exactly one definition", async () => {
  const gate = await import("../lib/voice-call-gate.ts");
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual([...gate.VOICE_TELEPHONY_SECRET_NAMES], ["EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID", "EXOTEL_VOICE_APP_ID", "EXOTEL_WEBHOOK_SECRET"]);
  for (const path of ["app/api/system-integration/route.ts", "lib/integration-readiness.ts"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /VOICE_TELEPHONY_SECRET_NAMES/, `${path} derives the list`);
    const inlineNames = (source.match(/EXOTEL_[A-Z_]+/g) || []).filter(name => name !== "EXOTEL_SUBDOMAIN");
    assert.deepEqual(inlineNames, [], `${path} must not re-declare credential names: ${inlineNames.join(", ")}`);
  }
  const registry = await import("../lib/integration-readiness.ts");
  void registry;
  const full = uatVoiceEnv();
  assert.equal(gate.telephonyCredentialsConfigured(full), true);
  for (const name of gate.VOICE_TELEPHONY_SECRET_NAMES) {
    assert.equal(gate.telephonyCredentialsConfigured({ ...full, [name]: "" }), false, `missing ${name}`);
  }
});

test("a negative provider status is never classified as connected", async () => {
  for (const [status, expected] of [
    ["disconnected", "provider_error"], ["not_connected", "provider_error"], ["Disconnected", "provider_error"],
    ["not_answered", "no_answer"], ["not-answered", "no_answer"], ["unanswered", "no_answer"], ["no-answer", "no_answer"],
    ["failed", "provider_error"], ["canceled", "provider_error"], ["rejected", "provider_error"], ["declined", "provider_error"],
    ["busy", "busy"],
    ["in-progress", "connected"], ["answered", "connected"], ["connected", "connected"],
  ]) {
    const { sqlite, db, env } = await fresh();
    const call = await dial(db, env, `neg-${status}`);
    assert.equal(call.dialled, true, status);
    const body = eventBody(call.callId, { CallStatus: status });
    const result = await gov.recordVoiceProviderEvent(db, env, { rawBody: body, headers: await signedHeaders(body) });
    assert.equal(result.accepted, true, status);
    assert.equal(state(sqlite, call.callId), expected, `${status} must map to ${expected}, got ${state(sqlite, call.callId)}`);
  }
});

test("the Exotel adapter refuses to exist on an incomplete configuration", async () => {
  const gate = await import("../lib/voice-call-gate.ts");
  const full = uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT: "" });
  assert.equal(telephony.exotelTelephony(full).status, "connected");
  for (const name of gate.VOICE_TELEPHONY_SECRET_NAMES) {
    const partial = telephony.exotelTelephony({ ...full, [name]: "" });
    assert.equal(partial.status, "not_connected", `missing ${name} must not report connected`);
    assert.equal(partial.productionCapable, false, `missing ${name} must not report production-capable`);
    await assert.rejects(() => partial.createCall({ callRef: "x", toNumber: "+919876543210", statusCallbackUrl: "https://uat.pawspace.in/api/voice-provider-webhook", recordingAllowed: false }), /not connected/);
  }
});

test("a caller cannot redirect the carrier's callbacks to an endpoint of their choosing", async () => {
  const { db, env } = await fresh();
  await gov.requestOutboundVoiceCall(db, { ...env, PAWSPACE_VOICE_TRANSPORT: telephony.LOCAL_SIMULATOR_PROVIDER }, {
    idempotencyKey: "cb-override", useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr",
    customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1",
    actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME,
    statusCallbackUrl: "https://exfil.example/collect", callbackUrl: "https://exfil.example/collect",
    PAWSPACE_VOICE_STATUS_CALLBACK_URL: "https://exfil.example/collect",
  });
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../lib/voice-outbound-governance.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /input\.statusCallbackUrl/, "there must be no per-call callback override");
  assert.match(source, /const callbackUrl = statusCallbackUrl\(env\)/);
  const exotelEnv = uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT: "" });
  const provider = telephony.exotelTelephony(exotelEnv);
  const base = { callRef: "VCALL-X", toNumber: "+919876543210", recordingAllowed: false };
  await assert.rejects(() => provider.createCall({ ...base, statusCallbackUrl: "https://exfil.example/collect" }), /does not match the approved environment callback/);
  await assert.rejects(() => provider.createCall({ ...base, statusCallbackUrl: "" }), /does not match the approved environment callback/);
  await assert.rejects(() => telephony.exotelTelephony({ ...exotelEnv, PAWSPACE_VOICE_STATUS_CALLBACK_URL: "" }).createCall({ ...base, statusCallbackUrl: exotelEnv.PAWSPACE_VOICE_STATUS_CALLBACK_URL }), /status callback URL is required/);
});

test("an oversized or stalled provider response does not hang or exhaust the dial", async () => {
  const env = uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT: "" });
  const provider = telephony.exotelTelephony(env);
  const intent = { callRef: "VCALL-X", toNumber: "+919876543210", statusCallbackUrl: env.PAWSPACE_VOICE_STATUS_CALLBACK_URL, recordingAllowed: false };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("x".repeat(200_000), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(() => provider.createCall(intent), /exceeded the size limit/);
    globalThis.fetch = async (_url, init) => new Response(
      new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"Call":')); init.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const started = Date.now();
    await assert.rejects(() => provider.createCall(intent), /did not respond within/);
    assert.ok(Date.now() - started < 20_000, "the stalled body hit the deadline");
  } finally { globalThis.fetch = original; }
});

test("the readiness migration survives the runtime credential sync", async () => {
  const registry = await import("../lib/integration-readiness.ts");
  for (const writer of ["system_seed", "runtime_presence_check"]) {
    const ctx = await fresh();
    await registry.ensureIntegrationReadinessTables(ctx.db);
    ctx.sqlite.prepare("UPDATE integration_registry SET code_boundary_status='partial',notes='stale',updated_by=? WHERE integration_code='INT-VOICE-01'").run(writer);
    await registry.ensureIntegrationReadinessTables(ctx.db);
    const row = ctx.sqlite.prepare("SELECT code_boundary_status,readiness_state FROM integration_registry WHERE integration_code='INT-VOICE-01'").get();
    assert.equal(row.code_boundary_status, "code_ready", `a row last written by ${writer} must advance`);
    assert.equal(row.readiness_state, "sandbox_setup_required", "but the operational state never advances");
  }
  const edited = await fresh();
  await registry.ensureIntegrationReadinessTables(edited.db);
  edited.sqlite.prepare("UPDATE integration_registry SET code_boundary_status='partial',updated_by='karthik@pawspace.in' WHERE integration_code='INT-VOICE-01'").run();
  await registry.ensureIntegrationReadinessTables(edited.db);
  assert.equal(edited.sqlite.prepare("SELECT code_boundary_status FROM integration_registry WHERE integration_code='INT-VOICE-01'").get().code_boundary_status, "partial");
});

test("a whitespace-only credential is not reported as configured anywhere", async () => {
  const gate = await import("../lib/voice-call-gate.ts");
  const blank = uatVoiceEnv({ EXOTEL_API_TOKEN: "   " });
  assert.equal(gate.telephonyCredentialsConfigured(blank), false);
  assert.deepEqual(gate.voiceCallReadiness(blank).missingSecretNames, ["EXOTEL_API_TOKEN"]);
  assert.equal(gate.resolveVoiceCallGate(blank).ok, false);
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/system-integration/route.ts", import.meta.url), "utf8");
  assert.match(route, /String\(runtime\[name\] \?\? ""\)\.trim\(\)\.length > 0/, "the readiness surface trims too");
});
