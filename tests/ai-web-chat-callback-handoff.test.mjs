/**
 * Chat route only: a matched customer callback that the voice policy or provider does not dial
 * is handed to the team. An accepted callback is not. Public request-a-call and talk-to-team never dial.
 * Fetch is mocked; no live telephony provider is contacted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
import { uatVoiceEnv, ALLOWLISTED_PHONE } from "./helpers/voice-harness.mjs";

installWorkersHooks("__CHAT_CB_DB__", "__CHAT_CB_ENV__");
const route = await import("../app/api/ai-web-chat/route.ts");

const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/ai-web-chat`;
const fetches = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || input);
  fetches.push(url);
  throw new Error(`unexpected network fetch blocked: ${url}`);
};

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function world(env) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__CHAT_CB_DB__ = db;
  globalThis.__CHAT_CB_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureSecurityTables(db);
  await ensureCustomerAccountTables(db);
  return { sqlite, db };
}

function seedCustomer(sqlite, customerId, phone) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, "blr", `Customer ${customerId}`, phone, now, now);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(`PET-${customerId}`, customerId, "Indie", "dog", "Indie", "verified", now, now);
}

async function customerCookie(db, customerId, phone) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: phone,
    subjectType: "customer", subjectId: customerId, cityId: "blr", verificationState: "verified",
    expiresAt: null, metadata: {}, actorId: "test", reason: "callback handoff regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

function counts(sqlite) {
  const exists = (name) => Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const n = (name) => exists(name) ? Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n) : 0;
  const reason = exists("ai_handoffs") ? sqlite.prepare("SELECT reason FROM ai_handoffs ORDER BY created_at").all().map((row) => row.reason) : [];
  const states = exists("voice_call_orders") ? sqlite.prepare("SELECT state FROM voice_call_orders ORDER BY requested_at").all().map((row) => row.state) : [];
  return { calls: n("voice_call_orders"), handoffs: n("ai_handoffs"), reason, states };
}

async function post(db, body, headers = {}) {
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const response = await runWithWorkersDb(db, () => route.POST(request));
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function signedIn(env, customerId, phone) {
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, customerId, phone);
  const cookie = await customerCookie(ctx.db, customerId, phone);
  const call = (body) => post(ctx.db, body, { cookie });
  return { ...ctx, call };
}

const TELEPHONY = {
  EXOTEL_API_KEY: "test-key", EXOTEL_API_TOKEN: "test-token", EXOTEL_SID: "test-sid",
  EXOTEL_CALLER_ID: "08000000000", EXOTEL_VOICE_APP_ID: "123456", EXOTEL_WEBHOOK_SECRET: "test-webhook-secret",
  PAWSPACE_VOICE_STATUS_CALLBACK_URL: "https://uat.pawspace.in/api/voice-provider-webhook",
  PAWSPACE_VOICE_ENV: "uat", PAWSPACE_VOICE_UAT_APPROVED: "true",
  PAWSPACE_VOICE_UAT_ALLOWLIST: "+91 98765 43210",
};

test("a matched callback blocked by voice policy hands off and does not claim a queued call", async () => {
  const { sqlite, call } = await signedIn({}, "CUS-BLOCK", "+919900001111");
  await call({ mode: "authenticated", bot: true, start: true });
  const before = fetches.length;
  const response = await call({ mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "cb-blocked-1" });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  assert.equal(response.payload.data.callbackOutcome, "not_placed");
  assert.equal(response.payload.data.callback.matched, true);
  assert.equal(response.payload.data.callback.callback.dialled, false);
  assert.equal(response.payload.data.callback.callback.blockedBy, "voice_enabled");
  assert.match(response.payload.data.callbackNotice, /not placed/i);
  assert.doesNotMatch(response.payload.data.callbackNotice, /queued/i);
  const rows = counts(sqlite);
  assert.deepEqual(rows, { calls: 1, handoffs: 1, reason: ["policy_risk"], states: ["blocked_disabled"] });
  assert.equal(fetches.length, before, "a blocked callback must not dial a provider");
});

test("a matched callback that fails provider readiness hands off", async () => {
  const env = { ...TELEPHONY, PAWSPACE_VOICE_TRANSPORT: "", PAWSPACE_VOICE_RUNTIME: "not_a_provider" };
  const { sqlite, call } = await signedIn(env, "CUS-PROV", `+91${ALLOWLISTED_PHONE}`);
  await call({ mode: "authenticated", bot: true, start: true });
  const before = fetches.length;
  const response = await call({ mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "cb-provider-1" });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  assert.equal(response.payload.data.callbackOutcome, "not_placed");
  assert.equal(response.payload.data.callback.callback.dialled, false);
  assert.equal(response.payload.data.callback.callback.blockedBy, "provider_configured");
  assert.equal(response.payload.data.callback.callback.state, "provider_unavailable");
  assert.doesNotMatch(response.payload.data.callbackNotice, /queued/i);
  const rows = counts(sqlite);
  assert.equal(rows.calls, 1);
  assert.equal(rows.handoffs, 1);
  assert.deepEqual(rows.reason, ["provider_unavailable"]);
  assert.deepEqual(rows.states, ["provider_unavailable"]);
  assert.equal(fetches.length, before, "provider readiness failure must not place a call");
});

test("an accepted callback dials through the simulator and does not hand off", async () => {
  const env = uatVoiceEnv();
  const { sqlite, call } = await signedIn(env, "CUS-OK", `+91${ALLOWLISTED_PHONE}`);
  await call({ mode: "authenticated", bot: true, start: true });
  const before = fetches.length;
  const response = await call({ mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "cb-accepted-1" });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  assert.equal(response.payload.data.callbackOutcome, "accepted");
  assert.equal(response.payload.data.callback.callback.dialled, true);
  assert.equal(response.payload.data.callback.callback.state, "dialing");
  const rows = counts(sqlite);
  assert.equal(rows.calls, 1);
  assert.equal(rows.handoffs, 0);
  assert.deepEqual(rows.states, ["dialing"]);
  assert.equal(fetches.length, before, "the local simulator must not call a live provider");
});

test("replaying the same idempotency key does not add a second call or handoff", async () => {
  const { sqlite, db, call } = await signedIn({}, "CUS-REPLAY", "+919900002222");
  await call({ mode: "authenticated", bot: true, start: true });
  const first = await call({ mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "cb-replay-1" });
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  assert.equal(first.payload.data.callbackOutcome, "not_placed");
  const again = await call({ mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "cb-replay-1" });
  assert.notEqual(again.status, 500, JSON.stringify(again.payload));
  // The message path re-enters the voice engine with the same key. The call row already exists.
  const typed = await post(db, { mode: "authenticated", message: "Please call me back", idempotencyKey: "cb-replay-1:call" }, { cookie: (await customerCookie(db, "CUS-REPLAY", "+919900002222")) });
  assert.equal(typed.payload?.data?.callbackOutcome, "not_placed", JSON.stringify(typed.payload));
  const typedAgain = await post(db, { mode: "authenticated", message: "Please call me back", idempotencyKey: "cb-replay-1:call" }, { cookie: (await customerCookie(db, "CUS-REPLAY", "+919900002222")) });
  assert.equal(typedAgain.payload?.data?.callbackOutcome, "not_placed", JSON.stringify(typedAgain.payload));
  const rows = counts(sqlite);
  assert.equal(rows.calls, 1, `voice rows duplicated: ${JSON.stringify(rows)}`);
  assert.equal(rows.handoffs, 1, `handoff rows duplicated: ${JSON.stringify(rows)}`);

  const accepted = await signedIn(uatVoiceEnv(), "CUS-REPLAY-OK", `+91${ALLOWLISTED_PHONE}`);
  await accepted.call({ mode: "authenticated", bot: true, start: true });
  const placed = await accepted.call({ mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "cb-replay-ok" });
  assert.equal(placed.payload.data.callbackOutcome, "accepted", JSON.stringify(placed.payload));
  await accepted.call({ mode: "authenticated", bot: true, choiceId: "request_call", message: "", idempotencyKey: "cb-replay-ok" });
  const cookie = await customerCookie(accepted.db, "CUS-REPLAY-OK", `+91${ALLOWLISTED_PHONE}`);
  const placedTyped = await post(accepted.db, { mode: "authenticated", message: "Please call me back", idempotencyKey: "cb-replay-ok:call" }, { cookie });
  assert.equal(placedTyped.payload?.data?.callbackOutcome, "accepted", JSON.stringify(placedTyped.payload));
  const placedAgain = await post(accepted.db, { mode: "authenticated", message: "Please call me back", idempotencyKey: "cb-replay-ok:call" }, { cookie });
  assert.equal(placedAgain.payload?.data?.callbackOutcome, "accepted", JSON.stringify(placedAgain.payload));
  const okRows = counts(accepted.sqlite);
  assert.equal(okRows.calls, 1, `accepted replay dialled again: ${JSON.stringify(okRows)}`);
  assert.equal(okRows.handoffs, 0, `accepted replay created a handoff: ${JSON.stringify(okRows)}`);
});

test("public request-a-call and talk-to-team do not dial", async () => {
  const { sqlite, db } = await world({});
  const sessionKey = "publicrequestcall01";
  const visitor = (body) => post(db, { mode: "public", bot: true, sessionKey, ...body }, { "cf-connecting-ip": "203.0.113.44" });
  const started = await visitor({ start: true });
  assert.equal(started.status, 200, JSON.stringify(started.payload));
  const requested = await visitor({ choiceId: "request_call", message: "" });
  assert.equal(requested.status, 200, JSON.stringify(requested.payload));
  assert.equal(requested.payload.data.callback, undefined);
  const team = await visitor({ choiceId: "talk_to_team", message: "" });
  assert.notEqual(team.status, 500, JSON.stringify(team.payload));
  const rows = counts(sqlite);
  assert.equal(rows.calls, 0);
  assert.equal(rows.handoffs, 0);

  const signed = await signedIn({}, "CUS-TEAM", "+919900003333");
  await signed.call({ mode: "authenticated", bot: true, start: true });
  const human = await signed.call({ mode: "authenticated", bot: true, choiceId: "talk_to_team", message: "", idempotencyKey: "cb-team-1" });
  assert.equal(human.status, 200, JSON.stringify(human.payload));
  const signedRows = counts(signed.sqlite);
  assert.equal(signedRows.calls, 0, "talk to team must not create a voice call");
  assert.equal(signedRows.handoffs, 1, "talk to team still reaches the existing human queue");
  assert.deepEqual(signedRows.reason, ["customer_requested_human"]);
});
