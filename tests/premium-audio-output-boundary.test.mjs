import test from 'node:test';
import assert from 'node:assert/strict';
import {PREMIUM_AUDIO_SCENARIOS} from '../scripts/premium-audio-scenarios.mjs';
import {DEMO_LIMITS} from '../scripts/voice-demo-output-boundary.mjs';
import {premiumArtifactPaths,validatedPremiumReport,serializePremiumReport,serializePremiumSummary} from '../scripts/premium-audio-output-boundary.mjs';
const proof={passed:true,userTurns:3,finalTranscriptMatched:true,bidirectionalAudio:true,audioEvidence:'observed_live_stream'};
function report(index=0){const selected=PREMIUM_AUDIO_SCENARIOS[index];return{scenario:selected.id,revision:'a'.repeat(40),turns:selected.turns.map(item=>({scenario:item.id,prompt:'untrusted replacement',transcript:'Synthetic microphone transcript',reply:'Actual observed answer',inputToPlaybackCompletedMs:1800,utteranceEndToFirstAudioMs:400.25,utteranceEndToReplyEventMs:null,audioBytes:2400,nonSilentBytes:1800,playbackComplete:true})),proof:{...proof,userTurns:selected.turns.length}};}
test('genuine all-service measurements survive while reports cannot claim carrier or premium certification',()=>{
 const data=JSON.parse(serializePremiumSummary(PREMIUM_AUDIO_SCENARIOS.map((_,i)=>report(i))));
 assert.equal(data.demonstrations.length,3);assert.equal(data.demonstrations.flatMap(x=>x.turns).length,16);
 assert.equal(data.demonstrations[0].turns[0].utteranceEndToFirstAudioMs,400.25);
 assert.equal(data.demonstrations[0].turns[0].utteranceEndToReplyEventMs,null);
 assert.equal(data.premiumCertified,false);assert.equal(data.dialed,false);assert.equal(data.nativeCarrierCertified,false);
});
test('provider correlation, unknown metadata, invented claims and supplied prompts are excluded',()=>{
 const input=report();input.conversationId='conv_private';input.cookie='secret';input.premiumCertified=true;input.dialed=true;input.proof={...proof,conversationId:'conv_private',rawProvider:'secret'};input.turns[0].apiKey='secret';
 const json=serializePremiumReport(input),result=JSON.parse(json);
 for(const secret of ['conv_private','secret','untrusted replacement'])assert.equal(json.includes(secret),false);
 assert.equal(result.turns[0].prompt,PREMIUM_AUDIO_SCENARIOS[0].turns[0].text);assert.equal(result.premiumCertified,false);assert.equal(result.dialed,false);
});
test('only fixed session and child-turn filenames may be used',()=>{
 for(const selected of PREMIUM_AUDIO_SCENARIOS){assert.ok(premiumArtifactPaths(selected.id).raw.startsWith('voice-demo-results/'));for(const item of selected.turns)assert.ok(premiumArtifactPaths(selected.id,item.id).wav.endsWith('-observed.wav'));}
 for(const id of ['../outside','constructor','toString','grooming_recommendation/../outside'])assert.throws(()=>premiumArtifactPaths(id));
 assert.throws(()=>premiumArtifactPaths(PREMIUM_AUDIO_SCENARIOS[0].id,'boarding_intake'));
});
test('missing, repeated, reordered or failed session evidence cannot produce a passing summary',()=>{
 const reports=PREMIUM_AUDIO_SCENARIOS.map((_,i)=>report(i));
 assert.throws(()=>serializePremiumSummary(reports.slice(0,2)));
 assert.throws(()=>serializePremiumSummary([reports[0],reports[0],reports[2]]));
 assert.throws(()=>serializePremiumSummary([...reports].reverse()));
 assert.throws(()=>serializePremiumSummary([{...reports[0],passed:false},...reports.slice(1)]));
});
test('final provider proof and all three completed audible turns are required',()=>{
 for(const override of [{turns:report().turns.slice(0,2)},{proof:{...proof,userTurns:2}},{proof:{...proof,finalTranscriptMatched:false}},{proof:{...proof,bidirectionalAudio:false}},{proof:{...proof,audioEvidence:'synthetic_file'}},{revision:'stale'}])assert.throws(()=>validatedPremiumReport({...report(),...override}));
 const input=report();input.turns[0].playbackComplete=false;assert.throws(()=>validatedPremiumReport(input));
 const swapped=report();[swapped.turns[0],swapped.turns[1]]=[swapped.turns[1],swapped.turns[0]];assert.throws(()=>validatedPremiumReport(swapped));
});
test('invalid timings, byte counts and oversized transcript/report text are refused',()=>{
 for(const [name,value] of [['audioBytes',Infinity],['audioBytes',-1],['audioBytes',2.5],['nonSilentBytes',2401],['inputToPlaybackCompletedMs',NaN],['utteranceEndToFirstAudioMs',-1],['utteranceEndToReplyEventMs',300001],['transcript','x'.repeat(DEMO_LIMITS.textBytes+1)],['reply','🐾'.repeat(DEMO_LIMITS.textBytes/4+1)]]){const input=report();input.turns[0][name]=value;assert.throws(()=>validatedPremiumReport(input));}
 const input=report();for(const value of input.turns)value.audioBytes=DEMO_LIMITS.audioBytes;assert.throws(()=>validatedPremiumReport(input),/cumulative audio/);
});
test('failed reports retain bounded observations but never reflect raw exception tokens',()=>{
 const input={...report(),passed:false,turns:[],transcript:'Observed speech',reply:'Observed answer',audioBytes:2400,nonSilentBytes:1800,error:'token=private conversation=conv_private',conversationId:'conv_private'};
 const json=serializePremiumReport(input),result=JSON.parse(json);
 assert.equal(result.passed,false);assert.equal(result.transcript,input.transcript);assert.equal(result.reply,input.reply);assert.equal(result.error,'Premium audio demo failed before certification');assert.equal(json.includes('private'),false);assert.equal(result.premiumCertified,false);
 assert.throws(()=>serializePremiumSummary([input,report(1),report(2)]));
});

test('aligned answer-chunk arrival is optional and bounded, with no missing-to-zero substitution',()=>{
 const input=report();assert.equal(validatedPremiumReport(input).turns[0].utteranceEndToAlignedReplyChunkMs,null);
 input.turns[0].utteranceEndToAlignedReplyChunkMs=2200.5;assert.equal(validatedPremiumReport(input).turns[0].utteranceEndToAlignedReplyChunkMs,2200.5);
 for(const value of [NaN,Infinity,-1,300001,'2200']){input.turns[0].utteranceEndToAlignedReplyChunkMs=value;assert.throws(()=>validatedPremiumReport(input));}
});
