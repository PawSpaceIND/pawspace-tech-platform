import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, uatVoiceEnv } from "./helpers/voice-harness.mjs";

// Two-leg number-masked voice bridge (lib/voice-bridge-governance.ts). Drives the REAL governance against
// the local simulator transport: a bound party to an active booking can connect to the other party; the
// two real numbers are resolved server-side and NEVER stored; recording is off unless the environment
// approves it AND the caller opts in; the callback is signature-verified, deduplicated and out-of-order
// safe. Every gate is sabotage-verified in the accompanying run.

installWorkersHooks("__VBR_DB__", "__VBR_ENV__");
const bridge = await import("../lib/voice-bridge-governance.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");

const CUSTOMER_PHONE = "9876543210", PROVIDER_PHONE = "9876500000", MASKING = "08000000000";
const bridgeEnv = (extra = {}) => ({ ...uatVoiceEnv(), PAWSPACE_VOICE_UAT_ALLOWLIST: `${CUSTOMER_PHONE},${PROVIDER_PHONE}`, ...extra });

async function world(envOverrides = {}) {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__VBR_DB__ = db;
  globalThis.__VBR_ENV__ = bridgeEnv(envOverrides);
  await ensureSecurityTables(db); // creates customer_identity_links + provider_identity_links + identity bindings
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT);
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,primary_phone TEXT);
    CREATE TABLE canonical_providers (id TEXT PRIMARY KEY,phone TEXT);
  `);
  return { sqlite, db, env: globalThis.__VBR_ENV__ };
}
function seedBooking(sqlite, { id = "BKG-1", customerId = "CUS-1", providerId = "PRV-1", status = "in_progress", start, end } = {}) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,status,scheduled_start,scheduled_end) VALUES (?,?,?,?,?,?)")
    .run(id, customerId, providerId, status, start ?? new Date(now - 3_600_000).toISOString(), end ?? new Date(now + 3_600_000).toISOString());
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,primary_phone) VALUES (?,?)").run(customerId, CUSTOMER_PHONE);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_providers (id,phone) VALUES (?,?)").run(providerId, PROVIDER_PHONE);
}
const linkCustomer = (sqlite, email, id) => sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, id, Date.now(), Date.now());
const linkProvider = (sqlite, email, id) => sqlite.prepare("INSERT OR REPLACE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, id, Date.now(), Date.now());
const actor = (email) => ({ email, identitySource: "workspace", principalType: "email", principalKey: email });
const sessionRow = (sqlite, id) => sqlite.prepare("SELECT * FROM voice_bridge_sessions WHERE id=?").get(id);

const bytes = (v) => new TextEncoder().encode(v);
async function sign(secret, timestamp, body) {
  const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, bytes(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function signedHeaders(body, { secret = "test-webhook-secret", timestamp = Date.now(), signature } = {}) {
  return new Headers({ "x-pawspace-voice-timestamp": String(timestamp), "x-pawspace-voice-signature": signature ?? await sign(secret, timestamp, body) });
}
const callbackBody = (fields) => new URLSearchParams(fields).toString();

test("a bound provider can bridge an active booking; NEITHER party's number is stored (masking)", async () => {
  const { sqlite, db, env } = await world();
  seedBooking(sqlite, { status: "in_progress" });
  linkProvider(sqlite, "prov@pawspace.test", "PRV-1");
  const res = await bridge.initiateVoiceBridge(db, env, { bookingId: "BKG-1", actor: actor("prov@pawspace.test") });
  assert.equal(res.ok, true);
  assert.equal(res.status, "initiating");
  assert.equal(res.recording, false, "recording is OFF by default");
  assert.match(res.provider, /simulator/);
  assert.equal(res.maskingNumber, MASKING);
  const row = sessionRow(sqlite, res.sessionId);
  assert.equal(row.initiator_type, "provider");
  assert.equal(row.provider_id, "PRV-1");
  assert.equal(row.customer_id, "CUS-1");
  assert.equal(row.recording_status, "not_recorded");
  assert.ok(String(row.provider_call_sid).startsWith("SIMBRIDGE-"), "the two-number connect primitive was used, not the one-leg dial");
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(CUSTOMER_PHONE), "the pet parent's number is never stored");
  assert.ok(!serialized.includes(PROVIDER_PHONE), "the provider's number is never stored");
});

test("a non-party is refused (403)", async () => {
  const { sqlite, db, env } = await world();
  seedBooking(sqlite);
  const res = await bridge.initiateVoiceBridge(db, env, { bookingId: "BKG-1", actor: actor("stranger@pawspace.test") });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.reason, "not_a_party_to_this_booking");
});

test("a booking outside the active service window is refused (409)", async () => {
  const { sqlite, db, env } = await world();
  seedBooking(sqlite, { status: "completed" });
  linkCustomer(sqlite, "parent@pawspace.test", "CUS-1");
  const res = await bridge.initiateVoiceBridge(db, env, { bookingId: "BKG-1", actor: actor("parent@pawspace.test") });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.reason, "booking_not_in_active_window");
});

test("recording is OFF unless the environment approves it AND the caller opts in", async () => {
  // (a) opt-in but the environment has not approved recording -> off
  const a = await world();
  seedBooking(a.sqlite); linkCustomer(a.sqlite, "p@pawspace.test", "CUS-1");
  const ra = await bridge.initiateVoiceBridge(a.db, a.env, { bookingId: "BKG-1", actor: actor("p@pawspace.test"), recordRequested: true });
  assert.equal(ra.recording, false);
  assert.equal(sessionRow(a.sqlite, ra.sessionId).recording_status, "not_recorded");
  // (b) environment approved + explicit opt-in -> on
  const b = await world({ PAWSPACE_VOICE_RECORDING_APPROVED: "true" });
  seedBooking(b.sqlite); linkCustomer(b.sqlite, "p@pawspace.test", "CUS-1");
  const rb = await bridge.initiateVoiceBridge(b.db, b.env, { bookingId: "BKG-1", actor: actor("p@pawspace.test"), recordRequested: true });
  assert.equal(rb.recording, true);
  assert.equal(sessionRow(b.sqlite, rb.sessionId).recording_status, "pending");
  // (c) environment approved but NO opt-in -> off
  const c = await world({ PAWSPACE_VOICE_RECORDING_APPROVED: "true" });
  seedBooking(c.sqlite); linkCustomer(c.sqlite, "p@pawspace.test", "CUS-1");
  const rc = await bridge.initiateVoiceBridge(c.db, c.env, { bookingId: "BKG-1", actor: actor("p@pawspace.test") });
  assert.equal(rc.recording, false);
});

test("a UAT party whose number is not allow-listed is refused", async () => {
  const { sqlite, db, env } = await world({ PAWSPACE_VOICE_UAT_ALLOWLIST: CUSTOMER_PHONE }); // provider number omitted
  seedBooking(sqlite);
  linkProvider(sqlite, "prov@pawspace.test", "PRV-1");
  const res = await bridge.initiateVoiceBridge(db, env, { bookingId: "BKG-1", actor: actor("prov@pawspace.test") });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "recipient_not_allowlisted");
});

test("the environment gate is fail-closed (no approval -> 503)", async () => {
  const { sqlite, db, env } = await world({ PAWSPACE_VOICE_UAT_APPROVED: "" });
  seedBooking(sqlite);
  linkProvider(sqlite, "prov@pawspace.test", "PRV-1");
  const res = await bridge.initiateVoiceBridge(db, env, { bookingId: "BKG-1", actor: actor("prov@pawspace.test") });
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
});

test("callback: a signed status advances the session; recording stored only when opted-in; dup applies once; forged rejected", async () => {
  const { sqlite, db, env } = await world({ PAWSPACE_VOICE_RECORDING_APPROVED: "true" });
  seedBooking(sqlite); linkProvider(sqlite, "prov@pawspace.test", "PRV-1");
  const init = await bridge.initiateVoiceBridge(db, env, { bookingId: "BKG-1", actor: actor("prov@pawspace.test"), recordRequested: true });
  const sid = sessionRow(sqlite, init.sessionId).provider_call_sid;

  const completedBody = callbackBody({ CallSid: sid, CustomField: init.sessionId, CallStatus: "completed", CallDuration: "42" });
  const r1 = await bridge.recordVoiceBridgeCallback(db, env, { rawBody: completedBody, headers: await signedHeaders(completedBody) });
  assert.equal(r1.status, 200); assert.equal(r1.matched, true); assert.equal(r1.kind, "completed");
  let row = sessionRow(sqlite, init.sessionId);
  assert.equal(row.status, "completed"); assert.ok(row.ended_at > 0);
  // The stored event carries a digest of the body, never the raw provider payload.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_bridge_events WHERE session_id=?").get(init.sessionId).c, 1);

  const recBody = callbackBody({ CallSid: `${sid}-r`, CustomField: init.sessionId, EventType: "recording", RecordingUrl: "https://rec.exotel/xyz.mp3", CallDuration: "42" });
  const r2 = await bridge.recordVoiceBridgeCallback(db, env, { rawBody: recBody, headers: await signedHeaders(recBody) });
  assert.equal(r2.kind, "recording_available");
  row = sessionRow(sqlite, init.sessionId);
  assert.equal(row.recording_status, "recorded");
  assert.equal(row.recording_reference, "https://rec.exotel/xyz.mp3");

  const dup = await bridge.recordVoiceBridgeCallback(db, env, { rawBody: completedBody, headers: await signedHeaders(completedBody) });
  assert.equal(dup.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM voice_bridge_events WHERE session_id=?").get(init.sessionId).c, 2, "duplicate produced no new event");

  const forged = await bridge.recordVoiceBridgeCallback(db, env, { rawBody: completedBody, headers: await signedHeaders(completedBody, { signature: "0".repeat(64) }) });
  assert.equal(forged.accepted, false); assert.equal(forged.status, 401);
});

test("callback: a recording URL is IGNORED when the session did not opt in to recording", async () => {
  const { sqlite, db, env } = await world(); // recording NOT approved -> session recording_status 'not_recorded'
  seedBooking(sqlite); linkProvider(sqlite, "prov@pawspace.test", "PRV-1");
  const init = await bridge.initiateVoiceBridge(db, env, { bookingId: "BKG-1", actor: actor("prov@pawspace.test"), recordRequested: true });
  const recBody = callbackBody({ CallSid: "X", CustomField: init.sessionId, EventType: "recording", RecordingUrl: "https://rec.exotel/should-not-store.mp3" });
  await bridge.recordVoiceBridgeCallback(db, env, { rawBody: recBody, headers: await signedHeaders(recBody) });
  const row = sessionRow(sqlite, init.sessionId);
  assert.equal(row.recording_status, "not_recorded");
  assert.equal(row.recording_reference, null, "a stray recording URL is not stored when recording was never approved");
});

test("callback: an unknown call reference is acknowledged (202) but matches nothing", async () => {
  const { db, env } = await world();
  const body = callbackBody({ CallSid: "EX-nope", CustomField: "NOPE", CallStatus: "completed" });
  const res = await bridge.recordVoiceBridgeCallback(db, env, { rawBody: body, headers: await signedHeaders(body) });
  assert.equal(res.status, 202);
  assert.equal(res.matched, false);
});
