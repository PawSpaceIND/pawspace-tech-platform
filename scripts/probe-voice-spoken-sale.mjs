// Explicitly authorized staging-only synthetic speech sale. No telephony API.
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyVoiceSale} from './verify-voice-sale.mjs';
import {assertSaleBaseline,assertSpokenQuote,assertSpokenBooking,assertSandboxSale} from './voice-spoken-sale-guards.mjs';
import {audioFormat,createAudioProbeState,applyAudioProbeEvent,greetingPlaybackFinished,isHandoffReply} from './voice-audio-proof.mjs';
import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
if(env.VOICE_SALE_ACTION!=='probe-spoken-sale-sandbox'||! /^[a-f0-9]{40}$/.test(env.EXPECTED_STAGING_SHA||''))throw Error('Explicit spoken sandbox sale and exact staging SHA required');
const cfHeaders={authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
async function api(path){const r=await fetch(cf+path,{headers:cfHeaders,signal:AbortSignal.timeout(30000)}),b=await r.json();if(!r.ok||!b.success)throw Error('Staging version inspection failed');return b.result;}
async function checkRevision(){
 const d=await api('/workers/scripts/pawspace-staging/deployments'),active=d.deployments?.[0];
 if(active?.versions?.length!==1||active.versions[0].percentage!==100)throw Error('One active staging version required');
 const v=await api('/workers/scripts/pawspace-staging/versions/'+active.versions[0].version_id);
 if(v.annotations?.['workers/message']!=='staging '+env.EXPECTED_STAGING_SHA)throw Error('Staging revision drift');
 const bindings=v.resources?.bindings||[],vars=Object.fromEntries(bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
 if(!bindings.some(x=>x.type==='d1'&&(x.id??x.database_id)===env.STAGING_D1_ID)||vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='true')throw Error('Deployed sandbox isolation not proven');
 console.log('SPOKEN_SALE_REVISION='+env.EXPECTED_STAGING_SHA);
}
async function inspect(bookingId='',capture=false){
 await checkRevision();
 const report=await verifyVoiceSale({...env,VOICE_SALE_ACTION:capture?'capture-voice-sale-sandbox':'probe-agent-socket',SALE_BOOKING_ID:bookingId,VOICE_SALE_FULL_INVENTORY:'true'});
 if(report.aiPaused)throw Error('Paused voice context');return report;
}
const before=await inspect();assertSaleBaseline(before);
const headers={'xi-api-key':env.ELEVENLABS_API_KEY};
const cr=await fetch('https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),config=await cr.json();
if(!cr.ok||config.conversation_config?.agent?.prompt?.custom_llm?.url!==origin+'/api/elevenlabs/v1')throw Error('Agent must use exact staging backend');
const dir=await mkdtemp(join(tmpdir(),'amaya-spoken-'));
async function pcm(text,name){const wav=join(dir,name+'.wav'),raw=join(dir,name+'.pcm');execFileSync('espeak-ng',['-s','150','-w',wav,text]);execFileSync('ffmpeg',['-loglevel','error','-y','-i',wav,'-ar','16000','-ac','1','-f','s16le',raw]);return readFile(raw);}
const quoteAudio=await pcm('Please prepare an Essential Bath grooming booking for my saved dog Bruno, one healthy adult dog with no aggression or medical issues, at 12, 100 Feet Road, Indiranagar, Bengaluru, 560038, tomorrow at 11 AM. Please show the quote before booking.','quote');
const yesAudio=await pcm('Yes, proceed.','confirm');
const sr=await fetch('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),signed=await sr.json();
if(!sr.ok||!signed.signed_url)throw Error('Agent socket authorization refused');
const socket=new WebSocket(signed.signed_url);
let state=createAudioProbeState(),format,outputFormat,error,closed=false,firstAudio=0,lastAudio=0,bytes=0;
let audioStarted=false;
function playback(){return greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstAudio,lastAudioAt:lastAudio,bytes,format:outputFormat});}
socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_voice_call_id:env.UAT_VOICE_CALL_ID},dynamic_variables:{pawspace_voice_call_id:env.UAT_VOICE_CALL_ID,pawspace_uat:'true'}})));
socket.addEventListener('message',event=>{try{
 const d=JSON.parse(String(event.data));
 if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
 if(d.type==='conversation_initiation_metadata'){format=d.conversation_initiation_metadata_event.user_input_audio_format;outputFormat=d.conversation_initiation_metadata_event.agent_output_audio_format;audioFormat(outputFormat);if(format!=='pcm_16000')throw Error('PCM16000 caller required');}
 if(d.type==='interruption')throw Error('Interrupted speech cannot certify this sale');
 const change=applyAudioProbeEvent(state,d,{now:Date.now(),outputFormat});
 if(d.type==='audio'&&(!audioStarted||state.transcript)){const n=Buffer.from(d.audio_event?.audio_base_64||'','base64').length;if(n){firstAudio ||= Date.now();lastAudio=Date.now();bytes+=n;}}
 if((change==='reply'||change==='correction')&&isHandoffReply(state.reply))throw Error('Spoken sale handed off');
 if(d.type==='error')throw Error('Agent reported error');
 }catch(e){error=e;}});
socket.addEventListener('error',()=>{error=Error('Socket transport failed');});socket.addEventListener('close',()=>{closed=true;});
async function waitFor(predicate){const end=Date.now()+120000;while(!predicate()){if(error)throw error;if(closed)throw Error('Agent disconnected');if(Date.now()>end)throw Error('Spoken turn timed out');await delay(100);}if(error)throw error;}
async function turn(audio,expected){
 await checkRevision();
 state={...createAudioProbeState(),greeting:true,listening:true};firstAudio=lastAudio=bytes=0;audioStarted=true;
 const input=Buffer.concat([Buffer.alloc(16000),audio,Buffer.alloc(64000)]);
 for(let i=0;i<input.length;i+=3200){if(error)throw error;socket.send(JSON.stringify({user_audio_chunk:input.subarray(i,i+3200).toString('base64')}));await delay(100);}
 await waitFor(()=>expected.test(state.transcript)&&isSubstantiveVoiceReply(state.reply)&&!isHandoffReply(state.reply)&&state.audioBytes>1600&&state.nonSilentBytes>100&&playback());
 console.log('SPOKEN_SALE_TURN='+JSON.stringify({transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes}));
 return {...state};
}
try{
 await waitFor(()=>format&&state.greeting&&playback());
 await turn(quoteAudio,/(?=.*grooming)(?=.*bruno)(?=.*tomorrow)(?=.*11)/i);
 const quoted=await inspect(),offerId=assertSpokenQuote(before,quoted);
 // Only persisted, unexpired offer evidence permits explicit spoken confirmation.
 console.log('SPOKEN_SALE_QUOTE='+JSON.stringify({offerId,summary:quoted.pendingOffers[0].summary}));
 await turn(yesAudio,/\byes\b/i);
 const confirmed=await inspect(),bookingId=assertSpokenBooking(before,confirmed);
 const booking=await inspect(bookingId);if(booking.booking?.id!==bookingId)throw Error('Canonical booking missing');
 const captured=await inspect(bookingId,true);assertSandboxSale(captured,bookingId);
 await checkRevision();
 console.log('SPOKEN_SALE_PROOF='+JSON.stringify({passed:true,dialed:false,syntheticCaller:true,syntheticPayment:true,bookingId,offerId,booking:captured.booking,replayChecked:captured.replayChecked}));
}finally{socket.close();}
