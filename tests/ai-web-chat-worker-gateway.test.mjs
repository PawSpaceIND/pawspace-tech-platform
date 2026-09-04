import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";

installWorkersHooks("__AI_WEB_CHAT_DB__", "__AI_WEB_CHAT_ENV__");

const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/ai-web-chat`;

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

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__AI_WEB_CHAT_DB__ = db;
  globalThis.__AI_WEB_CHAT_ENV__ = {};
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
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: phone,
    subjectType: "customer",
    subjectId: customerId,
    cityId: "blr",
    verificationState: "verified",
    expiresAt: null,
    metadata: {},
    actorId: "test",
    reason: "AI web-chat gateway regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id),
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: String(binding.principal_key),
    subjectType: "customer",
    subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function throughGateway(request) {
  const env = { DB: globalThis.__AI_WEB_CHAT_DB__, ...globalThis.__AI_WEB_CHAT_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

/*
 * This suite has failed intermittently in CI - once, on PR #334, with `expected 403, got 500` at the
 * cross-customer ownership assertion. All that survived was the status code, so there was nothing to
 * root-cause from: no body, no exception, no stack. It has never reproduced locally or been explained.
 *
 * Every request in this file goes through here, so this is the one place that can capture evidence for
 * whichever assertion fires next. A 5xx from this route is ALWAYS unexpected - the route's own refusals
 * are 4xx - so an unexpected 5xx, or a handler that throws outright, prints what it actually was.
 *
 * Deliberately does not assert or swallow: the test still sees exactly the response it would have seen,
 * and still fails on its own terms. This only makes the next failure legible. The body is read from a
 * clone so the caller's own .json() is untouched.
 */
async function captureUnexpectedFailure(request, response) {
  if (response.status < 500) return response;
  let body = "<unreadable>";
  try { body = (await response.clone().text()).slice(0, 2000); } catch (error) { body = `<clone failed: ${error?.message}>`; }
  console.error(`[ai-web-chat-gateway] UNEXPECTED ${response.status} on ${request.method} ${request.url}`);
  console.error(`[ai-web-chat-gateway] body: ${body}`);
  return response;
}

async function callEndpoint(request) {
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const route = await import("../app/api/ai-web-chat/route.ts");
  const handler = request.method === "GET" ? route.GET : route.POST;
  let response;
  try {
    // Pin this suite's in-memory DB for the route's `database()` call. Release CI runs the
    // whole tests/*.test.mjs glob in parallel; the cached cloudflare:workers shim otherwise
    // reads whichever suite registered first, and public lead capture 500s on a foreign/empty DB.
    response = await runWithWorkersDb(globalThis.__AI_WEB_CHAT_DB__, () => handler(request));
  } catch (error) {
    // A throw that escapes the route entirely: the one case where no response exists to inspect.
    console.error(`[ai-web-chat-gateway] handler THREW on ${request.method} ${request.url}: ${error?.name}: ${error?.message}`);
    if (error?.stack) console.error(`[ai-web-chat-gateway] stack: ${String(error.stack).split("\n").slice(0, 6).join(" | ")}`);
    throw error;
  }
  return { reachedRoute: true, response: await captureUnexpectedFailure(request, response) };
}

function post(body, headers = {}) {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function count(sqlite, table) {
  try { return Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count); }
  catch { return 0; }
}

test("anonymous public AI knowledge GET reaches the real route without customer or staff credentials", async () => {
  await world();
  const result = await callEndpoint(new Request(`${ENDPOINT}?q=grooming`));
  assert.equal(result.reachedRoute, true, `public AI GET was stopped at gateway with ${result.response.status}`);
  assert.equal(result.response.status, 200);
  const body = await result.response.json();
  assert.equal(body.data.mode, "public");
  assert.equal(body.data.customerDataAccess, false);
  assert.equal(body.data.toolExecution, false);
});

test("a natural-language services question retrieves the approved public PawSpace grounding",async()=>{
 const{sqlite,db}=await world(),now=Date.now();
 const{ensureAiBusinessConfiguration}=await import("../lib/ai-business-configuration.ts");
 await ensureAiBusinessConfiguration(db);
 sqlite.prepare("INSERT INTO ai_knowledge_source_versions (id,source_key,version,status,title,source_type,content_text,visibility_scope_json,effective_from,effective_to,immutable_hash,created_by,reviewed_by,reviewed_at,approved_by,approved_at,activated_by,activated_at,retired_at,created_at,updated_at) VALUES (?,?,1,'active',?,'policy',?,'[\"public\"]',?,NULL,?,'uat',NULL,NULL,'uat',?,'uat',?,NULL,?,?)")
  .run("KNOW-SERVICES","pawspace-services","PawSpace services","PawSpace offers Grooming, Dog Training, Boarding, Pet Sitting, Pet Taxi and Dog Walking.",now,"hash-services",now,now,now,now);
 const result=await callEndpoint(new Request(`${ENDPOINT}?q=${encodeURIComponent("What services does PawSpace offer?")}`));
 assert.equal(result.response.status,200);
 const body=await result.response.json();
 assert.equal(body.data.knowledge[0]?.id,"KNOW-SERVICES");
 assert.match(body.data.knowledge[0]?.excerpt||"",/Grooming/);
});

test("anonymous public lead capture reaches the real route and writes exactly one customer-data-free lead", async () => {
  const { sqlite } = await world();
  const result = await callEndpoint(post({ mode: "public", sessionKey: "public-session-1", message: "Please call me about grooming", phone: "+919900000001" }));
  assert.equal(result.reachedRoute, true, `public lead capture was stopped at gateway with ${result.response.status}`);
  assert.equal(result.response.status, 201);
  assert.equal(count(sqlite, "ai_web_leads"), 1);
  assert.equal(count(sqlite, "communication_messages"), 0, "public lead capture must not enter authenticated customer conversation history");
});

test("cross-origin public lead capture is refused by the route and leaves business persistence unchanged", async () => {
  const { sqlite } = await world();
  const result = await callEndpoint(post(
    { mode: "public", sessionKey: "evil-session", message: "cross origin", phone: "+919900000002" },
    { origin: "https://evil.example" },
  ));
  assert.equal(result.reachedRoute, true, "public mode must rely on the route's same-origin write boundary");
  assert.equal(result.response.status, 403);
  assert.equal(count(sqlite, "ai_web_leads"), 0);
  assert.equal(count(sqlite, "communication_messages"), 0);
  assert.equal(count(sqlite, "ai_web_chat_events"), 0);
});

test("a verified customer can run its own authenticated AI turn through the real Worker gateway", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-AI-OWN", "+919900000003");
  const cookie = await customerCookie(db, "CUS-AI-OWN", "+919900000003");
  const result = await callEndpoint(post({
    mode: "authenticated",
    customerId: "CUS-AI-OWN",
    message: "What grooming services are available?",
    idempotencyKey: "ai-web-own-1",
  }, { cookie }));
  assert.equal(result.reachedRoute, true, `customer AI turn was stopped at gateway with ${result.response.status}`);
  assert.equal(result.response.status, 201);
  const body = await result.response.json();
  assert.equal(body.data.autonomousExecution, false);
  assert.equal(count(sqlite, "communication_messages"), 1);
  assert.equal(count(sqlite, "ai_web_chat_events"), 1);
  assert.equal(count(sqlite, "ai_handoffs"), 1, "without a live provider/rollout, the customer is safely handed to a human");
});

test("a customer cannot submit an authenticated turn for another customer and refusal creates no conversation state", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-AI-OWNER", "+919900000004");
  seedCustomer(sqlite, "CUS-AI-OTHER", "+919900000005");
  const cookie = await customerCookie(db, "CUS-AI-OWNER", "+919900000004");
  const result = await callEndpoint(post({
    mode: "authenticated",
    customerId: "CUS-AI-OTHER",
    message: "Show my booking details",
    idempotencyKey: "ai-web-cross-customer",
  }, { cookie }));
  assert.equal(result.reachedRoute, true, "gateway should authenticate the session; the route must enforce record ownership");
  assert.equal(result.response.status, 403);
  assert.equal(count(sqlite, "communication_threads"), 0);
  assert.equal(count(sqlite, "communication_messages"), 0);
  assert.equal(count(sqlite, "ai_web_chat_events"), 0);
  assert.equal(count(sqlite, "ai_context_snapshots"), 0);
});
