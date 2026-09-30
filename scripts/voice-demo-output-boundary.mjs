import {VOICE_DEMO_SCENARIOS} from './voice-demo-scenarios.mjs';
import {audioFormat} from './voice-audio-proof.mjs';

export const DEMO_LIMITS=Object.freeze({jsonBytes:2*1024*1024,eventBytes:512*1024,audioChunkBytes:256*1024,audioBytes:16*1024*1024,textBytes:16*1024,eventCount:4096,reportBytes:128*1024});
const destinations=Object.freeze({
 grooming_enquiry:Object.freeze({raw:'voice-demo-results/grooming_enquiry.raw',wav:'voice-demo-results/grooming_enquiry.wav',failed:'voice-demo-results/grooming_enquiry-failed.json'}),
 pet_health:Object.freeze({raw:'voice-demo-results/pet_health.raw',wav:'voice-demo-results/pet_health.wav',failed:'voice-demo-results/pet_health-failed.json'}),
 governed_offer:Object.freeze({raw:'voice-demo-results/governed_offer.raw',wav:'voice-demo-results/governed_offer.wav',failed:'voice-demo-results/governed_offer-failed.json'}),
});
export const DEMO_SUMMARY_PATH='voice-demo-results/conversations.json';
export function demoArtifactPaths(id){
 if(typeof id!=='string'||!Object.hasOwn(destinations,id))throw Error('Unknown fixed demo scenario');
 return destinations[id];
}
function boundedText(value,limit=DEMO_LIMITS.textBytes){
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>limit)throw Error('Demo text exceeds its input bound');
 return value;
}
export async function readDemoJson(response){
 const declared=Number(response.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>DEMO_LIMITS.jsonBytes){void response.body?.cancel().catch(()=>{});throw Error('Demo JSON response exceeded');}
 const reader=response.body?.getReader();
 if(!reader)throw Error('Demo JSON response body missing');
 let size=0;const chunks=[];
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>DEMO_LIMITS.jsonBytes||chunks.length>=DEMO_LIMITS.eventCount){void reader.cancel().catch(()=>{});throw Error('Demo JSON response exceeded');}
   chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
 }finally{reader.releaseLock();}
}
export function validateDemoIdentifier(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))throw Error('Invalid demo identifier');
 return value;
}
export function validateDemoContext(value){return{callId:validateDemoIdentifier(value?.callId),threadId:validateDemoIdentifier(value?.threadId)};}
export function actionsMaskCommand(value){
 // GitHub Actions command data must escape percent first, then CR/LF. Validation alone is not a
 // substitute for escaping: a signed URL may legitimately contain percent-encoded data.
 const data=boundedText(value,8192).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
 return '::add-mask::'+data;
}
export function validateDemoSignedUrl(value){
 boundedText(value,8192);
 if(/[\u0000-\u0020\u007f]/.test(value))throw Error('Invalid demo socket URL');
 const url=new URL(value);
 // Only the two regions already permitted by this demo. Official socket origins/path:
 // https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets
 // https://elevenlabs.io/docs/overview/administration/data-residency
 if(url.protocol!=='wss:'||url.username||url.password||url.port||url.hash||!['api.elevenlabs.io','api.in.residency.elevenlabs.io'].includes(url.hostname)||url.pathname!=='/v1/convai/conversation')throw Error('Unapproved demo socket URL');
 return url.href;
}
function decodeAudio(value){
 if(typeof value!=='string'||value.length>Math.ceil(DEMO_LIMITS.audioChunkBytes/3)*4||!value||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('Invalid bounded demo audio');
 const bytes=Buffer.from(value,'base64');
 if(bytes.length>DEMO_LIMITS.audioChunkBytes||bytes.toString('base64')!==value)throw Error('Invalid bounded demo audio');
 return bytes;
}
export function createDemoEventBoundary(){
 let eventCount=0,audioBytes=0,transcriptBytes=0;
 return{parse(raw){
  if(++eventCount>DEMO_LIMITS.eventCount)throw Error('Demo event count exceeded');
  boundedText(raw,DEMO_LIMITS.eventBytes);
  const event=JSON.parse(raw);
  if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'||event.type.length>64)throw Error('Invalid demo event');
  let audio;
  if(event.type==='conversation_initiation_metadata'){
   const metadata=event.conversation_initiation_metadata_event;
   validateDemoIdentifier(metadata?.conversation_id);
   if(metadata?.user_input_audio_format!=='pcm_16000')throw Error('Demo microphone requires PCM16000');
   audioFormat(metadata?.agent_output_audio_format);
  }
  if(event.type==='audio'){
   audio=decodeAudio(event.audio_event?.audio_base_64);
   audioBytes+=audio.length;
   if(audioBytes>DEMO_LIMITS.audioBytes)throw Error('Demo cumulative audio exceeded');
  }
  if(event.type==='user_transcript'){
   const transcript=boundedText(event.user_transcription_event?.user_transcript);
   // Includes the separator used when the existing probe joins transcript segments.
   transcriptBytes+=Buffer.byteLength(transcript,'utf8')+1;
   if(transcriptBytes>DEMO_LIMITS.textBytes)throw Error('Demo cumulative transcript exceeded');
  }
  if(event.type==='agent_response')boundedText(event.agent_response_event?.agent_response);
  if(event.type==='agent_response_correction'){
   boundedText(event.agent_response_correction_event?.original_agent_response);
   boundedText(event.agent_response_correction_event?.corrected_agent_response);
  }
  return{event,audio};
 }};
}
function count(value,max){
 if(!Number.isSafeInteger(value)||value<0||value>max)throw Error('Invalid bounded demo measurement');
 return value;
}
function baseReport(input){
 demoArtifactPaths(input.scenario);
 const scenario=VOICE_DEMO_SCENARIOS.find(item=>item.id===input.scenario);
 const audioBytes=count(input.audioBytes,DEMO_LIMITS.audioBytes),nonSilentBytes=count(input.nonSilentBytes,audioBytes);
 return{scenario:scenario.id,prompt:scenario.text,transcript:boundedText(input.transcript),reply:boundedText(input.reply),audioBytes,nonSilentBytes,dialed:false};
}
export function validatedDemoReport(input){
 const base=baseReport(input);
 if(input.passed===false)return{passed:false,...base,error:boundedText(input.error,2048)};
 const proof=input.proof;
 if(proof?.passed!==true||proof.userTurns!==1||proof.finalTranscriptMatched!==true||proof.bidirectionalAudio!==true||!['retained_recording','observed_live_stream'].includes(proof.audioEvidence))throw Error('Invalid demo proof report');
 return{...base,inputToPlaybackCompletedMs:count(input.inputToPlaybackCompletedMs,300000),proof:{passed:true,userTurns:1,finalTranscriptMatched:true,bidirectionalAudio:true,audioEvidence:proof.audioEvidence},engine:'elevenlabs_with_pawspace_brain',carrierVerified:false};
}
export function serializeDemoReport(input){return boundedText(JSON.stringify(validatedDemoReport(input),null,2),DEMO_LIMITS.reportBytes);}
export function serializeDemoSummary(reports){
 if(!Array.isArray(reports)||reports.length!==VOICE_DEMO_SCENARIOS.length||reports.some((report,index)=>report.scenario!==VOICE_DEMO_SCENARIOS[index].id||report.passed===false))throw Error('Three fixed successful scenarios are required');
 return boundedText(JSON.stringify({passed:true,demonstrations:reports.map(validatedDemoReport),bookingSetUnchanged:true,dialed:false,nativeCarrierCertified:false},null,2),DEMO_LIMITS.reportBytes);
}
