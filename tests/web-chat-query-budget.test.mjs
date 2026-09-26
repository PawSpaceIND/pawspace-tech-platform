/**
 * The signed-in web chat's D1 cost per request. The harness below is the web chat bot suite's (tests/web-chat-bot.test.mjs),
 * with every statement recorded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";

installWorkersHooks("__AI_WEB_CHAT_DB__", "__AI_WEB_CHAT_ENV__");
/* Load the route before any request exists. Under the loader-hook fallback (Node 22.16 in CI), the first
 * import of the route module while a cloned request body is pending leaves the original body unreadable. */
const route = await import("../app/api/ai-web-chat/route.ts");

const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/ai-web-chat`;

function makeD1(sqlite) {
  const log = (globalThis.__QLOG__ ||= []);
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { log.push(sql); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { log.push(sql); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => (log.push(sql), { results: sqlite.prepare(sql).all(...args) }),
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
    reason: "web chat bot regression",
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
  // Mirror the real Worker boundary exactly: pre-route authorization and service inspection run on a
  // clone, while the application handler receives the untouched original request body. Reusing the
  // original for both stages made the legacy module.register() fallback fixture capable of consuming
  // the body before route.ts read it, even though worker/index.ts never does that in production.
  const gate = await throughGateway(request.clone());
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
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


/** A valid answer for any step the bot asks. */
/* Every signed-in chat read and bot tap resolves the session several times (gateway, actor, ownership). On
 * staging each D1 call costs about 0.3-0.5 s, so table setup that re-ran on every request, a last-seen write
 * per resolve, and a second request to read the reply made one bot tap take 10-15 s. Warm requests must not
 * repeat schema work, session reads or session writes, and a tap answers with the conversation itself. */
test("a warm chat read and bot tap stay within their D1 query budget", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-BUDGET", "+919900000301");
  const cookie = await customerCookie(db, "CUS-BUDGET", "+919900000301");
  // Cloudflare stamps every request with its own cf-ray; the session is reused only within one request.
  let ray = 0;
  const headers = () => ({ cookie, "cf-ray": `test-ray-${++ray}` });
  const call = async (body) => (await callEndpoint(post({ mode: "authenticated", bot: true, ...body }, headers()))).response;
  assert.equal((await call({ start: true })).status, 200);
  assert.equal((await call({ choiceId: "grooming", message: "", idempotencyKey: "budget-1" })).status, 200);
  assert.equal((await callEndpoint(new Request(`${ENDPOINT}?mode=thread`, { headers: headers() }))).response.status, 200);
  const log = globalThis.__QLOG__;
  log.splice(0);
  const read = await (await callEndpoint(new Request(`${ENDPOINT}?mode=thread`, { headers: headers() }))).response.json();
  assert.equal(read.data.messages.length, 3);
  const readQueries = log.splice(0);
  const tap = await call({ choiceId: "no", message: "", idempotencyKey: "budget-2" });
  const tapQueries = log.splice(0);
  assert.equal(tap.status, 200);
  // The answer carries the conversation, so the page needs no second request to show the reply.
  const tapped = await tap.json();
  assert.deepEqual(tapped.data.transcript.messages.map((message) => message.role), ["bot", "customer", "bot", "customer", "bot"]);
  assert.equal(tapped.data.transcript.messages[3].text, "No");
  for (const [label, queries, budget] of [["read", readQueries, 6], ["tap", tapQueries, 21]]) {
    const schema = queries.filter((sql) => /^\s*(CREATE|ALTER)\b/i.test(sql));
    assert.deepEqual(schema, [], `${label} repeated schema work`);
    assert.ok(!queries.some((sql) => /SET last_seen_at/.test(sql)), `${label} rewrote the session's last-seen time`);
    assert.ok(queries.length <= budget, `${label} made ${queries.length} D1 calls (budget ${budget}):\n${queries.join("\n")}`);
  }
});

test("a session is reused only within one request: a suspended binding stops the very next request", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-MEMO", "+919900000302");
  const cookie = await customerCookie(db, "CUS-MEMO", "+919900000302");
  const { resolvePlatformSession } = await import("../lib/platform-session.ts");
  const request = (ray) => new Request(ENDPOINT, { headers: { cookie, "cf-ray": ray } });
  assert.ok(await resolvePlatformSession(db, request("ray-a")));
  const log = globalThis.__QLOG__; log.splice(0);
  assert.ok(await resolvePlatformSession(db, request("ray-a")), "the same request reuses its session");
  assert.equal(log.length, 0, "a repeat resolve within one request makes no D1 call");
  sqlite.prepare("UPDATE identity_bindings SET status='suspended' WHERE subject_id='CUS-MEMO'").run();
  assert.equal(await resolvePlatformSession(db, request("ray-b")), null, "a new request reads the session afresh");
});
