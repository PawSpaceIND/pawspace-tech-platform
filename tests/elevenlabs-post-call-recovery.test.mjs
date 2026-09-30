import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import {freshSqlite,makeD1} from './helpers/voice-harness.mjs';
const stubs={
 './communication-engine':'export async function ensureCommunicationTables(){}',
 './inbound-ai-telephony':'export async function endInboundAiVoiceSession(db,input){return globalThis.__postCall.end(input)}',
 './voice-outbound-governance':'export async function ensureVoiceCallTables(){};export async function reconcileVerifiedElevenLabsCompletion(db,input){return globalThis.__postCall.complete(input)}',
 './elevenlabs-failure-correlation':'export async function resolveElevenLabsFailureCall(){throw Error("not used")};export async function resolveElevenLabsAcceptedCall(){return globalThis.__postCall.identity()}',
 './elevenlabs-custom-llm':'export function voiceThreadIdForCall(id){return `THREAD-VOICE-${id}`}',
 './bot-call-disposition':'export async function recordBotCallDisposition(db,input){return globalThis.__postCall.disposition(input)}',
};
const urls=Object.fromEntries(Object.entries(stubs).map(([key,value])=>[key,'data:text/javascript,'+encodeURIComponent(value)]));
const resolve=(s,c,n)=>c.parentURL?.endsWith('/lib/elevenlabs-post-call.ts')&&urls[s]?{url:urls[s],shortCircuit:true}:n(s,c);
if(typeof nodeModule.registerHooks === "function")nodeModule.registerHooks({resolve});
else nodeModule.register('data:text/javascript,'+encodeURIComponent(`const urls=${JSON.stringify(urls)};export function resolve(s,c,n){return c.parentURL?.endsWith('/lib/elevenlabs-post-call.ts')&&urls[s]?{url:urls[s],shortCircuit:true}:n(s,c)}`));
const {reconcileElevenLabsPostCall}=await import('../lib/elevenlabs-post-call.ts');
function world(t){
 const sqlite=freshSqlite(),db=makeD1(sqlite);t.after(()=>sqlite.close());
 sqlite.exec(`CREATE TABLE communication_threads(id TEXT PRIMARY KEY,customer_id TEXT,booking_id TEXT,lead_id TEXT,ticket_id TEXT,status TEXT,assigned_to TEXT,sla_due_at INTEGER,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE communication_participants(id TEXT PRIMARY KEY,thread_id TEXT,participant_type TEXT,participant_id TEXT,display_ref TEXT,role TEXT,created_at INTEGER);
 CREATE TABLE communication_messages(id TEXT PRIMARY KEY,thread_id TEXT,customer_id TEXT,booking_id TEXT,lead_id TEXT,ticket_id TEXT,direction TEXT,channel TEXT,purpose TEXT,template_key TEXT,payload_json TEXT,status TEXT,provider TEXT,provider_reference TEXT,idempotency_key TEXT,policy_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE voice_call_orders(id TEXT,customer_id TEXT,lead_id TEXT,booking_id TEXT);
 CREATE TABLE inbound_ai_voice_sessions(id TEXT,thread_id TEXT,customer_id TEXT,turn_index INTEGER,ai_call_id TEXT);
 CREATE TABLE ai_voice_calls(id TEXT,disposition TEXT,outcome TEXT,ended_at INTEGER);
 INSERT INTO voice_call_orders VALUES('call','customer','lead',NULL);
 INSERT INTO communication_threads(id,customer_id,status,updated_at) VALUES('unrelated','customer','open',9999999999999);`);
 globalThis.__postCall={identity:async()=> 'call',end:async()=>({status:'ended'}),complete:async()=>({completed:true}),disposition:async()=>({id:'disposition'})};
 const payload={type:'post_call_transcription',event_timestamp:1,data:{conversation_id:'conversation',conversation_initiation_client_data:{dynamic_variables:{pawspace_voice_call_id:'call'}},transcript:[{role:'user',message:'Hello'},{role:'agent',message:'How can I help?'}]}};
 return{sqlite,db,payload};
}
test('exact call owns transcript even when another customer thread is newer',async t=>{
 const w=world(t);let recorded;globalThis.__postCall.disposition=async input=>{recorded=input;return{id:'d'}};
 await reconcileElevenLabsPostCall(w.db,w.payload);
 assert.deepEqual(w.sqlite.prepare('SELECT DISTINCT thread_id FROM communication_messages').all().map(r=>r.thread_id),['THREAD-VOICE-call']);assert.equal(recorded.leadId,'lead');assert.equal(recorded.primaryTag,'info_shared');
 assert.equal((await reconcileElevenLabsPostCall(w.db,w.payload)).duplicatePrevented,true);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages').get().n,2);
});
for(const failure of ['disposition','complete'])test(`${failure} failure remains retryable without duplicate transcript`,async t=>{
 const w=world(t);globalThis.__postCall[failure]=async()=>{throw Error('temporary storage failure')};
 await assert.rejects(reconcileElevenLabsPostCall(w.db,w.payload),/temporary storage failure/);
 assert.equal(w.sqlite.prepare('SELECT status FROM elevenlabs_voice_webhooks').get().status,'processing');
 globalThis.__postCall[failure]=async()=>({id:'done'});await reconcileElevenLabsPostCall(w.db,w.payload);
 assert.equal(w.sqlite.prepare('SELECT status FROM elevenlabs_voice_webhooks').get().status,'processed');assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages').get().n,2);
});
test('pending CRM reservation does not acknowledge webhook completion',async t=>{
 const w=world(t);globalThis.__postCall.disposition=async()=>({pending:true});await assert.rejects(reconcileElevenLabsPostCall(w.db,w.payload),/still processing/);assert.equal(w.sqlite.prepare('SELECT status FROM elevenlabs_voice_webhooks').get().status,'processing');
});
test('inbound ElevenLabs speech updates native turn count before CRM completion and retries failures',async t=>{
 const w=world(t);w.sqlite.exec("INSERT INTO inbound_ai_voice_sessions VALUES('session','inbound-thread','customer',0,NULL)");w.payload.data.conversation_initiation_client_data.dynamic_variables={pawspace_voice_session_id:'session'};
 globalThis.__postCall.end=async()=>{assert.equal(w.sqlite.prepare('SELECT turn_index FROM inbound_ai_voice_sessions').get().turn_index,1);throw Error('CRM unavailable')};
 await assert.rejects(reconcileElevenLabsPostCall(w.db,w.payload),/CRM unavailable/);assert.equal(w.sqlite.prepare('SELECT status FROM elevenlabs_voice_webhooks').get().status,'processing');
});
test('mixed inbound/outbound identities fail before writing transcripts',async t=>{const w=world(t);w.payload.data.conversation_initiation_client_data.dynamic_variables.pawspace_voice_session_id='session';await assert.rejects(reconcileElevenLabsPostCall(w.db,w.payload),e=>e instanceof Response&&e.status===409);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages').get().n,0);});

test('mismatched provider acceptance writes no transcript or CRM outcome',async t=>{
 const w=world(t);globalThis.__postCall.identity=async()=>{throw new Response('identity mismatch',{status:409})};
 globalThis.__postCall.disposition=async()=>{assert.fail('CRM must not run')};
 await assert.rejects(reconcileElevenLabsPostCall(w.db,w.payload),e=>e instanceof Response&&e.status===409);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages').get().n,0);
});
