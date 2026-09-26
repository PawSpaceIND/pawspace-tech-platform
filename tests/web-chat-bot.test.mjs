/**
 * The WATI-style web chat bot, executed: every service flow, bot -> AI -> person, and where a finished
 * enquiry lands (a CRM lead for a visitor, the Inbox queue / AI booking agent for a signed-in customer).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";

installWorkersHooks("__AI_WEB_CHAT_DB__", "__AI_WEB_CHAT_ENV__");
/* Load the route before any request exists. Under the loader-hook fallback (Node 22.16 in CI), the first
 * import of the route module while a cloned request body is pending leaves the original body unreadable. */
const route = await import("../app/api/ai-web-chat/route.ts");
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

test("WATI relocation: pet type (Other is typed), cities, a DD/MM/YY date, then confirm - and it goes to the relocation desk", () => {
  const { result, asked } = walk("relocation", ["Domestic", "maya@example.com", "Other", "Rabbit", "Bengaluru", "Delhi", "15/11/26", "No", "Travel date is 20/11 instead"]);
  assert.match(asked[3], /Please type the pet type/);
  assert.match(asked[5], /destination city/);
  assert.match(asked[6], /DD\/MM\/YY/);
  assert.match(asked[7], /Please confirm the following details[\s\S]*Pet type: Other[\s\S]*To location: Delhi[\s\S]*Date of travel: 15\/11\/2026/);
  assert.match(asked[8], /required changes/);
  assert.equal(result.event.type, "completed");
  assert.equal(result.event.followUp, "team");
  assert.equal(result.event.followUpReason, "sensitive_relocation", "relocation goes to the relocation desk queue");
  assert.match(result.reply.text, /relocation partner team will contact you on phone within 24 hours/);
  assert.doesNotMatch(result.reply.text, /₹400/, "WATI shows no grooming offer after relocation");
  assert.equal(walk("relocation", ["International", "maya@example.com", "Dog", "Bengaluru", "Dubai", "01/12/26", "Yes"]).result.event.type, "completed", "Yes finishes");
});

test("WATI pet taxi: 'Outstation from BLR' continues in the relocation flow without asking the name again", () => {
  let result = bot.runBotTurn(bot.initialBotState(), { choiceId: "pet_taxi", signedIn: false });
  result = bot.runBotTurn(result.state, { text: "Ravi Kumar", signedIn: false });
  result = bot.runBotTurn(result.state, { text: "9876543210", signedIn: false });
  result = bot.runBotTurn(result.state, { text: "Outstation from BLR", signedIn: false });
  assert.equal(result.state.flow, "relocation");
  assert.match(result.reply.text, /Outstation from BLR trips are arranged by our pet relocation team[\s\S]*travel type/);
  assert.equal(result.state.answers.name, "Ravi Kumar");
  assert.equal(result.state.answers.via, "Pet Taxi - Outstation from BLR");
});

test("answers are validated, and a typed number picks the step's own option", () => {
  let result = bot.runBotTurn(bot.initialBotState(), { choiceId: "pet_taxi", signedIn: true });
  result = bot.runBotTurn(result.state, { text: "1", signedIn: true });
  assert.equal(result.state.answers.travelType, "Incity");
  for (const typed of ["1", "1", "1", "1", "1", "2", "1"]) result = bot.runBotTurn(result.state, { text: typed, signedIn: true });
  assert.equal(result.state.answers.purpose, "Airport/station");
  assert.equal(result.state.answers.luggage, "1-2", "an airport trip asks about luggage, as in WATI");
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
  assert.ok(read.data.messages[2].choices.some((choice) => choice.label === "First-time Enquiry"), "the bot's buttons must come back with the transcript");

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
  assert.match(afterPhone.bot.text, /select the travel type/);
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

test("a signed-in customer who stops mid-flow is reminded at 10 minutes, PawSpace AI takes over at 20, then a person", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-STALL", "+919900000203");
  const cookie = await customerCookie(db, "CUS-STALL", "+919900000203");
  const call = async (body) => (await callEndpoint(post({ mode: "authenticated", bot: true, ...body }, { cookie }))).response;
  await call({ start: true });
  await call({ choiceId: "grooming", message: "", idempotencyKey: "stall-1" });
  const adapter = await import("../lib/ai-web-chat-adapter.ts");
  const sweep = (asOf) => runWithWorkersDb(db, () => adapter.runWebChatBotFollowUpSweep(db, { asOf }));
  const now = Date.now(), min = 60_000;
  assert.equal((await sweep(now + 5 * min)).nudged, 0, "not yet stalled");
  // A reminder that fails to post leaves the session as it was, so the next sweep sends it.
  sqlite.exec("CREATE TRIGGER messages_offline BEFORE INSERT ON communication_messages BEGIN SELECT RAISE(ABORT, 'offline'); END");
  assert.equal((await sweep(now + 11 * min)).nudged, 0);
  sqlite.exec("DROP TRIGGER messages_offline");
  assert.equal((await sweep(now + 11 * min)).nudged, 1, "first reminder at 10 minutes");
  assert.equal((await sweep(now + 15 * min)).takenOver, 0, "the second waits another 10 minutes");
  assert.equal((await sweep(now + 22 * min)).takenOver, 1, "PawSpace AI takes over at 20 minutes");
  const texts = sqlite.prepare("SELECT payload_json FROM communication_messages WHERE idempotency_key LIKE 'web-chat-bot-remind:%' OR idempotency_key LIKE 'web-chat-bot-takeover:%' ORDER BY created_at").all().map((row) => JSON.parse(row.payload_json).text);
  assert.match(texts[0], /Still there\? .*active grooming subscription/);
  assert.match(texts[1], /PawSpace AI here\. Pick an option, or just tell me in your own words/);
  const session = JSON.parse(sqlite.prepare("SELECT state_json FROM web_chat_bot_sessions WHERE session_ref='customer:CUS-STALL'").get().state_json);
  assert.equal(session.aiTakeover, true, "anything that is not an option now goes to the AI");
  assert.equal((await sweep(now + 60 * min)).escalated, 0, "a person only after two more hours");
  assert.equal((await sweep(now + 22 * min + 2 * 60 * min)).escalated, 1);
  const handoff = sqlite.prepare("SELECT reason,queue_code FROM ai_handoffs WHERE customer_id='CUS-STALL'").get();
  assert.deepEqual({ ...handoff }, { reason: "bot_abandoned", queue_code: "sales-web-chat" });
  assert.equal((await sweep(now + 5 * 60 * min)).escalated, 0, "escalated only once");
});

test("a second answer that does not fit the question goes to PawSpace AI, then the question is asked again", () => {
  let state = bot.runBotTurn(bot.initialBotState(), { choiceId: "grooming", signedIn: true }).state;
  const first = bot.runBotTurn(state, { text: "hmm what is included", signedIn: true });
  assert.equal(first.event.type, "none"); assert.match(first.reply.text, /Please pick one of the options/);
  const second = bot.runBotTurn(first.state, { text: "which one is best for a husky?", signedIn: true });
  assert.deepEqual(second.event, { type: "ai", question: "which one is best for a husky?" });
  assert.match(second.reply.text, /^Whenever you're ready: /); assert.equal(second.state.step, state.step, "the flow waits on the same question");
  const answered = bot.runBotTurn(second.state, { choiceId: second.reply.choices[0].id, signedIn: true });
  assert.equal(answered.state.misses, undefined, "an answer clears the misses");
  state = { ...first.state, misses: 0, aiTakeover: true };
  assert.equal(bot.runBotTurn(state, { text: "can you just book it", signedIn: true }).event.type, "ai", "after a takeover the first off-script answer goes to the AI");
});

test("the follow-up timing is shared by web chat and WhatsApp", () => {
  const state = bot.runBotTurn(bot.initialBotState(), { choiceId: "grooming", signedIn: true }).state, t = 1_000_000_000_000, min = 60_000;
  assert.equal(bot.botFollowUp(state, { asOf: t + 9 * min, idleSince: t, signedIn: true }).kind, "wait");
  const remind = bot.botFollowUp(state, { asOf: t + 10 * min, idleSince: t, signedIn: true });
  assert.equal(remind.kind, "remind");
  const takeover = bot.botFollowUp(remind.next, { asOf: t + 20 * min, idleSince: t + 10 * min, signedIn: true });
  assert.equal(takeover.kind, "takeover"); assert.equal(takeover.next.aiTakeover, true);
  assert.equal(bot.botFollowUp(takeover.next, { asOf: t + 20 * min + 119 * min, idleSince: t + 20 * min, signedIn: true }).kind, "wait");
  assert.equal(bot.botFollowUp(takeover.next, { asOf: t + 20 * min + 120 * min, idleSince: t + 20 * min, signedIn: true }).kind, "escalate");
  assert.equal(bot.botFollowUp(bot.initialBotState(), { asOf: t + 99 * min, idleSince: t, signedIn: true }).kind, "wait", "only an unfinished flow is followed up");
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

test("a lead's service survives a question to the AI and 'Ask a question'", () => {
  let state = { ...bot.initialBotState(), preferredFlow: "relocation" };
  for (const input of [{ text: "how much does relocation cost?" }, { choiceId: "ask_ai" }, { text: "Hi" }]) {
    const result = bot.runBotTurn(state, { ...input, signedIn: true });
    state = result.state;
    if (state.flow) break;
    assert.equal(state.preferredFlow, "relocation", JSON.stringify(input));
  }
  assert.equal(bot.runBotTurn(state, { text: "Yes", signedIn: true }).state.flow, "relocation");
});

test("a date without a year means its next occurrence and is stored with the year", () => {
  const now = Date.UTC(2026, 8, 26);
  assert.equal(bot.parseDayMonth("26/09", now), "26/09/2026", "today counts");
  assert.equal(bot.parseDayMonth("25/09", now), "25/09/2027");
  assert.equal(bot.parseDayMonth("5-1", now), "05/01/2027");
  assert.equal(bot.parseDayMonth("29/02", Date.UTC(2027, 5, 1)), "29/02/2028", "a leap day waits for the next leap year");
  assert.equal(bot.parseDayMonth("31/04", now), null);
  assert.equal(bot.parseDayMonth("29/02/2027", now), null);
});

test("two messages cannot both answer the same question: a stale save is refused and re-run", async () => {
  const { db } = await world();
  const store = await import("../lib/web-chat-bot-store.ts");
  await store.saveBotSession(db, "customer:CUS-RACE", bot.initialBotState());
  const read = await store.loadBotSessionVersion(db, "customer:CUS-RACE");
  const first = bot.runBotTurn(read.state, { choiceId: "grooming", signedIn: true });
  const second = bot.runBotTurn(read.state, { choiceId: "boarding", signedIn: true });
  assert.equal(await store.claimBotSession(db, "customer:CUS-RACE", first.state, read.version), true);
  assert.equal(await store.claimBotSession(db, "customer:CUS-RACE", second.state, read.version), false, "the stale turn must not overwrite the first");
  assert.equal((await store.loadBotSession(db, "customer:CUS-RACE")).flow, "grooming");
  const rerun = await store.advanceBotSession(db, "customer:CUS-RACE", (state) => bot.runBotTurn(state, { choiceId: "no", signedIn: true }));
  assert.equal(rerun.state.answers.subscription, "No", "the re-run answers the question the customer is actually on");
});

/* ---------------------------------------------------------------------------------------------------
 * The WATI flows, branch by branch, as exported from PawSpace's WATI account.
 * --------------------------------------------------------------------------------------------------- */
function walkWith(code, inputs, crossSell, signedIn = true) {
  let result = bot.runBotTurn(bot.initialBotState(), { choiceId: code, signedIn, crossSell });
  for (const input of inputs) result = bot.runBotTurn(result.state, { ...(typeof input === "string" ? { text: input } : input), signedIn, crossSell });
  return { result };
}

function walk(code, inputs, signedIn = true) {
  let result = bot.runBotTurn(bot.initialBotState(), { choiceId: code, signedIn });
  const asked = [result.reply.text];
  for (const input of inputs) {
    result = bot.runBotTurn(result.state, { ...(typeof input === "string" ? { text: input } : input), signedIn });
    asked.push(result.reply.text);
  }
  return { result, asked };
}

test("WATI grooming: two dogs pick a breed each, 'Show more breeds' pages the list, and OK confirms", () => {
  const { result, asked } = walk("grooming", ["No", "Dog", "2", "Show more breeds", "Pug", "Labrador", "Complete Makeover", "28/09", "9am-11am", "Flat 4, 12th Main, Indiranagar https://maps.app.goo.gl/x", "OK"]);
  assert.match(asked[0], /active grooming subscription/);
  assert.match(asked[3], /Breed of your 1st pet/);
  assert.match(asked[5], /Breed of your 2nd pet/);
  assert.match(asked[6], /Trusted by 12000\+ pet parents[\s\S]*Please select the package/);
  assert.match(asked[10], /Please confirm the following details[\s\S]*Breed: Pug[\s\S]*2nd pet's breed: Labrador[\s\S]*Would you like me to confirm the booking\?/);
  assert.equal(result.event.type, "completed");
  assert.equal(result.event.followUp, undefined, "a new grooming booking goes to PawSpace AI to price and book");
  assert.doesNotMatch(result.event.summary, /Show more/);
});

test("WATI grooming: 'Others' breed and three or more pets are typed; a cat gets the cat packages", () => {
  let { asked } = walk("grooming", ["No", "Dog", "1", "Show more breeds", "Others"]);
  assert.match(asked.at(-1), /type the breed of the pet\(s\)/);
  ({ asked } = walk("grooming", ["No", "Cat", "3 & above", "Persian and Bombay"]));
  assert.match(asked[3], /type the breed/);
  const cat = walk("grooming", ["No", "Cat", "1", "Persian Cat"]).result.reply.choices.map((choice) => choice.label);
  assert.deepEqual(cat, ["Routine Grooming ₹1,149", "Bath & Basic ₹1,899", "Complete Makeover ₹2,399", "Start over"]);
});

test("WATI grooming: 'No' to confirm starts again; an active subscription goes to the team", () => {
  const again = walk("grooming", ["No", "Dog", "1", "Beagle", "Essential Bath", "28/09", "9am-11am", "Koramangala 5th block", "No"]).result;
  assert.equal(again.state.status, "collecting");
  assert.equal(again.state.answers.petType, undefined, "the details are asked again from the start");
  assert.match(again.reply.text, /go through the details again[\s\S]*active grooming subscription/);
  const subscription = walk("grooming", ["Yes", "30/09", "3pm-5pm", "Yes", "1, 3", "No, it's changed", "New flat, HSR Layout"]).result;
  assert.equal(subscription.event.type, "completed");
  assert.equal(subscription.event.followUp, "team");
  assert.match(subscription.event.summary, /Add-ons list: 1, 3[\s\S]*New address: New flat, HSR Layout/);
  assert.match(subscription.reply.text, /for order confirmation[\s\S]*Space for grooming/);
  const same = walk("grooming", ["Yes", "30/09", "3pm-5pm", "No", "Yes, it's same"]).result;
  assert.equal(same.event.type, "completed", "the same address ends the subscription branch");
});

test("WATI training: a city outside Bangalore and Hyderabad ends with the apology; an existing customer types a requirement", () => {
  const away = walk("training", ["Others"]).result;
  assert.equal(away.state.status, "done");
  assert.equal(away.event.type, "none");
  assert.match(away.reply.text, /only available in Bangalore and Hyderabad/);
  const existing = walk("training", ["Bangalore", "Existing Customer", "Need two more sessions"]).result;
  assert.equal(existing.event.type, "completed");
  assert.equal(existing.event.followUp, "team");
  assert.match(existing.event.summary, /Requirement: Need two more sessions/);
});

test("WATI training: one dog is picked from the lists; two dogs are typed; the grooming offer follows", () => {
  const one = walk("training", ["Hyderabad", "First-time Enquiry", "1", "Show more", "Boxer", "Pup - less than 1yr", "Male", "Leash pulling", "01/10/2026", "5pm-7pm"]).result;
  assert.equal(one.event.type, "completed");
  assert.match(one.event.summary, /Breed: Boxer[\s\S]*Age: Pup - less than 1yr[\s\S]*Gender: Male[\s\S]*Consultation time: 5pm-7pm/);
  const { asked } = walk("training", ["Bangalore", "First-time Enquiry", "2"]);
  assert.match(asked.at(-1), /specify the breed of the Dogs/);
  const visitor = walk("training", ["Asha Rao", "9876543210", "Bangalore", "First-time Enquiry", "1", "Labrador", "Adult - 1-3 yrs", "Female", "Toilet training", "01/10/2026", "11am-1pm", "Yes, WhatsApp me"], false).result;
  assert.equal(visitor.event.type, "completed");
  assert.match(visitor.reply.text, /Happiness Team[\s\S]*₹400 off Pet Grooming/);
  assert.deepEqual(visitor.reply.choices.map((choice) => choice.label), ["Get ₹400 off", "Pay full price later"]);
  const offer = bot.runBotTurn(visitor.state, { choiceId: "grooming_offer", signedIn: false });
  assert.equal(offer.state.flow, "grooming");
  assert.equal(offer.state.answers.offer, "₹400 off Pet Grooming");
  assert.match(offer.reply.text, /active grooming subscription/);
});

test("WATI boarding and sitting: new booking, existing booking, and the eldest pet's age", () => {
  const fresh = walk("boarding", ["First-time Enquiry", "Bangalore", "Both Cat and Dog", "2", "1 to 3 years", "Overnight - 24 hrs", "2-5 days", "28/09 10am", "30/09 6pm"]).result;
  assert.equal(fresh.event.type, "completed");
  assert.match(fresh.event.summary, /City: Bangalore[\s\S]*Type of pet: Both Cat and Dog[\s\S]*Eldest pet's age: 1 to 3 years[\s\S]*Check out: 30\/09 6pm/);
  const repeat = walk("pet_sitting", ["Existing Customer", "New Booking", "Up to 10 hr", "0-2 days", "01/10 9am", "01/10 7pm"]).result;
  assert.equal(repeat.event.type, "completed");
  assert.equal(repeat.event.followUp, undefined);
  assert.doesNotMatch(repeat.event.summary, /City/, "an existing customer is not asked the city again");
  const lookup = walk("pet_sitting", ["Existing Customer", "Existing Booking", "Change my sitter's timing"]).result;
  assert.equal(lookup.event.followUp, "team");
});

test("WATI pet taxi: round trips ask the waiting period, and 'No' to the summary asks what to change", () => {
  const { result, asked } = walk("pet_taxi", ["Incity", "Dog", "1", "3+ years", "1-2", "Yes", "Vet Visits", "05/10", "10:30 AM", "Round Trip", "60 mins", "HSR Layout", "Cessna vet clinic", "No", "Pick up at 11 AM instead"]);
  assert.match(asked[10], /waiting period/);
  assert.match(asked[13], /Please confirm the following details[\s\S]*Handler: Yes[\s\S]*Do you confirm the above details\?/);
  assert.equal(result.event.type, "completed");
  assert.match(result.event.summary, /Waiting period: 60 mins[\s\S]*Required change: Pick up at 11 AM instead/);
  assert.equal(walk("pet_taxi", ["Incity", "Cat", "1", "3+ years", "0", "No", "Leisure (incity)trip", "05/10", "9 AM", "One way trip", "Whitefield", "Indiranagar", "Yes"]).result.event.followUp, undefined, "an in-city trip is priced by PawSpace AI");
});

test("grooming package buttons carry the catalogue price; typing the name still picks it, and the answer is the name", async () => {
  const { groomingCatalogue } = await import("../lib/grooming-governance.ts");
  const price = (code) => groomingCatalogue.find((row) => row.code === code).singlePrice;
  assert.deepEqual([price("dog-bath"), price("dog-basic"), price("dog-makeover")], [1349, 1899, 2399], "the business's regular single-pet prices");
  const at = walk("grooming", ["No", "Dog", "1", "Labrador"]).result;
  assert.deepEqual(at.reply.choices.map((choice) => choice.label), ["Essential Bath ₹1,349", "Bath & Basic ₹1,899", "Complete Makeover ₹2,399", "Start over"]);
  assert.deepEqual(at.reply.choices.slice(0, 3).map((choice) => choice.id), ["essential_bath", "bath_basic", "complete_makeover"], "ids stay name-based");
  for (const input of ["Essential Bath", "Essential Bath ₹1,349", { choiceId: "essential_bath" }, "1"]) {
    const picked = bot.runBotTurn(at.state, { ...(typeof input === "string" ? { text: input } : input), signedIn: true });
    assert.equal(picked.state.answers.package, "Essential Bath", JSON.stringify(input));
  }
});

test("the ₹400 cross-sell carries its coupon code into the grooming enquiry, and the code leads the summary", () => {
  const done = walk("training", ["Bangalore", "First-time Enquiry", "1", "Labrador", "Adult - 1-3 yrs", "Male", "Leash pulling", "01/10/2026", "5pm-7pm"]).result;
  assert.match(done.reply.text, new RegExp(`Use code ${bot.GROOMING_CROSS_SELL_COUPON} when you book`));
  let result = bot.runBotTurn(done.state, { choiceId: "grooming_offer", signedIn: true });
  assert.equal(result.state.answers.coupon, "GROOM400");
  assert.match(result.reply.text, /Your code GROOM400 is noted/);
  for (const input of ["No", "Dog", "1", "Labrador", "Bath & Basic", "28/09", "9am-11am", "HSR Layout", "No"]) result = bot.runBotTurn(result.state, { text: input, signedIn: true });
  assert.equal(result.state.answers.coupon, "GROOM400", "'No' to confirm starts again but keeps the code");
  for (const input of ["No", "Dog", "1", "Labrador", "Bath & Basic", "28/09", "9am-11am", "HSR Layout", "OK"]) result = bot.runBotTurn(result.state, { text: input, signedIn: true });
  assert.equal(result.event.type, "completed");
  assert.match(result.event.summary.split("\n")[1], /^Offer: ₹400 off Pet Grooming \(use code GROOM400\)$/);
});

test("the ₹400 cross-sell is only promised while its coupon can be used, and in its cities", () => {
  const finishTraining = (city, crossSell) => walkWith("training", [city, "First-time Enquiry", "1", "Labrador", "Adult - 1-3 yrs", "Male", "Leash pulling", "01/10/2026", "5pm-7pm"], crossSell).result;
  const live = finishTraining("Bangalore", { code: "GROOM400", cityIds: ["blr"] });
  assert.match(live.reply.text, /Use code GROOM400/);
  const paused = finishTraining("Bangalore", null);
  assert.doesNotMatch(paused.reply.text, /₹400|GROOM400/, "a paused or used-up campaign is not promised");
  assert.deepEqual(paused.reply.choices.map((choice) => choice.id), ["start_over"]);
  assert.equal(bot.runBotTurn(paused.state, { choiceId: "grooming_offer", signedIn: true, crossSell: null }).state.flow, null, "the offer button cannot be used either");
  const hyderabad = finishTraining("Hyderabad", { code: "GROOM400", cityIds: ["blr"] });
  assert.doesNotMatch(hyderabad.reply.text, /GROOM400/, "a Bangalore-only code is not promised to a Hyderabad enquiry");
  const renamed = finishTraining("Bangalore", { code: "GROOM450", cityIds: ["blr"] });
  assert.match(renamed.reply.text, /Use code GROOM450/, "the code staff set in Control > Coupons");
  assert.equal(bot.runBotTurn(renamed.state, { choiceId: "grooming_offer", signedIn: true, crossSell: { code: "GROOM450", cityIds: ["blr"] } }).state.answers.coupon, "GROOM450");
});

test("a conversation saved before the flows changed shape starts again instead of resuming at the wrong question", () => {
  const stale = { version: 1, status: "collecting", flow: "relocation", step: 3, answers: { travelType: "Domestic", email: "a@b.co", from: "Bengaluru" } };
  assert.deepEqual(bot.parseBotState(JSON.stringify(stale)), bot.initialBotState());
  assert.equal(bot.parseBotState(bot.initialBotState()).status, "menu");
});

test("a visitor's relocation - including Pet Taxi 'Outstation from BLR' - becomes a relocation lead on the relocation desk", async () => {
  const { sqlite } = await world();
  const sessionKey = "botvisitor0000000009";
  const call = async (body) => (await (await callEndpoint(post({ mode: "public", bot: true, sessionKey, ...body }, IP))).response.json()).data;
  await call({ start: true });
  await call({ choiceId: "pet_taxi", message: "" });
  await call({ message: "Ravi Kumar" });
  await call({ message: "9876543210" });
  assert.equal(sqlite.prepare("SELECT service FROM lead_work_items").get().service, "Pet Taxi", "the lead exists from the number");
  let last;
  for (const message of ["Outstation from BLR", "Domestic", "ravi@example.com", "Dog", "Bengaluru", "Delhi", "15/11/26", "Yes", "Yes, WhatsApp me"]) last = await call({ message });
  assert.equal(last.event, "completed");
  assert.match(last.bot.text, /relocation partner team will contact you/);
  const lead = sqlite.prepare("SELECT service, owner FROM lead_work_items").get();
  assert.deepEqual({ ...lead }, { service: "Pet Relocation", owner: "cx-relocation" });
  assert.equal(last.lead.routedTo, "cx-relocation");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items").get().n), 1, "still one lead");
});

test("a stale saved conversation restarts the questions but keeps the visitor's lead", () => {
  const stale = { version: 1, status: "collecting", flow: "pet_taxi", step: 4, answers: { name: "Ravi" }, leadId: "LEAD-KEEP", preferredFlow: "pet_taxi" };
  const parsed = bot.parseBotState(JSON.stringify(stale));
  assert.equal(parsed.status, "menu");
  assert.equal(parsed.leadId, "LEAD-KEEP", "the lead is updated, not duplicated");
  assert.equal(parsed.preferredFlow, "pet_taxi");
  assert.deepEqual(parsed.answers, {});
});
