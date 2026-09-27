// Synthetic caller audio through real agent ASR/LLM/TTS; never uses a telephony dial API.
import {setTimeout as delay} from 'node:timers/promises';
import {verifyVoiceSale} from './verify-voice-sale.mjs';
import {audioFormat,audioProof} from './voice-audio-proof.mjs';
const before=await verifyVoiceSale({...process.env,VOICE_SALE_ACTION:'probe-agent-socket'});
const key=process.env.ELEVENLABS_API_KEY,agentId=process.env.GROOMING_AGENT_ID,callId=process.env.UAT_VOICE_CALL_ID;
const headers={'xi-api-key':key};
const ar=await fetch('https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(agentId),{headers,signal:AbortSignal.timeout(30000)});
const agent=await ar.json();if(!ar.ok)throw Error('Agent configuration unavailable');
const voice=agent.conversation_config?.tts?.voice_id;if(!voice)throw Error('Agent voice is not configured');
const sr=await fetch('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(agentId),{headers,signal:AbortSignal.timeout(30000)});
const signed=await sr.json();if(!sr.ok||!signed.signed_url)throw Error('Agent socket authorization refused');
console.log('::add-mask::'+signed.signed_url);
const socket=new WebSocket(signed.signed_url);
let format,outputFormat,greeting=false,sending=false,finished=false,transcript='',reply='',audioBytes=0,nonSilentBytes=0,lastAudio=0,started=0;
await new Promise((resolve,reject)=>{
 const deadline=setTimeout(()=>finish(Error('Audio round trip did not complete within 90 seconds')),90000);
 const check=setInterval(()=>{if(reply&&Date.now()-lastAudio>1500&&audioProof({transcript,reply,audioBytes,nonSilentBytes}))finish();},250);
 function finish(error){if(finished)return;finished=true;clearTimeout(deadline);clearInterval(check);socket.close();error?reject(error):resolve();}
 async function sendAudio(){
  if(sending||!format||!greeting)return;sending=true;
  // Fixed informational utterance: this probe cannot confirm or create a sale.
  const text='What grooming services do you offer for my dog Bruno?';
  const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(voice)+'?output_format='+encodeURIComponent(format),{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({text,model_id:'eleven_multilingual_v2'}),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error('Synthetic caller speech generation failed: '+r.status);
  const audio=Buffer.from(await r.arrayBuffer()),f=audioFormat(format);
  if(audio.length<1000||audio.length>f.rate*f.bytesPerSample*30)throw Error('Invalid synthetic caller audio size');
  await delay(1500);started=Date.now();
  const chunk=Math.floor(f.rate*f.bytesPerSample/10),input=Buffer.concat([audio,Buffer.alloc(f.rate*f.bytesPerSample*2,f.silence)]);
  for(let i=0;i<input.length&&!finished;i+=chunk){socket.send(JSON.stringify({user_audio_chunk:input.subarray(i,i+chunk).toString('base64')}));await delay(100);}
 }
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_voice_call_id:callId},dynamic_variables:{pawspace_voice_call_id:callId,pawspace_uat:'true'}})));
 socket.addEventListener('message',event=>{try{
  const d=JSON.parse(String(event.data));
  if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
  if(d.type==='conversation_initiation_metadata'){
   const m=d.conversation_initiation_metadata_event;format=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;audioFormat(format);audioFormat(outputFormat);
   if(m.conversation_id)console.log('::add-mask::'+m.conversation_id);
   console.log('VOICE_AUDIO_FORMATS='+JSON.stringify({input:format,output:outputFormat}));void sendAudio().catch(finish);
  }
  if(d.type==='user_transcript'&&started){transcript=String(d.user_transcription_event?.user_transcript||'');console.log('VOICE_AUDIO_TRANSCRIPT='+JSON.stringify({text:transcript,ms:Date.now()-started}));}
  if(d.type==='audio'&&transcript){const b=Buffer.from(d.audio_event?.audio_base_64||'','base64');audioBytes+=b.length;const silence=audioFormat(outputFormat).silence;for(const byte of b)if(byte!==silence)nonSilentBytes++;lastAudio=Date.now();}
  if(d.type==='agent_response'){
   const text=String(d.agent_response_event?.agent_response||'');
   if(!greeting){greeting=true;void sendAudio().catch(finish);}
   else if(transcript){reply=text;console.log('VOICE_AUDIO_REPLY='+JSON.stringify({text:reply.slice(0,900),ms:Date.now()-started}));if(/waiting for a PawSpace team member|routing this to a PawSpace team member|cannot continue the booking/i.test(reply))finish(Error('Audio turn handed off instead of answering'));}
  }
  if(d.type==='error')finish(Error('Agent audio socket returned error'));
 }catch(e){finish(e);}});
 socket.addEventListener('error',()=>finish(Error('Agent audio transport error')));
 socket.addEventListener('close',()=>{if(!finished)finish(Error('Agent closed before audio proof'));});
});
const after=await verifyVoiceSale({...process.env,VOICE_SALE_ACTION:'verify-voice-sale'});
if(JSON.stringify(before.completedBookings)!==JSON.stringify(after.completedBookings))throw Error('Informational audio probe changed booking set');
console.log('VOICE_AUDIO_PROOF='+JSON.stringify({passed:true,dialed:false,syntheticCaller:true,transcript,reply,audioBytes,nonSilentBytes,inputFormat:format,outputFormat,bookingSetUnchanged:true}));
