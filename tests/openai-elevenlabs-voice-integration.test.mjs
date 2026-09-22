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

test("ElevenLabs post-call HMAC verification rejects stale and tampered payloads",async()=>{
 const mod=await import("../lib/elevenlabs-post-call.ts"),secret="post-call-secret",raw='{"type":"post_call_transcription"}',timestamp=1800000000;
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${raw}`)))).map(v=>v.toString(16).padStart(2,"0")).join("");
 assert.equal((await mod.verifyElevenLabsWebhook(raw,`t=${timestamp},v0=${sig}`,{ELEVENLABS_WEBHOOK_SECRET:secret},timestamp)).verified,true);
 assert.equal((await mod.verifyElevenLabsWebhook(raw+"x",`t=${timestamp},v0=${sig}`,{ELEVENLABS_WEBHOOK_SECRET:secret},timestamp)).verified,false);
 assert.equal((await mod.verifyElevenLabsWebhook(raw,`t=${timestamp},v0=${sig}`,{ELEVENLABS_WEBHOOK_SECRET:secret},timestamp+1900)).verified,false);
});

test("Exotel human transfer readiness stays UAT-gated and points at India residency",async()=>{
 const mod=await import("../lib/elevenlabs-post-call.ts");
 const status=mod.elevenLabsTransferReadiness({PAWSPACE_VOICE_RUNTIME:"elevenlabs",PAWSPACE_VOICE_HUMAN_TRANSFER_NUMBER:"+918000000000"});
 assert.equal(status.enabled,true);
 assert.equal(status.destinationConfigured,true);
 assert.equal(status.exotelConnectAppletRequired,true);
 assert.match(status.connectAppletUrl,/api\.in\.residency\.elevenlabs\.io/);
 assert.equal(status.productionReady,false);
});

test("ElevenLabs custom LLM extracts the latest user input and streams Responses-compatible SSE",async()=>{
 const mod=await import("../lib/elevenlabs-custom-llm.ts");
 assert.equal(mod.extractElevenLabsResponsesInput({input:[{role:"assistant",content:[{type:"output_text",text:"hi"}]},{role:"user",content:[{type:"input_text",text:"book grooming tomorrow"}]}]}),"book grooming tomorrow");
 const sse=mod.responsesSse("I can help with that.");
 assert.match(sse,/response\.output_text\.delta/);
 assert.match(sse,/I can help with that\./);
 assert.match(sse,/data: \[DONE\]/);
});

test("ElevenLabs custom LLM bearer auth fails closed",async()=>{
 const mod=await import("../lib/elevenlabs-custom-llm.ts");
 const make=(auth)=>new Request("https://example.test",{headers:auth?{authorization:auth}:{}});
 assert.throws(()=>mod.assertElevenLabsLlmAuth(make(),{ELEVENLABS_LLM_SECRET:"secret"}));
 assert.throws(()=>mod.assertElevenLabsLlmAuth(make("Bearer wrong"),{ELEVENLABS_LLM_SECRET:"secret"}));
 assert.doesNotThrow(()=>mod.assertElevenLabsLlmAuth(make("Bearer secret"),{ELEVENLABS_LLM_SECRET:"secret"}));
});
