import test from "node:test";
import assert from "node:assert/strict";
import { providerPreflight, providerPreflightPassed } from "../scripts/elevenlabs-provider-preflight.mjs";
const env = { PAWSPACE_OPENAI_API_KEY: "openai-private-canary", ELEVENLABS_API_KEY: "eleven-private-canary", ELEVENLABS_AGENT_ID: "agent_test" };
test("provider preflight makes one synthetic request and one read, never a call or conversation", async () => {
  const calls = [];
  const r = await providerPreflight(env, async (url, init) => { calls.push({ url, init });
    return Response.json(calls.length === 1 ? { status: "completed", output: [{ content: [{ type: "output_text", text: "OK" }] }] } : {
      agent_id: "agent_test", phone_numbers: [], conversation_config: { agent: { prompt: { custom_llm: {
        url: "https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1/responses", api_type: "responses", api_key: { secret_id: "test-secret-reference" } } } } } });
  });
  assert.equal(r.openai.verified, true); assert.equal(r.elevenlabs.verified, true); assert.equal(r.callsPlaced, 0);
  assert.equal(r.elevenlabs.customLlmEndpointMatches, true); assert.equal(r.conversationsStarted, 0);
  assert.deepEqual(calls.map(c => c.init.method), ["POST", "GET"]);
  const body = JSON.parse(calls[0].init.body); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 128);
  assert.equal(body.reasoning.effort, "none"); assert.equal(calls[1].url, "https://api.elevenlabs.io/v1/convai/agents/agent_test");
  assert.doesNotMatch(JSON.stringify(r), /private-canary|test-secret-reference/);
});
test("missing provider secrets produce no traffic", async () => {
  let calls = 0; const r = await providerPreflight({}, async () => { calls++; throw Error("unexpected"); });
  assert.equal(calls, 0); assert.equal(r.openai.verified, false); assert.equal(r.elevenlabs.verified, false);
});
test("provider errors and transport errors cannot leak credentials or response details", async () => {
  for (const failure of [async () => Response.json({ error: "private-provider-canary" }, { status: 401 }), async () => { throw Error("private-provider-canary"); }]) {
    const r = await providerPreflight(env, failure); assert.equal(r.openai.verified, false); assert.equal(r.elevenlabs.verified, false);
    assert.doesNotMatch(JSON.stringify(r), /private-provider-canary|private-canary/);
  }
});
test("an agent-name mismatch and unconfigured LLM are never marked connected end-to-end", async () => {
  let calls = 0; const r = await providerPreflight(env, async () => Response.json(++calls === 1 ? { status: "incomplete", output_text: "OK" } : { agent_id: "agent_other" }));
  assert.equal(r.openai.verified, false); assert.equal(r.elevenlabs.verified, false);
  assert.equal(r.elevenlabs.customLlmEndpointMatches, false); assert.equal(r.productionReady, false);
});

for (const missing of ["customLlmEndpointMatches", "responsesApiSelected", "serverSideLlmAuthConfigured"]) {
  test(`successful provider reads cannot pass with invalid custom LLM configuration: ${missing}`, async () => {
    const good = { openai: { verified: true }, elevenlabs: { verified: true, customLlmEndpointMatches: true, responsesApiSelected: true, serverSideLlmAuthConfigured: true } };
    assert.equal(providerPreflightPassed(good), true);
    good.elevenlabs[missing] = false;
    assert.equal(providerPreflightPassed(good), false);
    delete good.elevenlabs[missing];
    assert.equal(providerPreflightPassed(good), false);
  });
}
