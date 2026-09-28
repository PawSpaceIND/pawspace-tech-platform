import {SPOKEN_INFO_EXPECTED} from './voice-spoken-fixtures.mjs';
import {spokenInputComplete} from './voice-spoken-sale-guards.mjs';
import {verifyFinalConversation} from './voice-final-conversation-proof.mjs';
// Synthetic caller audio through real agent ASR/LLM/TTS; never uses a telephony dial API.
import {setTimeout as delay} from 'node:timers/promises';
import {syntheticInfoAudio} from './voice-synthetic-audio.mjs';
import {verifyVoiceSale} from './verify-voice-sale.mjs';
import {greetingPlaybackFinished,applyAudioProbeEvent,audioEventKind,audioFormat,audioProbeComplete,audioProofChecks,createAudioProbeState,isHandoffReply} from './voice-audio-proof.mjs';
// Remote values are stripped of CR/LF (explicitly, so log-injection scanners see it), other control
// characters and line/paragraph separators, and capped before reaching workflow logs or commands.
const logSafe=(value,max=128)=>String(value).replace(/\r|\n/g,'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,'').slice(0,max);
const before=await verifyVoiceSale({...process.env,VOICE_SALE_ACTION:'probe-agent-socket'});
const key=process.env.ELEVENLABS_API_KEY,agentId=process.env.GROOMING_AGENT_ID,callId=process.env.UAT_VOICE_CALL_ID;
const headers={'xi-api-key':key};
const configResponse=await fetch('https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(agentId),{headers,signal:AbortSignal.timeout(30000)});
if(!configResponse.ok)throw Error('Agent configuration read failed');
const config=await configResponse.json();
console.log('VOICE_AUDIO_CLIENT_EVENTS='+JSON.stringify({events:config.conversation_config?.conversation?.client_events??[],asr:config.conversation_config?.asr?.user_input_audio_format??null}));
const sr=await fetch('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(agentId),{headers,signal:AbortSignal.timeout(30000)});
const signed=await sr.json();if(!sr.ok||!signed.signed_url)throw Error('Agent socket authorization refused');
console.log('::add-mask::'+signed.signed_url);
const socket=new WebSocket(signed.signed_url);
let conversationId,format,outputFormat,sending=false,finished=false,started=0,sentBytes=0,inputSpeechBytes=0;
// Counts are keyed only by allowlisted event names (anything else is 'other'), never by raw socket data.
const state=createAudioProbeState(),eventCounts=new Map();
let greetingBytes=0,firstGreetingAudioAt=0,lastGreetingAudioAt=0;
await new Promise((resolve,reject)=>{
 const deadline=setTimeout(()=>finish(Error('Audio round trip did not complete within 90 seconds')),90000);
 const check=setInterval(()=>{if(audioProbeComplete(state,Date.now()))finish();},250);
 function finish(error){if(finished)return;finished=true;clearTimeout(deadline);clearInterval(check);console.log('VOICE_AUDIO_DIAGNOSTICS='+JSON.stringify({eventCounts:Object.fromEntries(eventCounts),sentBytes,greeting:state.greeting,sending,started:Boolean(started),transcriptReceived:Boolean(state.transcript),transcriptSegments:state.segments.length,replyReceived:Boolean(state.reply),audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,interruptedEventId:state.interruptedEventId,proofs:audioProofChecks(state)}));socket.close();if(error)reject(error);else resolve();}
 async function sendAudio(){
  if(sending||!format||!state.greeting)return;sending=true;
  // Fixed informational utterance: this probe cannot confirm or create a sale.
  if(format!=='pcm_16000')throw Error('Caller fixture requires negotiated pcm_16000 input');
  const audio=syntheticInfoAudio(),f=audioFormat(format);
  inputSpeechBytes=audio.length;
  if(audio.length<1000||audio.length>f.rate*f.bytesPerSample*30)throw Error('Invalid synthetic caller audio size');
  while(!finished&&!greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstGreetingAudioAt,lastAudioAt:lastGreetingAudioAt,bytes:greetingBytes,format:outputFormat}))await delay(100);
  if(finished)return;started=Date.now();state.listening=true;
  const chunk=Math.floor(f.rate*f.bytesPerSample/10),input=Buffer.concat([Buffer.alloc(f.rate*f.bytesPerSample/2,f.silence),audio,Buffer.alloc(f.rate*f.bytesPerSample*2,f.silence)]);
  // Model a microphone: send the fixture once, then only silence while the reply plays.
  for(let i=0;!finished;i+=chunk){const stopSpeech=spokenInputComplete(state.transcript,state.reply,SPOKEN_INFO_EXPECTED);const frame=!stopSpeech&&i<input.length?input.subarray(i,i+chunk):Buffer.alloc(chunk,f.silence);socket.send(JSON.stringify({user_audio_chunk:frame.toString('base64')}));sentBytes+=frame.length;await delay(100);}
 }
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_voice_call_id:callId},dynamic_variables:{pawspace_voice_call_id:callId,pawspace_uat:'true'}})));
 socket.addEventListener('message',event=>{try{
  const d=JSON.parse(String(event.data)),kind=audioEventKind(d.type);eventCounts.set(kind,(eventCounts.get(kind)||0)+1);
  if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
  if(d.type==='conversation_initiation_metadata'){
   const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;format=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;audioFormat(format);audioFormat(outputFormat);
   if(m.conversation_id)console.log('::add-mask::'+logSafe(m.conversation_id));
   console.log('VOICE_AUDIO_FORMATS='+JSON.stringify({input:format,output:outputFormat}));void sendAudio().catch(finish);
  }
  if(d.type==='audio'&&!started){const n=Buffer.from(d.audio_event?.audio_base_64||'','base64').length;if(n){firstGreetingAudioAt ||= Date.now();lastGreetingAudioAt=Date.now();greetingBytes+=n;}}
  const change=applyAudioProbeEvent(state,d,{now:Date.now(),outputFormat});
  if(change==='greeting')void sendAudio().catch(finish);
  if(change==='transcript')console.log('VOICE_AUDIO_TRANSCRIPT='+JSON.stringify({text:state.segments.at(-1),ms:Date.now()-started}));
  if(change==='interruption')console.log('VOICE_AUDIO_INTERRUPTION='+JSON.stringify({eventId:state.interruptedEventId,ms:started?Date.now()-started:null}));
  if(change==='reply'||change==='correction'){console.log((change==='reply'?'VOICE_AUDIO_REPLY=':'VOICE_AUDIO_REPLY_CORRECTION=')+JSON.stringify({text:state.reply.slice(0,900),ms:Date.now()-started}));if(isHandoffReply(state.reply))finish(Error('Audio turn handed off instead of answering'));}
  if(d.type==='error')finish(Error('Agent audio socket returned error'));
 }catch(e){finish(e);}});
 socket.addEventListener('error',()=>finish(Error('Agent audio transport error')));
 socket.addEventListener('close',()=>{if(!finished)finish(Error('Agent closed before audio proof'));});
});
const finalProof=await verifyFinalConversation({key,conversationId,agentId,turns:[{transcript:state.transcript,reply:state.reply}],liveAudioEvidence:{conversationId,inputMode:'audio',inputBytes:inputSpeechBytes,outputBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,playbackComplete:audioProbeComplete(state,Date.now())}});
const after=await verifyVoiceSale({...process.env,VOICE_SALE_ACTION:'verify-voice-sale'});
if(JSON.stringify(before.completedBookings)!==JSON.stringify(after.completedBookings))throw Error('Informational audio probe changed booking set');
console.log('VOICE_AUDIO_PROOF='+JSON.stringify({passed:true,dialed:false,syntheticCaller:true,transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,inputFormat:format,outputFormat,bookingSetUnchanged:true,finalProof}));
