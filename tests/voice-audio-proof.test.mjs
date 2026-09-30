import test from 'node:test';import assert from 'node:assert/strict';
import {greetingPlaybackFinished,applyAudioProbeEvent,audioEventKind,audioFormat,audioProbeComplete,audioProof,audioProofChecks,createAudioProbeState,isHandoffReply} from '../scripts/voice-audio-proof.mjs';
import {installAiHooks,freshUatAiDb,seedCustomer,inboundMessage,applyOwnedDdl,stubFetch} from './helpers/ai-harness.mjs';
import {runWithWorkersDb} from './helpers/module-hooks.mjs';
import {VOICE_DEMO_SCENARIOS,assertDemoResponse} from '../scripts/voice-demo-scenarios.mjs';
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
async function spokenHandoff(t,{staffPause}){
 const w=freshUatAiDb({ELEVENLABS_API_KEY:'test-only-elevenlabs',ELEVENLABS_AGENT_ID:'agent-test',ELEVENLABS_LLM_SECRET:LLM_SECRET,PAWSPACE_UAT_LOGIN:'on',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_OPENAI_API_KEY:'test-only-openai'});
 t.after(()=>w.sqlite.close());globalThis.__PAWSPACE_TEST_ENV__={...globalThis.__PAWSPACE_TEST_ENV__,DB:w.db};
 seedCustomer(w.sqlite,'CUS-AUDIO-PROOF','Synthetic Tester','9876500093');
 await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-AUDIO-PROOF',customerId:'CUS-AUDIO-PROOF',text:'synthetic fixture',channel:'voice',idempotencyKey:'audio-proof-fixture'});
 const {ensureAiConversationOrchestrator}=await import('../lib/ai-conversation-orchestrator.ts');await ensureAiConversationOrchestrator(w.db);
 const {ensurePricingControlRuntime}=await import('../lib/pricing-control-runtime.ts');await ensurePricingControlRuntime(w.db);
 for(const owner of ['lib/training-commercial-governance.ts','lib/boarding-governance.ts','lib/sitting-governance.ts','lib/walking-governance.ts','lib/taxi-governance.ts'])applyOwnedDdl(w.sqlite,owner);
 const {setAiRolloutStage}=await import('../lib/ai-audience-rollout.ts');
 await setAiRolloutStage(w.db,{stage:'staff_only',reason:'synthetic audio proof handoff',actorEmail:'test@pawspace.test'});
 if(staffPause){const {requestAiHumanHandoff}=await import('../lib/ai-human-handoff.ts');await requestAiHumanHandoff(w.db,{threadId:'THREAD-AUDIO-PROOF',customerId:'CUS-AUDIO-PROOF',reason:'low_confidence',actorEmail:'test@pawspace.test'});}
 const mock=stubFetch(()=>{throw new Error('a handoff turn must not call the provider');});t.after(()=>mock.restore());
 const input=staffPause?'What grooming services do you offer for my dog Bruno?':'I want for tomorrow at 11:00 AM.';
 const request=new Request('https://pawspace-staging-gateway.test/api/elevenlabs/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+LLM_SECRET},body:JSON.stringify({input,elevenlabs_extra_body:{pawspace_customer_id:'CUS-AUDIO-PROOF',pawspace_thread_id:'THREAD-AUDIO-PROOF'}})});
 const sse=await runWithWorkersDb(w.db,async()=>(await responsesRoute.POST(request)).text());
 const events=sse.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
 assert.equal(events.at(-1)?.type,'response.completed');assert.equal(mock.calls.length,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_handoffs WHERE status='queued'").get().n,1,'the turn really handed off');
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
