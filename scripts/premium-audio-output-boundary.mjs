import {PREMIUM_AUDIO_SCENARIOS} from './premium-audio-scenarios.mjs';
import {DEMO_LIMITS} from './voice-demo-output-boundary.mjs';

const scope='Actual staged ASR/brain/TTS informational conversations; no booking confirmation, delivered checkout, payment or provider acceptance certification; first-audio metrics may include acknowledgement speech; aligned-reply-chunk timing measures answer-linked audio arrival only, not audible playback or carrier latency';
function session(id){const value=PREMIUM_AUDIO_SCENARIOS.find(item=>item.id===id);if(!value)throw Error('Unknown fixed premium scenario');return value;}
function text(value,max=DEMO_LIMITS.textBytes){if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>max)throw Error('Premium text exceeds input bound');return value;}
function number(value,max){if(!Number.isFinite(value)||value<0||value>max)throw Error('Invalid premium measurement');return value;}
function bytes(value,max=DEMO_LIMITS.audioBytes){if(!Number.isSafeInteger(value))throw Error('Invalid premium byte count');return number(value,max);}
export function premiumArtifactPaths(id,turnId){
 const selected=session(id);
 if(turnId!==undefined&&!selected.turns.some(turn=>turn.id===turnId))throw Error('Unknown fixed premium turn');
 const stem='voice-demo-results/'+selected.id+(turnId===undefined?'':'-'+turnId+'-observed');
 return{raw:stem+'.raw',wav:stem+'.wav',json:stem+'.json',failed:'voice-demo-results/'+selected.id+'-failed.json'};
}
function turn(input,selected,index){
 const expected=selected.turns[index];if(!expected||input.scenario!==expected.id)throw Error('Premium turn order mismatch');
 const audioBytes=bytes(input.audioBytes),nonSilentBytes=bytes(input.nonSilentBytes,audioBytes);
 if(input.playbackComplete!==true)throw Error('Premium playback incomplete');
 return{scenario:expected.id,prompt:expected.text,transcript:text(input.transcript),reply:text(input.reply),inputToPlaybackCompletedMs:number(input.inputToPlaybackCompletedMs,300000),utteranceEndToFirstAudioMs:input.utteranceEndToFirstAudioMs===null?null:number(input.utteranceEndToFirstAudioMs,300000),utteranceEndToReplyEventMs:input.utteranceEndToReplyEventMs===null?null:number(input.utteranceEndToReplyEventMs,300000),utteranceEndToAlignedReplyChunkMs:input.utteranceEndToAlignedReplyChunkMs==null?null:number(input.utteranceEndToAlignedReplyChunkMs,300000),audioBytes,nonSilentBytes,playbackComplete:true};
}
export function validatedPremiumReport(input){
 const selected=session(input.scenario);
 if(!/^[a-f0-9]{40}$/.test(input.revision||''))throw Error('Exact premium revision required');
 if(!Array.isArray(input.turns)||input.turns.length>selected.turns.length)throw Error('Invalid premium turn count');
 const turns=input.turns.map((value,index)=>turn(value,selected,index));
 if(turns.reduce((sum,value)=>sum+value.audioBytes,0)>DEMO_LIMITS.audioBytes)throw Error('Premium cumulative audio exceeded');
 const base={scenario:selected.id,revision:input.revision,turns,dialed:false,carrierVerified:false,premiumCertified:false};
 if(input.passed===false){
  const audioBytes=bytes(input.audioBytes),nonSilentBytes=bytes(input.nonSilentBytes,audioBytes);
  return{passed:false,...base,transcript:text(input.transcript),reply:text(input.reply),audioBytes,nonSilentBytes,error:'Premium audio demo failed before certification'};
 }
 const proof=input.proof;
 if(turns.length!==selected.turns.length||proof?.passed!==true||proof.userTurns!==selected.turns.length||proof.finalTranscriptMatched!==true||proof.bidirectionalAudio!==true||!['retained_recording','observed_live_stream'].includes(proof.audioEvidence))throw Error('Invalid premium final proof');
 return{...base,proof:{passed:true,userTurns:selected.turns.length,finalTranscriptMatched:true,bidirectionalAudio:true,audioEvidence:proof.audioEvidence},engine:'elevenlabs_with_pawspace_brain',scope};
}
export function serializePremiumReport(input){return text(JSON.stringify(validatedPremiumReport(input),null,2),DEMO_LIMITS.reportBytes);}
export function serializePremiumSummary(reports){
 if(!Array.isArray(reports)||reports.length!==PREMIUM_AUDIO_SCENARIOS.length||reports.some((report,index)=>report.scenario!==PREMIUM_AUDIO_SCENARIOS[index].id||report.passed===false))throw Error('Three fixed successful premium sessions required');
 return text(JSON.stringify({passed:true,demonstrations:reports.map(validatedPremiumReport),bookingSetUnchanged:true,dialed:false,nativeCarrierCertified:false,premiumCertified:false},null,2),DEMO_LIMITS.reportBytes);
}
