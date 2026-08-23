import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, FOUNDER_PERMISSIONS, DAYTIME } from "./helpers/voice-harness.mjs";

// ---------------------------------------------------------------------------
// What the voice layer is NOT allowed to do, executed.
//
// An automated caller that can move money, change a price or confirm a refund is the highest-impact
// failure mode in this lane, and it is not something a state machine or a consent gate prevents. So the
// assertion is made against the database: drive an entire call lifecycle - dial, connect, barge-in,
// speech failure, handoff, opt-out, complete - and prove the money and booking tables are byte-identical
// before and after.
//
// Also asserted here: the conversation itself stays on the existing governed AI orchestrator rather than
// a second agent living inside the dialler, and barge-in is actually recorded rather than merely
// accepted as a parameter.
// ---------------------------------------------------------------------------

installWorkersHooks("__VAB_DB__", "__VAB_ENV__");
const gov = await import("../lib/voice-outbound-governance.ts");

const MONEY_TABLES = ["booking_payments", "canonical_bookings", "provider_work_orders"];

async function fresh() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__VAB_DB__ = db;
  globalThis.__VAB_ENV__ = uatVoiceEnv();
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await gov.ensureVoiceCallTables(db);
  await gov.seedVoiceCallScripts(db);
  seedRecipient(sqlite);
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });

  // A real, paid booking for this customer, so "nothing moved" is a claim about actual rows.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, service_code TEXT, status TEXT, total_amount REAL, scheduled_start TEXT, scheduled_end TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY, booking_id TEXT, customer_id TEXT, amount REAL, status TEXT, method TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY, booking_id TEXT, provider_name TEXT, status TEXT, payout_amount REAL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount,scheduled_start,scheduled_end) VALUES ('BKG-V1','CON-V1','grooming','confirmed',1899,'2026-09-20T04:30:00.000Z','2026-09-20T06:30:00.000Z')").run();
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,method) VALUES ('PAY-V1','BKG-V1','CON-V1',1899,'captured','upi')").run();
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_name,status,payout_amount) VALUES ('WO-V1','BKG-V1','Meena R.','assigned',1200)").run();
  return { sqlite, db, env: globalThis.__VAB_ENV__ };
}

const moneySnapshot = (sqlite) => JSON.stringify(MONEY_TABLES.map(name => sqlite.prepare(`SELECT * FROM ${name} ORDER BY id`).all()));

async function placeCall(db, env, key) {
  return gov.requestOutboundVoiceCall(db, env, {
    idempotencyKey: key, useCase: "payment_recovery", phone: ALLOWLISTED_PHONE, cityId: "blr",
    customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1",
    actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME,
  });
}

test("a complete call lifecycle moves no money, no booking and no payout", async () => {
  const { sqlite, db, env } = await fresh();
  const before = moneySnapshot(sqlite);

  const call = await placeCall(db, env, "boundary-1");
  assert.equal(call.dialled, true);
  assert.equal(call.useCase, "payment_recovery", "the highest-temptation use case: chasing an unpaid booking");
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "provider:sim", asOf: DAYTIME });
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "speaking", reason: "disclosure", actor: "bot", asOf: DAYTIME });
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "listening", reason: "customer interrupted", actor: "bot", detail: { interrupted: true }, asOf: DAYTIME });
  await gov.recordVoiceSpeechFailure(db, { callId: call.callId, kind: "stt", reason: "provider timeout", actorId: "bot", asOf: DAYTIME });
  await gov.requestVoiceHumanHandoff(db, { callId: call.callId, reason: "STT failed, customer still on the line", actorId: "bot", asOf: DAYTIME });
  await gov.attachVoiceTranscript(db, { callId: call.callId, transcriptRef: "AIVCALL-XYZ", asOf: DAYTIME });
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "ended", reason: "closed out", actor: "bot", asOf: DAYTIME });

  assert.equal(moneySnapshot(sqlite), before, "no money, booking or payout row changed anywhere in the lifecycle");
  const audit = await gov.voiceCallAudit(db, call.callId);
  assert.equal(audit.call.state, "ended");
  assert.equal(audit.call.transcriptRef, "AIVCALL-XYZ");
  assert.ok(audit.call.handoffCaseId, "the human got a real case");
});

test("an opt-out spoken during a payment-recovery call still moves no money", async () => {
  const { sqlite, db, env } = await fresh();
  const before = moneySnapshot(sqlite);
  const call = await placeCall(db, env, "boundary-2");
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "provider:sim", asOf: DAYTIME });
  await gov.recordVoiceOptOutDuringCall(db, { callId: call.callId, reason: "do not call", actorId: "bot", asOf: DAYTIME });
  assert.equal(moneySnapshot(sqlite), before);
  // And the unpaid booking is untouched: the bot recorded a preference, not a financial outcome.
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-V1'").get().status, "captured");
});

test("the voice governance module exposes no money, price or refund operation", async () => {
  const exported = Object.keys(gov).filter(name => typeof gov[name] === "function");
  assert.ok(exported.length > 10, "the module really does export its API");
  const forbidden = exported.filter(name => /payment|refund|price|pricing|invoice|payout|charge|capture|wallet|credit|discount|coupon/i.test(name));
  assert.deepEqual(forbidden, [], `voice must not expose a money operation: ${forbidden.join(", ")}`);
  // paymentRecovery is a call USE CASE, not a money operation - it may only talk about a booking.
  assert.ok(gov.VOICE_USE_CASES.some(useCase => useCase.code === "payment_recovery"));
  assert.ok(gov.VOICE_USE_CASES.every(useCase => useCase.purpose !== "auth"), "voice never carries an auth/OTP purpose");
});

test("barge-in is recorded on the transition, not merely accepted", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await placeCall(db, env, "barge-1");
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "provider:sim", asOf: DAYTIME });
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "speaking", reason: "reading the disclosure", actor: "bot", asOf: DAYTIME });
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "listening", reason: "customer interrupted the bot", actor: "bot", detail: { interrupted: true }, asOf: DAYTIME });
  const step = sqlite.prepare("SELECT to_state,reason,detail_json FROM voice_call_state_transitions WHERE call_id=? ORDER BY sequence DESC LIMIT 1").get(call.callId);
  assert.equal(step.to_state, "listening");
  assert.equal(JSON.parse(step.detail_json).interrupted, true, "the interruption is in the audit trail");
  assert.match(step.reason, /interrupted/);
  // The bot may keep talking after an interruption, but it may not skip back past the customer's turn.
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "speaking", reason: "resuming", actor: "bot", asOf: DAYTIME });
  await assert.rejects(() => gov.transitionVoiceCall(db, { callId: call.callId, to: "speaking", reason: "again", actor: "bot" }), /Illegal voice call transition speaking -> speaking/);
});

test("the conversation is linked to the existing governed AI call, not to a second agent", async () => {
  const { sqlite, db, env } = await fresh();
  const call = await placeCall(db, env, "link-1");
  await gov.attachVoiceTranscript(db, { callId: call.callId, transcriptRef: "AIVCALL-LINK", aiCallId: "AIVCALL-LINK", asOf: DAYTIME });
  assert.equal(sqlite.prepare("SELECT ai_call_id FROM voice_call_orders WHERE id=?").get(call.callId).ai_call_id, "AIVCALL-LINK");
  // The dialler owns no AI turn of its own: orchestration stays where it already was.
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../lib/voice-outbound-governance.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /orchestrateAiTurn|ai\.run\(|runAiModel/, "the dialler must not run its own model turns");
  const harness = await import("../lib/ai-voice-uat.ts");
  assert.equal(typeof harness.recordAiVoiceTranscriptSegment, "function", "transcript turns still go through the existing governed harness");
});

test("a call cannot be created for a use case whose purpose the platform does not govern", async () => {
  const { db, env } = await fresh();
  for (const useCase of ["auth", "otp", "collections", ""]) {
    const result = await gov.requestOutboundVoiceCall(db, env, {
      idempotencyKey: `ungoverned-${useCase || "blank"}`, useCase, phone: ALLOWLISTED_PHONE, cityId: "blr",
      customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1",
      actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME,
    });
    assert.equal(result.dialled, false, useCase);
    assert.equal(result.state, "blocked_use_case");
  }
});
