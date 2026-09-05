import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, FOUNDER_PERMISSIONS, DAYTIME } from "./helpers/voice-harness.mjs";

installWorkersHooks("__TS_DB__", "__TS_ENV__");
const trust = await import("../lib/trust-safety-governance.ts");
const blocklist = await import("../lib/trust-safety-blocklist.ts");
const voice = await import("../lib/voice-outbound-governance.ts");

async function freshTrustDb() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__TS_DB__ = db;
  globalThis.__TS_ENV__ = uatVoiceEnv();
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,primary_phone TEXT,secondary_phone TEXT,updated_at INTEGER);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT,status TEXT);
    CREATE TABLE canonical_providers (id TEXT PRIMARY KEY,phone TEXT);
    CREATE TABLE provider_work_orders (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,live INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,customer_id TEXT,opt_out INTEGER DEFAULT 0,updated_at INTEGER);
  `);
  await trust.ensureTrustSafetyTables(db);
  const now = DAYTIME;
  sqlite.prepare("INSERT INTO canonical_customers (id,primary_phone,secondary_phone,updated_at) VALUES (?,?,NULL,?)").run("CUST-TS-1", "+919876543210", now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,status) VALUES (?,?,?,'confirmed')").run("BKG-TS-1", "CUST-TS-1", "PRV-TS-1");
  sqlite.prepare("INSERT INTO canonical_providers (id,phone) VALUES (?,?)").run("PRV-TS-1", "+919000000002");
  sqlite.prepare("INSERT INTO provider_work_orders (booking_id,provider_id,status) VALUES (?,?,?)").run("BKG-TS-1", "PRV-TS-1", "assigned");
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,live,status,updated_at) VALUES (?,1,'active',?)").run("PRV-TS-1", now);
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,NULL,NULL,'open',NULL,NULL,?,?)").run("THREAD-TS-1", "CUST-TS-1", "BKG-TS-1", now, now);
  return { sqlite, db, now };
}

test("provider UPI/direct contact in chat is redacted and immediately records strike 1", async () => {
  const { sqlite, db, now } = await freshTrustDb();
  const result = await trust.recordProviderChatMessage(db, {
    providerId: "PRV-TS-1", threadId: "THREAD-TS-1", actorId: "provider:PRV-TS-1",
    idempotencyKey: "ts-provider-chat-1", message: "Pay me direct by UPI/GPay on 9876543210 outside PawSpace", asOf: now,
  });
  assert.equal(result.redacted, true);
  assert.equal(result.strike.strikeNumber, 1);
  const message = sqlite.prepare("SELECT payload_json FROM communication_messages WHERE id=?").get(result.messageId);
  assert.match(message.payload_json, /\[REDACTED FOR SAFETY\]/);
  assert.doesNotMatch(message.payload_json, /9876543210|\bUPI\b|\bGPay\b|outside PawSpace/i);
  const event = sqlite.prepare("SELECT event_type,provider_id,strike_applied,detection_types_json FROM trust_safety_events WHERE message_id=?").get(result.messageId);
  assert.equal(event.event_type, "pilferage_attempt");
  assert.equal(event.provider_id, "PRV-TS-1");
  assert.equal(event.strike_applied, 1);
  assert.match(event.detection_types_json, /phone_number/);
  const strike = sqlite.prepare("SELECT strike_number,action,trust_score_after FROM provider_trust_strikes WHERE provider_id='PRV-TS-1'").get();
  assert.deepEqual(strike, { strike_number: 1, action: "warning", trust_score_after: 80 });
  const profile = sqlite.prepare("SELECT trust_score,trust_strike_count,status,live FROM provider_capacity_profiles WHERE id='PRV-TS-1'").get();
  assert.deepEqual(profile, { trust_score: 80, trust_strike_count: 1, status: "active", live: 1 });
  const warning = sqlite.prepare("SELECT strike_number,status,channel FROM trust_safety_provider_notifications WHERE provider_id='PRV-TS-1'").get();
  assert.deepEqual(warning, { strike_number: 1, status: "queued", channel: "whatsapp" });
});

test("tiered provider enforcement suspends strike 2 and permanently bans strike 3", async () => {
  const { sqlite, db, now } = await freshTrustDb();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await trust.inspectTrustSafetyText(db, {
      text: `contact me direct on 987654321${attempt}`,
      channel: "chat", sourceReference: `tiered-${attempt}`, actorType: "provider",
      actorId: "provider:PRV-TS-1", providerId: "PRV-TS-1", asOf: now + attempt,
    });
    if (attempt === 2) {
      const state = sqlite.prepare("SELECT strike_count,status,suspended_until FROM provider_trust_state WHERE provider_id='PRV-TS-1'").get();
      assert.equal(state.strike_count, 2);
      assert.equal(state.status, "suspended");
      assert.ok(state.suspended_until > now + 7 * 24 * 60 * 60_000 && state.suspended_until <= now + 4 * 7 * 24 * 60 * 60_000);
      const profile = sqlite.prepare("SELECT status,live FROM provider_capacity_profiles WHERE id='PRV-TS-1'").get();
      assert.deepEqual(profile, { status: "suspended", live: 0 });
    }
  }
  const state = sqlite.prepare("SELECT trust_score,strike_count,status,suspended_until FROM provider_trust_state WHERE provider_id='PRV-TS-1'").get();
  assert.deepEqual(state, { trust_score: 0, strike_count: 3, status: "banned_permanent", suspended_until: null });
  const profile = sqlite.prepare("SELECT trust_score,trust_strike_count,status,live FROM provider_capacity_profiles WHERE id='PRV-TS-1'").get();
  assert.deepEqual(profile, { trust_score: 0, trust_strike_count: 3, status: "banned_permanent", live: 0 });
});

test("globally blocked customer is rejected by the shared Audio Bot pre-dial gate and by canonical booking writes", async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite), env = uatVoiceEnv();
  globalThis.__TS_DB__ = db; globalThis.__TS_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await voice.ensureVoiceCallTables(db);
  await voice.seedVoiceCallScripts(db);
  const seeded = seedRecipient(sqlite, { contactId: "CON-BLOCK", leadId: "LEAD-BLOCK", bookingId: "BKG-BLOCK", phone: ALLOWLISTED_PHONE });
  await voice.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: seeded.contactId, granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  await blocklist.flagCustomerOnGlobalBlocklistSafe(db, { phone: ALLOWLISTED_PHONE, customerId: seeded.contactId, bookingId: seeded.bookingId, reasonCode: "circumvention", actorId: "ops@pawspace.in", actorType: "staff", asOf: DAYTIME });

  const call = await voice.requestOutboundVoiceCall(db, env, {
    idempotencyKey: "blocked-audio-bot-call", useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr",
    customerId: seeded.contactId, leadId: seeded.leadId, bookingId: seeded.bookingId,
    actorId: "operator@pawspace.in", actorPermissions: FOUNDER_PERMISSIONS, asOf: DAYTIME,
  });
  assert.equal(call.dialled, false, "carrier is never contacted");
  assert.equal(call.blockedBy, "opt_out_clear", "global blocklist is mirrored into the pre-dial do-not-call register");
  const decision = sqlite.prepare("SELECT passed FROM voice_call_policy_decisions WHERE call_id=? AND check_code='opt_out_clear'").get(call.callId);
  assert.equal(decision.passed, 0);
  const order = sqlite.prepare("SELECT dialed_at,provider_call_id FROM voice_call_orders WHERE id=?").get(call.callId);
  assert.equal(order.dialed_at, null);
  assert.equal(order.provider_call_id, null);
  assert.throws(() => sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id) VALUES (?,?)").run("BKG-BLOCK-2", seeded.contactId), /global_customer_blocked/);
});
