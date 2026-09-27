/**
 * The signed-in web chat's D1 cost for a typed message answered by PawSpace AI.
 *
 * On staging each D1 call costs 0.3-0.5 s and calls in sequence add up: an AI reply took 30 s, of which
 * 27 s was 77 D1 calls - the model itself answered in 4 s. Most of that was schema setup repeated on every
 * request, the same handoff/ownership/thread reads made three to five times by the layers a turn passes
 * through, and independent reads awaited one after another. This suite drives a warm AI turn through the
 * route with the provider's network stubbed and counts both the round trips and the sequential "waves"
 * (calls that cannot overlap), so the cost cannot creep back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";
installWorkersHooks("__AI_WEB_CHAT_DB__", "__AI_WEB_CHAT_ENV__");
const route = await import("../app/api/ai-web-chat/route.ts");
const { sqlFingerprint } = await import("../lib/d1-request-timing.ts");
const ORIGIN = "https://app.pawspace.in", ENDPOINT = `${ORIGIN}/api/ai-web-chat`;
function makeD1(sqlite) {
  const log = (globalThis.__QLOG__ ||= []);
  // Simulated network: each call takes a tick; calls that overlap form one "wave" (one sequential round trip).
  const waves = (globalThis.__WAVES__ = { inflight: 0, count: 0 });
  const trip = async (sql, run) => {
    log.push(sql);
    if (waves.inflight === 0) waves.count++; (globalThis.__WAVE_OF__ ||= []).push(waves.count);
    waves.inflight++;
    await new Promise((r) => setTimeout(r, 2));
    try { return run(); } finally { waves.inflight--; }
  };
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: () => trip(sql, () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; }),
    run: () => trip(sql, () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; }),
    all: () => trip(sql, () => ({ results: sqlite.prepare(sql).all(...args) })),
    __exec: () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: (items) => trip("BATCH:" + items.length, () => items.map((item) => item.__exec())),
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}
async function world() {
  const sqlite = new DatabaseSync(":memory:"); const db = makeD1(sqlite);
  globalThis.__AI_WEB_CHAT_DB__ = db;
  globalThis.__AI_WEB_CHAT_ENV__ = { PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_AI_PROVIDER: "openai", PAWSPACE_OPENAI_API_KEY: "test-key-not-real" };
  await (await import("../lib/server-auth.ts")).ensureSecurityTables(db);
  await (await import("../lib/customer-account.ts")).ensureCustomerAccountTables(db);
  await (await import("../lib/pricing-control-runtime.ts")).ensurePricingControlRuntime(db);
  await (await import("../lib/training-commercial-governance.ts")).ensureTrainingCommercialTables(db);
  await (await import("../lib/boarding-governance.ts")).ensureBoardingGovernanceTables(db);
  await (await import("../lib/sitting-governance.ts")).ensureSittingGovernanceTables(db);
  await (await import("../lib/walking-governance.ts")).ensureWalkingGovernanceTables(db);
  await (await import("../lib/taxi-governance.ts")).ensureTaxiGovernanceTables(db);
  await (await import("../lib/ai-audience-rollout.ts")).setAiRolloutStage(db, { stage: "customers", reason: "measure", actorEmail: "founder@pawspace.in" });
  return { sqlite, db };
}
function seedCustomer(sqlite, customerId, phone) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)").run(customerId, "blr", `Customer ${customerId}`, phone, now, now);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)").run(`PET-${customerId}`, customerId, "Indie", "dog", "Indie", "verified", now, now);
}
async function customerCookie(db, customerId, phone) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, { identitySource: "customer_app", principalType: "phone", principalKey: phone, subjectType: "customer", subjectId: customerId, cityId: "blr", verificationState: "verified", expiresAt: null, metadata: {}, actorId: "test", reason: "measure" });
  const issued = await issuePlatformSession(db, { bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone", principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
async function callEndpoint(request) {
  const env = { DB: globalThis.__AI_WEB_CHAT_DB__, ...globalThis.__AI_WEB_CHAT_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const c = request.clone();
  const s = await authorizePlatformSessionRequest(c, env.DB); if (s instanceof Response) return s;
  const a = s ?? await authorizeApiRequest(c, env); if (a instanceof Response) return a;
  return runWithWorkersDb(globalThis.__AI_WEB_CHAT_DB__, () => (request.method === "GET" ? route.GET : route.POST)(request));
}
const post = (body, headers) => new Request(ENDPOINT, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
test("a warm AI reply stays within its D1 round-trip and sequential-wave budget", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-M", "+919900000401");
  const cookie = await customerCookie(db, "CUS-M", "+919900000401");
  let ray = 0; const headers = () => ({ cookie, "cf-ray": `ray-${++ray}` });
  const origFetch = globalThis.fetch; const calls=[];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return new Response(JSON.stringify({ status: "completed", output_text: "Sure, I can book grooming.", usage: { input_tokens: 9, output_tokens: 6, total_tokens: 15 } }), { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    const call = async (body) => callEndpoint(post({ mode: "authenticated", bot: true, ...body }, headers()));
    assert.equal((await call({ start: true })).status, 200);
    assert.equal((await call({ choiceId: "grooming", message: "", idempotencyKey: "m-1" })).status, 200);
    await call({ message: "what does grooming include for a big dog", idempotencyKey: "m-warm" });
    const log = globalThis.__QLOG__; log.splice(0);
    globalThis.__WAVES__.count = 0; globalThis.__WAVE_OF__ = [];
    const res = await call({ message: "can i book a grooming session now", idempotencyKey: "m-2" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2, "both typed messages reached the model");
    const messages = body.data.transcript.messages;
    assert.equal(messages.at(-1).role, "ai");
    assert.equal(messages.at(-1).text, "Sure, I can book grooming.");
    assert.equal(body.data.transcript.threadId, body.data.threadId);
    const queries = log.splice(0);
    const roundTrips = queries.length, waves = globalThis.__WAVES__.count;
    const schema = queries.filter((sql) => /^\s*(CREATE|ALTER)\b/i.test(sql));
    assert.deepEqual(schema, [], "a warm AI turn repeated schema work");
    // Was 76 round trips in 42 waves. The budgets leave a little room, not a lot.
    assert.ok(roundTrips <= 56, `AI turn made ${roundTrips} D1 round trips (budget 56):\n${queries.map((sql) => sqlFingerprint(sql) + " " + sql.replace(/\s+/g, " ").slice(0, 120)).join("\n")}`);
    assert.ok(waves <= 24, `AI turn needed ${waves} sequential D1 waves (budget 24)`);
  } finally { globalThis.fetch = origFetch; }
});
