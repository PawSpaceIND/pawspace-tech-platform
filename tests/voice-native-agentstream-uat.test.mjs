import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, DAYTIME, QUIET_TIME } from "./helpers/voice-harness.mjs";
import {applyOwnedDdl} from './helpers/ai-harness.mjs';

installWorkersHooks("__NATIVE_UAT_DB__", "__NATIVE_UAT_ENV__");
const gov = await import("../lib/voice-outbound-governance.ts");
const {handleExotelAgentStream}=await import('../lib/exotel-agentstream.ts');

for(const scenario of [
 {name:'native stream emits the governed greeting as PCM frames and a playback mark',audioBytes:6400},
 {name:'native terminal greeting frames meet the carrier minimum even with a ten-byte tail',audioBytes:6410},
 {name:'native short greeting fills a complete carrier frame with terminal silence',audioBytes:320},
 {name:'native greeting playback failure persists its safe operation and never claims completed audio',audioBytes:6400,failPlayback:true},
 {name:'native provider error responses never become caller audio or completed calls',providerError:true},
 {name:'native empty TTS audio fails before greeting playback',audioBytes:0},
])test(scenario.name,async()=>{
 const failPlayback=scenario.failPlayback===true;
 const fails=failPlayback||scenario.providerError||scenario.audioBytes===0;
 const {sqlite,db,env}=await world();
 applyOwnedDdl(sqlite,'lib/outbound-schema.ts');
 const originals={fetch:globalThis.fetch,Response:globalThis.Response,pair:globalThis.WebSocketPair};
 const sockets=[];
 class Socket {
  listeners=new Map();sent=[];closed=null;readyState=1;
  accept(){}
  addEventListener(kind,handler){this.listeners.set(kind,handler);}
  send(message){if(failPlayback)throw new Error('WebSocket is not open SECRET-KEY customer-private-text');this.sent.push(JSON.parse(message));}
  close(code){this.closed=code;this.readyState=3;}
  emit(kind,data){this.listeners.get(kind)?.(data);}
 }
 try{
  globalThis.fetch=async()=>new originals.Response(JSON.stringify({Call:{Sid:'EXO-PLAYBACK-FAILURE',Status:'queued'}}),{status:200});
  const dial=await gov.requestControlledNativeAgentStreamUatCall(db,env,input({idempotencyKey:'voice-native-agentstream-uat:playback-failure'}));
  await db.prepare("UPDATE voice_call_orders SET state='connected' WHERE id=?").bind(dial.callId).run();
  globalThis.fetch=originals.fetch;
  globalThis.WebSocketPair=class {constructor(){const pair={0:new Socket(),1:new Socket()};sockets.push(pair);return pair;}};
  globalThis.Response=class extends originals.Response{constructor(body,init={}){super(body,{...init,status:init.status===101?200:init.status});this.webSocket=init.webSocket;}};
  const response=await handleExotelAgentStream(new Request('https://uat.pawspace.in/voice/exotel/agentstream',{headers:{upgrade:'websocket'}}),{...env,DB:db,AI:{run:async()=>scenario.providerError?new Response('{"error":"SECRET-KEY customer-private-text"}',{status:401,headers:{'content-type':'application/json'}}):new Uint8Array(scenario.audioBytes).fill(4)}},{waitUntil(){}});
  assert.ok(response.webSocket);
  const server=sockets[0][1];server.emit('message',{data:JSON.stringify({event:'start',start:{call_sid:'EXO-PLAYBACK-FAILURE',stream_sid:'STREAM-FAILURE',account_sid:env.EXOTEL_SID,media_format:{sample_rate:8000}}})});
  for(let attempt=0;attempt<100&&!server.closed&&!server.sent.some(x=>x.event==='mark');attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  const event=sqlite.prepare("SELECT detail_json FROM ai_voice_events WHERE event_type='agentstream_processing_failed'").get();
  const call=sqlite.prepare('SELECT status,outcome FROM ai_voice_calls').get();
  if(fails){
   assert.ok(event,'real stream handler persists playback failure');
   const detail=JSON.parse(event.detail_json);
   assert.equal(detail.stage,failPlayback?'opening_send':'opening_tts');
   assert.equal(detail.code,failPlayback?'processing_exception':scenario.providerError?'http_error':'empty_audio');
   assert.ok(Number.isFinite(detail.elapsedMs)&&detail.elapsedMs>=0);
   assert.deepEqual(Object.keys(detail).sort(),['code','elapsedMs','stage']);
   assert.doesNotMatch(event.detail_json,/SECRET|customer-private/);
   assert.equal(call.status,'failed');assert.equal(call.outcome,'provider_failure');assert.equal(server.closed,1011);
  }else{
   assert.equal(event,undefined);assert.equal(call.status,'active');assert.equal(server.closed,null);
   const media=server.sent.filter(x=>x.event==='media');assert.equal(media.length,Math.ceil(scenario.audioBytes/3200));
   const frames=media.map(x=>Buffer.from(x.media.payload,'base64'));assert.ok(frames.every(x=>x.length>=3200&&x.length<=100000&&x.length%320===0));
   const audio=Buffer.concat(frames);assert.deepEqual(audio.subarray(0,scenario.audioBytes),Buffer.alloc(scenario.audioBytes,4));assert.ok(audio.subarray(scenario.audioBytes).every(x=>x===0));
   assert.ok(media.every(x=>x.stream_sid==='STREAM-FAILURE'));
   assert.equal(server.sent.at(-1).event,'mark');
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_voice_segments WHERE speaker='customer'").get().n,0);
 }finally{globalThis.fetch=originals.fetch;globalThis.Response=originals.Response;globalThis.WebSocketPair=originals.pair;}
});

async function world(extra = {}) {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__NATIVE_UAT_DB__ = db;
  globalThis.__NATIVE_UAT_ENV__ = {
    ...uatVoiceEnv(),
    PAWSPACE_VOICE_TRANSPORT: "",
    PAWSPACE_VOICE_RUNTIME: "elevenlabs",
    PAWSPACE_VOICE_NATIVE_UAT_APPROVED: "true",
    PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED: "true",
    PAWSPACE_VOICE_STREAM_URL: "wss://uat.pawspace.in/voice/exotel/agentstream",
    ELEVENLABS_API_KEY: "test-elevenlabs-key",
    ELEVENLABS_AGENT_ID: "agent-default",
    ELEVENLABS_AGENT_PHONE_NUMBER_ID: "phone-exotel",
    ...extra,
  };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  await gov.ensureVoiceCallTables(db);
  await gov.seedVoiceCallScripts(db);
  seedRecipient(sqlite);
  await gov.recordVoiceConsent(db, {
    phone: ALLOWLISTED_PHONE,
    subjectType: "customer",
    subjectId: "CON-V1",
    granted: true,
    source: "native_uat_test_consent",
    actorId: "uat-test",
    asOf: DAYTIME,
  });
  return { sqlite, db, env: globalThis.__NATIVE_UAT_ENV__ };
}

const input = (overrides = {}) => ({
  idempotencyKey: "voice-native-agentstream-uat:booking:1",
  useCase: "booking_confirmation",
  phone: ALLOWLISTED_PHONE,
  cityId: "blr",
  customerId: "CON-V1",
  leadId: null,
  bookingId: "BKG-V1",
  campaignId: "controlled_native_agentstream_uat",
  asOf: DAYTIME,
  ...overrides,
});

test("ordinary calls stay on ElevenLabs while the private native UAT path alone selects direct Exotel AgentStream", async () => {
  const { sqlite, db, env } = await world();
  const ordinary = await gov.evaluateVoiceCallPolicy(db, env, {
    ...input({ idempotencyKey: "ordinary-policy" }),
    actorId: "founder@pawspace.in",
    actorPermissions: ["*"],
  });
  assert.equal(ordinary.provider.provider, "elevenlabs_exotel");

  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), body: String(init.body || "") });
    return new Response(JSON.stringify({ Call: { Sid: "EXO-NATIVE-UAT-1", Status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const native = await gov.requestControlledNativeAgentStreamUatCall(db, env, input());
    assert.equal(native.dialled, true);
    assert.equal(native.provider, "exotel");
    assert.equal(sqlite.prepare("SELECT provider FROM voice_call_orders WHERE id=?").get(native.callId).provider, "exotel");
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /api\.exotel\.com\/v1\/Accounts\/test-sid\/Calls\/connect\.json$/);
    const body = new URLSearchParams(seen[0].body);
    assert.equal(body.get("StreamUrl"), "wss://uat.pawspace.in/voice/exotel/agentstream");
    assert.equal(body.get("StreamType"), "bidirectional");
    assert.equal(body.get("CustomField"), native.callId);
    assert.equal(body.get("StatusCallback"), env.PAWSPACE_VOICE_STATUS_CALLBACK_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native AgentStream UAT fails closed without its dedicated approval, stream URL, exact allowlist or key", async () => {
  const { db, env } = await world();
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, { ...env, PAWSPACE_VOICE_NATIVE_UAT_APPROVED: "false" }, input()),
    /native-UAT/,
  );
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, { ...env, PAWSPACE_VOICE_STREAM_URL: "" }, input()),
    /WSS PAWSPACE_VOICE_STREAM_URL/,
  );
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, { ...env, PAWSPACE_VOICE_UAT_ALLOWLIST: "9000000001" }, input()),
    /single approved allowlisted recipient/,
  );
  await assert.rejects(
    () => gov.requestControlledNativeAgentStreamUatCall(db, env, input({ idempotencyKey: "not-native-uat" })),
    /dedicated voice-native-agentstream-uat idempotency key/,
  );
});

test("native Grooming sales UAT keeps the same sales gates and may bypass quiet hours only for the single controlled recipient", async () => {
  const { sqlite, db, env } = await world({ PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: "true" });
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), body: String(init.body || "") });
    return new Response(JSON.stringify({ Call: { Sid: "EXO-NATIVE-SALES-1", Status: "queued" } }), { status: 200 });
  };
  try {
    const result = await gov.requestControlledNativeAgentStreamUatCall(db, env, input({
      idempotencyKey: "voice-native-agentstream-uat:grooming:quiet",
      useCase: "grooming_sales",
      bookingId: null,
      asOf: QUIET_TIME,
    }));
    assert.equal(result.dialled, true);
    assert.equal(result.provider, "exotel");
    assert.equal(result.quietHoursDecision, "uat_bypass");
    const decision = sqlite.prepare("SELECT passed,detail FROM voice_call_policy_decisions WHERE call_id=? AND check_code='quiet_hours'").get(result.callId);
    assert.equal(decision.passed, 1);
    assert.match(decision.detail, /Controlled native AgentStream UAT bypassed quiet hours/);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public request data cannot forge the private native provider override", async () => {
  const { db, env } = await world();
  const policy = await gov.evaluateVoiceCallPolicy(db, env, {
    ...input({ idempotencyKey: "public-spoof" }),
    actorId: "founder@pawspace.in",
    actorPermissions: ["*"],
    nativeAgentStream: true,
    PAWSPACE_VOICE_NATIVE_UAT_APPROVED: "true",
  });
  assert.equal(policy.provider.provider, "elevenlabs_exotel");
  assert.equal(policy.checks.some(check => check.code === "native_agentstream_stream"), false);
});
