import test from "node:test";
import assert from "node:assert/strict";
import {installAiHooks,stubFetch,jsonResponse} from "./helpers/ai-harness.mjs";

installAiHooks();
const adapter=await import("../lib/ai-provider-adapter.ts");
const eleven=await import("../lib/elevenlabs-voice-integration.ts");
const telephony=await import("../lib/voice-telephony-provider.ts");

test("OpenAI uses a dedicated credential and voice uses the low-latency model when explicitly selected",async()=>{
 globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"test-openai-key"};
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
 assert.equal(body.reasoning.effort,"none");
  assert.equal(body.instructions,"system");
  assert.equal(body.input,"hello");
  assert.ok(!String(call.init.body).includes("test-openai-key"));
 }finally{stub.restore();}
});


test("legacy generic AI credential remains Anthropic until OpenAI cutover is explicit",async()=>{
 globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_AI_PROVIDER_API_KEY:"test-anthropic-key"};
 const stub=stubFetch(()=>jsonResponse({type:"message",stop_reason:"end_turn",content:[{type:"text",text:"legacy-safe"}]}));
 try{
  const result=await adapter.requestAiDraft({systemPrompt:"system",userPrompt:"hello"});
  assert.equal(result.connected,true);
  assert.equal(result.providerRef,"anthropic");
  assert.equal(stub.calls[0].url,"https://api.anthropic.com/v1/messages");
  assert.equal(stub.calls[0].init.headers["x-api-key"],"test-anthropic-key");
 }finally{stub.restore();}
});

test("explicit OpenAI selection fails closed without the dedicated OpenAI credential",async()=>{
 globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_AI_PROVIDER_API_KEY:"legacy-anthropic-key"};
 const stub=stubFetch(()=>jsonResponse({output_text:"must not be called"}));
 try{
  const result=await adapter.requestAiDraft({systemPrompt:"system",userPrompt:"hello"});
  assert.equal(result.connected,false);
  assert.equal(result.failure,"not_configured");
  assert.equal(stub.calls.length,0);
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

test("ElevenLabs readiness preserves the legacy Anthropic provider until OpenAI cutover is explicit",()=>{
 const ready=eleven.elevenLabsVoiceReadiness({
  PAWSPACE_VOICE_RUNTIME:"elevenlabs",
  ELEVENLABS_API_KEY:"x",
  ELEVENLABS_AGENT_ID:"agent_123",
  ELEVENLABS_INIT_WEBHOOK_SECRET:"secret",
  ELEVENLABS_RESIDENCY:"india",
 });
 assert.equal(ready.enabled,true);
 assert.equal(ready.configured,true);
 assert.equal(ready.indiaResidency,true);
 assert.equal(ready.intelligenceProvider,"anthropic");
 assert.equal(ready.intelligenceModel,"claude-sonnet-4-6");
 assert.equal(ready.exotelWebSocket,eleven.ELEVENLABS_EXOTEL_INDIA_WS);
 assert.equal(ready.productionReady,false);
});


test("ElevenLabs readiness reports OpenAI voice intelligence after explicit cutover",()=>{
 const ready=eleven.elevenLabsVoiceReadiness({PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"openai-key",PAWSPACE_VOICE_RUNTIME:"elevenlabs",ELEVENLABS_API_KEY:"x",ELEVENLABS_AGENT_ID:"agent",ELEVENLABS_INIT_WEBHOOK_SECRET:"secret",ELEVENLABS_RESIDENCY:"india"});
 assert.equal(ready.intelligenceProvider,"openai");
 assert.equal(ready.intelligenceModel,"gpt-5.6-luna");
 assert.equal(ready.indiaResidency,true);
});

test("ElevenLabs readiness refuses ambiguous residency and reflects the selected AI provider/model",()=>{
 const ready=eleven.elevenLabsVoiceReadiness({PAWSPACE_VOICE_RUNTIME:"elevenlabs",ELEVENLABS_API_KEY:"x",ELEVENLABS_AGENT_ID:"agent",ELEVENLABS_INIT_WEBHOOK_SECRET:"secret",ELEVENLABS_RESIDENCY:"global",PAWSPACE_AI_PROVIDER:"anthropic",PAWSPACE_AI_VOICE_MODEL:"claude-voice-test"});
 assert.equal(ready.indiaResidency,false);
 assert.equal(ready.intelligenceProvider,"anthropic");
 assert.equal(ready.intelligenceModel,"claude-voice-test");
});

test("ElevenLabs initiation requires the full integration configuration",()=>{
 assert.throws(()=>eleven.assertElevenLabsVoiceConfigured({ELEVENLABS_INIT_WEBHOOK_SECRET:"secret"}));
 assert.doesNotThrow(()=>eleven.assertElevenLabsVoiceConfigured({ELEVENLABS_API_KEY:"x",ELEVENLABS_AGENT_ID:"agent",ELEVENLABS_INIT_WEBHOOK_SECRET:"secret"}));
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
 assert.match(status.connectAppletUrl,/^https:\/\/api\.in\.residency\.elevenlabs\.io\/v1\/convai\/exotel\/connect-applet$/);
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

test("ElevenLabs outbound voice calls use a dedicated deterministic AI-owned thread id",async()=>{
 const mod=await import("../lib/elevenlabs-custom-llm.ts");
 assert.equal(mod.voiceThreadIdForCall("VCALL-C2A93B2F-269"),"THREAD-VOICE-VCALL-C2A93B2F-269");
 assert.equal(mod.voiceThreadIdForCall("VCALL-C2A93B2F-269"),mod.voiceThreadIdForCall("VCALL-C2A93B2F-269"));
 assert.notEqual(mod.voiceThreadIdForCall("VCALL-A"),mod.voiceThreadIdForCall("VCALL-B"));
 assert.throws(()=>mod.voiceThreadIdForCall("   "));
});

test("ElevenLabs custom LLM bearer auth fails closed",async()=>{
 const mod=await import("../lib/elevenlabs-custom-llm.ts");
 const make=(auth)=>new Request("https://example.test",{headers:auth?{authorization:auth}:{}});
 assert.throws(()=>mod.assertElevenLabsLlmAuth(make(),{ELEVENLABS_LLM_SECRET:"secret"}));
 assert.throws(()=>mod.assertElevenLabsLlmAuth(make("Bearer wrong"),{ELEVENLABS_LLM_SECRET:"secret"}));
 assert.doesNotThrow(()=>mod.assertElevenLabsLlmAuth(make("Bearer secret"),{ELEVENLABS_LLM_SECRET:"secret"}));
});


test("ElevenLabs specialist agent routing is deterministic by governed voice use case",()=>{
 const env={ELEVENLABS_AGENT_ID:"agent-generic",ELEVENLABS_GROOMING_AGENT_ID:"agent-grooming",ELEVENLABS_TRAINING_AGENT_ID:"agent-training"};
 assert.equal(telephony.elevenLabsAgentIdForUseCase(env,"grooming_sales"),"agent-grooming");
 assert.equal(telephony.elevenLabsAgentIdForUseCase(env,"training_sales"),"agent-training");
 assert.equal(telephony.elevenLabsAgentIdForUseCase(env,"booking_confirmation"),"agent-generic");
 assert.equal(telephony.elevenLabsAgentIdForUseCase({ELEVENLABS_AGENT_ID:"agent-generic"},"grooming_sales"),"agent-generic");
});

test("ElevenLabs Exotel outbound adapter is selected only when explicitly configured and carries PawSpace IDs",async()=>{
 const mod=await import("../lib/voice-telephony-provider.ts");
 const env={PAWSPACE_VOICE_RUNTIME:"elevenlabs",ELEVENLABS_API_KEY:"el-test",ELEVENLABS_AGENT_ID:"agent-1",ELEVENLABS_AGENT_PHONE_NUMBER_ID:"phone-1",ELEVENLABS_API_BASE:"https://api.in.residency.elevenlabs.io"};
 const provider=mod.selectTelephonyProvider(env);assert.equal(provider.provider,"elevenlabs_exotel");
 const stub=stubFetch((_url)=>jsonResponse({success:true,conversation_id:"conv-1",callSid:"call-1"}));
 try{
  const result=await provider.createCall({callRef:"VCALL-1",toNumber:"+919999999999",statusCallbackUrl:"https://example.test/cb",recordingAllowed:false,customerId:"CUS-1",leadId:"LEAD-1",bookingId:"BOOK-1",useCase:"booking_confirmation"});
  assert.equal(result.accepted,true);assert.equal(result.providerCallId,"call-1");
  const call=stub.calls[0],body=JSON.parse(call.init.body);
  assert.equal(call.url,"https://api.in.residency.elevenlabs.io/v1/convai/exotel/outbound-call");
  assert.equal(call.init.headers["xi-api-key"],"el-test");
  assert.deepEqual(body.conversation_initiation_client_data.custom_llm_extra_body,{pawspace_voice_call_id:"VCALL-1"});
  assert.equal(body.conversation_initiation_client_data.dynamic_variables.pawspace_voice_call_id,"VCALL-1");
  assert.equal(body.conversation_initiation_client_data.dynamic_variables.pawspace_customer_id,"CUS-1");
 }finally{stub.restore();}
});

test("ElevenLabs Exotel outbound adapter recovers one stale phone-number id without weakening call guards",async()=>{
 const mod=await import("../lib/voice-telephony-provider.ts");
 const env={PAWSPACE_VOICE_RUNTIME:"elevenlabs",ELEVENLABS_API_KEY:"el-test",ELEVENLABS_AGENT_ID:"agent-1",ELEVENLABS_AGENT_PHONE_NUMBER_ID:"phone-stale",ELEVENLABS_API_BASE:"https://api.in.residency.elevenlabs.io",EXOTEL_CALLER_ID:"09513886363"};
 const provider=mod.selectTelephonyProvider(env);
 const stub=stubFetch((url,init)=>{
  if(url.endsWith("/v1/convai/phone-numbers?provider=exotel"))return jsonResponse({phone_numbers:[{provider:"exotel",phone_number:"+919513886363",phone_number_id:"phone-current"}]});
  if(url.endsWith("/v1/convai/exotel/outbound-call")){
   const body=JSON.parse(init.body);
   if(body.agent_phone_number_id==="phone-stale")return jsonResponse({detail:{code:"document_not_found"}},404);
   assert.equal(body.agent_phone_number_id,"phone-current");
   return jsonResponse({success:true,conversation_id:"conv-current",callSid:"call-current"});
  }
  throw new Error("unexpected URL "+url);
 });
 try{
  const result=await provider.createCall({callRef:"VCALL-STALE",toNumber:"+919999999999",statusCallbackUrl:"https://example.test/cb",recordingAllowed:false,customerId:"CUS-1",useCase:"grooming_sales"});
  assert.equal(result.accepted,true);
  assert.equal(result.providerCallId,"call-current");
  assert.equal(stub.calls.filter(x=>x.url.endsWith("/v1/convai/exotel/outbound-call")).length,2);
  assert.equal(stub.calls.filter(x=>x.url.includes("/v1/convai/phone-numbers?provider=exotel")).length,1);
 }finally{stub.restore();}
});

