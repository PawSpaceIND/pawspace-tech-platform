/**
 * Two staging defects in PawSpace AI chat, driven through the real adapter, orchestrator, tool registry
 * and provider adapter over a real SQLite-backed D1. Only the network is stubbed, so every assertion on
 * the provider is an assertion on the exact request the adapter sent.
 *
 * AI-01: any public question naming a service got the directory one-liner ("Yes. PawSpace offers
 * Boarding...") and the model never saw it. Only a bare service question may be answered from the
 * directory; anything more goes to the model when one is connected, and falls back to the directory
 * answer when none answers.
 *
 * AI-02: a signed-in customer's "Which of my bookings are coming up, and what do I still need to pay?"
 * was handed to a person as provider_error without the provider ever being called: the keyword
 * classifier calls it "unknown", web chat asks the model anyway, and the grounding's approved-knowledge
 * read was refused for "unknown" - a thrown 403 the orchestrator reports as provider_error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshUatAiDb, customerActor, staffActor, stubFetch, jsonResponse, NOW } from "./helpers/ai-harness.mjs";

installAiHooks();

const adapter = await import("../lib/ai-web-chat-adapter.ts");
const orchestrator = await import("../lib/ai-conversation-orchestrator.ts");
const rollout = await import("../lib/ai-audience-rollout.ts");
const registry = await import("../lib/ai-tool-registry.ts");
const { DEFAULT_AI_MODEL_REF } = await import("../lib/ai-provider-adapter.ts");

const API_KEY = "test-key-not-a-real-credential";
const OPENAI = { PAWSPACE_AI_PROVIDER: "openai", PAWSPACE_OPENAI_API_KEY: API_KEY };
const OPENAI_URL = "https://api.openai.com/v1/responses";
const openAiReply = (text) => jsonResponse({ status: "completed", output_text: text, usage: { input_tokens: 900, output_tokens: 60, total_tokens: 960 } });

/** The server-owned catalogue tables every grounded prompt reads, created and seeded by their owners. */
async function world(env = {}) {
  const { sqlite, db } = freshUatAiDb(env);
  await (await import("../lib/pricing-control-runtime.ts")).ensurePricingControlRuntime(db);
  await (await import("../lib/training-commercial-governance.ts")).ensureTrainingCommercialTables(db);
  await (await import("../lib/boarding-governance.ts")).ensureBoardingGovernanceTables(db);
  await (await import("../lib/sitting-governance.ts")).ensureSittingGovernanceTables(db);
  await (await import("../lib/walking-governance.ts")).ensureWalkingGovernanceTables(db);
  await (await import("../lib/taxi-governance.ts")).ensureTaxiGovernanceTables(db);
  return { sqlite, db };
}

async function withFetch(handler, run) {
  const net = stubFetch(handler);
  try { return await run(net); } finally { net.restore(); }
}

const ask = (db, query, sessionKey) => adapter.runPublicAiWebChat(db, { query, sessionKey });
const lastPublicEvent = (sqlite, sessionKey) => JSON.parse(sqlite.prepare("SELECT detail_json FROM ai_web_chat_events WHERE event_type='public_turn' AND actor_ref=? ORDER BY rowid DESC LIMIT 1").get(`public:${sessionKey}`).detail_json);

// ---------------------------------------------------------------------------------------------------
// AI-01: public chat routing
// ---------------------------------------------------------------------------------------------------

test("AI-01: bare service questions keep the directory answer and never reach the provider", async () => {
  const { db } = await world(OPENAI);
  await withFetch(() => openAiReply("should not be called"), async (net) => {
    const cases = [
      ["Do you do boarding?", "Boarding"],
      ["Boarding", "Boarding"],
      ["boarding?", "Boarding"],
      ["is grooming available", "Grooming"],
      ["Do you offer boarding?", "Boarding"],
      ["Does PawSpace offer pet relocation?", "Pet Relocation"],
      ["Hi, do you have dog walking?", "Dog Walking"],
      ["Is there a dog training service?", "Training"],
    ];
    for (const [index, [question, name]] of cases.entries()) {
      const result = await ask(db, question, `bare-question-${index}`);
      assert.equal(result.ai.turn.provider, "canonical_service_directory", question);
      assert.equal(result.ai.turn.outcome, "reply_ready", question);
      assert.equal(result.ai.providerConnected, false, question);
      assert.equal(result.ai.turn.output, `Yes. PawSpace offers ${name}. I can help you understand the service or start from the ${name} section in PawSpace.`, question);
    }
    assert.equal(net.calls.length, 0, "a bare service question is not a paid model call");
  });
});

test("AI-01: a question that names a service and asks something real goes to the connected provider, grounded", async () => {
  const { sqlite, db } = await world(OPENAI);
  const questions = [
    "What is included in PawSpace boarding?",
    "My indie dog gets anxious during thunderstorms. What should I tell the boarding host before a 3-night stay?",
    "How is boarding different from a kennel?",
  ];
  await withFetch((url, init, n) => openAiReply(`Model answer ${n}`), async (net) => {
    for (const [index, question] of questions.entries()) {
      const sessionKey = `substantive-question-${index}`;
      const result = await ask(db, question, sessionKey);
      assert.equal(result.ai.providerConnected, true, question);
      assert.equal(result.ai.turn.provider, "openai", question);
      assert.equal(result.ai.turn.modelRef, DEFAULT_AI_MODEL_REF, question);
      assert.equal(result.ai.turn.outcome, "reply_ready", question);
      assert.equal(result.ai.turn.output, `Model answer ${index + 1}`, question);
      assert.equal(result.customerDataAccess, false);
      assert.equal(result.toolExecution, false);

      const call = net.calls[index];
      assert.equal(call.url, OPENAI_URL);
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.headers.authorization, `Bearer ${API_KEY}`);
      const body = JSON.parse(call.init.body);
      assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "max_output_tokens", "model", "store"]);
      assert.equal(body.model, DEFAULT_AI_MODEL_REF);
      assert.equal(body.max_output_tokens, 650);
      assert.equal(body.store, false);
      const prompt = JSON.parse(body.input);
      assert.equal(prompt.question, question, "the model sees the visitor's actual question");
      // Grounded exactly like any model answer: the service directory, the catalogue and approved offers.
      assert.equal(prompt.canonicalServiceDirectory.find((service) => service.code === "boarding")?.enabled, true);
      assert.ok(prompt.currentServiceCatalogue.boarding.length > 0, "the boarding catalogue (with its prices) is in the prompt");
      assert.ok(Array.isArray(prompt.approvedOffers));
      assert.ok(!prompt.canonicalServiceDirectory.some((service) => "disabledReason" in service), "no internal disabled reasons reach the prompt");
      assert.match(body.instructions, /canonicalServiceDirectory is authoritative/);
      const event = lastPublicEvent(sqlite, sessionKey);
      assert.equal(event.outcome, "reply_ready");
      assert.equal(event.provider, "openai");
      assert.equal(event.providerConnected, true);
    }
    assert.equal(net.calls.length, questions.length, "one model call per substantive question");
  });
});

test("AI-01: without a connected provider the same questions fall back to the directory answer", async () => {
  const { sqlite, db } = await world({});
  // With no provider configured nothing is read for a model call, exactly as before: a missing catalogue cannot fail the turn.
  sqlite.exec("DROP TABLE service_packages");
  await withFetch(() => openAiReply("should not be called"), async (net) => {
    const result = await ask(db, "My indie dog gets anxious during thunderstorms. What should I tell the boarding host before a 3-night stay?", "no-provider-substantive");
    assert.equal(result.ai.turn.provider, "canonical_service_directory");
    assert.equal(result.ai.turn.outcome, "reply_ready");
    assert.equal(result.ai.providerConnected, false);
    assert.equal(result.ai.turn.output, "PawSpace offers Boarding. I can help you understand the service or start from the Boarding section in PawSpace.");
    assert.equal(lastPublicEvent(sqlite, "no-provider-substantive").providerFailure, "not_configured");
    const bare = await ask(db, "Do you do boarding?", "no-provider-bare");
    assert.match(bare.ai.turn.output, /^Yes\. PawSpace offers Boarding\./);
    assert.equal(lastPublicEvent(sqlite, "no-provider-bare").providerFailure, undefined, "a bare question never asked the provider");
    assert.equal(net.calls.length, 0);
  });
});

test("AI-01: a provider outage falls back to the directory answer instead of an error line", async () => {
  const { sqlite, db } = await world(OPENAI);
  await withFetch(() => jsonResponse({ error: { message: "upstream unavailable" } }, 503), async (net) => {
    const result = await ask(db, "What is included in PawSpace boarding?", "provider-outage");
    assert.equal(net.calls.length, 1, "the provider was asked");
    assert.equal(result.ai.turn.provider, "canonical_service_directory");
    assert.equal(result.ai.providerConnected, false);
    assert.equal(result.ai.turn.output, "PawSpace offers Boarding. I can help you understand the service or start from the Boarding section in PawSpace.");
    assert.equal(lastPublicEvent(sqlite, "provider-outage").providerFailure, "provider_error");
  });
});

test("AI-01: asked what a service includes, the directory fallback uses approved knowledge written for that service and nothing else", async () => {
  const { sqlite, db } = await world({});
  await (await import("../lib/ai-business-configuration.ts")).ensureAiBusinessConfiguration(db);
  const insert = sqlite.prepare("INSERT INTO ai_knowledge_source_versions (id,source_key,version,status,title,source_type,content_text,visibility_scope_json,effective_from,effective_to,immutable_hash,created_by,created_at,updated_at) VALUES (?,?,1,'active',?,'faq',?,'[\"public\"]',NULL,NULL,?,'test',?,?)");
  // Mentions boarding in its content but is not about boarding: never offered as what boarding includes.
  insert.run("K-VACC", "vaccination", "Vaccination records & reminders", "Keeping vaccinations up to date is required for some services like Boarding.", "h-vacc", NOW, NOW);
  const withoutServiceKnowledge = await ask(db, "What is included in PawSpace boarding?", "inclusions-none");
  assert.equal(withoutServiceKnowledge.ai.turn.output, "PawSpace offers Boarding. I can help you understand the service or start from the Boarding section in PawSpace.");

  insert.run("K-BOARD", "boarding_inclusions", "Boarding at PawSpace", "Boarding includes a vetted host home, two meals a day on your pet's own food, daily walks and photo updates.", "h-board", NOW, NOW);
  const withServiceKnowledge = await ask(db, "What is included in PawSpace boarding?", "inclusions-approved");
  assert.equal(withServiceKnowledge.ai.turn.provider, "canonical_service_directory");
  assert.equal(withServiceKnowledge.ai.turn.output, "PawSpace offers Boarding. From PawSpace's approved information: Boarding includes a vetted host home, two meals a day on your pet's own food, daily walks and photo updates.");
  // Only an inclusion question gets the knowledge; other questions keep the plain directory answer.
  const advice = await ask(db, "My dog is anxious - what should I tell the boarding host?", "inclusions-advice");
  assert.equal(advice.ai.turn.output, "PawSpace offers Boarding. I can help you understand the service or start from the Boarding section in PawSpace.");
});

// ---------------------------------------------------------------------------------------------------
// AI-02: signed-in "My PawSpace" chat
// ---------------------------------------------------------------------------------------------------

async function signedInWorld() {
  const { sqlite, db } = await world(OPENAI);
  await orchestrator.ensureAiConversationOrchestrator(db);
  await rollout.setAiRolloutStage(db, { stage: "customers", reason: "AI-02 executed evidence", actorEmail: staffActor.email });
  // A brand-new customer: no pets, no bookings.
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES ('CUS-NEW','blr','Nila','9876500009',NULL,NULL,'customer_app','{}',?,?)").run(NOW, NOW);
  return { sqlite, db, actor: customerActor(sqlite, "CUS-NEW") };
}
const BOOKINGS_QUESTION = "Which of my bookings are coming up, and what do I still need to pay?";
const chat = (db, actor, idempotencyKey, text = BOOKINGS_QUESTION) => adapter.runAuthenticatedAiWebChat(db, { actor, customerId: "CUS-NEW", text, idempotencyKey }, { acceptWhileWithTeam: true });
const lastAuthenticatedEvent = (sqlite) => JSON.parse(sqlite.prepare("SELECT detail_json FROM ai_web_chat_events WHERE event_type='authenticated_turn' ORDER BY rowid DESC LIMIT 1").get().detail_json);

test("AI-02: the question is unclassified, and web chat asks the model for it", () => {
  const intent = orchestrator.classifyAiIntent(BOOKINGS_QUESTION);
  assert.equal(intent.intent, "unknown", "the keyword classifier has no signal here, so the chat model-first rule applies");
});

test("AI-02: a new customer's bookings question reaches the provider with the exact request, and its answer is delivered", async () => {
  const { sqlite, db, actor } = await signedInWorld();
  const answer = "You have no upcoming bookings and nothing left to pay. Shall I help you book grooming?";
  const data = await withFetch(() => openAiReply(answer), async (net) => {
    const result = await chat(db, actor, "ai02-bookings");
    assert.equal(net.calls.length, 1, "the provider is called exactly once");
    const call = net.calls[0];
    assert.equal(call.url, OPENAI_URL);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["content-type"], "application/json");
    assert.equal(call.init.headers.authorization, `Bearer ${API_KEY}`);
    const body = JSON.parse(call.init.body);
    // The same request shape the working public path sends: no tools, schema, temperature or reasoning knobs.
    assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "max_output_tokens", "model", "store"]);
    assert.equal(body.model, DEFAULT_AI_MODEL_REF);
    assert.equal(body.max_output_tokens, 1200);
    assert.equal(body.store, false);
    assert.equal(typeof body.instructions, "string");
    const prompt = JSON.parse(body.input);
    assert.equal(prompt.channel, "chat");
    assert.equal(prompt.customerMessage, BOOKINGS_QUESTION);
    assert.equal(prompt.intent.intent, "unknown");
    assert.equal(prompt.canonicalContext.customer.customerId, "[REDACTED]", "the provider privacy boundary still sanitizes the request");
    assert.deepEqual(prompt.canonicalContext.bookings, [], "zero bookings is a valid, empty context - not an error");
    assert.deepEqual(prompt.canonicalContext.pets, []);
    assert.equal(prompt.canonicalContext.approvedKnowledge.status, "completed", "the grounding knowledge read ran");
    assert.ok(prompt.canonicalContext.catalogue.boarding.length > 0, "the server-owned catalogue grounds the answer");
    return result;
  });

  assert.notEqual(data.ai.turn.outcome, "handoff");
  assert.equal(data.ai.turn.outcome, "draft_review_required", "the orchestrator's outcome for a delivered model answer");
  assert.equal(data.ai.turn.handoffReason, null);
  assert.equal(data.ai.turn.provider, "openai");
  assert.equal(data.ai.turn.modelRef, DEFAULT_AI_MODEL_REF);
  assert.equal(data.ai.turn.output, answer);
  assert.equal(data.handoff, undefined);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs").get().n, 0, "nobody was paged");
  const mirrored = sqlite.prepare("SELECT payload_json FROM communication_messages WHERE thread_id=? AND template_key='web_app_chat_ai_reply'").get(data.threadId);
  assert.equal(JSON.parse(mirrored.payload_json).text, answer, "the customer's thread holds the answer");
  const read = sqlite.prepare("SELECT intent_code,status FROM ai_tool_execution_requests WHERE tool_code='approved_knowledge.read'").get();
  assert.deepEqual({ ...read }, { intent_code: "unknown", status: "completed" });
  assert.deepEqual(lastAuthenticatedEvent(sqlite), { outcome: "draft_review_required", handoffReason: null, autonomousExecution: false, trustSafetyRedacted: false });
});

test("AI-02: an unclassified turn may read public knowledge, and nothing else is widened", async () => {
  const { sqlite, db, actor } = await signedInWorld();
  const { threadId } = await withFetch(() => openAiReply("ok"), () => chat(db, actor, "ai02-registry", "Hello there"));
  const read = await registry.prepareAiToolExecution(db, { actor, toolCode: "approved_knowledge.read", threadId, customerId: "CUS-NEW", intent: "unknown", channel: "chat", arguments: { query: "grooming", visibilityScopes: ["public"] } });
  assert.equal(read.status, "completed");
  for (const toolCode of ["customer_bookings.read", "service_catalogue.read", "booking_status.read"]) {
    await assert.rejects(
      registry.prepareAiToolExecution(db, { actor, toolCode, threadId, customerId: "CUS-NEW", intent: "unknown", channel: "chat", arguments: {} }),
      (error) => error instanceof Response && error.status === 403,
      toolCode,
    );
  }
  assert.ok(sqlite.prepare("SELECT COUNT(*) n FROM ai_tool_execution_requests").get().n >= 1);
});

test("AI-02: a provider rejection is recorded by class and HTTP status, never by message, and not shown to the customer", async () => {
  const { sqlite, db, actor } = await signedInWorld();
  const data = await withFetch(() => jsonResponse({ error: { message: "Unsupported parameter for this model; request included Nila's question" } }, 400), (net) => chat(db, actor, "ai02-rejected").then((result) => { assert.equal(net.calls.length, 1); return result; }));
  assert.equal(data.ai.turn.outcome, "handoff");
  assert.equal(data.ai.turn.handoffReason, "provider_error");
  assert.equal("providerFailure" in data.ai, false, "diagnostics stay out of the customer's response");
  const detail = lastAuthenticatedEvent(sqlite);
  assert.equal(detail.providerFailure, "client_error_http_400");
  assert.equal(detail.handoffReason, "provider_error");
  const recorded = JSON.stringify(detail);
  for (const secret of [API_KEY, "Unsupported parameter", "Nila", BOOKINGS_QUESTION]) assert.equal(recorded.includes(secret), false, secret);
});

test("AI-02: a failure before the provider is called is told apart from a provider failure", async () => {
  const { sqlite, db, actor } = await signedInWorld();
  sqlite.exec("DROP TABLE service_packages");
  const data = await withFetch(() => openAiReply("should not be called"), (net) => chat(db, actor, "ai02-grounding-failed").then((result) => { assert.equal(net.calls.length, 0, "the provider was never reached"); return result; }));
  assert.equal(data.ai.turn.handoffReason, "provider_error", "the customer-facing reason is unchanged");
  const detail = lastAuthenticatedEvent(sqlite);
  assert.equal(detail.providerFailure, "exception_Error");
  assert.equal(JSON.stringify(detail).includes("service_packages"), false, "the error message is not recorded");
});
