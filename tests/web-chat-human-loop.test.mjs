/**
 * The web chat human loop, end to end: customer -> AI handoff -> staff takeover -> staff reply ->
 * the customer reads that reply -> AI resumes.
 *
 * Every step before this existed as a unit, and each unit passed, while the loop itself was broken:
 * the customer's next message was refused with "AI replies are paused", and a staff reply was stored
 * as delivered with no way for any customer screen to read it. Customer requests go through the real
 * gateway and route with a real customer session cookie; staff actions call the same library functions
 * their routes call.
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
const STAFF = { email: "care.agent@pawspace.in", name: "Care Agent", roleCode: "admin", permissions: ["*"], developmentPreview: false };

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
    reason: "web chat human loop regression",
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


const get = (query, headers = {}) => new Request(`${ENDPOINT}?${query}`, { headers });
const turn = (cookie, message, idempotencyKey) => post({ mode: "authenticated", customerId: "CUS-LOOP", message, idempotencyKey }, { cookie });

async function transcript(cookie, query = "mode=thread") {
  const result = await callEndpoint(get(query, { cookie }));
  assert.equal(result.reachedRoute, true, `transcript read was stopped at the gateway with ${result.response.status}`);
  return result.response;
}

async function customer(id = "CUS-LOOP", phone = "+919900000101") {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, id, phone);
  return { sqlite, db, cookie: await customerCookie(db, id, phone) };
}

test("the customer sees the team's reply, and can keep writing while the team has the conversation", async () => {
  const { sqlite, db, cookie } = await customer();

  // 1. The AI cannot answer here (no provider in this world), so it hands the customer to a person.
  const first = await callEndpoint(turn(cookie, "Hi, I need help with my dog's grooming", "loop-1"));
  assert.equal(first.response.status, 200);
  const firstBody = await first.response.json();
  assert.equal(firstBody.data.ai.turn.outcome, "handoff");
  assert.equal(firstBody.data.handoff?.active, true, "the response must tell the page a person is taking over");
  const threadId = firstBody.data.threadId;

  // 2. Writing again used to be refused with 409 "AI replies are paused". It is now kept for the team.
  const second = await callEndpoint(turn(cookie, "Are you still there?", "loop-2"));
  assert.equal(second.response.status, 200, "a customer message during a handoff must not be refused");
  const secondBody = await second.response.json();
  assert.equal(secondBody.data.withTeam, true);
  assert.match(secondBody.data.ai.turn.output, /PawSpace team/);

  // 3. Staff take over from the inbox and reply in the web chat.
  const { staffTakeOverConversation } = await import("../lib/ai-human-handoff.ts");
  const { queueChatHumanReply } = await import("../lib/chat-human-reply.ts");
  const taken = await runWithWorkersDb(db, () => staffTakeOverConversation(db, { actor: STAFF, threadId, customerId: "CUS-LOOP", reason: "inbox takeover" }));
  assert.equal(taken.handoff.status, "staff_active");
  await runWithWorkersDb(db, () => queueChatHumanReply(db, { actor: STAFF, threadId, message: "Hi, this is Asha from PawSpace. I can help.", clientRequestId: "loop-staff-1" }));

  // 4. The customer reads the whole conversation back, including the team's reply.
  const read = await transcript(cookie);
  assert.equal(read.status, 200);
  const data = (await read.json()).data;
  assert.equal(data.threadId, threadId);
  assert.deepEqual(data.handoff, { active: true, status: "staff_active" });
  const roles = data.messages.map((message) => message.role);
  assert.deepEqual(roles, ["customer", "ai", "customer", "team"], `unexpected transcript: ${JSON.stringify(data.messages)}`);
  assert.equal(data.messages[3].text, "Hi, this is Asha from PawSpace. I can help.");
  assert.equal(data.messages[3].author, "PawSpace team", "staff identities are not exposed to the customer");
  assert.doesNotMatch(JSON.stringify(data), /care\.agent@pawspace\.in/);

  // 5. The inbox sees the AI's side of the conversation too.
  const aiRows = sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE thread_id=? AND template_key='web_app_chat_ai_reply'").get(threadId).n;
  assert.equal(Number(aiRows), 1, "the AI reply was not written into the thread staff read");

  // 6. Staff return the conversation to the AI; the next message is the AI's again, not the team's.
  const { manageAiHumanHandoff } = await import("../lib/ai-human-handoff.ts");
  await runWithWorkersDb(db, () => manageAiHumanHandoff(db, { actor: STAFF, threadId, customerId: "CUS-LOOP", action: "resume_ai", reason: "customer helped" }));
  const after = await (await callEndpoint(turn(cookie, "Thanks! One more question", "loop-3"))).response.json();
  assert.notEqual(after.data.withTeam, true, "after resume the message must go to the AI");
});

test("a retried message shows the stored answer instead of 'already received'", async () => {
  const { cookie } = await customer();
  const first = await (await callEndpoint(turn(cookie, "What grooming packages do you have?", "retry-1"))).response.json();
  const retry = await (await callEndpoint(turn(cookie, "What grooming packages do you have?", "retry-1"))).response.json();
  assert.equal(retry.data.duplicatePrevented, true);
  assert.ok(retry.data.ai?.turn?.output, "the retry came back without the reply");
  assert.equal(retry.data.ai.turn.output, first.data.ai.turn.output);
});

test("web chat does not reuse a booking thread for the customer's chat", async () => {
  const { sqlite, db, cookie } = await customer();
  const { ensureCommunicationTables } = await import("../lib/communication-engine.ts");
  await ensureCommunicationTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES ('THREAD-BOOKING','CUS-LOOP','BK-1',NULL,NULL,'open','ops',NULL,?,?)").run(now, now + 60_000);
  const body = await (await callEndpoint(turn(cookie, "Hello there", "scope-1"))).response.json();
  assert.notEqual(body.data.threadId, "THREAD-BOOKING");
  const next = await (await callEndpoint(turn(cookie, "Another question", "scope-2"))).response.json();
  assert.equal(next.data.threadId, body.data.threadId, "the customer's web chat must continue in its own thread");
});

test("a customer cannot read another customer's conversation", async () => {
  const owner = await customer("CUS-LOOP", "+919900000101");
  const body = await (await callEndpoint(turn(owner.cookie, "Hello", "owner-1"))).response.json();
  seedCustomer(owner.sqlite, "CUS-OTHER", "+919900000102");
  const intruder = await customerCookie(owner.db, "CUS-OTHER", "+919900000102");
  const response = await transcript(intruder, `mode=thread&threadId=${encodeURIComponent(body.data.threadId)}`);
  assert.equal(response.status, 404);
  const own = await (await transcript(intruder)).json();
  assert.deepEqual(own.data.messages, [], "a customer with no chat must get an empty conversation, not someone else's");
});

test("reading the conversation requires a signed-in customer", async () => {
  await world();
  const result = await callEndpoint(get("mode=thread"));
  assert.ok([401, 403].includes(result.response.status), `anonymous transcript read returned ${result.response.status}`);
});

test("anonymous public AI turns are rate limited per origin", async () => {
  await world();
  const ask = () => callEndpoint(post({ mode: "public", sessionKey: "rate-session", message: "Tell me about grooming" }, { "cf-connecting-ip": "203.0.113.9" }));
  for (let index = 0; index < 30; index++) assert.equal((await ask()).response.status, 200, `turn ${index + 1} was refused`);
  const refused = await ask();
  assert.equal(refused.response.status, 429);
  assert.equal((await refused.response.json()).code, "public_chat_rate_limited");
});
