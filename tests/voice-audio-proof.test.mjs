import test from 'node:test';import assert from 'node:assert/strict';
import {audioFormat,audioProof} from '../scripts/voice-audio-proof.mjs';
const valid={transcript:'What grooming services do you offer for my dog Bruno?',reply:'We offer Essential Bath grooming for dogs. Would you like to hear more?',audioBytes:16000,nonSilentBytes:9000};
test('audio proof requires recognized request, substantive response and non-silent audio',()=>{
 assert.equal(audioProof(valid),true);
 for(const change of [{transcript:''},{transcript:'Hello'},{reply:'One moment while I check that for you.'},{reply:'This conversation is waiting for a PawSpace team member.'},{audioBytes:0},{nonSilentBytes:0}])assert.equal(audioProof({...valid,...change}),false);
});
test('agent audio format controls pacing and encoded silence',()=>{
 assert.deepEqual(audioFormat('pcm_16000'),{rate:16000,bytesPerSample:2,silence:0});assert.deepEqual(audioFormat('ulaw_8000'),{rate:8000,bytesPerSample:1,silence:255});assert.throws(()=>audioFormat('mp3_44100'));
});
