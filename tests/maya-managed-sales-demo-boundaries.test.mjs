import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const runnerUrl = new URL('../scripts/demo-three-voice-conversations.mjs', import.meta.url);
const source = await readFile(runnerUrl, 'utf8');
const workflow = await readFile(new URL('../.github/workflows/elevenlabs-provider-preflight.yml', import.meta.url), 'utf8');

test('managed suite cannot execute provider traffic when imported for offline checks', () => {
  assert.match(source, /pathToFileURL\(process\.argv\[1\]\)/);
});
test('managed suite requires effective budget reads before signing or opening a paid session', () => {
  assert.match(source, /export async function readManagedDemoBudget/);
  assert.match(source, /\/v1\/user/);
  assert.match(source, /ai_provider_runtime_circuit/);
});
test('six turns and five sessions have an aggregate deadline and zero reruns', () => {
  assert.match(source, /export const MANAGED_DEMO_LIMITS/);
  assert.match(source, /GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /demo-five-sales-conversations/);
});
test('managed final transcript and state receipts cover every turn, including failures', () => {
  assert.match(source, /export function assertManagedFinalTranscript/);
  assert.match(source, /export function assertManagedState/);
  assert.match(source, /transactionCompletionTested: false/);
});
test('claims distinguish observed audio, playback estimates and listening', () => {
  assert.match(source, /endOfSpeechToFirstAudioMs/);
  assert.match(source, /playbackEstimated/);
  assert.match(source, /listened: false/);
});
test('no-send and recipient isolation precede any mutating confirmation', () => {
  assert.match(source, /export function assertManagedCases/);
  assert.match(source, /confirmationsAllowed: false/);
  assert.match(source, /No mutating confirmation/);
});

const {
 MANAGED_DEMO_LIMITS,assertManagedCases,assertManagedSource,readManagedDemoBudget,
 assertManagedState,assertManagedFinalTranscript,createManagedRecorder,
}=await import(runnerUrl);
const fixture=JSON.parse(await readFile(new URL('../scripts/fixtures/maya-managed-sales-scenarios.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
const sha='a'.repeat(40),head='b'.repeat(40);
const settings={bindings:[{name:'PAWSPACE_AI_PROVIDER',type:'plain_text',text:'openai'},{name:'PAWSPACE_AI_VOICE_MODEL',type:'plain_text',text:'gpt-5.6-luna'}]};
const budgetInput=(overrides={})=>({settings:clone(settings),now:86400000,query:async(sql)=>sql.includes('COUNT(*)')?[{count:0}]:sql.includes('SUM(')?[{tokens:100,cost:0}]:[],readEleven:async path=>path.endsWith('/subscription')?{character_count:1,character_limit:999999,max_credit_limit_extension:0,status:'active'}:{subscription_extras:{usage:{subscription_cycle_credits_quota:999999,subscription_cycle_credits_used:1}}},...overrides});

// These checks never authenticate, open a socket, generate speech, or mutate staging.
test('import and all pure checks are safe with no provider credentials',()=>{
 assert.equal(typeof readManagedDemoBudget,'function');
 assert.deepEqual(MANAGED_DEMO_LIMITS,{sessions:5,turnsPerSession:6,aggregateMs:720000,sessionMs:120000,sessionRetries:0,confirmationsAllowed:false,audioBytes:16777216});
});
test('fixture has five enquiries, Tamil, a real interruption attempt and a final handoff',()=>{
 const cases=assertManagedCases(fixture);assert.equal(cases.length,5);
 assert.equal(cases.reduce((n,s)=>n+s.turns.length,0),25);
 assert.equal(cases.filter(s=>s.language==='ta').length,1);
 assert.equal(cases.flatMap(s=>s.turns).filter(t=>t.interruptPrevious).length,1);
 assert.equal(cases.at(-1).turns.at(-1).expectHandoff,true);
});
test('reject extra session, seventh turn, affirmative consent and early handoff',()=>{
 for(const change of [f=>f.scenarios.push(clone(f.scenarios[0])),f=>{f.scenarios[0].turns.push(...clone(f.scenarios[0].turns.slice(0,2)));},f=>{f.scenarios[0].turns[1].text='Yes';},f=>{f.scenarios[1].turns[1].text='ஆம்';},f=>{f.scenarios[4].turns[1].expectHandoff=true;}]){const f=clone(fixture);change(f);assert.throws(()=>assertManagedCases(f));}
});
test('pinned deployed source or four-path reviewed test delta is required',()=>{
 assert.equal(assertManagedSource(sha,sha,[],'1').testOnlyDelta,false);
 assert.equal(assertManagedSource(sha,head,['scripts/demo-three-voice-conversations.mjs'],'1').testOnlyDelta,true);
 assert.throws(()=>assertManagedSource(sha,head,['lib/voice-sales-specialists.ts'],'1'),/managed_source_not_test_only_delta/);
 assert.throws(()=>assertManagedSource('main',head,[],'1'),/managed_source_pin_required/);
 assert.throws(()=>assertManagedSource(sha,sha,[],'2'),/managed_rerun_refused/);
});
test('character credits never authorize an Agents-minute spend',async()=>{
 const calls=[];const input=budgetInput();const original=input.readEleven;input.readEleven=async path=>{calls.push(path);return original(path);};
 const receipt=await readManagedDemoBudget(input);
 assert.equal(receipt.allowed,false);assert.deepEqual(calls.sort(),['/v1/user','/v1/user/subscription']);
 assert.equal(receipt.runtime.remainingReservedTokensToday,4999900);
 assert.equal(receipt.runtime.costCapConfigured,false);
 assert.equal(receipt.speech.agentsMinutesRemaining,null);
 assert.ok(receipt.gates.includes('elevenlabs_agents_included_minutes_headroom_not_exposed_by_existing_reads'));
});
test('encrypted cap value fails closed without assuming a public default',async()=>{
 const s=clone(settings);s.bindings.push({name:'PAWSPACE_AI_MAX_RESERVED_TOKENS_PER_DAY',type:'secret_text'});
 let queried=false;const receipt=await readManagedDemoBudget(budgetInput({settings:s,query:async()=>{queried=true;return[];}}));
 assert.equal(queried,false);assert.equal(receipt.runtime,null);
 assert.ok(receipt.gates.includes('encrypted_effective_binding:PAWSPACE_AI_MAX_RESERVED_TOKENS_PER_DAY'));
});
test('quota and open circuit reads match the configured runtime model',async()=>{
 const calls=[];const receipt=await readManagedDemoBudget(budgetInput({query:async(sql,params)=>{calls.push({sql,params});if(sql.includes('COUNT(*)'))return[{count:240}];if(sql.includes('SUM('))return[{tokens:5000000,cost:0}];return[{open_until:86460000}];}}));
 assert.ok(receipt.gates.includes('runtime_existing_quota_exhausted'));assert.ok(receipt.gates.includes('runtime_circuit_open'));
 assert.deepEqual(calls.find(c=>c.sql.includes('ai_provider_runtime_circuit')).params,['openai','gpt-5.6-luna']);
 assert.equal(receipt.runtime.remainingReservedTokensToday,0);
});
test('existing read denial names the exact endpoint and status without leaking payload',async()=>{
 const receipt=await readManagedDemoBudget(budgetInput({readEleven:async path=>{if(path==='/v1/user')throw Object.assign(Error('SECRET_CANARY'),{status:403});return {character_limit:100,max_credit_limit_extension:0};}}));
 assert.ok(receipt.gates.includes('speech_budget_read_denied:/v1/user:403'));
 assert.doesNotMatch(JSON.stringify(receipt),/SECRET_CANARY/);assert.equal(receipt.allowed,false);
});
test('usage based billing does not silently spend beyond included credit',async()=>{
 const receipt=await readManagedDemoBudget(budgetInput({readEleven:async path=>path.endsWith('/subscription')?{character_count:1,character_limit:100,max_credit_limit_extension:'unlimited',status:'active'}:{}}));
 assert.ok(receipt.gates.includes('speech_usage_based_extension_not_disabled'));
});
const snapshot=()=>Object.fromEntries(['bookings','payments','reservations','confirmationGuards','messages','outbox','deliveries','confirmedOffers','payoutInstructions','schedulerActivation'].map(k=>[k,{count:0,sha256:sha}]));
test('persisted booking/payment/reservation/outbound changes cannot pass an enquiry',()=>{
 const before=snapshot();assert.equal(assertManagedState(before,clone(before)).transactionCompletionTested,false);
 for(const key of Object.keys(before)){const after=clone(before);after[key].count=1;assert.throws(()=>assertManagedState(before,after),new RegExp('managed_forbidden_state_change:'+key));}
 assert.throws(()=>assertManagedState({},{}));
});
const response=(text,eventId=1)=>({type:'agent_response',agent_response_event:{agent_response:text,event_id:eventId}});
const audio=(eventId,bytes=Buffer.alloc(2000,1))=>({event:{type:'audio',audio_event:{event_id:eventId,audio_base_64:bytes.toString('base64')}},bytes});
const metadata={type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{agent_output_audio_format:'pcm_16000'}};
test('all audio is retained, including greeting, pre-ASR and cancelled frames',()=>{
 let time=1;const recorder=createManagedRecorder(()=>time++);recorder.event(metadata);
 const greeting=audio(1);recorder.event(greeting.event,greeting.bytes);recorder.event(response('Hello'));
 recorder.begin({text:'A grooming enquiry'});
 const beforeAsr=audio(2);recorder.event(beforeAsr.event,beforeAsr.bytes);
 recorder.event({type:'user_transcript',user_transcription_event:{user_transcript:'A grooming enquiry'}});
 recorder.event(response('Here are the grooming options.'));
 const audible=audio(3);recorder.event(audible.event,audible.bytes);
 recorder.event({type:'interruption',interruption_event:{event_id:3}});
 const stale=audio(3);recorder.event(stale.event,stale.bytes);
 assert.equal(recorder.chunks.length,4);assert.equal(recorder.bytes,8000);
 assert.equal(recorder.turns[0].acceptedAudioBytes,2000);assert.equal(recorder.turns[0].interruptionObserved,true);
 assert.equal(recorder.chunks.at(-1).cancelled,true);assert.equal(recorder.chunks[1].turn,-1);
});
test('corrections are recorded and applied only to the matching reply',()=>{
 const recorder=createManagedRecorder(()=>1);recorder.event(metadata);recorder.begin({text:'enquiry'});
 recorder.event({type:'user_transcript',user_transcription_event:{user_transcript:'enquiry'}});
 recorder.event(response('Original response'));
 recorder.event({type:'agent_response_correction',agent_response_correction_event:{original_agent_response:'Unrelated response',corrected_agent_response:'Wrong correction'}});
 recorder.event({type:'agent_response_correction',agent_response_correction_event:{original_agent_response:'Original response',corrected_agent_response:'Approved correction'}});
 assert.equal(recorder.turns[0].reply,'Approved correction');
 assert.deepEqual(recorder.turns[0].corrections.map(c=>c.applied),[false,true]);
});
const turns=[{transcript:'தமிழில் பேசுங்கள்',reply:'தமிழில் விளக்குகிறேன்',acceptedAudioBytes:2000,nonSilentBytes:1000}];
const detail={status:'done',agent_id:'agent',transcript:[{role:'user',message:turns[0].transcript},{role:'agent',message:turns[0].reply}]};
test('Tamil proof uses Unicode text, actual audio and every final turn',()=>{
 const proof=assertManagedFinalTranscript(detail,{agentId:'agent',turns});assert.equal(proof.userTurns,1);assert.equal(proof.listened,false);
 const wrong=clone(detail);wrong.transcript[0].message='வேறொரு தமிழ் கேள்வி';assert.throws(()=>assertManagedFinalTranscript(wrong,{agentId:'agent',turns}),/recognition_mismatch/);
 const extra=clone(detail);extra.transcript.push({role:'user',message:'Yes'});assert.throws(()=>assertManagedFinalTranscript(extra,{agentId:'agent',turns}),/user_turn_count/);
 assert.throws(()=>assertManagedFinalTranscript(detail,{agentId:'agent',turns:[{...turns[0],acceptedAudioBytes:0}]}),/missing_actual_audio/);
});
test('interruption proof requires matching provider and observed evidence',()=>{
 const d=clone(detail);d.transcript[1].interrupted=true;
 assert.throws(()=>assertManagedFinalTranscript(d,{agentId:'agent',turns,allowInterrupted:true}),/unexpected_interruption/);
 const t=[{...turns[0],intentionalInterruption:true,interruptionObserved:true}];
 assert.equal(assertManagedFinalTranscript(d,{agentId:'agent',turns:t,allowInterrupted:true}).actualBidirectionalAudio,true);
 d.transcript[1].message='An unrelated English answer';assert.throws(()=>assertManagedFinalTranscript(d,{agentId:'agent',turns:t,allowInterrupted:true}),/interrupted_reply_mismatch/);
 assert.throws(()=>assertManagedFinalTranscript(detail,{agentId:'agent',turns:t,allowInterrupted:true}),/interruption_receipt_missing/);
});

test('speech-end timing excludes synthetic trailing silence and refuses silent input',async()=>{
 const {managedSpeechEndByte}=await import(runnerUrl);const pcm=Buffer.alloc(1000);pcm.writeInt16LE(200,200);
 assert.equal(managedSpeechEndByte(pcm),202);
 assert.throws(()=>managedSpeechEndByte(Buffer.alloc(1000)),/caller_audio_silent/);
 assert.throws(()=>managedSpeechEndByte(Buffer.alloc(999)),/pcm_boundary/);
});
test('unknown event fields cannot inflate exported event names or reveal a URL',()=>{
 const recorder=createManagedRecorder(()=>1);recorder.event({type:'SECRET_CANARY'.repeat(1000),url:'https://secret.example/token'});
 assert.equal(recorder.events[0].type,'other');assert.doesNotMatch(JSON.stringify(recorder.events),/SECRET_CANARY|secret\.example/);
});
test('a later ASR segment resets accepted first-audio timing and keeps raw history',()=>{
 let time=100;const recorder=createManagedRecorder(()=>time++);recorder.event(metadata);recorder.begin({text:'multi segment'});
 recorder.event({type:'user_transcript',user_transcription_event:{user_transcript:'First segment'}});
 recorder.event(response('First reply'));const first=audio(1);recorder.event(first.event,first.bytes);
 assert.ok(recorder.turns[0].firstAudioAt);
 recorder.event({type:'user_transcript',user_transcription_event:{user_transcript:'Second segment'}});
 assert.equal(recorder.turns[0].firstAudioAt,null);assert.equal(recorder.turns[0].acceptedAudioBytes,0);assert.equal(recorder.chunks.length,1);
});

test('fixed session deadline spans successive waits and cannot reset per turn',async()=>{
 const runner=await import(runnerUrl),{setTimeout:sleep}=await import('node:timers/promises');
 // V1 had only a fresh 75s limit per wait. This fallback replays that missing
 // session guard; scaled waits exceed the session cap while each wait succeeds.
 const scope=runner.createManagedDeadline?.({endAt:Date.now()+80,code:'managed_session_deadline'})||{sleep:ms=>sleep(ms),dispose(){}};
 let caught;try{await scope.sleep(45);await scope.sleep(45);}catch(e){caught=e;}finally{scope.dispose();}
 assert.equal(caught?.code,'managed_session_deadline','successive individually bounded waits must abort at the original session deadline');
});
test('long subprocess cannot postpone the timer which terminates a paid socket',async()=>{
 const runner=await import(runnerUrl),{execFileSync}=await import('node:child_process'),{setTimeout:sleep}=await import('node:timers/promises');
 const started=Date.now();let closedAt=null;const closeTimer=setTimeout(()=>{closedAt=Date.now();},40);
 const scope=runner.createManagedDeadline?.({endAt:started+40,code:'managed_aggregate_deadline'})||{signal:undefined,dispose(){}};
 let caught;try{
  if(runner.runManagedSubprocess)await runner.runManagedSubprocess(process.execPath,['-e','setTimeout(()=>{},240)'],{scope,maxMs:1000});
  else execFileSync(process.execPath,['-e','setTimeout(()=>{},240)']);
 }catch(e){caught=e;}finally{await sleep(1);clearTimeout(closeTimer);scope.dispose();}
 assert.ok(closedAt-started<180,'synchronous process blocked the socket termination timer past its deadline');
 assert.equal(caught?.code,'managed_aggregate_deadline','deadline must abort and kill the subprocess');
});

test('session expiry requests socket close even when no caller wait is running',async()=>{
 const {createManagedDeadline,createManagedSessionDeadline}=await import(runnerUrl);
 const run=createManagedDeadline({endAt:Date.now()+500,code:'managed_aggregate_deadline'});let closed=0;
 const session=createManagedSessionDeadline(run,{sessionMs:30,onExpire:()=>{closed++;}});
 try{await assert.rejects(session.sleep(200),e=>e.code==='managed_session_deadline');assert.equal(closed,1);assert.ok(session.deadline<=run.deadline);}finally{session.dispose();run.dispose();}
});
test('aggregate expiry aborts session and subprocess and preserves its distinct reason',async()=>{
 const {createManagedDeadline,createManagedSessionDeadline,runManagedSubprocess}=await import(runnerUrl);
 const run=createManagedDeadline({endAt:Date.now()+40,code:'managed_aggregate_deadline'});let closed=0;
 const session=createManagedSessionDeadline(run,{sessionMs:500,onExpire:reason=>{assert.equal(reason.code,'managed_aggregate_deadline');closed++;}});
 try{await assert.rejects(runManagedSubprocess(process.execPath,['-e','setTimeout(()=>{},500)'],{scope:session}),e=>e.code==='managed_aggregate_deadline');assert.equal(closed,1);assert.ok(session.deadline<=run.deadline);}finally{session.dispose();run.dispose();}
});
test('caller audio is completely prepared before any managed socket construction',async()=>{
 const {createManagedDeadline,prepareManagedCallerAudio}=await import(runnerUrl);
 const run=createManagedDeadline({endAt:Date.now()+500,code:'managed_aggregate_deadline'}),calls=[],pcm=Buffer.alloc(2000,1);
 try{const prepared=await prepareManagedCallerAudio(fixture.scenarios[0],{scope:run,process:async(file,args,options)=>{calls.push({file,args,scope:options.scope});return file==='espeak-ng'?Buffer.alloc(2000,1):pcm;}});assert.equal(prepared.length,5);assert.equal(calls.length,15);assert.ok(calls.every(c=>c.scope===run));}finally{run.dispose();}
 const managed=source.slice(source.indexOf('async function runManagedDemo'));
 assert.doesNotMatch(managed,/execFileSync\(/);
 assert.ok(managed.indexOf('await prepareManagedCallerAudio')<managed.indexOf('socket=new WebSocket'));
});
test('deadline kills a child which ignores SIGTERM, rather than only rejecting its promise',async()=>{
 const {createManagedDeadline,runManagedSubprocess}=await import(runnerUrl),{mkdtemp,access,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{setTimeout:sleep}=await import('node:timers/promises');
 const dir=await mkdtemp(join(tmpdir(),'maya-managed-kill-')),flag=join(dir,'should-not-exist');
 const scope=createManagedDeadline({endAt:Date.now()+50,code:'managed_aggregate_deadline'});
 try{await assert.rejects(runManagedSubprocess(process.execPath,['-e','process.on("SIGTERM",()=>{});setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"still alive"),200);setTimeout(()=>{},500);',flag],{scope}),e=>e.code==='managed_aggregate_deadline');await sleep(240);await assert.rejects(access(flag));}finally{scope.dispose();await rm(dir,{recursive:true,force:true});}
});
test('customer no-send preferences do not certify all other potential notification recipients',async()=>{
 const {readManagedNoOutboundGate}=await import(runnerUrl);const calls=[];
 const receipt=await readManagedNoOutboundGate({settings:{bindings:[]},customerId:'owned-test-customer',query:async sql=>{calls.push(sql);return sql.includes('communication_preferences')?[{service_updates:0,marketing:0}]:[{channel:'all',adapter_name:'sandbox_simulator',status:'sandbox_ready',credentials_status:'not_required',environment:'sandbox'}];}});
 assert.equal(receipt.callerNoSendVerified,true);assert.equal(receipt.allowed,false);assert.equal(receipt.allPotentialRecipientsVerified,false);
 assert.ok(receipt.potentialRecipientClasses.includes('staff'));assert.ok(receipt.potentialRecipientClasses.includes('caregiver'));
 assert.ok(receipt.gates.includes('all_potential_notification_recipients_not_attested_by_existing_read_routes'));
 assert.ok(calls.every(sql=>sql.startsWith('SELECT ')));
 const managed=source.slice(source.indexOf('async function runManagedDemo'));
 assert.ok(managed.indexOf('report.noOutbound=await readManagedNoOutboundGate')<managed.indexOf("app({action:'start'"));
 assert.ok(managed.indexOf('report.noOutbound=await readManagedNoOutboundGate')<managed.indexOf('get-signed-url'));
});
test('pre-execution notification read failure remains unrun and does not fabricate coverage',async()=>{
 const {readManagedNoOutboundGate}=await import(runnerUrl);
 const receipt=await readManagedNoOutboundGate({settings:{bindings:[]},customerId:'owned-test-customer',query:async()=>{throw Object.assign(Error('SECRET_CANARY'),{code:'managed_d1_read_denied:communication_preferences'});}});
 assert.equal(receipt.allowed,false);assert.equal(receipt.allPotentialRecipientsVerified,false);
 assert.deepEqual(receipt.gates,['managed_d1_read_denied:communication_preferences']);assert.doesNotMatch(JSON.stringify(receipt),/SECRET_CANARY/);
});

test('expired cleanup retains all turns raw audio before skipping every conversion',async()=>{
 const {createManagedDeadline,writeManagedAudio}=await import(runnerUrl),{mkdtemp,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'maya-managed-retain-')),scope=createManagedDeadline({endAt:Date.now()-1,code:'managed_aggregate_deadline'});
 try{
  assert.throws(()=>scope.check(),/managed_aggregate_deadline/);
  const pcm=Buffer.alloc(2000,1),recorder={outputFormat:'pcm_16000',turns:[{inputPcm:pcm,inputSentBytes:2000},{inputPcm:pcm,inputSentBytes:1000}],chunks:[{turn:0,cancelled:false,bytes:pcm},{turn:1,cancelled:true,bytes:pcm}]};
  const capture=await writeManagedAudio(dir,recorder,scope);
  assert.equal(capture.conversionGate,'managed_aggregate_deadline');
  assert.deepEqual(capture.artifacts.map(a=>a.path),['turn-1-caller.pcm','turn-1-agent.raw','turn-2-caller.pcm','turn-2-agent.raw']);
  assert.equal((await readFile(join(dir,'turn-2-caller.pcm'))).length,1000);assert.equal((await readFile(join(dir,'turn-2-agent.raw'))).length,2000);
 }finally{scope.dispose();await rm(dir,{recursive:true,force:true});}
});

test('managed job leaves setup and artifact-upload allowance outside unchanged runner caps',()=>{
 const job=workflow.split('  demo-three-voice-conversations:\n')[1]?.split('\n  diagnose-native-audio:')[0];
 assert.ok(job,'exact managed job must be present');
 const timeout=job.match(/^    timeout-minutes:\s*(.+)$/m)?.[1];
 const conditional=timeout?.match(/^\$\{\{ inputs\.confirm == 'demo-five-sales-conversations' && (\d+) \|\| (\d+) \}\}$/);
 assert.ok(conditional,'managed mode needs a separate conditional job allowance for checkout, tests, tools, cleanup and upload');
 const managedMinutes=Number(conditional[1]),legacyMinutes=Number(conditional[2]);
 assert.equal(managedMinutes,25);assert.equal(legacyMinutes,12);
 assert.equal(MANAGED_DEMO_LIMITS.aggregateMs,720000);assert.equal(MANAGED_DEMO_LIMITS.sessionMs,120000);
 assert.ok(managedMinutes*60000>=MANAGED_DEMO_LIMITS.aggregateMs+10*60000,'job allowance must leave at least ten minutes outside the runner ceiling');
 assert.match(job,/if: \$\{\{ always\(\) \}\}/);
 assert.match(job,/uses: actions\/upload-artifact@v4/);
});

test('dollar guard reserves the full server duration at burst rate, not the local socket deadline',async()=>{
 const runner=await import(runnerUrl);assert.equal(typeof runner.managedSessionCostBound,'function');
 const b=runner.managedSessionCostBound({config:{conversation_config:{conversation:{max_duration_seconds:600},tts:{model_id:'eleven_v3_conversational'}}},budget:{runtime:{provider:'openai',model:'gpt-5.6-luna'}}});
 assert.equal(b.speech.maximumBilledSeconds,600);assert.equal(b.speech.reservedMicros,1600000);
 assert.equal(b.speech.localDisconnectDiscountApplied,false);assert.equal(b.upperBoundMicros,null);
 assert.ok(b.gates.includes('managed_model_attempt_upper_bound_not_enforced'));
 assert.equal(b.model.maximumInputTokensPerAttempt,1050000);assert.equal(b.model.maximumOutputTokensPerAttempt,8000);
});
test('unknown model attempt costs block before any reservation can authorize execution',async()=>{
 const runner=await import(runnerUrl);assert.equal(typeof runner.createManagedRunBudget,'function');
 const ledger=runner.createManagedRunBudget();let started=0;
 assert.throws(()=>{ledger.reserve({upperBoundMicros:null,gates:['managed_model_attempt_upper_bound_not_enforced']});started++;},/managed_run_cost_upper_bound_unknown/);
 assert.equal(started,0);assert.deepEqual(ledger.receipt(),{capMicros:5000000,reservedMicros:0,remainingMicros:5000000,reservations:[]});
});
test('aggregate pre-execution reservations refuse the next session and never refund from local close or actual usage',async()=>{
 const runner=await import(runnerUrl);assert.equal(typeof runner.createManagedRunBudget,'function');const ledger=runner.createManagedRunBudget();
 // Offline verified-bound fixtures exercise arithmetic only; they do not attest the hosted runtime.
 ledger.reserve({upperBoundMicros:2400000,gates:[]},'first');ledger.reserve({upperBoundMicros:2400000,gates:[]},'second');
 assert.throws(()=>ledger.reserve({upperBoundMicros:2400000,gates:[]},'third'),/managed_run_budget_insufficient/);
 assert.equal(ledger.receipt().remainingMicros,200000);assert.equal(ledger.refund,undefined);
 assert.throws(()=>ledger.reserve({upperBoundMicros:-1,gates:[]}),/managed_run_cost_upper_bound_unknown/);
 assert.throws(()=>ledger.reserve({upperBoundMicros:1.5,gates:[]}),/managed_run_cost_upper_bound_unknown/);
});
test('unknown duration, voice model, runtime model and enabled cost uncertainty remain gated',async()=>{
 const runner=await import(runnerUrl);assert.equal(typeof runner.managedSessionCostBound,'function');
 const config={conversation_config:{conversation:{max_duration_seconds:600},tts:{model_id:'eleven_v3_conversational'}}},budget={runtime:{provider:'openai',model:'gpt-5.6-luna'}};
 for(const seconds of [undefined,NaN,0,7201]){const c=clone(config);c.conversation_config.conversation.max_duration_seconds=seconds;assert.ok(runner.managedSessionCostBound({config:c,budget}).gates.includes('managed_server_duration_unknown'));}
 const c=clone(config);c.conversation_config.tts.model_id='unknown';assert.ok(runner.managedSessionCostBound({config:c,budget}).gates.includes('managed_speech_rate_unknown'));
 const b=clone(budget);b.runtime.model='unknown';assert.ok(runner.managedSessionCostBound({config,budget:b}).gates.includes('managed_model_rate_unknown'));
 assert.equal(runner.managedSessionCostBound({config,budget}).model.inputMicrosPerMillion,500000);
 assert.equal(runner.managedSessionCostBound({config,budget}).model.outputMicrosPerMillion,1800000);
});
test('Grooming-first selection retains the reviewed conversation and does not require Taxi',async()=>{
 const runner=await import(runnerUrl);assert.equal(typeof runner.selectManagedCases,'function');
 const cases=assertManagedCases(fixture);assert.deepEqual(runner.selectManagedCases(cases),[cases[0]]);
 assert.equal(runner.selectManagedCases(cases,'five-enquiries').length,5);
 assert.deepEqual(runner.selectManagedCases(cases,'readiness-only'),[]);
 assert.throws(()=>runner.selectManagedCases(cases,'unknown'),/managed_scope_unknown/);
});
test('readiness-only collects existing SELECT-only isolation and dollar receipts before paid-session gates',()=>{
 const managed=source.slice(source.indexOf('async function runManagedDemo'));
 assert.match(managed,/report\.runBudgetBound=managedSessionCostBound/);
 assert.match(managed,/scope==='readiness-only'/);
 assert.ok(managed.indexOf('report.noOutbound=await readManagedNoOutboundGate')<managed.indexOf("if(!budget.allowed)"));
 assert.ok(managed.indexOf('runBudget.reserve(')<managed.indexOf("app({action:'start'"));
 assert.match(workflow,/managed_audio_scope:/);assert.match(workflow,/MANAGED_DEMO_SCOPE:/);
});
test('cost evidence expires and billed-duration rounding remains conservative',async()=>{
 const {managedSessionCostBound}=await import(runnerUrl),config={conversation_config:{conversation:{max_duration_seconds:601},tts:{model_id:'eleven_v3_conversational'}}},budget={runtime:{provider:'openai',model:'gpt-5.6-luna'}};
 const b=managedSessionCostBound({config,budget,now:Date.parse('2026-10-02T12:00:00Z')});assert.equal(b.speech.reservedMicros,1760000);assert.equal(b.model.maximumPerAttemptMicros,539400);
 for(const now of [NaN,Date.parse('2026-10-01T12:00:00Z'),Date.parse('2026-10-03T00:00:00Z')])assert.ok(managedSessionCostBound({config,budget,now}).gates.includes('managed_rate_evidence_expired_or_invalid'));
});
