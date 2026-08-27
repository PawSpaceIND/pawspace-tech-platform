/**
 * WAVE 3 TIER A - adversarial verification of W2-B4-M-R01. [PTJA-W3A]
 *
 * THE REFUTATION UNDER TEST: "the voice provider callback does NOT act on an unsigned, wrongly-signed,
 * stale or replayed payload, and an absent secret refuses rather than unlocks".
 *
 * This is the sharpest of the nine to leave untested. The route is deliberately gateway-allowlisted -
 * a carrier has no cookie - so it is reachable by ANY anonymous caller on the internet. The only thing
 * between an anonymous POST and the call state machine is this shared-secret check. The hunter probed it
 * and threw the probe away.
 *
 * Every refusal case asserts the state machine did NOT move, not merely that a 401 came back.
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
// Every name selectTelephonyProvider requires; a partial set must degrade to the disconnected adapter.
const CONNECTED_ENV = {
  EXOTEL_API_KEY: "k", EXOTEL_API_TOKEN: "t", EXOTEL_SID: "s",
  EXOTEL_CALLER_ID: "+918000000000", EXOTEL_VOICE_APP_ID: "app", EXOTEL_WEBHOOK_SECRET: SECRET,
  PAWSPACE_VOICE_MODE: "uat",
};

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

const BODY = { CallSid: "SIMCALL-1", CustomField: "VCALL-1", CallStatus: "completed", EventType: "terminal", ConversationDuration: 42 };

const hex = (bytes) => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function callback(raw, headers = {}) {
  const response = await route.POST(new Request("https://uat.pawspace.in/api/voice-provider-webhook", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw,
  }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

async function signedCallback({ secret = SECRET, timestamp = Date.now(), body = BODY } = {}) {
  const raw = JSON.stringify(body);
  return callback(raw, {
    "x-pawspace-voice-signature": await hmac(secret, `${timestamp}.${raw}`),
    "x-pawspace-voice-timestamp": String(timestamp),
  });
}

const callState = () => sqlite.prepare("SELECT state FROM voice_call_orders WHERE id='VCALL-1'").get()?.state;
const eventCount = () => {
  try { return Number(sqlite.prepare("SELECT COUNT(*) c FROM voice_call_provider_events").get().c); } catch { return 0; }
};

test("MR01-06 (non-vacuity): a correctly signed, fresh callback IS applied and moves the state", async () => {
  // First. If the receiver rejects everything, every refusal below is worthless.
  await voiceWorld();
  assert.equal(callState(), "dialing", "precondition");
  const res = await signedCallback();
  assert.equal(res.status, 200, `a valid signed callback must be accepted: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.applied, true, "and must be applied");
  assert.equal(callState(), "completed", "and must move the call state machine");
});

test("MR01-01: an UNSIGNED callback is refused and the state machine does not move", async () => {
  await voiceWorld();
  const res = await callback(JSON.stringify(BODY));
  assert.equal(res.status, 401, "no signature and no Basic credentials must be refused");
  assert.equal(callState(), "dialing", "an unsigned callback must not advance the call");
  assert.equal(eventCount(), 0, "and must not record a provider event");
});

test("MR01-02: a WRONGLY signed callback is refused and the state machine does not move", async () => {
  await voiceWorld();
  const raw = JSON.stringify(BODY);
  const res = await callback(raw, { "x-pawspace-voice-signature": "deadbeef".repeat(8), "x-pawspace-voice-timestamp": String(Date.now()) });
  assert.equal(res.status, 401, "a wrong signature must be refused");
  assert.equal(callState(), "dialing", "and must not advance the call");
  assert.equal(eventCount(), 0, "and must not record a provider event");
});

test("MR01-03: a STALE but correctly signed callback is refused (replay outside the window)", async () => {
  await voiceWorld();
  const res = await signedCallback({ timestamp: Date.now() - 600_000 });
  assert.equal(res.status, 401, "a signature older than the freshness window must be refused");
  assert.match(String(res.body?.error ?? ""), /freshness|timestamp/i);
  assert.equal(callState(), "dialing", "a stale callback must not advance the call");
});

test("MR01-04: a byte-identical REPLAY of a valid callback is inert", async () => {
  await voiceWorld();
  const raw = JSON.stringify(BODY);
  const timestamp = Date.now();
  const headers = { "x-pawspace-voice-signature": await hmac(SECRET, `${timestamp}.${raw}`), "x-pawspace-voice-timestamp": String(timestamp) };

  const first = await callback(raw, headers);
  assert.equal(first.body?.applied, true, "the first delivery is applied");
  const stateAfterFirst = callState();

  const replay = await callback(raw, headers);
  assert.equal(replay.status, 200, "a replay is answered 200 so the carrier stops retrying");
  assert.equal(replay.body?.applied, false, "but it must NOT be applied");
  assert.equal(replay.body?.duplicate, true, "and must be reported as a duplicate");
  assert.equal(callState(), stateAfterFirst, "and must not move the state machine a second time");
  assert.equal(eventCount(), 1, "and must not record a second provider event");
});

test("MR01-05: with NO telephony secrets configured the receiver refuses rather than unlocking", async () => {
  // The defect class this whole audit hunts: absent treated as satisfied. An empty secret must not
  // validate an HMAC computed with the empty secret.
  await voiceWorld({});
  const raw = JSON.stringify(BODY);
  const timestamp = Date.now();
  // An attacker cannot HMAC with an empty key (WebCrypto refuses to import one), so the real attack
  // against an unconfigured receiver is an arbitrary signature - and a guessed one, in case the code
  // ever compared against a default.
  for (const guess of ["deadbeef".repeat(8), await hmac("guessed", `${timestamp}.${raw}`)]) {
    const res = await callback(raw, { "x-pawspace-voice-signature": guess, "x-pawspace-voice-timestamp": String(timestamp) });
    assert.equal(res.status, 401, "an unconfigured receiver must refuse every signature");
    // Named, because this refusal comes from the CONNECTEDNESS layer, not the secret layer - see
    // MR01-10. Asserting only the 401 would let this case pass with signature verification removed.
    assert.match(String(res.body?.error ?? ""), /not connected/i,
      "the unconfigured refusal is the disconnected-adapter layer");
    assert.equal(callState(), "dialing", "and must not advance the call");
  }

  const basic = await callback(JSON.stringify(BODY), { authorization: `Basic ${btoa("user:")}` });
  assert.equal(basic.status, 401, "an empty Basic password must not match an absent secret either");
  assert.equal(callState(), "dialing", "and must not advance the call");
});

test("MR01-07: a signature over a DIFFERENT body does not carry to a swapped body", async () => {
  await voiceWorld();
  const timestamp = Date.now();
  const honest = JSON.stringify(BODY);
  const swapped = JSON.stringify({ ...BODY, CallStatus: "failed", EventType: "terminal" });
  const res = await callback(swapped, {
    "x-pawspace-voice-signature": await hmac(SECRET, `${timestamp}.${honest}`),
    "x-pawspace-voice-timestamp": String(timestamp),
  });
  assert.equal(res.status, 401, "the signature is over the body, so a swap must not validate");
  assert.equal(callState(), "dialing", "and must not advance the call");
});

test("MR01-08: the timestamp is part of the signed material, so it cannot be freshened", async () => {
  // Take a valid old signature and present it with a fresh timestamp header.
  await voiceWorld();
  const raw = JSON.stringify(BODY);
  const oldStamp = Date.now() - 600_000;
  const res = await callback(raw, {
    "x-pawspace-voice-signature": await hmac(SECRET, `${oldStamp}.${raw}`),
    "x-pawspace-voice-timestamp": String(Date.now()),
  });
  assert.equal(res.status, 401, "rewriting the timestamp header must invalidate the signature");
  assert.equal(callState(), "dialing", "and must not advance the call");
});

test("MR01-09: a malformed or absent timestamp is refused, not treated as now", async () => {
  await voiceWorld();
  const raw = JSON.stringify(BODY);
  const sig = await hmac(SECRET, `not-a-number.${raw}`);
  const res = await callback(raw, { "x-pawspace-voice-signature": sig, "x-pawspace-voice-timestamp": "not-a-number" });
  assert.equal(res.status, 401, "a malformed timestamp must be refused");
  assert.equal(callState(), "dialing", "and must not advance the call");

  const noStamp = await callback(raw, { "x-pawspace-voice-signature": await hmac(SECRET, `.${raw}`) });
  assert.equal(noStamp.status, 401, "an absent timestamp must be refused, never defaulted to now");
  assert.equal(callState(), "dialing", "and must not advance the call");
});

test("MR01-10: an absent webhook secret refuses at the verifier itself, not merely upstream", async () => {
  // MR01-05 was SHADOWED and is recorded as such. EXOTEL_WEBHOOK_SECRET is one of the six names in
  // VOICE_TELEPHONY_SECRET_NAMES, so removing it also makes selectTelephonyProvider return the
  // disconnected adapter - and the route answers "Telephony provider is not connected" BEFORE any
  // signature work. That is a real second layer, but it means the route can never exercise the
  // absent-secret branch, and a route-level test of it proves nothing: the sabotage that makes an empty
  // secret VERIFY leaves MR01-05 green.
  //
  // So the claim "an absent secret refuses rather than unlocks" is tested where it actually lives.
  const { verifyVoiceWebhookSignature } = await import("../lib/voice-telephony-provider.ts");
  const raw = JSON.stringify(BODY);
  const timestamp = Date.now();
  const headers = new Headers({
    "x-pawspace-voice-signature": await hmac("anything", `${timestamp}.${raw}`),
    "x-pawspace-voice-timestamp": String(timestamp),
  });

  const absent = await verifyVoiceWebhookSignature("", raw, headers);
  assert.equal(absent.verified, false, "an absent secret must never verify");
  assert.match(String(absent.reason ?? ""), /not configured/i, "and must say why");

  const blank = await verifyVoiceWebhookSignature("   ".trim(), raw, headers);
  assert.equal(blank.verified, false, "a whitespace-only secret trims to absent and must not verify");

  // Non-vacuity for this unit: the same verifier DOES accept a correct signature.
  const good = new Headers({
    "x-pawspace-voice-signature": await hmac(SECRET, `${timestamp}.${raw}`),
    "x-pawspace-voice-timestamp": String(timestamp),
  });
  const ok = await verifyVoiceWebhookSignature(SECRET, raw, good);
  assert.equal(ok.verified, true, "a correct signature against a configured secret must verify");
});

test("MR01-11: an absent secret does not accept Basic credentials either", async () => {
  const { verifyVoiceWebhookSignature } = await import("../lib/voice-telephony-provider.ts");
  const raw = JSON.stringify(BODY);
  for (const password of ["", "guessed", "   "]) {
    const headers = new Headers({ authorization: `Basic ${btoa(`user:${password}`)}` });
    const result = await verifyVoiceWebhookSignature("", raw, headers);
    assert.equal(result.verified, false, `an absent secret must not match Basic password ${JSON.stringify(password)}`);
  }
  // Non-vacuity: Basic DOES work when a secret is configured and matches.
  const headers = new Headers({ authorization: `Basic ${btoa(`user:${SECRET}`)}` });
  const ok = await verifyVoiceWebhookSignature(SECRET, raw, headers);
  assert.equal(ok.verified, true, "the Basic mechanism must still be usable, or MR01-11 proves nothing");
});
