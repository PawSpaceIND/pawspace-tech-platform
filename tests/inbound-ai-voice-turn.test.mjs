import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
const stubs={
 './server-auth':'export {};',
 './ai-conversation-orchestrator':'export async function orchestrateAiTurn(){return {turn:globalThis.__voiceTurn}}',
 './ai-grounded-runtime-provider':'export async function createGroundedAiRuntimeProvider(){return {}}',
 './ai-human-handoff':'export async function requestAiHumanHandoff(){return {}}',
 './ai-voice-uat':'export async function ensureAiVoiceUatTables(){}',
 './communication-engine':'export async function ensureCommunicationTables(){}',
 './voice-workers-ai':`export function resolveWorkersAiStt(){return {status:'connected',provider:'test',transcribe:async()=>({text:'Hello'})}};export function resolveWorkersAiTts(){return {status:'connected',provider:'test',synthesize:async({text})=>{globalThis.__spoken=text;return {audioRef:'test-audio'}}}}`,
 './voice-outbound-canonical':'export async function recordVoiceConsent(){}',
 './customer-360':'export async function buildCustomer360(){return []}',
 './inbound-ai-lead-capture':'export async function resolveOrCaptureInboundCaller(){}',
 './bot-call-disposition':'export async function recordBotCallDisposition(){return globalThis.__inboundDisposition()}',
};
const urls=Object.fromEntries(Object.entries(stubs).map(([k,v])=>[k,'data:text/javascript,'+encodeURIComponent(v)]));
const resolver=`const urls=${JSON.stringify(urls)};export function resolve(s,c,n){if(c.parentURL?.endsWith('/lib/inbound-ai-telephony.ts')&&urls[s])return{url:urls[s],shortCircuit:true};return n(s,c)}`;
if(typeof nodeModule.registerHooks === "function" && process.env.PAWSPACE_FORCE_LOADER_HOOK !== "1")nodeModule.registerHooks({resolve(s,c,n){if(c.parentURL?.endsWith('/lib/inbound-ai-telephony.ts')&&urls[s])return{url:urls[s],shortCircuit:true};return n(s,c)}});
else nodeModule.register('data:text/javascript,'+encodeURIComponent(resolver));
const {runInboundAiVoiceTurn,endInboundAiVoiceSession}=await import('../lib/inbound-ai-telephony.ts');
const session={id:'test',thread_id:'thread',customer_id:'customer',turn_index:0};
const statement={bind(){return this},async run(){return {meta:{changes:1}}},async first(){return session}};
const db={prepare(){return statement},async batch(items){return Promise.all(items.map(i=>i.run()))}};
for(const [name,turn] of [['fresh',{output:'How can I help?',outcome:'replied'}],['replayed',{output_text:'How can I help?',outcome:'replied'}]]){
 test(`${name} orchestrator reply reaches inbound speech synthesis`,async()=>{globalThis.__voiceTurn=turn;globalThis.__spoken=null;const r=await runInboundAiVoiceTurn(db,{}, {sessionId:'test',audioRef:'test-input'});assert.equal(r.status,'reply_ready');assert.equal(globalThis.__spoken,'How can I help?');});
}
test('fresh explicit human request retains its handoff reason',async()=>{globalThis.__voiceTurn={outcome:'handoff',handoffReason:'customer_requested_human'};const r=await runInboundAiVoiceTurn(db,{}, {sessionId:'test',audioRef:'test-input'});assert.equal(r.reason,'customer_requested_human');});

test('inbound completion exposes failed and pending CRM writes for retry',async()=>{
 session.lead_id='lead';session.turn_index=1;
 try{
  globalThis.__inboundDisposition=async()=>{throw Error('write failed')};
  await assert.rejects(endInboundAiVoiceSession(db,{sessionId:'test'}),/write failed/);
  globalThis.__inboundDisposition=async()=>({pending:true});
  await assert.rejects(endInboundAiVoiceSession(db,{sessionId:'test'}),/still processing/);
  globalThis.__inboundDisposition=async()=>({id:'saved'});
  assert.deepEqual((await endInboundAiVoiceSession(db,{sessionId:'test'})).crmDisposition,{id:'saved'});
 }finally{delete session.lead_id;session.turn_index=0;delete globalThis.__inboundDisposition;}
});
