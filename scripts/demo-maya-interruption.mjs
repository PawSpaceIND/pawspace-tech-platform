// Actual microphone interruption of staged Maya; no telephony dial or confirmation.
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
import {assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';
import {createAudioProbeState,applyAudioProbeEvent,audioFormat,greetingPlaybackFinished} from './voice-audio-proof.mjs';

import {isSubstantiveVoiceReply,isControlledVoiceReply} from './voice-uat-evidence.mjs';
import {INTERRUPTION_PROMPTS,assertInterruptionConversation} from './voice-interruption-proof.mjs';
import {readDemoJson,validateDemoContext,validateDemoSignedUrl,actionsMaskCommand,createDemoEventBoundary} from './voice-demo-output-boundary.mjs';

const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
authorizedLaunchTester(env);
if(!/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA||'')||!env.SPECIALIST_CUSTOMER_ID||!env.ELEVENLABS_API_KEY||!env.GROOMING_AGENT_ID)throw Error('Exact demo prerequisites missing');
const eleven=(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(eleven))throw Error('Approved voice provider region required');
const headers={'xi-api-key':env.ELEVENLABS_API_KEY};
const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
async function readCf(path,body){const r=await fetch(cf+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok||b.success!==true)throw Error('Staging verification failed');return b.result;}
async function isolation(verifyRuntime=true){
 const db=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));if(db.name!=='pawspace-staging'||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Isolated demo database required');
 const settings=await readCf('/workers/scripts/pawspace-staging/settings');
 if(settings.annotations?.['workers/message']!=='staging '+env.EXPECTED_SHA)throw Error('Demo staging revision changed');
 const vars=Object.fromEntries(settings.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
 assertDemoPhonePauseMetadata(vars);
 if(verifyRuntime){const readiness=await fetch(origin+'/api/voice-outbound',{headers:{cookie},signal:AbortSignal.timeout(30000)}),body=await readDemoJson(readiness);if(!readiness.ok)throw Error('Authenticated runtime phone-shutdown read refused');assertDemoRuntimePhonePause(vars,body.data?.gate);}
 if(vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='true'||!settings.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Demo sandbox bindings not proven');
}
async function paymentIds(){const rows=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT id FROM booking_payments WHERE customer_id=? ORDER BY id',params:[env.SPECIALIST_CUSTOMER_ID]});if(!Array.isArray(rows)||rows.length!==1||rows[0]?.success===false||!Array.isArray(rows[0]?.results))throw Error('Business-state readback refused');return rows[0].results.map(x=>x.id);}
async function bookingIds(){const rows=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT id FROM canonical_bookings WHERE customer_id=? ORDER BY id',params:[env.SPECIALIST_CUSTOMER_ID]});if(!Array.isArray(rows)||rows.length!==1||rows[0]?.success===false||!Array.isArray(rows[0]?.results))throw Error('Business-state readback refused');return rows[0].results.map(x=>x.id);}
await isolation(false);
const configResponse=await fetch(eleven+'/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),config=await readDemoJson(configResponse);
if(!configResponse.ok||config.conversation_config?.agent?.prompt?.custom_llm?.url!==origin+'/api/elevenlabs/v1')throw Error('Demo must use the actual PawSpace staging brain');
const login=await fetch(origin+'/api/staging-login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];if(login.status!==200||!cookie.startsWith('pawspace_uat='))throw Error('Authenticated demo login refused');
await isolation();
async function app(body){const r=await fetch(origin+'/api/ai-voice-uat',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok)throw Error('Governed simulator request refused ('+r.status+')');return b.data;}
const identity=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT primary_phone FROM canonical_customers WHERE id=?',params:[env.SPECIALIST_CUSTOMER_ID]});
const customerPhone=String(identity[0]?.results?.[0]?.primary_phone||'').replace(/\D/g,'');
const testerPhone=authorizedLaunchTester(env).replace(/\D/g,'');
if(![testerPhone,testerPhone.slice(2)].includes(customerPhone))throw Error('Demo customer does not own the authorized tester number');
const before=await bookingIds(),paymentsBefore=await paymentIds();await mkdir('voice-interruption-results',{recursive:true});
const context=validateDemoContext(await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'}));
console.log(actionsMaskCommand(context.callId));console.log(actionsMaskCommand(context.threadId));
const signedResponse=await fetch(eleven+'/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),signed=await readDemoJson(signedResponse);if(!signedResponse.ok)throw Error('Interruption socket authorization refused');const signedUrl=validateDemoSignedUrl(signed.signed_url);console.log(actionsMaskCommand(signedUrl));
const socket=new WebSocket(signedUrl),boundary=createDemoEventBoundary();let state=createAudioProbeState(),inputFormat,outputFormat,conversationId,error,closed=false,phase='greeting',interruptionEvents=0,firstGreeting=0,lastGreeting=0,greetingBytes=0,firstTurn=null,recoverySeen=false;const recoveryAudio=[];
socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:context.threadId},dynamic_variables:{pawspace_uat:'true'}})));
socket.addEventListener('message',event=>{try{
 const {event:d,audio}=boundary.parse(String(event.data));
 if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
 if(d.type==='conversation_initiation_metadata'){const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;inputFormat=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;audioFormat(outputFormat);if(inputFormat!=='pcm_16000')throw Error('Approved microphone format required');}
 if(d.type==='interruption'&&phase==='barge'){interruptionEvents++;}
 if(d.type==='user_transcript'&&phase==='barge'){
  if(!firstTurn||!INTERRUPTION_PROMPTS[1].recognized.test(String(d.user_transcription_event?.user_transcript||'')))throw Error('Recovery ASR differs from controlled speech');
  const interruptedEventId=state.interruptedEventId;state={...createAudioProbeState(),greeting:true,listening:true,interruptedEventId};recoverySeen=true;
 }
 const outcome=applyAudioProbeEvent(state,d,{now:Date.now(),outputFormat});
 if(d.type==='audio'&&phase==='greeting'){firstGreeting ||=Date.now();lastGreeting=Date.now();greetingBytes+=audio.length;}
 if(outcome==='audio'&&recoverySeen)recoveryAudio.push(audio);
 if(d.type==='error')throw Error('Interruption provider error');
 }catch(e){error=e;}});
socket.addEventListener('error',()=>{error=Error('Interruption transport failed');});socket.addEventListener('close',()=>{closed=true;});
async function waitFor(predicate){const until=Date.now()+70000;while(!predicate()){if(error)throw error;if(closed)throw Error('Interruption socket disconnected');if(Date.now()>until)throw Error('Interruption probe timed out');if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({user_audio_chunk:Buffer.alloc(3200).toString('base64')}));await delay(100);}if(error)throw error;}
let inputBytes=0;
async function speak(text,{leadSilence=true,beforeSend=()=>{}}={}){
 const wav=execFileSync('espeak-ng',['--stdout','-s','150',text],{maxBuffer:2097152,timeout:10000});const pcm=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:2097152,timeout:10000});
 if(pcm.length<1000||pcm.length>960000)throw Error('Invalid interruption microphone audio');inputBytes+=pcm.length;const input=Buffer.concat([Buffer.alloc(leadSilence?16000:0),pcm,Buffer.alloc(32000)]);
 beforeSend();
 for(let offset=0;offset<input.length;offset+=3200){if(error)throw error;if(closed)throw Error('Interruption socket disconnected during speech');socket.send(JSON.stringify({user_audio_chunk:input.subarray(offset,offset+3200).toString('base64')}));await delay(100);}
}
try{
 await waitFor(()=>state.greeting&&inputFormat&&greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstGreeting,lastAudioAt:lastGreeting,bytes:greetingBytes,format:outputFormat}));
 state={...createAudioProbeState(),greeting:true,listening:true};phase='first';await speak(INTERRUPTION_PROMPTS[0].text);
 await waitFor(()=>INTERRUPTION_PROMPTS[0].recognized.test(state.transcript)&&isSubstantiveVoiceReply(state.reply)&&state.audioBytes>1600&&state.playbackEndAt-Date.now()>=2000);
 firstTurn={transcript:state.transcript,reply:state.reply};let remainingAtBarge=0;phase='barge';await speak(INTERRUPTION_PROMPTS[1].text,{leadSilence:false,beforeSend:()=>{remainingAtBarge=state.playbackEndAt-Date.now();if(remainingAtBarge<1000)throw Error('First reply finished before interruption speech');}});
 await waitFor(()=>interruptionEvents>0&&recoverySeen&&isSubstantiveVoiceReply(state.reply)&&/walk/i.test(state.reply)&&!isControlledVoiceReply(state.reply)&&!state.replyInterrupted&&state.audioBytes>1600&&state.nonSilentBytes>100&&state.playbackEndAt>0&&Date.now()>=state.playbackEndAt+1500&&Date.now()-state.lastAudio>1500);
 const second={transcript:state.transcript,reply:state.reply},observed={interruptionEvents,playbackRemainingAtBargeMs:remainingAtBarge,inputBytes,recoveryAudioBytes:state.audioBytes,recoveryNonSilentBytes:state.nonSilentBytes,recoveryPlaybackComplete:true};socket.close();
 let proof;for(let attempt=0;attempt<30;attempt++){const r=await fetch(eleven+'/v1/convai/conversations/'+encodeURIComponent(conversationId),{headers,signal:AbortSignal.timeout(15000)}),detail=await readDemoJson(r);if(!r.ok)throw Error('Final interruption conversation read refused');if(['done','failed'].includes(detail.status)){proof=assertInterruptionConversation(detail,{agentId:env.GROOMING_AGENT_ID,conversationId,turns:[firstTurn,second],observed});break;}await delay(2000);}if(!proof)throw Error('Final interruption conversation did not settle');
 await isolation();if(JSON.stringify(before)!==JSON.stringify(await bookingIds())||JSON.stringify(paymentsBefore)!==JSON.stringify(await paymentIds()))throw Error('Interruption probe changed booking or payment sets');
 const raw=Buffer.concat(recoveryAudio),format=audioFormat(outputFormat);await writeFile('voice-interruption-results/recovery.raw',raw);execFileSync('ffmpeg',['-loglevel','error','-y','-f',outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(format.rate),'-ac','1','-i','voice-interruption-results/recovery.raw','voice-interruption-results/recovery.wav']);
 const report={revision:env.EXPECTED_SHA,scope:'Actual synthetic ASR/brain/TTS interruption and recovery; no handset or purchase acceptance',...proof,observed,turns:[firstTurn,second],bookingSetUnchanged:true,paymentSetUnchanged:true};const serialized=JSON.stringify(report,null,2);if(Buffer.byteLength(serialized)>128*1024)throw Error('Interruption report exceeds limit');await writeFile('voice-interruption-results/report.json',serialized);
 await app({action:'complete',callId:context.callId,outcome:'synthetic_interruption_probe',disposition:'info_shared'});console.log('INTERRUPTION_RECOVERY_PROOF='+serialized);
}catch(e){socket.close();await app({action:'transport_failure',callId:context.callId,reason:'synthetic_interruption_probe_failed',reconnected:false}).catch(()=>{});await writeFile('voice-interruption-results/failure.json',JSON.stringify({revision:env.EXPECTED_SHA,passed:false,dialed:false,premiumCertified:false,reason:'Interruption recovery not certified'}));throw Error('Interruption recovery not certified');}
