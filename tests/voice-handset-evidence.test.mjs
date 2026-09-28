import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, DAYTIME } from './helpers/voice-harness.mjs';
import { stubFetch, jsonResponse } from './helpers/ai-harness.mjs';
import { inspectHandsetEvidence, assertHandsetEvidence, correlationFromVoiceTransitions, voiceProviderCorrelation } from '../lib/voice-handset-evidence.ts';
import { canonicalDialNumber } from '../lib/voice-call-gate.ts';
import { verifyHandsetAttempt } from '../scripts/verify-handset-attempt.mjs';
installWorkersHooks('__HANDSET_DB__', '__HANDSET_ENV__');
const gov = await import('../lib/voice-outbound-governance.ts');
const telephony = await import('../lib/voice-telephony-provider.ts');
const expected = { appCallId: 'VCALL-LOCAL', agentId: 'agent-local', phone: '+919876543210' };
const correlation = { carrierCallId: 'carrier-local', conversationId: 'conv-local', agentId: expected.agentId };
const fixture = () => ({ ...expected,
  appAudit: { call: { callId: expected.appCallId, provider: 'elevenlabs_exotel', providerCallId: correlation.carrierCallId, dialed: true }, providerCorrelation: { ...correlation } },
  carrier: { Call: { Sid: correlation.carrierCallId, From: expected.phone, Status: 'completed', Duration: 55, Details: { ConversationDuration: 12 } } },
  conversation: { conversation_id: correlation.conversationId, agent_id: expected.agentId, status: 'done',
    metadata: { text_only: false, phone_call: { type: 'exotel', direction: 'outbound', call_sid: correlation.carrierCallId, external_number: expected.phone } },
    has_user_audio: true, has_response_audio: true,
    transcript: [{ role: 'agent', message: 'Hello, this is the AI demo.' }, { role: 'user', message: 'What grooming do you offer?' }, { role: 'agent', message: 'We offer doorstep bathing and grooming packages.' }] },
});
test('only a correlated completed spoken exchange passes; human quality is not inferred', () => {
  const result = assertHandsetEvidence(fixture());
  assert.equal(result.passed, true); assert.equal(result.humanQuality, 'not_assessed');
  assert.ok(!JSON.stringify(result).includes(expected.phone));
});
const rejected = [
 ['wrong app ID', f => { f.appAudit.call.callId = 'other'; }],
 ['no dial', f => { f.appAudit.call.dialed = false; }],
 ['wrong provider', f => { f.appAudit.call.provider = 'simulated'; }],
 ['legacy correlation', f => { delete f.appAudit.providerCorrelation; }],
 ['missing carrier ID', f => { f.appAudit.providerCorrelation.carrierCallId = null; }],
 ['missing conversation ID', f => { f.appAudit.providerCorrelation.conversationId = null; }],
 ['wrong acceptance agent', f => { f.appAudit.providerCorrelation.agentId = 'other'; }],
 ['wrong ledger carrier', f => { f.appAudit.call.providerCallId = 'other'; }],
 ['wrong CDR', f => { f.carrier.Call.Sid = 'other'; }],
 ['wrong recipient', f => { f.carrier.Call.From = '+919000000001'; }],
 ['unknown carrier status', f => { f.carrier.Call.Status = 'unknown'; }],
 ['zero talk, long ringing', f => { f.carrier.Call.Details.ConversationDuration = 0; }],
 ['missing talk time', f => { delete f.carrier.Call.Details; }],
 ['infinite talk time', f => { f.carrier.Call.Details.ConversationDuration = Infinity; }],
 ['wrong conversation', f => { f.conversation.conversation_id = 'conv-other'; }],
 ['wrong agent', f => { f.conversation.agent_id = 'agent-other'; }],
 ['missing carrier binding', f => { delete f.conversation.metadata.phone_call.call_sid; }],
 ['different carrier binding', f => { f.conversation.metadata.phone_call.call_sid = 'carrier-other'; }],
 ['wrong external number', f => { f.conversation.metadata.phone_call.external_number = '+919000000001'; }],
 ['text-only session', f => { f.conversation.metadata.text_only = true; }],
 ['zero turns', f => { f.conversation.transcript = []; }],
 ['greeting only', f => { f.conversation.transcript.splice(1); }],
 ['no final answer', f => { f.conversation.transcript.pop(); }],
 ['interrupted answer', f => { f.conversation.transcript[2].interrupted = true; }],
 ['filler only', f => { f.conversation.transcript[2].message = 'One moment.'; }],
 ['one-way audio', f => { f.conversation.has_user_audio = false; }],
];
for (const status of ['no-answer','from_leg_unanswered','busy','failed','canceled','to_leg_unanswered','initiated','in-progress']) rejected.push(['carrier '+status, f => { f.carrier.Call.Status = status; }]);
for (const status of ['initiated','in-progress','processing','failed']) rejected.push(['conversation '+status, f => { f.conversation.status = status; }]);
for (const [name, mutate] of rejected) test('refuses '+name, () => {
  const f = fixture(); mutate(f); assert.equal(inspectHandsetEvidence(f).passed, false); assert.throws(() => assertHandsetEvidence(f), /not verified/);
});
for (const variant of ['9876543210','09876543210','919876543210','+919876543210','+91 98765 43210','+91 (98765) 43210','98765-43210','98765.43210']) {
  test('evidence agrees with application number normalization: '+variant.length, () => {
    assert.equal(canonicalDialNumber({}, variant), expected.phone);
    const f = fixture(); f.carrier.Call.From = variant; f.conversation.metadata.phone_call.external_number = variant;
    assert.equal(inspectHandsetEvidence(f).passed, true);
  });
}
test('recording disabled requires exact same-session observed audio, without enabling recording', () => {
  const f = fixture(); f.conversation.has_user_audio = false; f.conversation.has_response_audio = false;
  assert.equal(inspectHandsetEvidence(f).passed, false);
  f.liveAudioEvidence = { conversationId: correlation.conversationId, inputMode:'audio', inputBytes:32000, outputBytes:64000, nonSilentBytes:100, playbackComplete:true };
  assert.equal(inspectHandsetEvidence(f).passed, true);
  f.liveAudioEvidence.conversationId = 'wrong'; assert.equal(inspectHandsetEvidence(f).passed, false);
});
test('transition parser never invents legacy IDs or exports raw payloads', () => {
  for (const transitions of [null, [], [{to_state:'dialing',detail_json:'bad'}], [{to_state:'dialing',detail_json:'{}'}]]) assert.equal(correlationFromVoiceTransitions(transitions), null);
  const t = {to_state:'dialing',detail_json:JSON.stringify({providerCorrelation:{...correlation, secret:'do-not-export'}})};
  assert.deepEqual(correlationFromVoiceTransitions([t]),correlation);
  assert.equal(correlationFromVoiceTransitions([t,t]),null);
  assert.deepEqual(voiceProviderCorrelation({carrierCallId:'https://bad.test/token',conversationId:{},agentId:'wrong\nvalue'}),{carrierCallId:null,conversationId:null,agentId:null});
});
const readEnv = { EXOTEL_SUBDOMAIN:'api.exotel.com', EXOTEL_SID:'local-account', EXOTEL_API_KEY:'local-key', EXOTEL_API_TOKEN:'local-token', ELEVENLABS_API_KEY:'local-eleven-key' };
const context = { ...expected, cookie:'pawspace_uat=local-test-session' };
function reader(f, calls, override) { return async (url, init) => {
  calls.push({url,init}); assert.equal(init.method,'GET'); assert.equal(init.redirect,'error');
  if (override) { const response = override(url, init); if (response) return response; }
  if (url.startsWith('https://pawspace-staging.karthik-fce.workers.dev/api/voice-outbound?scope=audit&callId=VCALL-LOCAL')) return jsonResponse({data:f.appAudit});
  if (url === 'https://api.exotel.com/v1/Accounts/local-account/Calls/carrier-local.json?details=true') return jsonResponse(f.carrier);
  if (url === 'https://api.elevenlabs.io/v1/convai/conversations/conv-local') return jsonResponse(f.conversation);
  throw Error('Unexpected endpoint: no listing or dial allowed');
}; }
test('read-only verifier fetches exact identifiers, uses GET only, and never searches latest', async () => {
  const f=fixture(), calls=[];
  const result = await verifyHandsetAttempt(context, readEnv, {fetchImpl:reader(f,calls),maxAttempts:1});
  assert.equal(result.passed,true); assert.equal(calls.length,3);
  assert.ok(!calls.some(c=>c.url.includes('/outbound-call')||c.url.includes('/connect')));
  assert.equal(calls[1].init.headers['xi-api-key'],undefined);
  assert.equal(calls[2].init.headers.authorization,undefined);
});
test('legacy audit aborts before any provider request instead of guessing latest', async () => {
  const f=fixture(),calls=[];delete f.appAudit.providerCorrelation;
  await assert.rejects(()=>verifyHandsetAttempt(context,readEnv,{fetchImpl:reader(f,calls)}),/do not guess/);
  assert.equal(calls.length,1);
});
for(const status of [401,403,404,429,500]) test('provider HTTP '+status+' stops without fallback or redial',async()=>{
 const calls=[];
 await assert.rejects(()=>verifyHandsetAttempt(context,readEnv,{fetchImpl:reader(fixture(),calls,url=>url.startsWith('https://api.exotel.com')?jsonResponse({},status):null)}),/read refused/);
 assert.equal(calls.length,2);
});
test('polling exhaustion with initiated/zero-turn conversation fails, not green',async()=>{
 const f=fixture(),calls=[];f.carrier.Call.Status='in-progress';f.conversation.status='initiated';f.conversation.transcript=[];
 await assert.rejects(()=>verifyHandsetAttempt(context,readEnv,{fetchImpl:reader(f,calls),delay:async()=>{},maxAttempts:2}),/not verified/);
 assert.equal(calls.length,5);
});
test('same no-answer evidence as the failed demo stops immediately without claiming the phone rang',async()=>{
 const f=fixture(),calls=[];f.carrier.Call.Status='no-answer';f.carrier.Call.Details.ConversationDuration=0;
 await assert.rejects(()=>verifyHandsetAttempt(context,readEnv,{fetchImpl:reader(f,calls)}),/recipient_leg_not_answered/);
 assert.equal(calls.length,2);
});
for(const host of ['api.exotel.com.evil.test','evil.test','https://api.exotel.com','api.exotel.com@evil.test']) test('unapproved carrier host fails before reads: '+host,async()=>{
 let calls=0;await assert.rejects(()=>verifyHandsetAttempt(context,{...readEnv,EXOTEL_SUBDOMAIN:host},{fetchImpl:async()=>{calls++;}}),/region/);assert.equal(calls,0);
});
test('oversized or malformed provider evidence never passes',async()=>{
 for(const body of ['not-json','x'.repeat(1048577)]){
  const calls=[];await assert.rejects(()=>verifyHandsetAttempt(context,readEnv,{fetchImpl:reader(fixture(),calls,url=>url.startsWith('https://api.exotel.com')?new Response(body):null)}));assert.equal(calls.length,2);
 }
});
test('actual app adapter preserves both provider IDs separately',async t=>{
 const env={PAWSPACE_VOICE_RUNTIME:'elevenlabs',ELEVENLABS_API_KEY:'local-key',ELEVENLABS_AGENT_ID:expected.agentId,ELEVENLABS_AGENT_PHONE_NUMBER_ID:'phone-local',ELEVENLABS_API_BASE:'https://api.elevenlabs.io'};
 const mock=stubFetch(()=>jsonResponse({success:true,callSid:correlation.carrierCallId,conversation_id:correlation.conversationId}));t.after(()=>mock.restore());
 const handle=await telephony.selectTelephonyProvider(env).createCall({callRef:expected.appCallId,toNumber:expected.phone,statusCallbackUrl:'https://example.test/callback',recordingAllowed:false});
 assert.deepEqual(handle.providerCorrelation,correlation);assert.equal(handle.providerCallId,correlation.carrierCallId);
 assert.equal(mock.calls.length,1);
});
test('conversation-only acceptance cannot be mistaken for a verified carrier ID',async t=>{
 const env={PAWSPACE_VOICE_RUNTIME:'elevenlabs',ELEVENLABS_API_KEY:'local-key',ELEVENLABS_AGENT_ID:expected.agentId,ELEVENLABS_AGENT_PHONE_NUMBER_ID:'phone-local'};
 const mock=stubFetch(()=>jsonResponse({success:true,conversation_id:correlation.conversationId}));t.after(()=>mock.restore());
 const handle=await telephony.selectTelephonyProvider(env).createCall({callRef:expected.appCallId,toNumber:expected.phone,statusCallbackUrl:'https://example.test/callback',recordingAllowed:false});
 assert.equal(handle.providerCorrelation.carrierCallId,null);assert.equal(handle.providerCorrelation.conversationId,correlation.conversationId);
});
test('real governed request persists correlation in its audit and idempotent replay does not dial again',async t=>{
 const sqlite=freshSqlite(),db=makeD1(sqlite);t.after(()=>sqlite.close());
 const env=uatVoiceEnv({PAWSPACE_VOICE_TRANSPORT:'',PAWSPACE_VOICE_RUNTIME:'elevenlabs',ELEVENLABS_API_KEY:'local-key',ELEVENLABS_AGENT_ID:expected.agentId,ELEVENLABS_AGENT_PHONE_NUMBER_ID:'phone-local',ELEVENLABS_API_BASE:'https://api.elevenlabs.io'});
 globalThis.__HANDSET_DB__=db;globalThis.__HANDSET_ENV__=env;
 const {ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);await gov.ensureVoiceCallTables(db);await gov.seedVoiceCallScripts(db);seedRecipient(sqlite);
 await gov.recordVoiceConsent(db,{phone:expected.phone,subjectType:'customer',subjectId:'CON-V1',granted:true,source:'local-test',actorId:'local-tester'});
 const mock=stubFetch(()=>jsonResponse({success:true,callSid:correlation.carrierCallId,conversation_id:correlation.conversationId}));t.after(()=>mock.restore());
 const request={idempotencyKey:'local-single-call',useCase:'booking_confirmation',phone:expected.phone,cityId:'blr',customerId:'CON-V1',leadId:'LEAD-V1',bookingId:'BKG-V1',actorId:'local-tester',actorPermissions:['*'],asOf:DAYTIME};
 const call=await gov.requestOutboundVoiceCall(db,env,request);assert.equal(call.dialled,true);
 const audit=await gov.voiceCallAudit(db,call.callId);assert.deepEqual(audit.providerCorrelation,correlation);assert.ok(audit.transitions.every(step=>!Object.hasOwn(step,'detail_json')));
 const stored=sqlite.prepare('SELECT ai_call_id FROM voice_call_orders WHERE id=?').get(call.callId);assert.equal(stored.ai_call_id,null);
 await gov.requestOutboundVoiceCall(db,env,request);assert.equal(mock.calls.length,1);
});

test('specialist workflow is wired to exact-call proof instead of timestamp-based success',async()=>{
 const {readFileSync}=await import('node:fs');
 const workflow=readFileSync(new URL('../.github/workflows/elevenlabs-provider-preflight.yml',import.meta.url),'utf8');
 const block=workflow.slice(workflow.indexOf('  specialist-call:'),workflow.indexOf('  direct-grooming-call:'));
 assert.match(block,/verifyHandsetAttempt/);assert.match(block,/appCallId:body\.data\.callId/);
 assert.match(block,/SPECIALIST_CUSTOMER_ID/);assert.doesNotMatch(block,/INBOUND-9513886363/);
 assert.match(block,/idempotencyKey:.*GITHUB_RUN_ID/);
 assert.doesNotMatch(block,/conversations\?agent_id|start_time_unix_secs|let detail=null/);
 assert.ok(block.indexOf('Exact existing canonical customer required')<block.indexOf("const call=await fetch"));
});
