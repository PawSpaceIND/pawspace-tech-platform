/**
 * The WATI-style web chat bot, executed: every service flow, bot -> AI -> person, and where a finished
 * enquiry lands (a CRM lead for a visitor, the Inbox queue / AI booking agent for a signed-in customer).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";

installWorkersHooks("__AI_WEB_CHAT_DB__", "__AI_WEB_CHAT_ENV__");
const bot = await import("../lib/web-chat-bot.ts");

const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/ai-web-chat`;
const IP = { "cf-connecting-ip": "203.0.113.44" };

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


/** A valid answer for any step the bot asks. */
function answerFor(reply) {
  if ((reply.choices || []).length > 1) return { choiceId: reply.choices[0].id };
  const prompt = reply.text.toLowerCase();
  if (prompt.includes("name")) return { text: "Asha Rao" };
  if (prompt.includes("mobile")) return { text: "98765 43210" };
  if (prompt.includes("email")) return { text: "asha@example.com" };
  if (prompt.includes("dd/mm")) return { text: "28/09" };
  return { text: "Indiranagar, Bengaluru 560038" };
}

function runFlow(code, signedIn) {
  let state = bot.initialBotState(), result = bot.runBotTurn(state, { choiceId: code, signedIn });
  for (let guard = 0; guard < 20 && result.event.type === "none"; guard++) {
    state = result.state;
    result = bot.runBotTurn(state, { ...answerFor(result.reply), signedIn });
  }
  return result;
}

test("every service has a complete guided flow, for visitors and signed-in customers", () => {
  assert.equal(bot.WEB_CHAT_FLOWS.length, 8);
  for (const flow of bot.WEB_CHAT_FLOWS) for (const signedIn of [false, true]) {
    const done = runFlow(flow.code, signedIn);
    assert.equal(done.event.type, "completed", `${flow.code} (${signedIn ? "signed in" : "visitor"}) did not complete`);
    assert.equal(done.event.service, flow.service);
    if (signedIn) assert.equal(done.event.answers.phone, undefined, "a signed-in customer must not be asked for their number");
    else assert.equal(done.event.answers.phone, "+919876543210");
  }
});

test("the WATI relocation flow asks the same questions in the same shape", () => {
  let result = bot.runBotTurn(bot.initialBotState(), { choiceId: "relocation", signedIn: false });
  assert.match(result.reply.text, /Please type your Name/);
  result = bot.runBotTurn(result.state, { text: "Santhanalakshmi", signedIn: false });
  result = bot.runBotTurn(result.state, { text: "9876543210", signedIn: false });
  assert.match(result.reply.text, /Please select the travel type/);
  assert.deepEqual(result.reply.choices.slice(0, 2).map((choice) => choice.label), ["Domestic", "International"]);
  result = bot.runBotTurn(result.state, { text: "International", signedIn: false });
  assert.match(result.reply.text, /Email ID/);
});

test("answers are validated, and a typed number picks the step's own option", () => {
  let result = bot.runBotTurn(bot.initialBotState(), { choiceId: "pet_taxi", signedIn: true });
  result = bot.runBotTurn(result.state, { text: "2", signedIn: true });
  assert.equal(result.state.answers.purpose, "Airport/station");
  const invalid = bot.runBotTurn(result.state, { text: "31/02", signedIn: true });
  assert.equal(invalid.state.step, result.state.step, "an impossible date must be asked again");
  assert.match(invalid.reply.text, /DD\/MM/);
});

test("a question at the menu goes to the AI; a person, a refund or an emergency goes to the team", () => {
  assert.equal(bot.runBotTurn(bot.initialBotState(), { text: "How is boarding different from a kennel?", signedIn: false }).event.type, "ai");
  assert.deepEqual(bot.runBotTurn(bot.initialBotState(), { text: "I need a refund", signedIn: true }).event, { type: "human", reason: "refund_payment_dispute" });
  assert.equal(bot.runBotTurn(bot.initialBotState(), { choiceId: "talk_to_team", signedIn: true }).event.type, "human");
  assert.equal(bot.runBotTurn(bot.initialBotState(), { choiceId: "request_call", signedIn: true }).event.type, "call");
  const visitor = bot.runBotTurn(bot.initialBotState(), { text: "my dog is bleeding", signedIn: false });
  assert.equal(visitor.event.type, "none", "a visitor is asked for contact details before the team is involved");
  assert.equal(visitor.state.flow, "team");
});

test("a visitor's finished enquiry becomes a CRM lead through the website intake", async () => {
  const { sqlite } = await world();
  const sessionKey = "botvisitor0000000001";
  const call = async (body) => (await callEndpoint(post({ mode: "public", bot: true, sessionKey, ...body }, IP))).response;
  const started = await (await call({ start: true })).json();
  assert.ok(started.data.bot.choices.some((choice) => choice.id === "grooming"));
  let reply = (await (await call({ choiceId: "grooming", message: "" })).json()).data.bot;
  let last;
  for (let guard = 0; guard < 12 && !last?.lead; guard++) {
    const answer = answerFor(reply);
    const response = await call({ message: answer.text || "", choiceId: answer.choiceId });
    assert.equal(response.status, 200);
    last = (await response.json()).data;
    reply = last.bot;
  }
  assert.equal(last.event, "completed");
  assert.equal(last.lead?.captured, true, `lead capture failed: ${JSON.stringify(last.lead)}`);
  const contact = sqlite.prepare("SELECT name,primary_phone,opportunity,pet_summary FROM crm_contacts").get();
  assert.equal(contact.name, "Asha Rao");
  assert.equal(contact.opportunity, "Grooming");
  assert.match(contact.pet_summary, /Grooming enquiry/);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items").get().n), 1);
});

test("a signed-in customer's bot conversation is in the thread, and a request for a person reaches the Inbox queue", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-BOT", "+919900000201");
  const cookie = await customerCookie(db, "CUS-BOT", "+919900000201");
  const call = async (body) => (await callEndpoint(post({ mode: "authenticated", bot: true, ...body }, { cookie }))).response;
  assert.equal((await call({ start: true })).status, 200);
  assert.equal((await call({ choiceId: "boarding", message: "", idempotencyKey: "bot-auth-1" })).status, 200);
  const read = await (await callEndpoint(new Request(`${ENDPOINT}?mode=thread`, { headers: { cookie } }))).response.json();
  const roles = read.data.messages.map((message) => message.role);
  assert.deepEqual(roles, ["bot", "customer", "bot"], JSON.stringify(read.data.messages));
  assert.equal(read.data.messages[1].text, "Boarding");
  assert.ok(read.data.messages[2].choices.some((choice) => choice.label === "Dog"), "the bot's buttons must come back with the transcript");

  assert.equal((await call({ choiceId: "talk_to_team", message: "", idempotencyKey: "bot-auth-2" })).status, 200);
  const handoff = sqlite.prepare("SELECT reason,status FROM ai_handoffs WHERE customer_id='CUS-BOT'").get();
  assert.deepEqual({ ...handoff }, { reason: "customer_requested_human", status: "queued" });
  const after = await (await callEndpoint(new Request(`${ENDPOINT}?mode=thread`, { headers: { cookie } }))).response.json();
  assert.equal(after.data.handoff.active, true);
});

test("a signed-in customer's finished enquiry goes to the AI booking agent, never left waiting", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-BOOK", "+919900000202");
  const cookie = await customerCookie(db, "CUS-BOOK", "+919900000202");
  const call = async (body) => (await callEndpoint(post({ mode: "authenticated", bot: true, ...body }, { cookie }))).response;
  await call({ start: true });
  let data = (await (await call({ choiceId: "dog_walking", message: "", idempotencyKey: "walk-0" })).json()).data;
  for (let index = 1; index < 6 && data.path !== "completed"; index++) {
    const thread = (await (await callEndpoint(new Request(`${ENDPOINT}?mode=thread`, { headers: { cookie } }))).response.json()).data;
    const answer = answerFor(thread.messages.at(-1));
    data = (await (await call({ message: answer.text || "", choiceId: answer.choiceId, idempotencyKey: `walk-${index}` })).json()).data;
  }
  assert.equal(data.path, "completed");
  const booking = sqlite.prepare("SELECT payload_json FROM communication_messages WHERE idempotency_key='walk-3:book'").get()
    ?? sqlite.prepare("SELECT payload_json FROM communication_messages WHERE idempotency_key LIKE '%:book'").get();
  assert.ok(booking, "the enquiry was not handed to the AI booking agent");
  assert.match(JSON.parse(booking.payload_json).text, /book Dog Walking/);
  // No live model in this world, so the AI hands the customer to a person rather than stalling.
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs WHERE customer_id='CUS-BOOK'").get().n), 1);
});

test("a visitor's lead exists as soon as they give their number, and one that stops half way is not lost", async () => {
  const { sqlite } = await world();
  const sessionKey = "botvisitor0000000002";
  const call = async (body) => (await (await callEndpoint(post({ mode: "public", bot: true, sessionKey, ...body }, IP))).response.json()).data;
  await call({ start: true });
  await call({ choiceId: "pet_taxi", message: "" });
  await call({ message: "Ravi Kumar" });
  const afterPhone = await call({ message: "9876543210" });
  assert.match(afterPhone.bot.text, /purpose of your travel/);
  const contact = sqlite.prepare("SELECT name,primary_phone,opportunity,pet_summary FROM crm_contacts").get();
  assert.equal(contact.name, "Ravi Kumar");
  assert.equal(contact.opportunity, "Pet Taxi");
  assert.match(contact.pet_summary, /in progress/);
  // Start over and pick another service: still one lead, and it is completed with the new answers.
  await call({ choiceId: "start_over", message: "" });
  let reply = (await call({ choiceId: "dog_walking", message: "" })).bot;
  let last;
  for (let guard = 0; guard < 10 && !last?.lead; guard++) { const answer = answerFor(reply); last = await call({ message: answer.text || "", choiceId: answer.choiceId }); reply = last.bot; }
  assert.equal(last.lead?.captured, true);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items").get().n), 1, "a visitor must not become two leads");
  const updated = sqlite.prepare("SELECT opportunity,pet_summary,next_action FROM crm_contacts").get();
  assert.equal(updated.opportunity, "Dog Walking");
  assert.match(updated.pet_summary, /Dog Walking enquiry/);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM crm_activities WHERE type='web_chat_bot'").get().n), 1);
});

test("a signed-in customer who stops mid-flow is nudged once, then handed to the sales queue", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-STALL", "+919900000203");
  const cookie = await customerCookie(db, "CUS-STALL", "+919900000203");
  const call = async (body) => (await callEndpoint(post({ mode: "authenticated", bot: true, ...body }, { cookie }))).response;
  await call({ start: true });
  await call({ choiceId: "grooming", message: "", idempotencyKey: "stall-1" });
  const adapter = await import("../lib/ai-web-chat-adapter.ts");
  const sweep = (asOf) => runWithWorkersDb(db, () => adapter.runWebChatBotFollowUpSweep(db, { asOf }));
  const now = Date.now();
  assert.equal((await sweep(now + 5 * 60_000)).nudged, 0, "not yet stalled");
  assert.equal((await sweep(now + 16 * 60_000)).nudged, 1);
  assert.equal((await sweep(now + 20 * 60_000)).nudged, 0, "nudged only once");
  const nudge = sqlite.prepare("SELECT payload_json FROM communication_messages WHERE idempotency_key LIKE 'web-chat-bot-nudge:%'").get();
  assert.match(JSON.parse(nudge.payload_json).text, /Still there\? .*dog or a cat/);
  assert.equal((await sweep(now + 16 * 60_000 + 2 * 60 * 60_000)).escalated, 1);
  const handoff = sqlite.prepare("SELECT reason,queue_code FROM ai_handoffs WHERE customer_id='CUS-STALL'").get();
  assert.deepEqual({ ...handoff }, { reason: "bot_abandoned", queue_code: "sales-web-chat" });
  assert.equal((await sweep(now + 5 * 60 * 60_000)).escalated, 0, "escalated only once");
});

test("a short request naming a service starts it; a lead's greeting starts the service it came for", () => {
  assert.equal(bot.runBotTurn(bot.initialBotState(), { text: "Book grooming", signedIn: true }).state.flow, "grooming");
  assert.equal(bot.runBotTurn(bot.initialBotState(), { text: "I need a dog walker", signedIn: true }).state.flow, "dog_walking");
  assert.equal(bot.runBotTurn(bot.initialBotState(), { text: "how much is grooming?", signedIn: true }).event.type, "ai", "a question goes to the AI");
  assert.equal(bot.runBotTurn(bot.initialBotState(), { text: "not grooming", signedIn: true }).state.flow, null);
  const lead = { ...bot.initialBotState(), preferredFlow: "relocation" };
  for (const reply of ["Hi", "Yes", "Plan relocation", "book now"]) assert.equal(bot.runBotTurn(lead, { text: reply, signedIn: true }).state.flow, "relocation", reply);
  assert.equal(bot.runBotTurn(bot.initialBotState(), { text: "Hi", signedIn: true }).state.flow, null, "without a lead service a greeting opens the menu");
});
