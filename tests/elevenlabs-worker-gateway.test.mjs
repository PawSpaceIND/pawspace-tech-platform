import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installAiHooks, freshUatAiDb, seedCustomer, inboundMessage, applyOwnedDdl, stubFetch, jsonResponse } from "./helpers/ai-harness.mjs";
import { runWithWorkersDb } from "./helpers/module-hooks.mjs";
installAiHooks();
const { authorizeApiRequest, requiredPermission } = await import("../lib/api-gateway.ts");
const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
const { requestForAuthorization } = await import("../lib/trusted-workspace-identity.ts");
const routes = {
  "/api/elevenlabs/v1/responses": await import("../app/api/elevenlabs/v1/responses/route.ts"),
  "/api/webhooks/elevenlabs/init": await import("../app/api/webhooks/elevenlabs/init/route.ts"),
  "/api/webhooks/elevenlabs/post-call": await import("../app/api/webhooks/elevenlabs/post-call/route.ts"),
};
const ORIGIN = "https://pawspace-staging-gateway.test";
const credentials = { ELEVENLABS_API_KEY: "test-only-elevenlabs", ELEVENLABS_AGENT_ID: "agent-test",
  ELEVENLABS_LLM_SECRET: "test-only-llm-secret", ELEVENLABS_INIT_WEBHOOK_SECRET: "test-only-init-secret",
  ELEVENLABS_WEBHOOK_SECRET: "test-only-webhook-secret" };
function world(t, overrides = {}) {
  const w = freshUatAiDb({ ...credentials, PAWSPACE_UAT_LOGIN: "on", ...overrides });
  t.after(() => w.sqlite.close());
  w.env = { ...globalThis.__PAWSPACE_TEST_ENV__, DB: w.db };
  globalThis.__PAWSPACE_TEST_ENV__ = w.env;
  return w;
}
function request(path, body = "{}", headers = {}, method = "POST") {
  return new Request(ORIGIN + path, { method, headers: { "content-type": "application/json", ...headers },
    ...(["GET", "HEAD"].includes(method) ? {} : { body }) });
}
async function dispatch(w, req) {
  return runWithWorkersDb(w.db, async () => {
    const inspection = requestForAuthorization(req, w.env);
    const session = await authorizePlatformSessionRequest(inspection, w.db);
    const access = session ?? await authorizeApiRequest(inspection, w.env);
    if (access instanceof Response) return { reachedRoute: false, response: access };
    return { reachedRoute: true, response: await routes[new URL(req.url).pathname].POST(req) };
  });
}
function signed(raw, delta = 0) {
  const t = Math.floor(Date.now() / 1000) + delta;
  const digest = createHmac("sha256", credentials.ELEVENLABS_WEBHOOK_SECRET).update(`${t}.${raw}`).digest("hex");
  return { "ElevenLabs-Signature": `t=${t},v0=${digest}` };
}
for (const path of Object.keys(routes)) {
  test(`provider POST reaches its own authentication boundary without staff login: ${path}`, async t => {
    const w = world(t), before = w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers").get().n;
    const r = await dispatch(w, request(path));
    assert.equal(r.reachedRoute, true, "a carrier cannot supply a staff session cookie");
    assert.equal(r.response.status, 401);
    assert.doesNotMatch(await r.response.text(), /staging-login|sign_in_required/);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers").get().n, before);
  });
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    test(`unsupported provider method stays protected: ${method} ${path}`, async () => {
      assert.notEqual(await requiredPermission(request(path, "{}", {}, method)), null);
    });
  }
  test(`near-prefix provider path stays protected: ${path}/extra`, async () => {
    assert.notEqual(await requiredPermission(request(path + "/extra")), null);
  });
}
test("a valid LLM bearer reaches canonical identity validation but cannot manufacture a session", async t => {
  const w = world(t);
  const r = await dispatch(w, request("/api/elevenlabs/v1/responses", JSON.stringify({ input: "grooming services" }),
    { authorization: `Bearer ${credentials.ELEVENLABS_LLM_SECRET}` }));
  assert.equal(r.reachedRoute, true); assert.equal(r.response.status, 200);
  const failureSse=await r.response.text();
  assert.match(failureSse, /response\.failed/);
  assert.match(failureSse, /voice identity is missing/);
  assert.doesNotMatch(failureSse, /response\.output_text\.delta|response\.completed/);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages").get().n, 0);
});
test("authenticated initiation still rejects the wrong agent before customer or consent writes", async t => {
  const w = world(t);
  const r = await dispatch(w, request("/api/webhooks/elevenlabs/init", JSON.stringify({ agent_id: "wrong-agent" }),
    { authorization: `Bearer ${credentials.ELEVENLABS_INIT_WEBHOOK_SECRET}` }));
  assert.equal(r.reachedRoute, true); assert.equal(r.response.status, 403);
});
test("signed post-call validation rejects tampered and stale payloads after edge routing", async t => {
  const w = world(t), raw = '{"type":"post_call_transcription","data":{"conversation_id":"conv-test"}}';
  for (const [body, header] of [[raw + " ", signed(raw)], [raw, signed(raw, -1900)]]) {
    const r = await dispatch(w, request("/api/webhooks/elevenlabs/post-call", body, header));
    assert.equal(r.reachedRoute, true); assert.equal(r.response.status, 401);
  }
});
for (const raw of ["null", "[]", '"text"', "123"]) {
  test(`valid credentials cannot make non-object JSON a server error: ${raw}`, async t => {
    const w = world(t);
    for (const [path, headers] of [
      ["/api/elevenlabs/v1/responses", { authorization: `Bearer ${credentials.ELEVENLABS_LLM_SECRET}` }],
      ["/api/webhooks/elevenlabs/init", { authorization: `Bearer ${credentials.ELEVENLABS_INIT_WEBHOOK_SECRET}` }],
      ["/api/webhooks/elevenlabs/post-call", signed(raw)],
    ]) {
      const r = await dispatch(w, request(path, raw, headers));
      assert.equal(r.reachedRoute, true); assert.equal(r.response.status, 400, path);
    }
  });
}
test("staff, voice administration and money endpoints do not inherit provider access", async () => {
  for (const path of ["/api/voice-providers", "/api/ai-voice-uat", "/api/voice-outbound", "/api/customer-account/admin", "/api/finance-control", "/api/elevenlabs/admin"]) {
    assert.notEqual(await requiredPermission(request(path)), null, path);
  }
});


test("authenticated initialization forwards only canonical IDs into the documented custom_llm_extra_body wire field", async t => {
  const w = world(t);
  seedCustomer(w.sqlite, "CUS-EL-TEST", "Synthetic Voice User", "9876500091");
  await inboundMessage(w.sqlite, w.db, { threadId: "THREAD-EL-TEST", customerId: "CUS-EL-TEST",
    text: "synthetic fixture", channel: "voice", idempotencyKey: "fixture" });
  applyOwnedDdl(w.sqlite, "lib/inbound-ai-telephony.ts");
  const now = Date.now();
  w.sqlite.prepare("INSERT INTO inbound_ai_voice_sessions (id,provider_call_id,customer_id,thread_id,caller_key,status,started_at,updated_at) VALUES (?,?,?,?,?,'active',?,?)")
    .run("INVOICE-EL-TEST", "carrier-fixture", "CUS-EL-TEST", "THREAD-EL-TEST", "9876500091", now, now);
  const r = await dispatch(w, request("/api/webhooks/elevenlabs/init", JSON.stringify({
    agent_id: "agent-test", call_sid: "carrier-fixture", caller_id: "9876500091", conversation_id: "conv-fixture",
    extra_body: { pawspace_customer_id: "ATTACKER" },
  }), { authorization: `Bearer ${credentials.ELEVENLABS_INIT_WEBHOOK_SECRET}` }));
  assert.equal(r.reachedRoute, true); assert.equal(r.response.status, 200, await r.response.clone().text());
  const result = await r.response.json();
  assert.equal("extra_body" in result,false,"SDK convenience names must not replace the wire field");
  assert.deepEqual(result.custom_llm_extra_body, { pawspace_customer_id: "CUS-EL-TEST", pawspace_voice_session_id: "INVOICE-EL-TEST", pawspace_thread_id: "THREAD-EL-TEST" });
  assert.equal(result.dynamic_variables.pawspace_customer_id, result.custom_llm_extra_body.pawspace_customer_id);
  assert.doesNotMatch(JSON.stringify(result.custom_llm_extra_body), /9876500091|Synthetic Voice User|ATTACKER/);
});

test("authenticated Responses route executes a real grounded turn and returns audible text SSE", async t => {
  const w = world(t, { PAWSPACE_AI_PROVIDER: "openai", PAWSPACE_OPENAI_API_KEY: "test-only-openai" });
  seedCustomer(w.sqlite, "CUS-EL-TURN", "Synthetic Tester", "9876500092");
  await inboundMessage(w.sqlite, w.db, { threadId: "THREAD-EL-TURN", customerId: "CUS-EL-TURN",
    text: "synthetic fixture", channel: "voice", idempotencyKey: "fixture-turn" });
  const { ensureAiConversationOrchestrator } = await import("../lib/ai-conversation-orchestrator.ts");
  const { setAiRolloutStage } = await import("../lib/ai-audience-rollout.ts");
  await ensureAiConversationOrchestrator(w.db);
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensurePricingControlRuntime(w.db);
  for (const owner of ["lib/training-commercial-governance.ts", "lib/boarding-governance.ts", "lib/sitting-governance.ts", "lib/walking-governance.ts", "lib/taxi-governance.ts"])
    applyOwnedDdl(w.sqlite, owner);

  await setAiRolloutStage(w.db, { stage: "staff_only", reason: "synthetic executed voice UAT", actorEmail: "test@pawspace.test" });
  const mock = stubFetch(() => new Response([
    {type:"response.output_text.delta",delta:"I can explain PawSpace grooming services."},
    {type:"response.completed",response:{status:"completed",usage:{total_tokens:20}}},
  ].map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}}));
  t.after(() => mock.restore());
  const r = await dispatch(w, request("/api/elevenlabs/v1/responses", JSON.stringify({
    model: "pawspace-grounded-openai", input: "What grooming services do you offer?",
    elevenlabs_extra_body: { pawspace_customer_id: "CUS-EL-TURN", pawspace_thread_id: "THREAD-EL-TURN" },
  }), { authorization: `Bearer ${credentials.ELEVENLABS_LLM_SECRET}` }));
  assert.equal(r.reachedRoute, true); assert.equal(r.response.status, 200, await r.response.clone().text());
  assert.match(r.response.headers.get("content-type"), /text\/event-stream/);
  const sse = await r.response.text();

  assert.match(sse, /response\.output_text\.delta/);
  assert.match(sse, /I can explain PawSpace grooming services/, JSON.stringify({providerCalls:mock.calls.length,turns:w.sqlite.prepare("SELECT intent_code,provider,outcome,handoff_reason,policy_decision FROM ai_conversation_turns").all()}));
  assert.equal(mock.calls.length, 1, "the real adapter must reach its mocked external provider");
  assert.equal(mock.calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE template_key='elevenlabs_custom_llm_reply'").get().n, 1);
  const completed=sse.split("\n").filter(line=>line.startsWith("data: {")).map(line=>JSON.parse(line.slice(6))).find(event=>event.type==="response.completed");
  assert.equal(completed.response.pawspace_timing.path,"fast");
  for(const stage of ["groundingStarted","groundingCompleted","governanceStarted","governanceCompleted","reservationStarted","reservationCompleted"])assert.equal(typeof completed.response.pawspace_timing[stage],"number",stage);
});
