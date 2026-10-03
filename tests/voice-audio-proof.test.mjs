import {describe} from 'node:test';
import net from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEMO_LIMITS,DEMO_SUMMARY_PATH,readDemoJson,validateDemoIdentifier,validateDemoContext,validateDemoSignedUrl,actionsMaskCommand,createDemoEventBoundary,demoArtifactPaths,validatedDemoReport,serializeDemoReport,serializeDemoSummary} from '../scripts/voice-demo-output-boundary.mjs';
import {assertFinalConversation,verifyFinalConversation} from '../scripts/voice-final-conversation-proof.mjs';
import {inspect} from 'node:util';
import test from 'node:test';import assert from 'node:assert/strict';
import {greetingPlaybackFinished,applyAudioProbeEvent,audioEventKind,audioFormat,audioProbeComplete,audioProof,audioProofChecks,createAudioProbeState,isHandoffReply} from '../scripts/voice-audio-proof.mjs';
import {installAiHooks,freshUatAiDb,seedCustomer,inboundMessage,applyOwnedDdl,stubFetch} from './helpers/ai-harness.mjs';
import {runWithWorkersDb} from './helpers/module-hooks.mjs';
import {VOICE_DEMO_SCENARIOS,assertDemoResponse,assertDemoRuntimePhonePause} from '../scripts/voice-demo-scenarios.mjs';
installAiHooks();
const responsesRoute=await import('../app/api/elevenlabs/v1/responses/route.ts');
const valid={transcript:'What grooming services do you offer for my dog Bruno?',reply:'We offer Essential Bath grooming for dogs. Would you like to hear more?',audioBytes:16000,nonSilentBytes:9000};
test('audio proof requires recognized request, substantive response and non-silent audio',()=>{
 assert.equal(audioProof(valid),true);
 for(const change of [{transcript:''},{transcript:'Hello'},{reply:'One moment while I check that for you.'},{reply:'This conversation is waiting for a PawSpace team member.'},{audioBytes:0},{nonSilentBytes:0}])assert.equal(audioProof({...valid,...change}),false);
});
test('three demos reject the observed silent-call failure and require scenario-specific responses',()=>{
 const replies=['We offer grooming and bath packages for your dog Bruno.','Please contact a veterinarian before grooming Bruno with itchy skin.','I can check approved coupons and explain booking; nothing is booked yet.'];
 for(const [index,scenario] of VOICE_DEMO_SCENARIOS.entries()){
  const state={transcript:scenario.text,reply:replies[index],audioBytes:16000,nonSilentBytes:8000,replyInterrupted:false};
  assert.equal(assertDemoResponse(scenario,state),true);
  for(const change of [{audioBytes:0,nonSilentBytes:0},{replyInterrupted:true},{transcript:'Hello'},{reply:'This conversation is waiting for a PawSpace team member.'}])assert.throws(()=>assertDemoResponse(scenario,{...state,...change}));
 }
 assert.throws(()=>assertDemoResponse(VOICE_DEMO_SCENARIOS[1],{transcript:VOICE_DEMO_SCENARIOS[1].text,reply:'You should give your dog 10 mg now rather than contacting a vet.',audioBytes:16000,nonSilentBytes:8000}),/Unsafe clinical/);
});
test('agent audio format controls pacing and encoded silence',()=>{
 assert.deepEqual(audioFormat('pcm_16000'),{rate:16000,bytesPerSample:2,silence:0});assert.deepEqual(audioFormat('ulaw_8000'),{rate:8000,bytesPerSample:1,silence:255});assert.throws(()=>audioFormat('mp3_44100'));
});
const pcm=(bytes,fill=7)=>Buffer.alloc(bytes,fill).toString('base64');
function replay(events,{outputFormat='pcm_16000'}={}){
 const s=createAudioProbeState(),changes=[];let now=0;
 for(const e of events){now+=100;if(e.listen)s.listening=true;else changes.push(applyAudioProbeEvent(s,e,{now,outputFormat}));}
 return {s,now,changes};
}
const greetingText='Hi, this is Amaya from PawSpace.';
const greeting=[{type:'agent_response',agent_response_event:{agent_response:greetingText}},{type:'audio',audio_event:{event_id:1,audio_base_64:pcm(4000)}},{listen:true}];
const asked={type:'user_transcript',user_transcription_event:{user_transcript:'What grooming services do you offer for my dog Bruno?'}};
const reply='One moment while I check that for you. Yes. We offer doorstep grooming for Bruno, including Essential Bath at 1,349 rupees.';
test('finish predicate completes after reply audio settles when the greeting was interrupted and corrected',()=>{
 const {s,now,changes}=replay([...greeting,
  {type:'interruption',interruption_event:{event_id:1}},
  {type:'agent_response_correction',agent_response_correction_event:{original_agent_response:greetingText,corrected_agent_response:'Hi, this is'}},
  asked,
  {type:'audio',audio_event:{event_id:1,audio_base_64:pcm(3200)}},
  {type:'agent_response',agent_response_event:{agent_response:reply}},
  {type:'audio',audio_event:{event_id:2,audio_base_64:pcm(32000)}}]);
 assert.deepEqual(changes,['greeting',null,'interruption',null,'transcript','cancelled-audio','reply','audio']);
 assert.equal(s.reply,reply);assert.equal(s.audioBytes,32000);
 assert.equal(audioProbeComplete(s,now+1000),false,'waits while reply audio may still be streaming');
 assert.equal(audioProbeComplete(s,now+2600),true);
});
test('interrupted reply is judged on the corrected text actually spoken, and cancelled audio is never waited for',()=>{
 const base=[...greeting,asked,{type:'agent_response',agent_response_event:{agent_response:reply}},{type:'audio',audio_event:{event_id:2,audio_base_64:pcm(32000)}},{type:'interruption',interruption_event:{event_id:2}}];
 const spoken=replay([...base,{type:'agent_response_correction',agent_response_correction_event:{original_agent_response:reply,corrected_agent_response:'One moment while I check that for you. Yes. We offer doorstep grooming for Bruno'}},
  {type:'audio',audio_event:{event_id:2,audio_base_64:pcm(64000)}}]);
 assert.deepEqual(spoken.changes.slice(-2),['correction','cancelled-audio']);
 assert.equal(spoken.s.audioBytes,32000,'cancelled audio is not counted');
 assert.equal(spoken.s.lastAudio,spoken.now-300,'cancelled audio does not extend the settle window');
 assert.equal(audioProbeComplete(spoken.s,spoken.now+60000),false);
 const cutEarly=replay([...base,{type:'agent_response_correction',agent_response_correction_event:{original_agent_response:reply,corrected_agent_response:'One moment while I check that for you.'}}]);
 assert.equal(cutEarly.s.reply,'One moment while I check that for you.');
 assert.equal(audioProofChecks(cutEarly.s).substantiveReply,false);
 assert.equal(audioProbeComplete(cutEarly.s,cutEarly.now+5000),false,'a reply interrupted before any answer is not proof');
});
test('ASR proof stays strict: the CI transcript without "grooming" never completes and names the missing proof',()=>{
 const {s,now}=replay([...greeting,{type:'user_transcript',user_transcription_event:{user_transcript:'Do you offer for my dog, Bruno?'}},
  {type:'agent_response',agent_response_event:{agent_response:reply}},{type:'audio',audio_event:{event_id:2,audio_base_64:pcm(32000)}}]);
 assert.deepEqual(audioProofChecks(s),{asrGrooming:false,asrBruno:true,substantiveReply:true,noHandoff:true,audio:true,nonSilentAudio:true});
 assert.equal(audioProbeComplete(s,now+60000),false);
});
test('a later recognised segment joins the transcript and supersedes the earlier reply and its audio',()=>{
 const {s,now}=replay([...greeting,{type:'user_transcript',user_transcription_event:{user_transcript:'What grooming services'}},
  {type:'agent_response',agent_response_event:{agent_response:'We offer several grooming services. Which one would you like?'}},{type:'audio',audio_event:{event_id:2,audio_base_64:pcm(32000)}},
  {type:'user_transcript',user_transcription_event:{user_transcript:'do you offer for my dog Bruno?'}},{type:'user_transcript',user_transcription_event:{user_transcript:'  '}}]);
 assert.equal(s.transcript,'What grooming services do you offer for my dog Bruno?');assert.equal(s.reply,'');assert.equal(s.audioBytes,0);
 assert.equal(audioProbeComplete(s,now+5000),false);
});
test('speech before the caller fixture starts, audio before recognition and handoff replies are not proof',()=>{
 const early=replay([{type:'agent_response',agent_response_event:{agent_response:'Hi'}},{type:'user_transcript',user_transcription_event:{user_transcript:'grooming for Bruno'}}]);
 assert.equal(early.s.transcript,'');
 assert.equal(replay([...greeting,{type:'audio',audio_event:{event_id:2,audio_base_64:pcm(32000)}}]).s.audioBytes,0);
 assert.equal(isHandoffReply('This conversation is waiting for a PawSpace team member.'),true);assert.equal(isHandoffReply(reply),false);
});
test('socket event types are counted only under allowlisted names',()=>{
 for(const t of ['audio','interruption','agent_response_correction','user_transcript','ping'])assert.equal(audioEventKind(t),t);
 for(const t of ['__proto__','constructor','prototype','toString','audio\n::error::x',undefined,null,{},42])assert.equal(audioEventKind(t),'other');
});
/* The probe must never pass a turn in which the real voice runtime handed off to staff. These run the
 * product's own ElevenLabs custom-LLM route through both handoff paths - the orchestrator's handoff
 * for an unclassifiable turn and the governed staff pause - and judge the words it actually speaks. */
const LLM_SECRET='test-only-llm-secret';
async function spokenHandoff(t,{staffPause,rolloutBlocked=false}){
 const w=freshUatAiDb({ELEVENLABS_API_KEY:'test-only-elevenlabs',ELEVENLABS_AGENT_ID:'agent-test',ELEVENLABS_LLM_SECRET:LLM_SECRET,PAWSPACE_UAT_LOGIN:'on',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'test-only-openai'});
 t.after(()=>w.sqlite.close());globalThis.__PAWSPACE_TEST_ENV__={...globalThis.__PAWSPACE_TEST_ENV__,DB:w.db};
 seedCustomer(w.sqlite,'CUS-AUDIO-PROOF','Synthetic Tester','9876500093');
 await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-AUDIO-PROOF',customerId:'CUS-AUDIO-PROOF',text:'synthetic fixture',channel:'voice',idempotencyKey:'audio-proof-fixture'});
 const {ensureAiConversationOrchestrator}=await import('../lib/ai-conversation-orchestrator.ts');await ensureAiConversationOrchestrator(w.db);
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 const {setAiRolloutStage}=await import('../lib/ai-audience-rollout.ts');
 await setAiRolloutStage(w.db,{stage:rolloutBlocked?'staff_only':'customers',reason:'synthetic UAT customer audio proof handoff',actorEmail:'test@pawspace.test'});
 if(staffPause){const {requestAiHumanHandoff}=await import('../lib/ai-human-handoff.ts');await requestAiHumanHandoff(w.db,{threadId:'THREAD-AUDIO-PROOF',customerId:'CUS-AUDIO-PROOF',reason:'low_confidence',actorEmail:'test@pawspace.test'});}
 const mock=stubFetch(()=>{throw new Error('a handoff turn must not call the provider');});t.after(()=>mock.restore());
 const input=staffPause?'What grooming services do you offer for my dog Bruno?':'I want for tomorrow at 11:00 AM.';
 const request=new Request('https://pawspace-staging-gateway.test/api/elevenlabs/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+LLM_SECRET},body:JSON.stringify({input,elevenlabs_extra_body:{pawspace_customer_id:'CUS-AUDIO-PROOF',pawspace_thread_id:'THREAD-AUDIO-PROOF'}})});
 const sse=await runWithWorkersDb(w.db,async()=>(await responsesRoute.POST(request)).text());
 const events=sse.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
 assert.equal(events.at(-1)?.type,'response.completed');assert.equal(mock.calls.length,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs WHERE status='queued'").get().n,rolloutBlocked?0:1,'handoff state matches the exercised path');
 return events.filter(e=>e.type==='response.output_text.delta').map(e=>e.delta).join('');
}
for(const [name,staffPause] of [['orchestrator handoff',false],['staff pause',true]])test(`the audio proof rejects the real ${name} reply the voice runtime speaks`,async t=>{
 const spoken=await spokenHandoff(t,{staffPause});
 assert.ok(spoken.length>20,spoken);
 assert.equal(isHandoffReply(spoken),true,spoken);
 assert.equal(audioProof({...valid,reply:spoken}),false);
 const {s,now}=replay([...greeting,asked,{type:'agent_response',agent_response_event:{agent_response:spoken}},{type:'audio',audio_event:{event_id:2,audio_base_64:pcm(32000)}}]);
 assert.equal(audioProbeComplete(s,now+5000),false);
});

test('caller waits for greeting playback duration as well as stream silence',()=>{
 const greeting={firstAudioAt:1000,lastAudioAt:1200,bytes:128000,format:'pcm_16000'};
 assert.equal(greetingPlaybackFinished({...greeting,now:3000}),false);
 assert.equal(greetingPlaybackFinished({...greeting,now:5749}),false);
 assert.equal(greetingPlaybackFinished({...greeting,now:5750}),true);
 assert.equal(greetingPlaybackFinished({...greeting,now:6000,lastAudioAt:5900}),false);
 assert.equal(greetingPlaybackFinished({...greeting,now:6000,bytes:0}),false);
});

test('non-dialing demos verify encrypted phone controls through runtime truth, never binding-name guesses',()=>{
 const vars={PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_VOICE_NATIVE_UAT_APPROVED:'false',PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED:'false',PAWSPACE_VOICE_UAT_AUTORUN:'false'};
 const gate={mode:'disabled',enabled:false,uatApproved:false,salesOutboundApproved:false};
 assert.equal(assertDemoRuntimePhonePause(vars,gate),true);
 for(const change of [{mode:'uat'},{enabled:true},{uatApproved:true},{salesOutboundApproved:true},{enabled:undefined}])assert.throws(()=>assertDemoRuntimePhonePause(vars,{...gate,...change}),/shutdown/);
 assert.throws(()=>assertDemoRuntimePhonePause(vars,undefined),/shutdown/);
 for(const name of Object.keys(vars))assert.throws(()=>assertDemoRuntimePhonePause({...vars,[name]:name==='PAWSPACE_VOICE_PHONE_TESTS_PAUSED'?'false':'true'},gate),/phone stop/);
});
test('audio proof rejects the real rollout refusal without inventing a queued handoff',async t=>{
 const spoken=await spokenHandoff(t,{staffPause:false,rolloutBlocked:true});
 assert.match(spoken,/team needs to help.*no live transfer has been made/);
 assert.doesNotMatch(spoken,/queued|nobody has joined/i);
 assert.equal(audioProofChecks({...valid,reply:spoken}).substantiveReply,false);
 assert.equal(audioProof({...valid,reply:spoken}),false);
});
test('controlled fallback, unavailable and emergency replies cannot certify substantive grooming audio',()=>{
 for(const reply of [
  'AI voice cannot continue this conversation right now. Please contact the PawSpace team for help.',
  'Customer AI voice is unavailable at the current rollout stage',
  'AI replies are paused while the conversation is owned by staff',
  'PawSpace custom LLM failed safely',
  'Please contact your nearest emergency vet immediately.',
  'One moment while I check that for you. I’m routing this conversation to a PawSpace team member so it can be handled safely.'
 ]){
  const checks=audioProofChecks({...valid,reply});
  assert.equal(checks.substantiveReply,false,reply);
  assert.equal(checks.noHandoff,false,reply);
  assert.equal(audioProof({...valid,reply}),false,reply);
 }
 assert.equal(audioProof(valid),true,'a genuine answer remains eligible with audio evidence');
});

test('useful answers with incidental support advice remain eligible task-answer evidence',()=>{
 for(const reply of [
  'We offer Essential Bath grooming for Bruno. Please contact the PawSpace team for help with special requests.',
  'We offer Essential Bath grooming for Bruno. If AI voice cannot continue this conversation later, please contact support.',
  'One moment while I check that for you. We offer Essential Bath grooming for Bruno. If your pet is struggling to breathe, contact your nearest emergency vet immediately.'
 ])assert.equal(audioProof({...valid,reply}),true,reply);
 // A safe emergency response can be the correct outcome while not proving the requested grooming answer.
 const emergency="Please don't wait for a response here — contact your nearest emergency vet immediately. PawSpace chat cannot diagnose or treat your pet. No call, booking or dispatch has been made by this reply.";
 assert.equal(audioProofChecks({...valid,reply:emergency}).audio,true);
 assert.equal(audioProofChecks({...valid,reply:emergency}).substantiveReply,false);
});

test('call handoff wording is controlled while incidental support advice is a useful answer',()=>{
 for(const reply of ["I’m routing this call to a PawSpace team member.","I'm routing this call to a PawSpace team member.","One moment while I check that for you. I’m routing this call to a PawSpace team member."]){
  assert.equal(isHandoffReply(reply),true,reply);assert.equal(audioProof({...valid,reply}),false,reply);
 }
 assert.equal(audioProof({...valid,reply:'We offer Essential Bath for Bruno. If you need help, a PawSpace team member can assist.'}),true);
});

// Network-derived demo metadata and artifacts share the audio proof boundary.
describe('bounded demo output security',()=>{
test.beforeEach(t=>{
 const deny=()=>{throw Error('External network is forbidden in demo output fixtures');};
 t.mock.method(globalThis,'fetch',deny);
 t.mock.method(net.Socket.prototype,'connect',deny);
});
const metadata=id=>({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{conversation_id:id,user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_24000'}});
const audio=bytes=>({type:'audio',audio_event:{audio_base_64:bytes.toString('base64'),event_id:1}});
const parse=(boundary,event)=>boundary.parse(JSON.stringify(event));
const proof={passed:true,userTurns:1,finalTranscriptMatched:true,bidirectionalAudio:true,audioEvidence:'observed_live_stream'};
const report=(scenario='grooming_enquiry')=>({scenario,transcript:'What grooming services do you offer?',reply:'PawSpace grooming includes brushing and a bath.',audioBytes:3200,nonSilentBytes:1600,inputToPlaybackCompletedMs:4000,proof});

test('provider metadata rejects workflow control characters before it can become a mask command',()=>{
 for(const id of ['conv_ok\n::error::injected','conv_ok\r::stop-commands::token','conv_ok\0hidden','conv_%0Ainjected','../outside',{},'x'.repeat(129),'']){
  assert.throws(()=>parse(createDemoEventBoundary(),metadata(id)),/Invalid demo identifier/);
 }
 const {event}=parse(createDemoEventBoundary(),metadata('conv_fixture-123'));
 assert.equal(actionsMaskCommand(event.conversation_initiation_metadata_event.conversation_id),'::add-mask::conv_fixture-123');
 assert.equal(validateDemoIdentifier('CALL-123_ab'),'CALL-123_ab');
});

test('Actions command escaping turns malicious CR/LF/percent input into exactly one command',()=>{
 const malicious='conv%0A\r\n::warning::injected';
 const command=actionsMaskCommand(malicious);
 assert.equal(command,'::add-mask::conv%250A%0D%0A::warning::injected');
 assert.equal(command.split(/[\r\n]/).length,1);
 const decoded=command.slice('::add-mask::'.length).replace(/%0D/g,'\r').replace(/%0A/g,'\n').replace(/%25/g,'%');
 assert.equal(decoded,malicious,'the runner receives the original mask data without parsing a second command');
 assert.throws(()=>actionsMaskCommand('x'.repeat(8193)));
 assert.throws(()=>actionsMaskCommand({toString(){throw Error('must not coerce');}}));
});

test('context identifiers and signed socket URLs are validated before logging or socket construction',()=>{
 assert.deepEqual(validateDemoContext({callId:'CALL-fixture',threadId:'THREAD-fixture',ignored:'private'}),{callId:'CALL-fixture',threadId:'THREAD-fixture'});
 assert.throws(()=>validateDemoContext({callId:'CALL\n::error::bad',threadId:'THREAD-fixture'}));
 for(const host of ['api.elevenlabs.io','api.in.residency.elevenlabs.io']){
  const url=`wss://${host}/v1/convai/conversation?conversation_signature=fixture%2Bdata`;
  assert.equal(validateDemoSignedUrl(url),url);
  assert.equal(actionsMaskCommand(validateDemoSignedUrl(url)).includes('%252B'),true);
 }
 for(const url of ['wss://evil.example/v1/convai/conversation','https://api.elevenlabs.io/v1/convai/conversation','wss://api.elevenlabs.io/v1/other','wss://user:secret@api.elevenlabs.io/v1/convai/conversation','wss://api.elevenlabs.io:8080/v1/convai/conversation','wss://api.elevenlabs.io/v1/convai/conversation\n::error::bad','wss://api.elevenlabs.io/v1/convai/conversation#fragment'])assert.throws(()=>validateDemoSignedUrl(url));
});

test('artifact destinations are the exact three local scenario paths and reject arbitrary names',()=>{
 for(const scenario of VOICE_DEMO_SCENARIOS){
  assert.deepEqual(demoArtifactPaths(scenario.id),{raw:`voice-demo-results/${scenario.id}.raw`,wav:`voice-demo-results/${scenario.id}.wav`,failed:`voice-demo-results/${scenario.id}-failed.json`});
  assert.equal(Object.isFrozen(demoArtifactPaths(scenario.id)),true);
 }
 for(const id of ['../outside','grooming_enquiry/../../outside','grooming_enquiry\0','__proto__','constructor','pet_health.wav',{},null])assert.throws(()=>demoArtifactPaths(id));
 assert.equal(DEMO_SUMMARY_PATH,'voice-demo-results/conversations.json');
});

test('event size and structure are bounded before state processing',()=>{
 for(const raw of ['null','[]','42','{}','not json',Buffer.from('{}'),' '.repeat(DEMO_LIMITS.eventBytes+1)])assert.throws(()=>createDemoEventBoundary().parse(raw));
 const boundary=createDemoEventBoundary();
 for(let i=0;i<DEMO_LIMITS.eventCount;i++)parse(boundary,{type:'ping',ping_event:{event_id:i}});
 assert.throws(()=>parse(boundary,{type:'ping'}),/event count/);
});

test('audio requires canonical bounded base64 and a per-scenario cumulative byte ceiling',()=>{
 for(const value of ['',null,{},'!!!!','AA=A','AB==','AA==\n','A'.repeat(Math.ceil(DEMO_LIMITS.audioChunkBytes/3)*4+4)])assert.throws(()=>parse(createDemoEventBoundary(),{type:'audio',audio_event:{audio_base_64:value}}));
 const boundary=createDemoEventBoundary(),chunk=Buffer.alloc(DEMO_LIMITS.audioChunkBytes,1);
 for(let total=0;total<DEMO_LIMITS.audioBytes;total+=chunk.length)assert.deepEqual(parse(boundary,audio(chunk)).audio,chunk);
 assert.throws(()=>parse(boundary,audio(Buffer.from([1]))),/cumulative audio/);
});

test('transcript aggregation and reply/correction text cannot make unbounded state or reports',()=>{
 const boundary=createDemoEventBoundary();
 const segment='a'.repeat(DEMO_LIMITS.textBytes/2-1);
 parse(boundary,{type:'user_transcript',user_transcription_event:{user_transcript:segment}});
 parse(boundary,{type:'user_transcript',user_transcription_event:{user_transcript:segment}});
 assert.throws(()=>parse(boundary,{type:'user_transcript',user_transcription_event:{user_transcript:'x'}}),/cumulative transcript/);
 for(const event of [{type:'agent_response',agent_response_event:{agent_response:'x'.repeat(DEMO_LIMITS.textBytes+1)}},{type:'agent_response_correction',agent_response_correction_event:{original_agent_response:'original',corrected_agent_response:'🐾'.repeat(DEMO_LIMITS.textBytes/4+1)}}])assert.throws(()=>parse(createDemoEventBoundary(),event));
});

test('metadata audio formats retain the original supported PCM and microphone constraints',()=>{
 const invalidOutput=metadata('conv_fixture');invalidOutput.conversation_initiation_metadata_event.agent_output_audio_format='pcm_999999';
 assert.throws(()=>parse(createDemoEventBoundary(),invalidOutput),/Unsupported agent audio format/);
 const invalidInput=metadata('conv_fixture');invalidInput.conversation_initiation_metadata_event.user_input_audio_format='pcm_48000';
 assert.throws(()=>parse(createDemoEventBoundary(),invalidInput),/microphone/);
});

test('bounded HTTP JSON refuses declared and received oversize and releases the reader',async()=>{
 assert.deepEqual(await readDemoJson(Response.json({ok:true})),{ok:true});
 let cancelled=false,pulls=0;
 const declared=new Response(new ReadableStream({pull(){pulls++;},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-length':String(DEMO_LIMITS.jsonBytes+1)}});
 await assert.rejects(readDemoJson(declared),/JSON response exceeded/);
 assert.equal(cancelled,true);assert.equal(pulls,0);assert.equal(declared.body.locked,false);
 cancelled=false;
 const received=new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(DEMO_LIMITS.jsonBytes+1));},cancel(){cancelled=true;return new Promise(()=>{});}}),{headers:{'content-length':'1'}});
 await assert.rejects(readDemoJson(received),/JSON response exceeded/);
 assert.equal(cancelled,true);assert.equal(received.body.locked,false);
 await assert.rejects(readDemoJson(new Response('not JSON')));
});

test('report validation keeps genuine evidence and excludes arbitrary provider metadata and claims',()=>{
 const input={...report(),dialed:true,carrierVerified:true,prompt:'untrusted prompt',file:'../../outside',proof:{...proof,secret:'untrusted'}};
 const result=JSON.parse(serializeDemoReport(input));
 assert.equal(result.reply,input.reply);assert.equal(result.transcript,input.transcript);
 assert.equal(result.prompt,VOICE_DEMO_SCENARIOS[0].text);
 assert.equal(result.dialed,false);assert.equal(result.carrierVerified,false);
 assert.equal('file' in result,false);assert.equal('secret' in result.proof,false);
 for(const override of [{scenario:'../outside'},{audioBytes:Infinity},{nonSilentBytes:5000},{inputToPlaybackCompletedMs:-1},{reply:'x'.repeat(DEMO_LIMITS.textBytes+1)},{proof:{...proof,userTurns:2}},{proof:{...proof,passed:false}}])assert.throws(()=>validatedDemoReport({...report(),...override}));
 const failed=JSON.parse(serializeDemoReport({...report(),passed:false,error:'fixture\n::error::metadata'}));
 assert.equal(failed.passed,false);assert.equal(failed.error,'fixture\n::error::metadata');
 assert.equal(JSON.stringify(failed).split('\n').length,1);
 assert.throws(()=>serializeDemoReport({...report(),passed:false,error:'x'.repeat(2049)}));
});

test('the summary requires exactly three successful fixed scenarios and stays byte-bounded after escaping',()=>{
 const reports=VOICE_DEMO_SCENARIOS.map(scenario=>report(scenario.id));
 const summary=JSON.parse(serializeDemoSummary(reports));
 assert.equal(summary.demonstrations.length,3);assert.equal(summary.nativeCarrierCertified,false);assert.equal(summary.dialed,false);
 assert.throws(()=>serializeDemoSummary(reports.slice(0,2)));
 assert.throws(()=>serializeDemoSummary([...reports].reverse()));
 assert.throws(()=>serializeDemoSummary(reports.map(item=>({...item,reply:'\0'.repeat(DEMO_LIMITS.textBytes)}))),/input bound/);
});

test('real probe and final-conversation proof preserve validated audio bytes and the three fixed artifacts offline',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'voice-demo-boundary-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await mkdir(join(directory,'voice-demo-results'));
 const reports=[];
 const replies=['PawSpace grooming includes a bath, brushing and coat care for Bruno.','Please contact a vet about Bruno’s itchy skin before booking grooming.','I can explain approved coupon checks and booking steps without booking anything.'];
 for(const [index,scenario] of VOICE_DEMO_SCENARIOS.entries()){
  const boundary=createDemoEventBoundary(),state=createAudioProbeState(),id=`conv_fixture_${index}`;
  const accept=event=>{const parsed=parse(boundary,event);applyAudioProbeEvent(state,parsed.event,{now:1000,outputFormat:'pcm_24000'});return parsed.audio;};
  accept(metadata(id));accept({type:'agent_response',agent_response_event:{agent_response:'Hello, this is PawSpace.'}});
  state.listening=true;
  accept({type:'user_transcript',user_transcription_event:{user_transcript:scenario.text}});
  accept({type:'agent_response',agent_response_event:{agent_response:replies[index]}});
  const bytes=Buffer.alloc(3200,7),validated=accept(audio(bytes));
  assertDemoResponse(scenario,state);
  const verified=assertFinalConversation({status:'done',conversation_id:id,agent_id:'agent_fixture',metadata:{text_only:false},transcript:[{role:'user',message:state.transcript},{role:'agent',message:state.reply}]},{agentId:'agent_fixture',turns:[{transcript:state.transcript,reply:state.reply}],liveAudioEvidence:{conversationId:id,inputMode:'audio',inputBytes:2000,outputBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,playbackComplete:true}});
  const result=validatedDemoReport({scenario:scenario.id,transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,inputToPlaybackCompletedMs:4000,proof:verified});
  await writeFile(join(directory,demoArtifactPaths(scenario.id).raw),validated);
  assert.deepEqual(await readFile(join(directory,demoArtifactPaths(scenario.id).raw)),bytes);
  reports.push(result);
 }
 await writeFile(join(directory,DEMO_SUMMARY_PATH),serializeDemoSummary(reports));
 const saved=JSON.parse(await readFile(join(directory,DEMO_SUMMARY_PATH),'utf8'));
 assert.equal(saved.passed,true);assert.equal(saved.demonstrations.every(item=>item.proof.finalTranscriptMatched),true);
 assert.equal(saved.nativeCarrierCertified,false);
});
test('malformed signed URLs expose only a generic error without their secret input or cause',()=>{
 const secret='test_token_test_token';
 for(const value of [`wss://[${secret}]/v1/convai/conversation`,`${secret}`,`wss://api.elevenlabs.io:${secret}/v1/convai/conversation`]){
  assert.throws(()=>validateDemoSignedUrl(value),error=>{
   assert.equal(error.message,'Invalid demo socket URL');
   assert.equal(Object.hasOwn(error,'input'),false);
   assert.equal(Object.hasOwn(error,'cause'),false);
   assert.equal(inspect(error,{showHidden:true,depth:null}).includes(secret),false);
   return true;
  });
 }
});

test('malformed event and HTTP JSON cannot reflect conversation IDs or tokens into diagnostics',async()=>{
 const id='conv_test_test_test';
 let eventError;
 try{createDemoEventBoundary().parse(id);}catch(error){eventError=error;}
 assert.equal(eventError?.message,'Invalid demo event JSON');
 assert.equal(inspect(eventError,{showHidden:true,depth:null}).includes(id),false);
 const secret='test_token_test_token';
 await assert.rejects(readDemoJson(new Response(secret)),error=>{
  assert.equal(error.message,'Invalid demo JSON response');
  assert.equal(inspect(error,{showHidden:true,depth:null}).includes(secret),false);
  const serialized=serializeDemoReport({...report(),passed:false,error:error.message});
  assert.equal(serialized.includes(secret),false);
  return true;
 });
});

test('validated conversation IDs remain in-memory proof correlation and stay out of exported reports',async t=>{
 const logged=[];
 t.mock.method(console,'log',(...args)=>logged.push(args));
 const {event}=parse(createDemoEventBoundary(),metadata('conv_test_test_test'));
 const conversationId=event.conversation_initiation_metadata_event.conversation_id;
 const input=report(),requests=[];
 const evidence={conversationId,inputMode:'audio',inputBytes:2000,outputBytes:input.audioBytes,nonSilentBytes:input.nonSilentBytes,playbackComplete:true};
 const detail={status:'done',conversation_id:conversationId,agent_id:'agent_fixture',metadata:{text_only:false},transcript:[{role:'user',message:input.transcript},{role:'agent',message:input.reply}]};
 const verified=await verifyFinalConversation({key:'fixture-key',conversationId,agentId:'agent_fixture',turns:[{transcript:input.transcript,reply:input.reply}],liveAudioEvidence:evidence,request:async(url,options)=>{
  requests.push({url,options});
  return Response.json(detail);
 }});
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`);
 assert.equal(verified.finalTranscriptMatched,true);
 assert.deepEqual(logged,[]);
 const saved=serializeDemoReport({...input,conversationId,conversation_id:conversationId,proof:{...verified,conversationId}});
 assert.equal(saved.includes(conversationId),false);
 const summary=serializeDemoSummary(VOICE_DEMO_SCENARIOS.map(scenario=>({...input,scenario:scenario.id,conversationId,proof:verified})));
 assert.equal(summary.includes(conversationId),false);
 assert.throws(()=>assertFinalConversation({...detail,conversation_id:'conv_wrong_fixture'},{agentId:'agent_fixture',turns:[{transcript:input.transcript,reply:input.reply}],liveAudioEvidence:evidence}),error=>{
  assert.equal(error.message,'Final conversation lacks bidirectional audio evidence');
  assert.equal(inspect(error,{showHidden:true,depth:null}).includes(conversationId),false);
  return true;
 });
});
});
