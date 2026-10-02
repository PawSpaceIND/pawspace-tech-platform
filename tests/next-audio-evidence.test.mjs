import test from 'node:test';import assert from 'node:assert/strict';
import {createAudioEventReceipt} from '../scripts/next-audio-evidence.mjs';
test('audio before transcript is retained; a late ASR event cannot overwrite latency',()=>{
 let now=100;const r=createAudioEventReceipt(()=>now);r.callerSpeechEnded();now=850;
 r.receive({type:'audio',audio_event:{event_id:1,audio_base_64:Buffer.from([1,2,3,4]).toString('base64')}});
 now=900;r.receive({type:'user_transcript'});now=950;r.receive({type:'agent_response'});
 const s=r.snapshot();assert.equal(s.firstAudioAfterCallerEndMs,750);assert.equal(s.audioChunks[0].pcm.length,4);assert.equal(s.listened,false);
});
test('missing audio stays unknown; interruption and native conversation ID are retained',()=>{
 const r=createAudioEventReceipt(()=>20);r.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{conversation_id:'synthetic-provider-id'}});r.receive({type:'interruption'});
 assert.equal(r.snapshot().firstAudioAfterCallerEndMs,null);assert.equal(r.snapshot().conversationId,'synthetic-provider-id');assert.ok(r.snapshot().events.some(e=>e.type==='interruption'));
});
