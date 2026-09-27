import test from 'node:test';import assert from 'node:assert/strict';
import {audioFormat,audioProof,greetingPlaybackFinished} from '../scripts/voice-audio-proof.mjs';
const valid={transcript:'What grooming services do you offer for my dog Bruno?',reply:'We offer Essential Bath grooming for dogs. Would you like to hear more?',audioBytes:16000,nonSilentBytes:9000};
test('audio proof requires recognized request, substantive response and non-silent audio',()=>{
 assert.equal(audioProof(valid),true);
 for(const change of [{transcript:''},{transcript:'Hello'},{reply:'One moment while I check that for you.'},{reply:'This conversation is waiting for a PawSpace team member.'},{audioBytes:0},{nonSilentBytes:0}])assert.equal(audioProof({...valid,...change}),false);
});
test('agent audio format controls pacing and encoded silence',()=>{
 assert.deepEqual(audioFormat('pcm_16000'),{rate:16000,bytesPerSample:2,silence:0});assert.deepEqual(audioFormat('ulaw_8000'),{rate:8000,bytesPerSample:1,silence:255});assert.throws(()=>audioFormat('mp3_44100'));
});

test('caller waits for greeting playback duration as well as stream silence',()=>{
 const greeting={firstAudioAt:1000,lastAudioAt:1200,bytes:128000,format:'pcm_16000'};
 assert.equal(greetingPlaybackFinished({...greeting,now:3000}),false);
 assert.equal(greetingPlaybackFinished({...greeting,now:5749}),false);
 assert.equal(greetingPlaybackFinished({...greeting,now:5750}),true);
 assert.equal(greetingPlaybackFinished({...greeting,now:6000,lastAudioAt:5900}),false);
 assert.equal(greetingPlaybackFinished({...greeting,now:6000,bytes:0}),false);
});
