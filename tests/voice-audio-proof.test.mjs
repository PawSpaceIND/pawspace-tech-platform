import test from 'node:test';import assert from 'node:assert/strict';
import {applyAudioProbeEvent,audioFormat,audioProbeComplete,audioProof,audioProofChecks,createAudioProbeState,isHandoffReply} from '../scripts/voice-audio-proof.mjs';
const valid={transcript:'What grooming services do you offer for my dog Bruno?',reply:'We offer Essential Bath grooming for dogs. Would you like to hear more?',audioBytes:16000,nonSilentBytes:9000};
test('audio proof requires recognized request, substantive response and non-silent audio',()=>{
 assert.equal(audioProof(valid),true);
 for(const change of [{transcript:''},{transcript:'Hello'},{reply:'One moment while I check that for you.'},{reply:'This conversation is waiting for a PawSpace team member.'},{audioBytes:0},{nonSilentBytes:0}])assert.equal(audioProof({...valid,...change}),false);
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
 assert.equal(audioProbeComplete(s,now+1600),true);
});
test('interrupted reply is judged on the corrected text actually spoken, and cancelled audio is never waited for',()=>{
 const base=[...greeting,asked,{type:'agent_response',agent_response_event:{agent_response:reply}},{type:'audio',audio_event:{event_id:2,audio_base_64:pcm(32000)}},{type:'interruption',interruption_event:{event_id:2}}];
 const spoken=replay([...base,{type:'agent_response_correction',agent_response_correction_event:{original_agent_response:reply,corrected_agent_response:'One moment while I check that for you. Yes. We offer doorstep grooming for Bruno'}},
  {type:'audio',audio_event:{event_id:2,audio_base_64:pcm(64000)}}]);
 assert.deepEqual(spoken.changes.slice(-2),['correction','cancelled-audio']);
 assert.equal(spoken.s.audioBytes,32000,'cancelled audio is not counted');
 assert.equal(spoken.s.lastAudio,spoken.now-300,'cancelled audio does not extend the settle window');
 assert.equal(audioProbeComplete(spoken.s,spoken.now+1300),true);
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
