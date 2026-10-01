import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { freshSqlite, makeD1 } from './helpers/voice-harness.mjs';

// Execute the whole handler and its real SQL/session/ledger lifecycle. Only external AI and CRM
// dispatch are mocked. No network, credentials, carrier calls or provider inference are involved.
installWorkersHooks('__NATIVE_LIFECYCLE_DB__', '__NATIVE_LIFECYCLE_ENV__');
const stubs = {
  './ai-grounded-runtime-provider': 'export async function createGroundedAiRuntimeProvider(){return {generate:async()=>({})}}',
  './ai-conversation-orchestrator': 'export async function orchestrateAiTurn(){return {turn:{output:"Synthetic reply",outcome:"replied"}}}',
  './voice-agentstream-disposition': 'export async function recordAgentStreamCompletionDisposition(){return {recorded:false,reason:"test_no_lead"}}',
};
const urls = Object.fromEntries(Object.entries(stubs).map(([key, value]) => [key, 'data:text/javascript,' + encodeURIComponent(value)]));
const resolver = `const urls=${JSON.stringify(urls)};export function resolve(s,c,n){if(c.parentURL?.endsWith('/lib/exotel-agentstream.ts')&&urls[s])return{url:urls[s],shortCircuit:true};return n(s,c)}`;
if (typeof nodeModule.registerHooks === 'function' && process.env.PAWSPACE_FORCE_LOADER_HOOK !== '1') {
  nodeModule.registerHooks({ resolve(s,c,n) { if (c.parentURL?.endsWith('/lib/exotel-agentstream.ts') && urls[s]) return {url:urls[s],shortCircuit:true}; return n(s,c); } });
} else nodeModule.register('data:text/javascript,' + encodeURIComponent(resolver));
const { handleExotelAgentStream } = await import('../lib/exotel-agentstream.ts');
const { ensureVoiceCallTables, seedVoiceCallScripts } = await import('../lib/voice-outbound-governance.ts');
const { ensureAiVoiceUatTables } = await import('../lib/ai-voice-uat.ts');
const RealResponse = globalThis.Response, priorPair = globalThis.WebSocketPair;
// Node disallows Worker-only status 101. Preserve real Response handling for all TTS responses.
globalThis.Response = class extends RealResponse {
  constructor(body, init) { if (init?.status === 101) return {status:101,webSocket:init.webSocket}; super(body,init); }
};
class Socket {
  readyState = 1; listeners = new Map(); frames = []; closes = []; sendAttempts = 0;
  accept() {}
  addEventListener(name, callback) { this.listeners.set(name,callback); }
  send(payload) { this.sendAttempts++; if (this.readyState !== 1) throw new Error('synthetic socket closed'); this.frames.push(JSON.parse(payload)); }
  close(code, reason) { this.closes.push({code,reason}); this.disconnect(); }
  disconnect() { this.readyState = 3; this.listeners.get('close')?.({}); }
  message(value) { this.listeners.get('message')?.({data:JSON.stringify(value)}); }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
const start = {event:'start',start:{stream_sid:'synthetic-stream',call_sid:'synthetic-provider-call',account_sid:'synthetic-account',media_format:{encoding:'linear16',sample_rate:8000}}};
async function world(t, run = async () => new Uint8Array(640)) {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__NATIVE_LIFECYCLE_DB__ = db;
  globalThis.__NATIVE_LIFECYCLE_ENV__ = {};
  await ensureVoiceCallTables(db); await seedVoiceCallScripts(db); await ensureAiVoiceUatTables(db);
  sqlite.exec('CREATE TABLE IF NOT EXISTS outbound_routing_queue (voice_call_id TEXT,context_json TEXT,updated_at INTEGER)');
  sqlite.prepare(`INSERT INTO voice_call_orders (id,idempotency_key,direction,use_case,purpose,customer_id,city_id,phone_key,phone_last4,dial_number,mode,provider,provider_call_id,state,consent_decision,opt_out_decision,requested_by,requested_at,updated_at) VALUES ('synthetic-call','synthetic-key','outbound','booking_confirmation','transactional','synthetic-customer','blr','synthetic-phone','0000','0000000000','uat','exotel','synthetic-provider-call','dialing','granted','clear','test',1,1)`).run();
  const server = new Socket(); globalThis.WebSocketPair = class { 0 = {}; 1 = server; };
  const pending = []; let consumed = 0;
  const ctx = {waitUntil(promise) { pending.push(promise); }};
  const env = {DB:db,AI:{run},PAWSPACE_VOICE_ENV:'uat',EXOTEL_SID:'synthetic-account'};
  const response = await handleExotelAgentStream(new Request('https://synthetic.invalid/voice/exotel/agentstream',{headers:{upgrade:'websocket'}}),env,ctx);
  assert.equal(response.status,101);
  const drain = async () => { while (consumed < pending.length) await pending[consumed++]; };
  const events = type => sqlite.prepare('SELECT detail_json FROM ai_voice_events WHERE event_type=? ORDER BY rowid').all(type).map(x => JSON.parse(x.detail_json));
  const state = () => sqlite.prepare('SELECT state FROM voice_call_orders').get().state;
  const aiStatus = () => sqlite.prepare('SELECT status FROM ai_voice_calls').get()?.status;
  t.after(() => sqlite.close());
  return {server,db,sqlite,env,drain,events,state,aiStatus};
}
after(() => { globalThis.Response = RealResponse; globalThis.WebSocketPair = priorPair; });

test('opening text, queued PCM, and matching carrier mark are distinct evidence', async t => {
  const w = await world(t); w.server.message(start); await w.drain();
  assert.equal(w.state(),'connected'); assert.equal(w.aiStatus(),'active');
  assert.equal(w.events('agentstream_text_generated').length,1);
  const [queued] = w.events('agentstream_audio_queued'); assert.equal(queued.bytes,640); assert.equal(queued.frames,1);
  assert.equal(w.events('agentstream_audio_mark_ack').length,0);
  assert.deepEqual(w.server.frames.map(x=>x.event),['media','mark']);
  assert.equal(w.server.frames[0].stream_sid,'synthetic-stream');
  assert.equal(Buffer.from(w.server.frames[0].media.payload,'base64').byteLength,3200);
  assert.deepEqual(Buffer.from(w.server.frames[0].media.payload,'base64').subarray(640),Buffer.alloc(2560));
  for (const mark of [{name:'foreign'},{name:queued.markName,stream:'wrong-stream'}]) {
    w.server.message({event:'mark',stream_sid:mark.stream,mark:{name:mark.name}}); await w.drain();
  }
  assert.equal(w.events('agentstream_audio_mark_ack').length,0);
  w.server.message({event:'mark',stream_sid:'synthetic-stream',mark:{name:queued.markName}}); await w.drain();
  w.server.message({event:'mark',mark:{name:queued.markName}}); await w.drain();
  assert.equal(w.events('agentstream_audio_mark_ack').length,1);
});

test('close during pending greeting TTS refuses sends and preserves reconnectable status', async t => {
  const entered=deferred(), done=deferred();
  const w=await world(t,async()=>{entered.resolve(); return done.promise;});
  w.server.message(start); await entered.promise; w.server.disconnect(); done.resolve(new Uint8Array(640)); await w.drain();
  assert.equal(w.server.sendAttempts,0); assert.equal(w.state(),'connected'); assert.equal(w.aiStatus(),'active');
  assert.equal(w.events('agentstream_processing_failed').length,0);
  assert.equal(w.events('agentstream_processing_abandoned')[0].stage,'opening_tts');
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM ai_voice_segments').get().n,0);
});

test('close during post-send greeting persistence keeps already-queued speech truthful', async t => {
  const w=await world(t), entered=deferred(), done=deferred();
  w.db.onSql('INSERT INTO communication_messages',async()=>{entered.resolve();await done.promise;});
  w.server.message(start); await entered.promise; w.server.disconnect(); done.resolve(); await w.drain();
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM ai_voice_segments').get().n,1);
  assert.equal(w.events('agentstream_text_generated').length,1);
  assert.equal(w.events('agentstream_audio_queued').length,1);
  assert.equal(w.server.sendAttempts,2); assert.equal(w.state(),'connected'); assert.equal(w.aiStatus(),'active');
  assert.equal(w.events('agentstream_processing_abandoned')[0].stage,'opening_text');
});

for (const [name,result,code] of [
  ['HTTP error',()=>new Response('private synthetic provider error',{status:500}), 'http_error'],
  ['empty response',()=>new Response(new Uint8Array()),'empty_audio'],
  ['empty binary',()=>new Uint8Array(),'empty_audio'],
  ['odd PCM',()=>new Uint8Array(3),'invalid_audio'],
  ['JSON MIME',()=>new Response('{}',{headers:{'content-type':'application/json'}}),'invalid_audio'],
  ['JSON bytes',()=>new TextEncoder().encode('{}'),'invalid_audio'],
  ['MP3 MIME',()=>new Response(new Uint8Array(640),{headers:{'content-type':'audio/mpeg'}}),'invalid_audio'],
  ['MP3 container',()=>new TextEncoder().encode('ID3-synthetic-audio'),'invalid_audio'],
  ['malformed audio object',()=>({audio:123}),'invalid_audio'],
  ['oversized binary',()=>new Uint8Array(8*1024*1024+2),'audio_too_large'],
]) test(`${name} TTS fails before transcript/send and reconciles ledger`,async t=>{
  const w=await world(t,async()=>result()); w.server.message(start); await w.drain();
  assert.equal(w.state(),'tts_failed'); assert.equal(w.aiStatus(),'failed'); assert.equal(w.server.sendAttempts,0);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM ai_voice_segments').get().n,0);
  const [failure]=w.events('agentstream_processing_failed'); assert.equal(failure.stage,'opening_tts'); assert.equal(failure.code,code);
  assert.equal(w.server.closes[0].code,1011);
  assert.equal(JSON.stringify(w.events('agentstream_processing_failed')).includes('private synthetic'),false);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_call_state_transitions WHERE to_state='tts_failed'").get().n,1);
});

test('provider exception persists bounded stage telemetry, not raw exception or successful outcome',async t=>{
  const w=await world(t,async()=>{throw new Error('synthetic secret/token/request body');}); w.server.message(start); await w.drain();
  assert.equal(w.state(),'tts_failed'); assert.equal(w.aiStatus(),'failed');
  assert.deepEqual(Object.keys(w.events('agentstream_processing_failed')[0]).sort(),['code','elapsedMs','stage']);
  assert.equal(w.events('agentstream_processing_failed')[0].code,'processing_exception');
  assert.equal(JSON.stringify(w.server.closes).includes('secret'),false);
});

test('unexpected send exception never persists an unheard opening transcript',async t=>{
  const w=await world(t); w.server.send=()=>{throw new Error('synthetic send exception');};
  w.server.message(start); await w.drain();
  assert.equal(w.state(),'provider_error'); assert.equal(w.aiStatus(),'failed');
  assert.equal(w.events('agentstream_processing_failed')[0].stage,'opening_send');
  assert.equal(w.events('agentstream_text_generated').length,1); assert.equal(w.events('agentstream_audio_queued').length,0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_voice_segments WHERE speaker='assistant'").get().n,0);
});

function wav(rate=8000,format=1) {
  const bytes=new Uint8Array(684),v=new DataView(bytes.buffer),write=(at,s)=>bytes.set(new TextEncoder().encode(s),at);
  write(0,'RIFF');v.setUint32(4,676,true);write(8,'WAVE');write(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,format,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
  write(36,'data');v.setUint32(40,640,true);return bytes;
}
test('turn send failure persists the customer but not the unheard assistant reply',async t=>{
  let ttsCalls=0;
  const w=await world(t,async model=>{
    if(model.includes('whisper'))return {text:'Synthetic customer sentence'};
    ttsCalls++;return new Uint8Array(640);
  });
  w.server.message(start);await w.drain();
  const openingMark=w.events('agentstream_audio_queued')[0].markName;
  w.server.message({event:'mark',stream_sid:'synthetic-stream',mark:{name:openingMark}});await w.drain();
  w.server.send=()=>{throw new Error('synthetic turn send exception');};
  w.server.message(speechEnvelope());w.server.message(silenceEnvelope);await w.drain();
  assert.equal(ttsCalls,2);assert.equal(w.state(),'provider_error');assert.equal(w.aiStatus(),'failed');
  assert.equal(w.events('agentstream_processing_failed')[0].stage,'turn_send');
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_voice_segments WHERE speaker='customer'").get().n,1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_voice_segments WHERE speaker='assistant'").get().n,1);
});

test('matching mono PCM WAV is stripped to raw little-endian frames; incompatible WAV fails',async t=>{
  const w=await world(t,async()=>new Response(wav(),{headers:{'content-type':'audio/wav'}})); w.server.message(start); await w.drain();
  assert.equal(w.events('agentstream_audio_queued')[0].bytes,640);
  assert.equal(Buffer.from(w.server.frames[0].media.payload,'base64').subarray(0,4).equals(Buffer.alloc(4)),true);
  for (const bytes of [wav(16000),wav(8000,3)]) {
    const bad=await world(t,async()=>bytes);bad.server.message(start);await bad.drain();assert.equal(bad.state(),'tts_failed');assert.equal(bad.server.sendAttempts,0);
  }
});

test('socket error and close alone remain transient and permit a new authenticated stream',async t=>{
  const w=await world(t); w.server.message(start);await w.drain();
  w.server.listeners.get('error')({});w.server.disconnect();await w.drain();
  assert.equal(w.state(),'connected');assert.equal(w.aiStatus(),'active');assert.equal(w.events('agentstream_processing_failed').length,0);
  const next=new Socket();globalThis.WebSocketPair=class {0={};1=next;};
  const pending=[];await handleExotelAgentStream(new Request('https://synthetic.invalid/voice/exotel/agentstream',{headers:{upgrade:'websocket'}}),w.env,{waitUntil:p=>pending.push(p)});
  next.message(start);for(let i=0;i<pending.length;i++)await pending[i];
  assert.equal(w.events('agentstream_reconnected').length,1);assert.equal(next.frames.length,0);assert.equal(w.aiStatus(),'active');
});

test('mark after barge-in clear is not counted as playback acknowledgement',async t=>{
  const w=await world(t);w.server.message(start);await w.drain();const mark=w.events('agentstream_audio_queued')[0].markName;
  const speech=new Uint8Array(320);const view=new DataView(speech.buffer);for(let i=0;i<320;i+=2)view.setInt16(i,1000,true);
  w.server.message({event:'media',media:{payload:Buffer.from(speech).toString('base64')}});await w.drain();
  assert.equal(w.server.frames.at(-1).event,'clear');
  w.server.message({event:'mark',mark:{name:mark}});await w.drain();assert.equal(w.events('agentstream_audio_mark_ack').length,0);
});

const speechEnvelope = () => {
  const pcm = new Uint8Array(320), view = new DataView(pcm.buffer);
  for (let i=0;i<pcm.length;i+=2) view.setInt16(i,1000,true);
  return {event:'media',media:{payload:Buffer.from(pcm).toString('base64')}};
};
const silenceEnvelope = {event:'media',media:{payload:Buffer.alloc(5600).toString('base64')}};

test('caller speech bypasses pending opening TTS and starts recognition immediately', async t => {
  const openingEntered=deferred(),openingDone=deferred(),sttEntered=deferred();let ttsCalls=0;
  const w=await world(t,async model=>{
    if(model.includes('whisper')){sttEntered.resolve();return {text:'Synthetic customer sentence'};}
    if(++ttsCalls===1){openingEntered.resolve();return openingDone.promise;}
    return new Uint8Array(640);
  });
  w.server.message(start);await openingEntered.promise;
  w.server.message(speechEnvelope());w.server.message(silenceEnvelope);
  let timer;await Promise.race([sttEntered.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('media waited behind opening TTS')),500);timer.unref?.();})]);clearTimeout(timer);
  openingDone.resolve(new Uint8Array(640));await w.drain();
  assert.equal(w.events('agentstream_audio_queued').some(event=>String(event.markName).startsWith('opening-')),false);
  const [barge]=w.events('agentstream_barge_in');assert.equal(barge.generationCancelled,true);
});

for (const failureStage of ['stt','turn_tts']) test(`${failureStage} failure during a customer turn records its distinct canonical failure`,async t=>{
  let ttsCalls=0;
  const w=await world(t,async model=>{
    if (model.includes('whisper')) {
      if (failureStage==='stt') throw new Error('synthetic STT failure');
      return {text:'Synthetic customer sentence'};
    }
    if (++ttsCalls>1 && failureStage==='turn_tts') throw new Error('synthetic turn TTS failure');
    return new Uint8Array(640);
  });
  w.server.message(start);await w.drain();w.server.message(speechEnvelope());w.server.message(silenceEnvelope);await w.drain();
  assert.equal(w.state(),failureStage==='stt'?'stt_failed':'tts_failed');assert.equal(w.aiStatus(),'failed');
  assert.equal(w.events('agentstream_processing_failed')[0].stage,failureStage);
  assert.equal(w.events('agentstream_audio_queued').length,1);
});

test('close during customer STT abandons the turn without producing more speech or failing the ledger',async t=>{
  const entered=deferred(),done=deferred();let ttsCalls=0;
  const w=await world(t,async model=>{
    if(model.includes('whisper')){entered.resolve();return done.promise;}
    ttsCalls++;return new Uint8Array(640);
  });
  w.server.message(start);await w.drain();w.server.message(speechEnvelope());w.server.message(silenceEnvelope);
  await entered.promise;w.server.disconnect();done.resolve({text:'Synthetic customer sentence'});await w.drain();
  assert.equal(ttsCalls,1);assert.equal(w.state(),'connected');assert.equal(w.aiStatus(),'active');
  assert.equal(w.events('agentstream_processing_abandoned')[0].stage,'stt');
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_voice_segments WHERE speaker='customer'").get().n,0);
});

test('a completed canonical call is not overwritten by a late processing failure',async t=>{
  const entered=deferred(),done=deferred();
  const w=await world(t,async()=>{entered.resolve();await done.promise;throw new Error('synthetic late failure');});
  w.server.message(start);await entered.promise;
  w.sqlite.exec("UPDATE voice_call_orders SET state='completed'");done.resolve();await w.drain();
  assert.equal(w.state(),'completed');assert.equal(w.aiStatus(),'failed');
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_call_state_transitions WHERE to_state='tts_failed'").get().n,0);
});

test('malformed PCM WAV and text error bodies are refused, but binary PCM with a printable first byte is valid',async t=>{
  for(const bytes of [new TextEncoder().encode('<html>synthetic error</html>'),new TextEncoder().encode('OggS-synthetic-data'),new Uint8Array([82,73,70,70])]){
    const w=await world(t,async()=>bytes);w.server.message(start);await w.drain();assert.equal(w.state(),'tts_failed');assert.equal(w.server.sendAttempts,0);
  }
  const pcm=new Uint8Array(640);pcm[0]=123;
  const valid=await world(t,async()=>pcm);valid.server.message(start);await valid.drain();assert.equal(valid.state(),'connected');assert.equal(valid.events('agentstream_audio_queued')[0].bytes,640);
});

test('transport closure during a multi-frame send refuses all subsequent frames',async t=>{
  const w=await world(t,async()=>new Uint8Array(6400));
  const originalSend=w.server.send.bind(w.server);
  w.server.send=payload=>{originalSend(payload);w.server.disconnect();};
  w.server.message(start);await w.drain();
  assert.equal(w.server.sendAttempts,1);assert.equal(w.server.frames.length,1);
  assert.equal(w.state(),'connected');assert.equal(w.aiStatus(),'active');
  assert.equal(w.events('agentstream_audio_queued').length,0);assert.equal(w.events('agentstream_processing_failed').length,0);
  assert.equal(w.events('agentstream_processing_abandoned')[0].stage,'opening_send');
});
