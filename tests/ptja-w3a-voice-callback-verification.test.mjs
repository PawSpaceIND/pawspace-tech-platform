/**
 * WAVE 3 TIER A - adversarial verification of the Exotel callback trust boundary. [PTJA-W3A]
 *
 * Exotel outbound callbacks are trigger-only: the public POST contributes only a provider CallSid.
 * PawSpace must prove that Sid is already owned by its D1 voice ledger and then fetch authoritative
 * state from Exotel's authenticated single-call details API before any lifecycle mutation. Mutable
 * callback fields, signatures and timestamps on the public trigger are not authoritative.
 *
 * Inbound AI callbacks still carry conversational input, so the shared-secret verifier remains covered
 * directly at the end of this suite for that separate trust boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_VOICE_DB__", "__W3A_VOICE_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const SECRET = "w3a-voice-webhook-secret";
const CONNECTED_ENV = {
  EXOTEL_API_KEY: "k", EXOTEL_API_TOKEN: "t", EXOTEL_SID: "s",
  EXOTEL_CALLER_ID: "+918000000000", EXOTEL_VOICE_APP_ID: "app", EXOTEL_WEBHOOK_SECRET: SECRET,
  PAWSPACE_VOICE_MODE: "uat",
};
const CALL_SID = "SIMCALL-1";
let sqlite;

async function voiceWorld(env = CONNECTED_ENV) {
  sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3A_VOICE_DB__ = db;
  globalThis.__W3A_VOICE_ENV__ = env;
  const { ensureVoiceCallTables } = await import("../lib/voice-outbound-governance.ts");
  await ensureVoiceCallTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO voice_call_orders (id,idempotency_key,direction,use_case,purpose,city_id,phone_key,phone_last4,dial_number,mode,provider,state,requested_by,requested_at,updated_at,provider_call_id) VALUES ('VCALL-1','idem-vcall-1','outbound','lead_followup','transactional','blr','pk','5678','+919812345678','uat','exotel','dialing','w3a',?,?,'SIMCALL-1')")
    .run(now, now);
  return db;
}

const route = await import("../app/api/voice-provider-webhook/route.ts");
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

async function callback(body, headers = {}) {
  const raw = typeof body === "string" ? body : new URLSearchParams(body).toString();
  const response = await route.POST(new Request("https://uat.pawspace.in/api/voice-provider-webhook", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: raw,
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

function authoritativeDetails(value = { Status: "completed", Duration: 42 }) {
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls += 1;
    const parsed = new URL(String(url));
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.hostname, "api.exotel.com");
    assert.equal(parsed.pathname, `/v1/Accounts/s/Calls/${CALL_SID}.json`);
    assert.equal(String(init.method || "GET"), "GET");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${btoa("k:t")}`);
    assert.equal(new Headers(init.headers).get("accept"), "application/json");
    return Response.json({ Call: { Sid: CALL_SID, ...value } });
  };
  return () => calls;
}

const callState = () => sqlite.prepare("SELECT state FROM voice_call_orders WHERE id='VCALL-1'").get()?.state;
const eventCount = () => {
  try { return Number(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_provider_events").get().c); } catch { return 0; }
};

const forgedTrigger = (overrides = {}) => ({
  CallSid: CALL_SID,
  CallStatus: "failed",
  CustomField: "VCALL-ATTACKER",
  CallDuration: "9999",
  RecordingUrl: "https://attacker.invalid/fake.mp3",
  ...overrides,
});

test("MR01-06 (non-vacuity): an owned unsigned CallSid is applied only after authoritative Exotel reconciliation", async () => {
  await voiceWorld();
  const fetchCount = authoritativeDetails({ Status: "completed", Duration: 18 });
  assert.equal(callState(), "dialing", "precondition");
  const res = await callback(forgedTrigger());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body?.applied, true, "the authoritative provider result must be applied");
  assert.equal(callState(), "completed", "the Exotel result, not the forged trigger status, drives state");
  assert.equal(fetchCount(), 1, "each owned trigger is reconciled server-to-server");
  assert.equal(eventCount(), 1);
});

test("MR01-01: an unknown unsigned CallSid is inert and never turns the callback route into an Exotel API proxy", async () => {
  await voiceWorld();
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  const res = await callback({ CallSid: "UNKNOWN-CALL", CallStatus: "completed", CustomField: "VCALL-1" });
  assert.equal(res.status, 202);
  assert.equal(res.body?.applied, false);
  assert.equal(fetched, false, "unknown provider ids must be rejected before any Exotel request");
  assert.equal(callState(), "dialing");
  assert.equal(eventCount(), 0);
});

test("MR01-02: Exotel must return the exact ledger-owned CallSid before any lifecycle mutation", async () => {
  await voiceWorld();
  globalThis.fetch = async () => Response.json({ Call: { Sid: "DIFFERENT-CALL", Status: "completed", Duration: 18 } });
  const res = await callback(forgedTrigger());
  assert.equal(res.status, 503);
  assert.match(String(res.body?.error ?? ""), /requested CallSid/i);
  assert.equal(callState(), "dialing");
  assert.equal(eventCount(), 0);
});

test("MR01-03: provider rejection fails closed and leaves the D1 lifecycle unchanged for retry", async () => {
  await voiceWorld();
  globalThis.fetch = async () => Response.json({ error: "temporary" }, { status: 503 });
  const res = await callback(forgedTrigger());
  assert.equal(res.status, 503);
  assert.equal(callState(), "dialing");
  assert.equal(eventCount(), 0);
});

test("MR01-04: a byte-identical provider result is replay-safe", async () => {
  await voiceWorld();
  authoritativeDetails({ Status: "completed", Duration: 18 });
  const first = await callback(forgedTrigger());
  assert.equal(first.status, 200);
  assert.equal(first.body?.applied, true);
  const replay = await callback(forgedTrigger());
  assert.equal(replay.status, 200, "duplicates are acknowledged so the carrier can stop retrying");
  assert.equal(replay.body?.applied, false);
  assert.equal(replay.body?.duplicate, true);
  assert.equal(callState(), "completed");
  assert.equal(eventCount(), 1, "a replay must not create a second provider event");
});

test("MR01-05: missing Exotel Call Details credentials fail closed for an owned CallSid", async () => {
  await voiceWorld({});
  globalThis.fetch = async () => { throw new Error("must not fetch without credentials"); };
  const res = await callback(forgedTrigger());
  assert.equal(res.status, 503);
  assert.match(String(res.body?.error ?? ""), /credentials are not configured/i);
  assert.equal(callState(), "dialing");
  assert.equal(eventCount(), 0);
});

test("MR01-07: missing or malformed CallSid is refused before any provider lookup", async () => {
  await voiceWorld();
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
  for (const body of [{ CallStatus: "completed" }, { CallSid: "bad sid with spaces", CallStatus: "completed" }]) {
    const res = await callback(body);
    assert.equal(res.status, 400);
    assert.equal(callState(), "dialing");
  }
  assert.equal(fetched, false);
  assert.equal(eventCount(), 0);
});

test("MR01-08: forged mutable callback fields have zero authority", async () => {
  await voiceWorld();
  authoritativeDetails({ Status: "in-progress", Duration: 7 });
  const res = await callback(forgedTrigger({ CallStatus: "completed", CustomField: "OTHER", CallDuration: "9999" }));
  assert.equal(res.status, 200);
  assert.equal(callState(), "connected", "authoritative in-progress must win over forged completed");
  const stored = sqlite.prepare("SELECT provider_status,signature_mechanism FROM voice_call_provider_events").get();
  assert.equal(stored.provider_status, "in-progress");
  assert.equal(stored.signature_mechanism, "exotel_call_details_api");
});

test("MR01-09: Exotel responses with no authoritative status are refused", async () => {
  await voiceWorld();
  globalThis.fetch = async () => Response.json({ Call: { Sid: CALL_SID } });
  const res = await callback(forgedTrigger());
  assert.equal(res.status, 503);
  assert.match(String(res.body?.error ?? ""), /no authoritative status/i);
  assert.equal(callState(), "dialing");
  assert.equal(eventCount(), 0);
});

const hex = (bytes) => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

test("MR01-10: the shared-secret verifier used by inbound AI refuses an absent secret", async () => {
  const { verifyVoiceWebhookSignature } = await import("../lib/voice-telephony-provider.ts");
  const raw = JSON.stringify({ pawspace_action: "inbound_ai_start", CallSid: CALL_SID });
  const timestamp = Date.now();
  const headers = new Headers({
    "x-pawspace-voice-signature": await hmac("anything", `${timestamp}.${raw}`),
    "x-pawspace-voice-timestamp": String(timestamp),
  });
  const absent = await verifyVoiceWebhookSignature("", raw, headers);
  assert.equal(absent.verified, false);
  assert.match(String(absent.reason ?? ""), /not configured/i);

  const good = new Headers({
    "x-pawspace-voice-signature": await hmac(SECRET, `${timestamp}.${raw}`),
    "x-pawspace-voice-timestamp": String(timestamp),
  });
  assert.equal((await verifyVoiceWebhookSignature(SECRET, raw, good)).verified, true, "non-vacuity");
});

test("MR01-11: inbound-AI Basic verification also refuses an absent secret", async () => {
  const { verifyVoiceWebhookSignature } = await import("../lib/voice-telephony-provider.ts");
  const raw = JSON.stringify({ pawspace_action: "inbound_ai_start", CallSid: CALL_SID });
  for (const password of ["", "guessed", "   "]) {
    const result = await verifyVoiceWebhookSignature("", raw, new Headers({ authorization: `Basic ${btoa(`user:${password}`)}` }));
    assert.equal(result.verified, false);
  }
  const ok = await verifyVoiceWebhookSignature(SECRET, raw, new Headers({ authorization: `Basic ${btoa(`user:${SECRET}`)}` }));
  assert.equal(ok.verified, true, "non-vacuity");
});
