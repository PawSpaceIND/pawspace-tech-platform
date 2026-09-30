// Three genuine ASR -> canonical PawSpace brain -> TTS sessions. No telephony dial API.
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
import {assertDemoResponse,assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';
import {createAudioProbeState,applyAudioProbeEvent,audioFormat,greetingPlaybackFinished} from './voice-audio-proof.mjs';
import {verifyFinalConversation} from './voice-final-conversation-proof.mjs';
import {isSubstantiveVoiceReply,isControlledVoiceReply} from './voice-uat-evidence.mjs';
import {createAlignedReplyTiming} from './voice-aligned-reply-timing.mjs';
import {PREMIUM_AUDIO_SCENARIOS} from './premium-audio-scenarios.mjs';
import {readDemoJson,validateDemoContext,validateDemoSignedUrl,actionsMaskCommand,createDemoEventBoundary} from './voice-demo-output-boundary.mjs';
import {premiumArtifactPaths,validatedPremiumReport,serializePremiumReport,serializePremiumSummary} from './premium-audio-output-boundary.mjs';
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
const before=await bookingIds(),paymentsBefore=await paymentIds();await mkdir('voice-demo-results',{recursive:true});const reports=[];
for(const sessionScenario of PREMIUM_AUDIO_SCENARIOS){
 const turns=[],sessionAudio=[],eventBoundary=createDemoEventBoundary(),paths=premiumArtifactPaths(sessionScenario.id);let sessionInputBytes=0;
 await isolation();
 const context=validateDemoContext(await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'}));
 console.log(actionsMaskCommand(context.callId));console.log(actionsMaskCommand(context.threadId));
 const signedResponse=await fetch(eleven+'/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),signed=await readDemoJson(signedResponse);if(!signedResponse.ok||!signed.signed_url)throw Error('Demo socket authorization refused');const signedUrl=validateDemoSignedUrl(signed.signed_url);console.log(actionsMaskCommand(signedUrl));
 const socket=new WebSocket(signedUrl),initialState=createAudioProbeState();let state=initialState;let inputFormat,outputFormat,conversationId,error,closed=false,greetingBytes=0,firstGreeting=0,lastGreeting=0;const returnedAudio=[];let firstAudio=0,lastAudio=0,replyEventAt=0,alignedTiming=createAlignedReplyTiming();
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:context.threadId},dynamic_variables:{pawspace_uat:'true'}})));
 socket.addEventListener('message',event=>{try{
  const {event:d,audio}=eventBoundary.parse(String(event.data));
  if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
  if(d.type==='conversation_initiation_metadata'){const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;inputFormat=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;audioFormat(outputFormat);if(inputFormat!=='pcm_16000')throw Error('Demo microphone requires PCM16000');}
  if(d.type==='audio'){const bytes=audio;if(!state.listening){firstGreeting ||= Date.now();lastGreeting=Date.now();greetingBytes+=bytes.length;}else if(state.transcript){alignedTiming.observe(d.audio_event,Date.now());returnedAudio.push(bytes);firstAudio ||=Date.now();lastAudio=Date.now();}}
  applyAudioProbeEvent(state,d,{now:Date.now(),outputFormat});
  if(d.type==='agent_response'&&state.transcript&&isSubstantiveVoiceReply(state.reply))replyEventAt=Date.now();
  if(d.type==='error')throw Error('Demo voice provider error');
 }catch(e){error=e;}});
 socket.addEventListener('error',()=>{error=Error('Demo audio transport failed');});socket.addEventListener('close',()=>{closed=true;});
 async function waitFor(predicate,{microphoneOpen=false}={}){const until=Date.now()+100000;while(!predicate()){if(error)throw error;if(closed)throw Error('Demo disconnected');if(Date.now()>until)throw Error('Demo timed out');
  // Match an open SDK microphone: silence is still input audio while the agent answers.
  // Stopping chunks is a transport gap, not an explicit end-of-turn signal.
  if(microphoneOpen)socket.send(JSON.stringify({user_audio_chunk:Buffer.alloc(3200).toString('base64')}));
  await delay(100);}if(error)throw error;}
 try{
  await waitFor(()=>state.greeting&&inputFormat&&greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstGreeting,lastAudioAt:lastGreeting,bytes:greetingBytes,format:outputFormat}));
  for(const scenario of sessionScenario.turns){
  state={...createAudioProbeState(),greeting:true,listening:true};returnedAudio.length=0;firstAudio=0;lastAudio=0;replyEventAt=0;alignedTiming=createAlignedReplyTiming();
  const wav=execFileSync('espeak-ng',['--stdout','-s','150',scenario.text],{maxBuffer:2097152,timeout:10000});
  const pcm=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:2097152,timeout:10000});
  if(pcm.length<1000||pcm.length>960000)throw Error('Invalid synthetic demo audio');
  state.listening=true;const input=Buffer.concat([Buffer.alloc(16000),pcm,Buffer.alloc(64000)]),started=Date.now();
  for(let offset=0;offset<input.length;offset+=3200){if(error)throw error;if(closed)throw Error('Demo disconnected during speech');socket.send(JSON.stringify({user_audio_chunk:input.subarray(offset,offset+3200).toString('base64')}));await delay(100);}
  await waitFor(()=>Boolean(state.transcript)&&(isSubstantiveVoiceReply(state.reply)||isControlledVoiceReply(state.reply))&&state.reply.length>=30&&state.audioBytes>1600&&state.nonSilentBytes>100&&state.playbackEndAt>0&&Date.now()>=state.playbackEndAt+1500&&Date.now()-state.lastAudio>1500,{microphoneOpen:true});
  // Preserve observed speech even when a semantic check fails; never substitute scripted audio.
  const observedRaw=Buffer.concat(returnedAudio),observedPaths=premiumArtifactPaths(sessionScenario.id,scenario.id);
  await writeFile(observedPaths.raw,observedRaw);
  const observedFormat=audioFormat(outputFormat);
  execFileSync('ffmpeg',['-loglevel','error','-y','-f',outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(observedFormat.rate),'-ac','1','-i',observedPaths.raw,observedPaths.wav]);
  assertDemoResponse(scenario,state);if(scenario.forbidden?.test(state.reply))throw Error('Premium audio turn violated '+scenario.id);
  const playbackCompletedMs=Date.now()-started,utteranceEndAt=started+(16000+pcm.length)/32000*1000;sessionInputBytes+=pcm.length;
  turns.push({scenario:scenario.id,prompt:scenario.text,transcript:state.transcript,reply:state.reply,inputToPlaybackCompletedMs:playbackCompletedMs,utteranceEndToFirstAudioMs:firstAudio?Math.max(0,firstAudio-utteranceEndAt):null,utteranceEndToReplyEventMs:replyEventAt?Math.max(0,replyEventAt-utteranceEndAt):null,utteranceEndToAlignedReplyChunkMs:alignedTiming.result(state.reply,utteranceEndAt),audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,playbackComplete:!state.replyInterrupted});
  sessionAudio.push(...returnedAudio,Buffer.alloc(audioFormat(outputFormat).rate*audioFormat(outputFormat).bytesPerSample/2,audioFormat(outputFormat).silence));
  if(JSON.stringify(before)!==JSON.stringify(await bookingIds())||JSON.stringify(paymentsBefore)!==JSON.stringify(await paymentIds()))throw Error('Informational audio turn changed bookings or payments');
  }
  socket.close();
  const proof=await verifyFinalConversation({key:env.ELEVENLABS_API_KEY,conversationId,agentId:env.GROOMING_AGENT_ID,turns:turns.map(turn=>({transcript:turn.transcript,reply:turn.reply})),liveAudioEvidence:{conversationId,inputMode:'audio',inputBytes:sessionInputBytes,outputBytes:turns.reduce((sum,turn)=>sum+turn.audioBytes,0),nonSilentBytes:turns.reduce((sum,turn)=>sum+turn.nonSilentBytes,0),playbackComplete:turns.every(turn=>turn.playbackComplete)},request:(url,options)=>fetch(url.replace('https://api.elevenlabs.io',eleven),options)});
  const f=audioFormat(outputFormat),raw=Buffer.concat(sessionAudio);await writeFile(paths.raw,raw);
  execFileSync('ffmpeg',['-loglevel','error','-y','-f',outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(f.rate),'-ac','1','-i',paths.raw,paths.wav]);
  const report=validatedPremiumReport({scenario:sessionScenario.id,revision:env.EXPECTED_SHA,turns,proof,dialed:false,engine:'elevenlabs_with_pawspace_brain',carrierVerified:false,premiumCertified:false,scope:'Actual staged ASR/brain/TTS informational conversations; no booking confirmation, delivered checkout, payment or provider acceptance certification; first-audio metrics may include acknowledgement speech'});reports.push(report);await writeFile(paths.json,serializePremiumReport(report));
  await app({action:'complete',callId:context.callId,outcome:'synthetic_audio_demo',disposition:'info_shared'});
  console.log('VOICE_DEMO_RESULT='+serializePremiumReport(report));
 }catch(e){
  const failed=validatedPremiumReport({passed:false,revision:env.EXPECTED_SHA,scenario:sessionScenario.id,turns,transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,dialed:false});
  console.log('VOICE_DEMO_FAILED='+serializePremiumReport(failed));await writeFile(paths.failed,serializePremiumReport(failed));
  socket.close();await app({action:'transport_failure',callId:context.callId,reason:'synthetic_audio_demo_failed',reconnected:false}).catch(()=>{});throw Error('Premium audio demo failed before certification');
 }
}
await isolation();if(JSON.stringify(before)!==JSON.stringify(await bookingIds())||JSON.stringify(paymentsBefore)!==JSON.stringify(await paymentIds()))throw Error('Informational demos changed bookings or payments');
await writeFile('voice-demo-results/conversations.json',serializePremiumSummary(reports));
console.log('THREE_PREMIUM_INFORMATIONAL_AUDIO_SESSIONS_PASSED='+JSON.stringify({count:reports.length,turns:reports.reduce((sum,report)=>sum+report.turns.length,0),premiumCertified:false,dialed:false,bookingSetUnchanged:true,nativeCarrierCertified:false}));
