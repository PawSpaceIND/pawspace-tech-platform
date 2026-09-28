import {assertCompletedCarrier} from '../scripts/voice-uat-evidence.mjs';
import {syntheticInfoAudio} from '../scripts/voice-synthetic-audio.mjs';
import {SPOKEN_INFO_TEXT} from '../scripts/voice-spoken-fixtures.mjs';
import {exotelApiOrigin} from '../scripts/repair-staging-voice-config.mjs';
import {testerCandidateQuery,resolveTesterCustomer} from '../scripts/voice-app-tester.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {SPOKEN_QUOTE_TEXT,SPOKEN_QUOTE_EXPECTED} from '../scripts/voice-spoken-fixtures.mjs';
import {audioProbeComplete,applyAudioProbeEvent,createAudioProbeState} from '../scripts/voice-audio-proof.mjs';
import {assertFinalConversation} from '../scripts/voice-final-conversation-proof.mjs';
import {selectVoiceRepairConfig,repairStagingVoice} from '../scripts/repair-staging-voice-config.mjs';
const caller='+918012341196';
const exophones=[{phone_number:caller,capabilities:{voice:true},region:'KA',voice_url:'https://my.exotel.com/test/exoml/start_voice/1347515'}];
const imports=[{provider:'exotel',phone_number:caller,phone_number_id:'phnum_verified'}];
test('actual synthetic quote and ASR success contract agree',()=>{
 assert.equal(SPOKEN_QUOTE_EXPECTED.test(SPOKEN_QUOTE_TEXT),true);
 assert.equal(SPOKEN_QUOTE_EXPECTED.test(SPOKEN_QUOTE_TEXT.replace('Grooming ','')),false);
});
test('network quiet cannot certify sixteen seconds of queued speech',()=>{
 const s={...createAudioProbeState(),greeting:true,listening:true,transcript:'What grooming for Bruno?',reply:'We offer doorstep grooming for Bruno.'};
 applyAudioProbeEvent(s,{type:'audio',audio_event:{event_id:2,audio_base_64:Buffer.alloc(512000,7).toString('base64')}},{now:1000,outputFormat:'pcm_16000'});
 assert.equal(audioProbeComplete(s,3000),false);
 assert.equal(audioProbeComplete(s,18499),false);
 assert.equal(audioProbeComplete(s,18500),true);
 applyAudioProbeEvent(s,{type:'interruption',interruption_event:{event_id:2}},{now:4000,outputFormat:'pcm_16000'});
 assert.equal(audioProbeComplete(s,60000),false);
});
const turns=[{transcript:'What grooming for Bruno?',reply:'We offer doorstep grooming for Bruno.'}];
const conversation=()=>({status:'done',agent_id:'agent-test',has_user_audio:true,has_response_audio:true,transcript:[{role:'agent',message:'Hello'},{role:'user',message:turns[0].transcript},{role:'agent',message:turns[0].reply}]});
test('final provider transcript must match the complete exchange',()=>{
 assert.equal(assertFinalConversation(conversation(),{agentId:'agent-test',turns}).passed,true);
 for(const field of ['has_user_audio','has_response_audio'])assert.throws(()=>assertFinalConversation({...conversation(),[field]:false},{agentId:'agent-test',turns}));
 const duplicate=conversation();duplicate.transcript.push({role:'user',message:turns[0].transcript});
 assert.throws(()=>assertFinalConversation(duplicate,{agentId:'agent-test',turns}),/duplicate/);
 const partial=conversation();partial.transcript[2].message='We offer grooming...';
 assert.throws(()=>assertFinalConversation(partial,{agentId:'agent-test',turns}),/incomplete/);
 assert.throws(()=>assertFinalConversation({...conversation(),agent_id:'other'},{agentId:'agent-test',turns}),/identity/);
});
test('routing repair only selects the owned dedicated staging phone and flow',()=>{
 const selected=selectVoiceRepairConfig(exophones,imports);
 assert.equal(selected.EXOTEL_CALLER_ID,caller);assert.equal(selected.EXOTEL_VOICE_APP_ID,'1347515');
 assert.throws(()=>selectVoiceRepairConfig(exophones,[]),/missing/);
 assert.throws(()=>selectVoiceRepairConfig(exophones,[...imports,...imports]),/ambiguous/);
 assert.throws(()=>selectVoiceRepairConfig([{...exophones[0],voice_url:'https://example.test/other'}],imports),/missing/);
});
test('repair refuses unsupported actions before any network operation',async()=>{
 let network=0;
 await assert.rejects(()=>repairStagingVoice({VOICE_REPAIR_ACTION:'production'},()=>{network++;}),/Explicit staging/);
 assert.equal(network,0);
});

test('recording-disabled sessions still require same-conversation live PCM proof and complete final transcript',()=>{
 const d={...conversation(),conversation_id:'conv-live',has_user_audio:false,has_response_audio:false,metadata:{text_only:false}};
 const evidence={conversationId:'conv-live',inputMode:'audio',inputBytes:32000,outputBytes:64000,nonSilentBytes:10000,playbackComplete:true};
 assert.equal(assertFinalConversation(d,{agentId:'agent-test',turns,liveAudioEvidence:evidence}).audioEvidence,'observed_live_stream');
 for(const change of [{conversationId:'other'},{inputMode:'text'},{inputBytes:0},{outputBytes:0},{nonSilentBytes:0},{playbackComplete:false}])assert.throws(()=>assertFinalConversation(d,{agentId:'agent-test',turns,liveAudioEvidence:{...evidence,...change}}));
 const interrupted={...d,transcript:d.transcript.map((row,i)=>i===2?{...row,interrupted:true}:row)};
 assert.throws(()=>assertFinalConversation(interrupted,{agentId:'agent-test',turns,liveAudioEvidence:evidence}),/interrupted/);
 assert.throws(()=>assertFinalConversation({...d,metadata:{text_only:true}},{agentId:'agent-test',turns,liveAudioEvidence:evidence}));
});

test('carrier origin is an exact fixed endpoint, never a hostname substring',()=>{
 assert.equal(exotelApiOrigin('api.exotel.com'),'https://api.exotel.com');
 assert.equal(exotelApiOrigin('api.in.exotel.com'),'https://api.in.exotel.com');
 for(const host of ['api.exotel.com.evil.test','evil.test/api.exotel.com','https://api.exotel.com','api.exotel.com@evil.test','api.exotel.com/path'])assert.throws(()=>exotelApiOrigin(host),/Invalid/);
});
test('audio sent to the provider is generated from the fixed fixture without file input',()=>{
 const calls=[];
 const pcm=syntheticInfoAudio((command,args,options)=>{calls.push({command,args,options});return Buffer.alloc(command==='ffmpeg'?2000:256,7);});
 assert.equal(pcm.length,2000);assert.equal(calls[0].command,'espeak-ng');
 assert.deepEqual(calls[0].args,['--stdout','-s','150',SPOKEN_INFO_TEXT]);
 assert.equal(calls[1].command,'ffmpeg');assert.equal(calls[1].args[calls[1].args.indexOf('-i')+1],'pipe:0');
 assert.equal(calls[1].args.at(-1),'pipe:1');assert.ok(Buffer.isBuffer(calls[1].options.input));
 assert.throws(()=>syntheticInfoAudio(()=>Buffer.alloc(1)),/invalid/);
});
test('tester discovery uses actual canonical phone ownership and never rewrites records',()=>{
 const phone='+919876543210';
 assert.equal(resolveTesterCustomer([{id:'actual',primary_phone:'9876543210'},{id:'legacy',primary_phone:'9999999999'}],phone),'actual');
 assert.equal(resolveTesterCustomer([{id:'secondary',primary_phone:'9999999999',secondary_phone:'09876543210'}],phone),'secondary');
 assert.throws(()=>resolveTesterCustomer([{id:'a',primary_phone:phone},{id:'b',secondary_phone:phone}],phone),/2 canonical owners/);
 assert.throws(()=>resolveTesterCustomer([{id:'foreign',primary_phone:'+19876543210'}],phone),/0 canonical owners/);
 assert.throws(()=>resolveTesterCustomer(Array.from({length:101},()=>({id:'x',primary_phone:phone})),phone),/incomplete/);
 const query=testerCandidateQuery(phone);assert.match(query.sql,/^SELECT /);assert.deepEqual(query.params,['%3210%','%3210%']);
 assert.throws(()=>testerCandidateQuery('not-a-phone'),/canonicalised/);
});

test('exhausted carrier polling cannot pass on a finished model session alone',()=>{
 assert.equal(assertCompletedCarrier({status:'completed',duration:12}),true);
 for(const carrier of [{status:'in-progress',duration:12},{status:'no-answer',duration:0},{status:'completed',duration:0},{status:'completed',duration:NaN},{status:'completed',duration:Infinity},undefined])assert.throws(()=>assertCompletedCarrier(carrier),/Carrier has not confirmed/);
});
