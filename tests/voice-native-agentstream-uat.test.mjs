import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, DAYTIME, QUIET_TIME } from "./helpers/voice-harness.mjs";

installWorkersHooks("__NATIVE_UAT_DB__", "__NATIVE_UAT_ENV__");
const gov = await import("../lib/voice-outbound-governance.ts");

async function world(extra = {}) {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__NATIVE_UAT_DB__ = db;
  globalThis.__NATIVE_UAT_ENV__ = {
    ...uatVoiceEnv(),
    PAWSPACE_VOICE_TRANSPORT: "",
    PAWSPACE_VOICE_RUNTIME: "elevenlabs",
    PAWSPACE_VOICE_NATIVE_UAT_APPROVED: "true",
    PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED: "true",
    PAWSPACE_VOICE_STREAM_URL: "wss://uat.pawspace.in/voice/exotel/agentstream",
    ELEVENLABS_API_KEY: "test-elevenlabs-key",
    ELEVENLABS_AGENT_ID: "agent-default",
    ELEVENLABS_AGENT_PHONE_NUMBER_ID: "phone-exotel",
    ...extra,
  };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await gov.ensureVoiceCallTables(db);
  await gov.seedVoiceCallScripts(db);
  seedRecipient(sqlite);
  await gov.recordVoiceConsent(db, {
    phone: ALLOWLISTED_PHONE,
    subjectType: "customer",
    subjectId: "CON-V1",
    granted: true,
    source: "native_uat_test_consent",
    actorId: "uat-test",
    asOf: DAYTIME,
  });
  return { sqlite, db, env: globalThis.__NATIVE_UAT_ENV__ };
}

const input = (overrides = {}) => ({
  idempotencyKey: "voice-native-agentstream-uat:booking:1",
  useCase: "booking_confirmation",
  phone: ALLOWLISTED_PHONE,
  cityId: "blr",
  customerId: "CON-V1",
  leadId: null,
  bookingId: "BKG-V1",
  campaignId: "controlled_native_agentstream_uat",
  asOf: DAYTIME,
  ...overrides,
});

test("ordinary calls stay on ElevenLabs while the private native UAT path alone selects direct Exotel AgentStream", async () => {
  const { sqlite, db, env } = await world();
  const ordinary = await gov.evaluateVoiceCallPolicy(db, env, {
    ...input({ idempotencyKey: "ordinary-policy" }),
    actorId: "founder@pawspace.in",
    actorPermissions: ["*"],
  });
  assert.equal(ordinary.provider.provider, "elevenlabs_exotel");

  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), body: String(init.body || "") });
    return new Response(JSON.stringify({ Call: { Sid: "EXO-NATIVE-UAT-1", Status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const native = await gov.requestControlledNativeAgentStreamUatCall(db, env, input());
    assert.equal(native.dialled, true);
    assert.equal(native.provider, "exotel");
    assert.equal(sqlite.prepare("SELECT provider FROM voice_call_orders WHERE id=?").get(native.callId).provider, "exotel");
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /api\.exotel\.com\/v1\/Accounts\/test-sid\/Calls\/connect\.json$/);
    const body = new URLSearchParams(seen[0].body);
    assert.equal(body.get("StreamUrl"), "wss://uat.pawspace.in/voice/exotel/agentstream");
    assert.equal(body.get("StreamType"), "bidirectional");
    assert.equal(body.get("CustomField"), native.callId);
    assert.equal(body.get("StatusCallback"), env.PAWSPACE_VOICE_STATUS_CALLBACK_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native AgentStream UAT fails closed without its dedicated approval, stream URL, exact allowlist or key", async () => {
  const { db, env } = await world();
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, { ...env, PAWSPACE_VOICE_NATIVE_UAT_APPROVED: "false" }, input()),
    /native-UAT/,
  );
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, { ...env, PAWSPACE_VOICE_STREAM_URL: "" }, input()),
    /WSS PAWSPACE_VOICE_STREAM_URL/,
  );
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, { ...env, PAWSPACE_VOICE_UAT_ALLOWLIST: "9000000001" }, input()),
    /single approved allowlisted recipient/,
  );
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, env, input({ idempotencyKey: "not-native-uat" })),
    /dedicated voice-native-agentstream-uat idempotency key/,
  );
});

test("native Grooming sales UAT keeps the same sales gates and may bypass quiet hours only for the single controlled recipient", async () => {
  const { sqlite, db, env } = await world({ PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: "true" });
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), body: String(init.body || "") });
    return new Response(JSON.stringify({ Call: { Sid: "EXO-NATIVE-SALES-1", Status: "queued" } }), { status: 200 });
  };
  try {
    const result = await gov.requestControlledNativeAgentStreamUatCall(db, env, input({
      idempotencyKey: "voice-native-agentstream-uat:grooming:quiet",
      useCase: "grooming_sales",
      bookingId: null,
      asOf: QUIET_TIME,
    }));
    assert.equal(result.dialled, true);
    assert.equal(result.provider, "exotel");
    assert.equal(result.quietHoursDecision, "uat_bypass");
    const decision = sqlite.prepare("SELECT passed,detail FROM voice_call_policy_decisions WHERE call_id=? AND check_code='quiet_hours'").get(result.callId);
    assert.equal(decision.passed, 1);
    assert.match(decision.detail, /Controlled native AgentStream UAT bypassed quiet hours/);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public request data cannot forge the private native provider override", async () => {
  const { db, env } = await world();
  const policy = await gov.evaluateVoiceCallPolicy(db, env, {
    ...input({ idempotencyKey: "public-spoof" }),
    actorId: "founder@pawspace.in",
    actorPermissions: ["*"],
    nativeAgentStream: true,
    PAWSPACE_VOICE_NATIVE_UAT_APPROVED: "true",
  });
  assert.equal(policy.provider.provider, "elevenlabs_exotel");
  assert.equal(policy.checks.some(check => check.code === "native_agentstream_stream"), false);
});
