import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, uatVoiceEnv, ALLOWLISTED_PHONE, DAYTIME } from "./helpers/voice-harness.mjs";

// Automated outbound Audio Bot service-recovery (lib/audio-bot-recovery.ts). Drives the REAL orchestrator
// against the governed outbound-voice path (requestOutboundVoiceCall -> the voice safety gate) and the
// local simulator transport: a provider-lateness/no-show signal places a governed service_recovery bot
// call, strict per-(booking,reason) tracking prevents loops and redundant dials, and the bot escalates to
// a human when it is capped, opted-out, or the customer asks for an agent. Every guard is sabotage-verified.

installWorkersHooks("__ABR_DB__", "__ABR_ENV__");
const abr = await import("../lib/audio-bot-recovery.ts");
const gov = await import("../lib/voice-outbound-governance.ts");

const H = 3_600_000;
async function world() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__ABR_DB__ = db;
  globalThis.__ABR_ENV__ = uatVoiceEnv();
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,status TEXT);
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,primary_phone TEXT);
  `);
  await gov.ensureVoiceCallTables(db);
  await gov.seedVoiceCallScripts(db);
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CUS-1", granted: true, source: "booking_form", actorId: "ops@pawspace.in", asOf: DAYTIME });
  return { sqlite, db, env: globalThis.__ABR_ENV__ };
}
function seedBooking(sqlite, { id = "BKG-1", customerId = "CUS-1", status = "in_progress" } = {}) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,status) VALUES (?,?,?,?)").run(id, customerId, "blr", status);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,primary_phone) VALUES (?,?)").run(customerId, ALLOWLISTED_PHONE);
}
const track = (sqlite, id = "BKG-1", reason = "provider_late") => sqlite.prepare("SELECT * FROM audio_bot_recovery_attempts WHERE booking_id=? AND recovery_reason=?").get(id, reason);
const dialCount = (sqlite, id = "BKG-1") => sqlite.prepare("SELECT COUNT(*) c FROM voice_call_orders WHERE booking_id=?").get(id).c;
const trigger = (ctx, opts) => abr.triggerAudioBotRecovery(ctx.db, ctx.env, { bookingId: "BKG-1", recoveryReason: "provider_late", actorId: "ops@pawspace.in", ...opts });
const settle = (ctx, outcome, asOf) => abr.settleAudioBotRecovery(ctx.db, { bookingId: "BKG-1", recoveryReason: "provider_late", outcome, actorId: "ops@pawspace.in", asOf });

test("a lateness signal places a GOVERNED service_recovery bot call; the ledger stores no phone number", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite, { status: "in_progress" });
  const res = await trigger(ctx, { asOf: DAYTIME });
  assert.equal(res.ok, true);
  assert.equal(res.status, "calling");
  assert.equal(res.attempt, 1);
  assert.ok(res.callId);
  const call = ctx.sqlite.prepare("SELECT use_case,booking_id FROM voice_call_orders WHERE id=?").get(res.callId);
  assert.equal(call.use_case, "service_recovery", "the dial went through the governed service_recovery use case");
  assert.equal(call.booking_id, "BKG-1");
  const row = track(ctx.sqlite);
  assert.equal(row.status, "calling");
  assert.equal(row.attempt_count, 1);
  assert.ok(!JSON.stringify(row).includes(ALLOWLISTED_PHONE), "the customer's number is never stored in the recovery ledger");
});

test("a non service-recovery reason is refused (bots do not cold-dial for anything else)", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite);
  const res = await abr.triggerAudioBotRecovery(ctx.db, ctx.env, { bookingId: "BKG-1", recoveryReason: "upsell_offer", actorId: "ops@pawspace.in", asOf: DAYTIME });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unsupported_recovery_reason");
});

test("loop prevention: a track already in-flight ('calling') is not dialled again", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite);
  await trigger(ctx, { asOf: DAYTIME });
  const again = await trigger(ctx, { asOf: DAYTIME });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, "call_in_flight");
  assert.equal(dialCount(ctx.sqlite), 1, "a redundant trigger placed no second dial");
});

test("strict cap: after MAX_BOT_ATTEMPTS the bot escalates to a human and never dials again", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite);
  // Attempt 1, then a fresh frequency window 25h later for attempt 2.
  await trigger(ctx, { asOf: DAYTIME });
  await settle(ctx, "no_answer", DAYTIME);
  assert.equal(track(ctx.sqlite).status, "pending_retry");
  await trigger(ctx, { asOf: DAYTIME + 25 * H });
  assert.equal(track(ctx.sqlite).attempt_count, 2);
  const escalated = await settle(ctx, "no_answer", DAYTIME + 25 * H);
  assert.equal(escalated.status, "escalated");
  const row = track(ctx.sqlite);
  assert.equal(row.status, "escalated");
  assert.ok(row.escalation_case_id, "a human intervention case was created");
  const unified = ctx.sqlite.prepare("SELECT source_type,booking_id FROM unified_cases WHERE id=?").get(row.escalation_case_id);
  assert.equal(unified.source_type, "audio_bot_recovery");
  // A further trigger is a no-op, and only two dials were ever placed.
  const after = await trigger(ctx, { asOf: DAYTIME + 50 * H });
  assert.equal(after.skipped, true);
  assert.equal(after.reason, "already_escalated");
  assert.equal(dialCount(ctx.sqlite), 2, "never a third dial");
});

test("an opted-out customer is never dialled by the bot; it escalates to a human immediately", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite);
  await gov.recordVoiceOptOut(ctx.db, { phone: ALLOWLISTED_PHONE, source: "customer_request", reason: "do not call", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const res = await trigger(ctx, { asOf: DAYTIME });
  assert.equal(res.status, "escalated");
  assert.equal(res.reason, "recipient_uncallable_by_bot");
  assert.ok(res.caseId);
  assert.equal(track(ctx.sqlite).status, "escalated");
});

test("a customer who acknowledges resolves the recovery without a human", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite);
  await trigger(ctx, { asOf: DAYTIME });
  const res = await settle(ctx, "acknowledged", DAYTIME);
  assert.equal(res.status, "resolved");
  assert.equal(track(ctx.sqlite).status, "resolved");
  const after = await trigger(ctx, { asOf: DAYTIME + H });
  assert.equal(after.skipped, true);
  assert.equal(after.reason, "already_resolved");
});

test("the sweep re-drives a pending_retry track (the automated driver)", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite);
  await trigger(ctx, { asOf: DAYTIME });
  await settle(ctx, "no_answer", DAYTIME);
  assert.equal(track(ctx.sqlite).status, "pending_retry");
  const sweep = await abr.runAudioBotRecoverySweep(ctx.db, ctx.env, { asOf: DAYTIME + 25 * H });
  assert.equal(sweep.redialled, 1);
  assert.equal(sweep.ok, true);
  const row = track(ctx.sqlite);
  assert.equal(row.status, "calling");
  assert.equal(row.attempt_count, 2);
});

test("the sweep rescues a call whose disposition was lost (stale 'calling' -> a fresh attempt), never throwing", async () => {
  const ctx = await world();
  seedBooking(ctx.sqlite);
  await trigger(ctx, { asOf: DAYTIME }); // status 'calling', updated_at = DAYTIME
  // 25h later the call is still 'calling' - its disposition never arrived. The sweep must rescue it.
  const sweep = await abr.runAudioBotRecoverySweep(ctx.db, ctx.env, { asOf: DAYTIME + 25 * H });
  assert.equal(sweep.rescued, 1);
  assert.equal(sweep.ok, true);
  // The stale attempt was settled as no-answer and a fresh dial placed (attempt 2).
  assert.equal(track(ctx.sqlite).status, "calling");
  assert.equal(track(ctx.sqlite).attempt_count, 2);
});
