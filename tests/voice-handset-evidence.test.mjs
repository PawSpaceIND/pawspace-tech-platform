import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, DAYTIME } from './helpers/voice-harness.mjs';
import { stubFetch, jsonResponse } from './helpers/ai-harness.mjs';
import { inspectHandsetEvidence, assertHandsetEvidence, correlationFromVoiceTransitions, voiceProviderCorrelation, positiveTalkSeconds, inspectAttendedHandsetEvidence, ATTENDED_HANDSET_STATEMENT } from '../lib/voice-handset-evidence.ts';
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
const CARRIER_EVIDENCE_URL = 'https://api.exotel.com/v1/Accounts/local-account/Calls/carrier-local.json?details=true';
// Exact fixture endpoint: a host prefix can also match an unrelated destination.
const isCarrierEvidenceRequest = url => url === CARRIER_EVIDENCE_URL;
function reader(f, calls, override) { return async (url, init) => {
  calls.push({url,init}); assert.equal(init.method,'GET'); assert.equal(init.redirect,'error');
  if (override) { const response = override(url, init); if (response) return response; }
  if (url === 'https://pawspace-staging.karthik-fce.workers.dev/api/voice-outbound?scope=audit&callId=VCALL-LOCAL') return jsonResponse({data:f.appAudit});
  if (isCarrierEvidenceRequest(url)) return jsonResponse(f.carrier);
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
 await assert.rejects(()=>verifyHandsetAttempt(context,readEnv,{fetchImpl:reader(fixture(),calls,url=>isCarrierEvidenceRequest(url)?jsonResponse({},status):null)}),/read refused/);
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
  const calls=[];await assert.rejects(()=>verifyHandsetAttempt(context,readEnv,{fetchImpl:reader(fixture(),calls,url=>isCarrierEvidenceRequest(url)?new Response(body):null)}));assert.equal(calls.length,2);
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
 assert.match(block,/specialistDemoPreflight\(process\.env\)/);
 const preflight=readFileSync(new URL('../scripts/voice-handset-preflight.mjs',import.meta.url),'utf8');
 assert.match(preflight,/GITHUB_RUN_ID/);assert.match(preflight,/idempotencyKey:/);
 assert.doesNotMatch(block,/conversations\?agent_id|start_time_unix_secs|let detail=null/);
 assert.match(preflight,/Exact existing canonical customer required/);
 assert.ok(block.indexOf('specialistDemoPreflight(process.env)')>=0);
 assert.ok(block.indexOf('specialistDemoPreflight(process.env)')<block.indexOf('const login=await fetch'));
 assert.ok(block.indexOf('specialistDemoPreflight(process.env)')<block.indexOf('const call=await fetch'));
 assert.ok(block.indexOf("import('./scripts/verify-handset-attempt.mjs')")<block.indexOf('const call=await fetch'));
});

// These exercise only the in-memory response stub; no external requests are made.
test('carrier error injection applies only to the exact expected evidence URL', async () => {
 const calls=[], request=reader(fixture(),calls,url=>isCarrierEvidenceRequest(url)?jsonResponse({},503):null);
 assert.equal(isCarrierEvidenceRequest(CARRIER_EVIDENCE_URL),true);
 assert.equal((await request(CARRIER_EVIDENCE_URL,{method:'GET',redirect:'error'})).status,503);
 assert.equal(calls.length,1);
});
const rejectedEvidenceUrls = [
 'https://api.exotel.com.untrusted.invalid/v1/Accounts/local-account/Calls/carrier-local.json?details=true',
 'https://api.exotel.com@untrusted.invalid/v1/Accounts/local-account/Calls/carrier-local.json?details=true',
 'http://api.exotel.com/v1/Accounts/local-account/Calls/carrier-local.json?details=true',
 'https://api.exotel.com:8443/v1/Accounts/local-account/Calls/carrier-local.json?details=true',
 'https://api.exotel.com/v1/Accounts/other-account/Calls/carrier-local.json?details=true',
 'https://api.exotel.com/v1/Accounts/local-account/Calls/other-call.json?details=true',
 'https://api.exotel.com/v1/Accounts/local-account/Calls/connect.json',
 CARRIER_EVIDENCE_URL + '&unexpected=1',
];
for (const [index,url] of rejectedEvidenceUrls.entries()) test('carrier evidence stub rejects non-exact destination '+index, async () => {
 assert.equal(isCarrierEvidenceRequest(url),false);
 const calls=[], request=reader(fixture(),calls,value=>isCarrierEvidenceRequest(value)?jsonResponse({},503):null);
 await assert.rejects(()=>request(url,{method:'GET',redirect:'error'}),/Unexpected endpoint/);
 assert.equal(calls.length,1);
});

import { handsetVerifierConfig, singleHandsetTester, specialistDemoPreflight } from '../scripts/voice-handset-preflight.mjs';
import { verifyAttendedHandset } from '../scripts/verify-attended-handset.mjs';
const demoEnv = { ...readEnv, SPECIALIST_USE_CASE:'grooming_sales', GROOMING_AGENT_ID:expected.agentId, TRAINING_AGENT_ID:'agent-training',
 SPECIALIST_CUSTOMER_ID:'CUS-LOCAL', PAWSPACE_UAT_ACCESS_CODE:'local-access', PAWSPACE_VOICE_UAT_ALLOWLIST:expected.phone, GITHUB_RUN_ID:'123456' };
for (const value of [null,undefined,true,false,[],[12],{},'', ' ', ' 12 ', '1e3','0x12','Infinity',Infinity,NaN,0,-1,'-1','00.1']) {
 test('talk time rejects non-decimal or nonpositive scalar '+String(value),()=>assert.equal(positiveTalkSeconds(value),null));
}
for (const value of [1,12.5,'1','12.5','0.1']) test('talk time accepts positive numeric or decimal scalar '+value,()=>assert.equal(positiveTalkSeconds(value),Number(value)));
test('arbitrary provider status never appears in the operator evidence report',()=>{
 const f=fixture();f.carrier.Call.Status='secret-personal-data';f.conversation.status='secret-personal-data';
 const result=inspectHandsetEvidence(f);assert.equal(result.carrierStatus,'unknown');assert.equal(result.conversationStatus,'unknown');
 assert.equal(result.passed,false);assert.ok(!JSON.stringify(result).includes('secret-personal-data'));
});
test('preflight uses app canonical allowlist parsing and stable workflow identity',()=>{
 for(const phone of ['9876543210','09876543210','+91 98765 43210','+91 (98765) 43210','919876543210']){
  const e={...demoEnv,PAWSPACE_VOICE_UAT_ALLOWLIST:phone};assert.equal(singleHandsetTester(e),expected.phone);
  const result=specialistDemoPreflight(e);assert.equal(result.phone,expected.phone);assert.equal(result.customerId,'CUS-LOCAL');
  assert.equal(result.idempotencyKey,'voice-specialist-uat:grooming_sales:123456');
  assert.equal(result.carrierOrigin,'https://api.exotel.com');
 }
});
const badPrerequisites=[['EXOTEL_API_KEY',''],['EXOTEL_API_TOKEN','token\n'],['ELEVENLABS_API_KEY',true],['EXOTEL_SID','../wrong'],
 ['EXOTEL_SUBDOMAIN','api.exotel.com.untrusted.invalid'],['ELEVENLABS_API_BASE','https://api.elevenlabs.io.untrusted.invalid'],
 ['GITHUB_RUN_ID',''],['GITHUB_RUN_ID','0'],['GITHUB_RUN_ID','12x'],['SPECIALIST_USE_CASE','other'],['GROOMING_AGENT_ID',''],
 ['SPECIALIST_CUSTOMER_ID',''],['PAWSPACE_UAT_ACCESS_CODE',''],['PAWSPACE_VOICE_UAT_ALLOWLIST','+19876543210'],
 ['PAWSPACE_VOICE_UAT_ALLOWLIST','9876543210,9000000001'],['PAWSPACE_VOICE_UAT_ALLOWLIST','9876543210 9000000001']];
for(const [key,value] of badPrerequisites)test('preflight rejects invalid '+key+' '+String(value).length,()=>assert.throws(()=>specialistDemoPreflight({...demoEnv,[key]:value})));

function attendedFixture(){
 const f=fixture(), now=Math.floor(Date.now()/1000)*1000;
 f.appAudit.call.recordingAllowed=false;f.conversation.has_user_audio=false;f.conversation.has_response_audio=false;
 f.conversation.metadata.start_time_unix_secs=now/1000-120;f.conversation.metadata.call_duration_secs=60;
 const report={schemaVersion:1,source:'participant_report',participant:'recipient',appCallId:expected.appCallId,
  statement:ATTENDED_HANDSET_STATEMENT,recordedBy:'local-operator',reportedAtMs:now-1000};
 return {f,report,now};
}
test('attended recording-disabled exchange is distinct from machine audio certification',()=>{
 const {f,report,now}=attendedFixture();const result=inspectAttendedHandsetEvidence(f,report,now);
 assert.equal(result.passed,false);assert.equal(result.attendedPassed,true);assert.equal(result.reason,'two_way_audio_not_verified');
 assert.equal(result.evidenceClass,'participant_report_with_correlated_provider_metadata');
 assert.equal(result.recordingChanged,false);assert.equal(result.audioRecordingInspected,false);assert.equal(result.answerAccuracy,'not_assessed');
 assert.ok(!JSON.stringify(result).includes(expected.phone));
});
const invalidAttendance=[['wrong app',x=>{x.report.appCallId='VCALL-WRONG';}],['no explicit statement',x=>{x.report.statement='yes';}],
 ['wrong reporter kind',x=>{x.report.source='automated';}],['missing operator',x=>{delete x.report.recordedBy;}],
 ['nonrecipient',x=>{x.report.participant='operator';}],['future time',x=>{x.report.reportedAtMs=x.now+1;}],
 ['before call ended',x=>{x.report.reportedAtMs=x.now-90000;}],['stale report',x=>{x.report.reportedAtMs=x.now-86400001;}],
 ['recording context unknown',x=>{delete x.f.appAudit.call.recordingAllowed;}],['wrong recipient',x=>{x.f.carrier.Call.From='+919000000001';}],
 ['no-answer call',x=>{x.f.carrier.Call.Status='no-answer';}],['no talk time',x=>{x.f.carrier.Call.Details.ConversationDuration=0;}],
 ['no reply',x=>{x.f.conversation.transcript.pop();}],['wrong conversation',x=>{x.f.conversation.conversation_id='wrong';}],
 ['missing duration',x=>{delete x.f.conversation.metadata.call_duration_secs;}]];
for(const [name,mutate] of invalidAttendance)test('attended evidence refuses '+name,()=>{
 const x=attendedFixture();mutate(x);const result=inspectAttendedHandsetEvidence(x.f,x.report,x.now);
 assert.equal(result.attendedPassed,false);assert.notEqual(result.evidenceClass,'participant_report_with_correlated_provider_metadata');
});

test('post-call participant verifier authenticates then reads only the three exact call records',async()=>{
 const {f,report}=attendedFixture(), calls=[], read=reader(f,calls);
 const env={...demoEnv,UAT_VOICE_CALL_ID:expected.appCallId,GITHUB_ACTOR:report.recordedBy,
  ATTENDED_STATEMENT:report.statement,ATTENDED_REPORTED_AT:new Date(report.reportedAtMs).toISOString()};
 const requests=[];const fetchImpl=async(url,init)=>{
  requests.push({url,method:init.method});
  if(url==='https://pawspace-staging.karthik-fce.workers.dev/api/staging-login'){
   assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');
   return new Response('{}',{status:200,headers:{'set-cookie':'pawspace_uat=local-test-session; Secure; HttpOnly'}});
  }
  return read(url,init);
 };
 const result=await verifyAttendedHandset(env,{fetchImpl});
 assert.equal(result.attendedPassed,true);assert.equal(result.passed,false);
 assert.deepEqual(requests.map(r=>r.method),['POST','GET','GET','GET']);assert.equal(calls.length,3);
 assert.ok(requests.every(r=>!r.url.includes('/outbound-call')&&!r.url.includes('/audio')&&!r.url.includes('/connect')));
});
test('missing participant statement or future report makes zero network requests',async()=>{
 const {report}=attendedFixture();let calls=0;
 const env={...demoEnv,UAT_VOICE_CALL_ID:expected.appCallId,GITHUB_ACTOR:report.recordedBy,ATTENDED_STATEMENT:report.statement,ATTENDED_REPORTED_AT:new Date(report.reportedAtMs).toISOString()};
 for(const changes of [{ATTENDED_STATEMENT:''},{ATTENDED_STATEMENT:'approved before calling'},{ATTENDED_REPORTED_AT:new Date(Date.now()+60000).toISOString()}]){
  await assert.rejects(()=>verifyAttendedHandset({...env,...changes},{fetchImpl:async()=>{calls++;throw Error('unexpected request');}}));
 }
 assert.equal(calls,0);
});

test('actual specialist workflow rejects every invalid prerequisite before any fetch',async()=>{
 const {readFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');
 const workflow=readFileSync(new URL('../.github/workflows/elevenlabs-provider-preflight.yml',import.meta.url),'utf8');
 const block=workflow.slice(workflow.indexOf('  specialist-call:'),workflow.indexOf('  direct-grooming-call:'));
 const match=block.match(/node --experimental-strip-types <<'NODE'\n([\s\S]*?)\n          NODE/);
 assert.ok(match,'Actual specialist workflow script must be executable');
 const script=match[1].replace(/^          /gm,'');
 const harness=`let requests=0;globalThis.fetch=async()=>{requests++;throw Error('unexpected fetch');};\ntry{${script}\nthrow Error('preflight accepted invalid context');}catch(error){if(requests||error.message==='preflight accepted invalid context')throw error;console.log('PREFLIGHT_REFUSED_WITH_ZERO_REQUESTS');}`;
 for(const [key,value] of badPrerequisites){
  const env={PATH:process.env.PATH,...demoEnv,[key]:String(value)};
  // Objects/booleans cannot occur as environment variables; empty is their invalid CLI representation.
  if(typeof value!=='string')env[key]='';
  const out=execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-'],{
   cwd:new URL('../',import.meta.url),env,input:harness,encoding:'utf8',timeout:10000,stdio:['pipe','pipe','pipe']});
  assert.match(out,/PREFLIGHT_REFUSED_WITH_ZERO_REQUESTS/,key);
 }
});
test('attended workflow defaults to no confirmation and cannot dial or enable recording',async()=>{
 const {readFileSync}=await import('node:fs');
 const yaml=await import('js-yaml');const doc=yaml.load(readFileSync(new URL('../.github/workflows/elevenlabs-provider-preflight.yml',import.meta.url),'utf8'));
 const job=doc.jobs['verify-attended-handset'];assert.ok(job);
 assert.equal(doc.on.workflow_dispatch.inputs.attended_statement.default,'');
 assert.equal(doc.on.workflow_dispatch.inputs.attended_reported_at.default,'');
 const step=job.steps.find(s=>s.run);assert.equal(step.run,'node --experimental-strip-types scripts/verify-attended-handset.mjs');
 assert.equal(step.env.ATTENDED_STATEMENT,'${{ inputs.attended_statement }}');
 assert.ok(!Object.keys(step.env).some(k=>/RECORDING_APPROVED|VOICE_LIVE_APPROVED/.test(k)));
});

test('read-only verifier retains an explicitly configured allowed provider region',()=>{
 for(const origin of ['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io']){
  assert.equal(handsetVerifierConfig({...demoEnv,ELEVENLABS_API_BASE:origin}).elevenOrigin,origin);
 }
 assert.throws(()=>handsetVerifierConfig({...demoEnv,ELEVENLABS_API_BASE:'https://api.elevenlabs.io@untrusted.invalid'}),/region/);
});

const rejectedProviderLocations=[
 ['EXOTEL_SUBDOMAIN','api.exotel.com.untrusted.invalid'],
 ['EXOTEL_SUBDOMAIN','api.exotel.com@untrusted.invalid'],
 ['EXOTEL_SUBDOMAIN','https://api.exotel.com'],
 ['EXOTEL_SUBDOMAIN','api.exotel.com:443'],
 ['EXOTEL_SUBDOMAIN','api.exotel.com/path'],
 ['EXOTEL_SUBDOMAIN','untrusted.invalid/?next=api.exotel.com'],
 ['ELEVENLABS_API_BASE','https://api.elevenlabs.io.untrusted.invalid'],
 ['ELEVENLABS_API_BASE','https://api.elevenlabs.io@untrusted.invalid'],
 ['ELEVENLABS_API_BASE','http://api.elevenlabs.io'],
 ['ELEVENLABS_API_BASE','https://api.elevenlabs.io:8443'],
 ['ELEVENLABS_API_BASE','https://api.elevenlabs.io/path'],
 ['ELEVENLABS_API_BASE','https://untrusted.invalid/?next=https://api.elevenlabs.io'],
];
for(const [index,[key,value]] of rejectedProviderLocations.entries())test('exact provider destination rejects embedded/lookalike URL '+index,()=>{
 assert.throws(()=>handsetVerifierConfig({...demoEnv,[key]:value}),/region/);
});
