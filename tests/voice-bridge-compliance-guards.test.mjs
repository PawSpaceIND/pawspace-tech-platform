import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";

// ---------------------------------------------------------------------------
// Two compliance guards on the masked bridge, EXECUTED against a real database.
//
// Both gaps were real at bfac8c55. The bridge gated on the environment, the allow-list, the service
// window and booking ownership — and:
//
//   1. never consulted voice_call_opt_outs. recordVoiceOptOut() writes that register from an IVR "do
//      not call", from the CRM and from a mid-call opt-out, and requestOutboundVoiceCall refuses on it.
//      So one number was simultaneously undialable by the automated dialler and dialable by a bridge.
//
//   2. gated recording on callRecordingApproved(env) — the flag written for a call where one party is a
//      bot and the seeded script says out loud that the call may be automated. A bridge has no script
//      and no disclosure, so switching bot recording on would have started recording two real people
//      who were told nothing.
//
// The voice env is left unconfigured for the opt-out cases, which makes the outcomes cleanly separable
// without ever contacting Exotel — the same technique tests/voice-bridge-service-window.test.mjs uses:
//   refused by a guard BEFORE the dial -> 403 (or 409)
//   admitted by every guard            -> reaches resolveVoiceCallGate and stops at 503
// A 503 is therefore proof the guards let the caller through, which is what stops these tests passing
// vacuously if a guard is deleted.
// ---------------------------------------------------------------------------

installWorkersHooks("__VCG_DB__", "__VCG_ENV__");

const CUSTOMER_PHONE = "+919000000001";
const PROVIDER_PHONE = "+919000000002";

const SCHEMA = [
  "CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL)",
  "CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,primary_phone TEXT)",
  "CREATE TABLE canonical_providers (id TEXT PRIMARY KEY,phone TEXT)",
  "CREATE TABLE provider_work_orders (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL)",
];

const PROVIDER_ACTOR = {
  email: "walker@pawspace.in", name: "Walker", roleCode: "service_provider", permissions: [],
  developmentPreview: false, identitySource: "partner_otp", principalType: "email",
  principalKey: "walker@pawspace.in",
};

async function world(env = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__VCG_DB__ = db;
  globalThis.__VCG_ENV__ = env;
  for (const sql of SCHEMA) sqlite.exec(sql);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUST-1','PRV-1','assigned')").run();
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUST-1',?)").run(CUSTOMER_PHONE);
  sqlite.prepare("INSERT INTO canonical_providers VALUES ('PRV-1',?)").run(PROVIDER_PHONE);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('BK-1','PRV-1','accepted')").run();

  const bridge = await import("../lib/voice-bridge-governance.ts");
  // Ownership is real, not bypassed: the provider is bound to PRV-1 through identity_bindings, so a
  // pass here is a guard opening, never a permission shortcut.
  const { ensureIdentityBindingTables } = await import("../lib/identity-binding.ts");
  await ensureIdentityBindingTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO identity_bindings (id,identity_source,principal_type,principal_key,subject_type,subject_id,status,verification_state,created_by,updated_by,created_at,updated_at) VALUES ('IB-1','partner_otp','email','walker@pawspace.in','provider','PRV-1','active','verified','seed','seed',?,?)").run(now, now);
  await bridge.ensureVoiceBridgeTables(db);
  return { sqlite, db, bridge, env };
}

async function attempt(bridge, db, env = {}, key = `idem-${crypto.randomUUID()}`) {
  try {
    await bridge.requestVoiceBridge(db, env, PROVIDER_ACTOR, { bookingId: "BK-1", idempotencyKey: key });
    return { status: 200, body: "" };
  } catch (error) {
    if (error instanceof Response) return { status: error.status, body: await error.clone().text() };
    throw error;
  }
}

const sessions = (sqlite) => sqlite.prepare("SELECT * FROM voice_call_sessions").all();

// --- the opt-out register -------------------------------------------------

test("VCG-01: a customer on the do-not-call register cannot be bridged, and no session is opened", async () => {
  const { sqlite, db, bridge, env } = await world();
  const { recordVoiceOptOut } = await import("../lib/voice-outbound-governance.ts");
  // Recorded through the REAL writer, not a hand-written INSERT. That is the point: if the guard
  // derived its lookup key any other way than normalisedDialKey it would read a register this row
  // never lands in, and a hand-written fixture would hide it.
  await recordVoiceOptOut(db, { phone: CUSTOMER_PHONE, source: "ivr_do_not_call", actorId: "system" });

  const result = await attempt(bridge, db, env);
  assert.equal(result.status, 403, `expected a governed refusal, got ${result.status}: ${result.body}`);
  assert.match(result.body, /do-not-call register/);
  assert.equal(sessions(sqlite).length, 0, "a refused request leaves no session row behind");
});

test("VCG-02: the PROVIDER's opt-out refuses the bridge too, not just the customer's", async () => {
  const { sqlite, db, bridge, env } = await world();
  const { recordVoiceOptOut } = await import("../lib/voice-outbound-governance.ts");
  await recordVoiceOptOut(db, { phone: PROVIDER_PHONE, source: "crm", actorId: "system" });

  const result = await attempt(bridge, db, env);
  assert.equal(result.status, 403, `expected a governed refusal, got ${result.status}: ${result.body}`);
  assert.match(result.body, /provider number is on the do-not-call register/);
  assert.equal(sessions(sqlite).length, 0);
});

test("VCG-03: with the register empty the same request is admitted, so the guard is not refusing everything", async () => {
  const { db, bridge, env } = await world();
  const result = await attempt(bridge, db, env);
  // 503 = it got past every guard and stopped at the unconfigured voice gate. Without this assertion
  // VCG-01 and VCG-02 would still pass if the guard refused unconditionally.
  assert.equal(result.status, 503, `an un-opted-out pair should reach the voice gate, got ${result.status}: ${result.body}`);
});

test("VCG-04: a refusal names the source but never the digits it protects", async () => {
  const { db, bridge, env } = await world();
  const { recordVoiceOptOut } = await import("../lib/voice-outbound-governance.ts");
  await recordVoiceOptOut(db, { phone: CUSTOMER_PHONE, source: "ivr_do_not_call", actorId: "system" });

  const result = await attempt(bridge, db, env);
  assert.match(result.body, /ivr_do_not_call/, "the source is named, so an operator can see why");
  for (const fragment of [CUSTOMER_PHONE, CUSTOMER_PHONE.slice(-10), CUSTOMER_PHONE.slice(-4)]) {
    assert.ok(!result.body.includes(fragment), `the refusal must not leak ${fragment}`);
  }
});

test("VCG-05: an opt-out recorded in the gap before the dial still wins, and closes the session", async () => {
  const { sqlite, db, bridge, env } = await world();
  const { recordVoiceOptOut } = await import("../lib/voice-outbound-governance.ts");
  // The check-then-act window itself: the hook fires immediately before the session INSERT, which is
  // after the first opt-out check has already passed. The pre-dial re-read is what has to catch it.
  db.onSql("INSERT INTO voice_call_sessions", async () => {
    await recordVoiceOptOut(db, { phone: CUSTOMER_PHONE, source: "mid_call_opt_out", actorId: "system" });
  });

  const result = await attempt(bridge, db, env);
  assert.equal(result.status, 403, `expected the late opt-out to win, got ${result.status}: ${result.body}`);
  const [session] = sessions(sqlite);
  assert.ok(session, "the session was already open when the opt-out landed");
  assert.equal(session.status, "failed", "it is closed out rather than left open");
  assert.equal(session.failure_code, "opt_out_recorded");
  assert.equal(session.exotel_call_id, null, "no carrier call id exists - nothing was dialled");
});

// --- two-party recording --------------------------------------------------

test("VCG-06: bridge recording needs its own approval, and the bridge flag alone is not a bypass", async () => {
  const { bridge } = await world();
  const cases = [
    [{}, false, "neither flag"],
    [{ PAWSPACE_VOICE_RECORDING_APPROVED: "true" }, false, "the bot dialler's approval does not record two real people"],
    [{ PAWSPACE_VOICE_BRIDGE_RECORDING_APPROVED: "true" }, false, "the bridge flag adds to the platform gate rather than replacing it"],
    [{ PAWSPACE_VOICE_RECORDING_APPROVED: "true", PAWSPACE_VOICE_BRIDGE_RECORDING_APPROVED: "true" }, true, "both, deliberately"],
    [{ PAWSPACE_VOICE_RECORDING_APPROVED: "true", PAWSPACE_VOICE_BRIDGE_RECORDING_APPROVED: "yes" }, false, "only the exact string true"],
  ];
  for (const [env, expected, why] of cases) {
    assert.equal(bridge.bridgeRecordingApproved(env), expected, why);
  }
});

test("VCG-07: an unapproved carrier recording URL is discarded, not stored", async () => {
  const secret = "uat-bridge-secret";
  const signed = (body) => {
    const timestamp = String(Date.now());
    return new Request("https://uat.pawspace.in/api/webhooks/exotel/call-event", {
      method: "POST", body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-pawspace-voice-signature": createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
        "x-pawspace-voice-timestamp": timestamp,
      },
    });
  };

  // A session to attach the event to, inserted directly: this case is about the recording decision, not
  // about the dial path (which the cases above already cover).
  async function seedSession(sqlite, db, bridge) {
    await bridge.ensureVoiceBridgeTables(db);
    const now = Date.now();
    sqlite.prepare("INSERT INTO voice_call_sessions (id,idempotency_key,booking_id,customer_id,provider_id,initiated_by_type,initiated_by_key,service_status,status,provider,customer_phone_hash,customer_phone_last4,provider_phone_hash,provider_phone_last4,initiated_at,updated_at) VALUES ('VB-1','k1','BK-1','CUST-1','PRV-1','provider','walker@pawspace.in','accepted','initiated','exotel','h1','0001','h2','0002',?,?)").run(now, now);
  }
  const payload = new URLSearchParams({ CallSid: "CARRIER-REC-1", CallStatus: "completed", CustomField: "VB-1", RecordingUrl: "https://recordings.exotel.example/abc.mp3" }).toString();

  const unapproved = await world({ EXOTEL_WEBHOOK_SECRET: secret, PAWSPACE_VOICE_RECORDING_APPROVED: "true" });
  await seedSession(unapproved.sqlite, unapproved.db, unapproved.bridge);
  const refused = await unapproved.bridge.recordVoiceBridgeEvent(unapproved.db, unapproved.env, { rawBody: payload, headers: signed(payload).headers });
  assert.equal(refused.accepted, true, "the event itself is still processed");
  assert.equal(refused.recordingStored, false, "no recording reference is kept without bridge approval");
  assert.equal(unapproved.sqlite.prepare("SELECT recording_ref FROM voice_call_sessions WHERE id='VB-1'").get().recording_ref, null);
  assert.equal(unapproved.sqlite.prepare("SELECT recording_ref FROM voice_call_session_events WHERE session_id='VB-1'").get().recording_ref, null,
    "and it is not retained on the event row either");

  const approved = await world({ EXOTEL_WEBHOOK_SECRET: secret, PAWSPACE_VOICE_RECORDING_APPROVED: "true", PAWSPACE_VOICE_BRIDGE_RECORDING_APPROVED: "true" });
  await seedSession(approved.sqlite, approved.db, approved.bridge);
  const stored = await approved.bridge.recordVoiceBridgeEvent(approved.db, approved.env, { rawBody: payload, headers: signed(payload).headers });
  assert.equal(stored.recordingStored, true, "with both approvals the reference is kept");
  assert.match(String(approved.sqlite.prepare("SELECT recording_ref FROM voice_call_sessions WHERE id='VB-1'").get().recording_ref), /abc\.mp3/);
});

// --- the register cannot be silently absent -------------------------------

test("VCG-08: the bridge declares the opt-out register itself, so the check can never pass for want of a table", async () => {
  const { sqlite } = await world();
  // ensureVoiceBridgeTables ran without lib/voice-outbound-governance having been asked to set up. If
  // the register were only created over there, a cold database would make the guard throw - and the
  // obvious fix for that (catching the error) silently turns "unknown" into "not opted out".
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voice_call_opt_outs'").get();
  assert.ok(table, "the do-not-call register exists after the bridge's own ensure");
});
