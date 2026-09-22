import test from "node:test";
import assert from "node:assert/strict";
import {installAiHooks,stubFetch,jsonResponse} from "./helpers/ai-harness.mjs";

installAiHooks();
const adapter=await import("../lib/ai-provider-adapter.ts");
const eleven=await import("../lib/elevenlabs-voice-integration.ts");

test("OpenAI is the default intelligence provider and voice uses the low-latency model",async()=>{
 globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_AI_PROVIDER_API_KEY:"test-openai-key"};
 const stub=stubFetch(()=>jsonResponse({id:"resp_1",status:"completed",output:[{type:"message",content:[{type:"output_text",text:"Hi from PawSpace"}]}],usage:{input_tokens:10,output_tokens:4,total_tokens:14}}));
 try{
  const result=await adapter.requestAiDraft({systemPrompt:"system",userPrompt:"hello",channel:"voice"});
  assert.equal(result.connected,true);
  assert.equal(result.providerRef,"openai");
  assert.equal(result.modelRef,adapter.DEFAULT_VOICE_AI_MODEL_REF);
  assert.equal(result.text,"Hi from PawSpace");
  const call=stub.calls[0],body=JSON.parse(call.init.body);
  assert.equal(call.url,"https://api.openai.com/v1/responses");
  assert.equal(call.init.headers.authorization,"Bearer test-openai-key");
  assert.equal(body.model,adapter.DEFAULT_VOICE_AI_MODEL_REF);
  assert.equal(body.store,false);
  assert.equal(body.instructions,"system");
  assert.equal(body.input,"hello");
  assert.ok(!String(call.init.body).includes("test-openai-key"));
 }finally{stub.restore();}
});

test("Anthropic remains an explicit fallback during migration",async()=>{
 globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_AI_PROVIDER:"anthropic",PAWSPACE_AI_PROVIDER_API_KEY:"test-anthropic-key"};
 const stub=stubFetch(()=>jsonResponse({type:"message",stop_reason:"end_turn",content:[{type:"text",text:"fallback"}]}));
 try{
  const result=await adapter.requestAiDraft({systemPrompt:"system",userPrompt:"hello"});
  assert.equal(result.connected,true);
  assert.equal(result.providerRef,"anthropic");
  assert.equal(result.modelRef,"claude-sonnet-4-6");
  assert.equal(stub.calls[0].url,"https://api.anthropic.com/v1/messages");
 }finally{stub.restore();}
});

test("ElevenLabs readiness defaults to India Exotel and OpenAI voice intelligence",()=>{
 const ready=eleven.elevenLabsVoiceReadiness({
  PAWSPACE_VOICE_RUNTIME:"elevenlabs",
  ELEVENLABS_API_KEY:"x",
  ELEVENLABS_AGENT_ID:"agent_123",
  ELEVENLABS_INIT_WEBHOOK_SECRET:"secret",
 });
 assert.equal(ready.enabled,true);
 assert.equal(ready.configured,true);
 assert.equal(ready.intelligenceProvider,"openai");
 assert.equal(ready.intelligenceModel,"gpt-5.6-luna");
 assert.equal(ready.exotelWebSocket,eleven.ELEVENLABS_EXOTEL_INDIA_WS);
 assert.equal(ready.productionReady,false);
});

test("ElevenLabs initiation webhook secret fails closed",()=>{
 const request=(auth)=>new Request("https://example.test/api",{headers:auth?{authorization:auth}:{}});
 assert.throws(()=>eleven.assertElevenLabsInitWebhook(request(),{ELEVENLABS_INIT_WEBHOOK_SECRET:"secret"}));
 assert.throws(()=>eleven.assertElevenLabsInitWebhook(request("Bearer wrong"),{ELEVENLABS_INIT_WEBHOOK_SECRET:"secret"}));
 assert.doesNotThrow(()=>eleven.assertElevenLabsInitWebhook(request("Bearer secret"),{ELEVENLABS_INIT_WEBHOOK_SECRET:"secret"}));
});
