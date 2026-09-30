// Three genuine ASR -> canonical PawSpace brain -> TTS sessions. No telephony dial API.
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
import {VOICE_DEMO_SCENARIOS,assertDemoResponse,assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';
import {createAudioProbeState,applyAudioProbeEvent,audioFormat,greetingPlaybackFinished} from './voice-audio-proof.mjs';
import {verifyFinalConversation} from './voice-final-conversation-proof.mjs';
import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
authorizedLaunchTester(env);
if(!/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA||'')||!env.SPECIALIST_CUSTOMER_ID||!env.ELEVENLABS_API_KEY||!env.GROOMING_AGENT_ID)throw Error('Exact demo prerequisites missing');
const eleven=(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(eleven))throw Error('Approved voice provider region required');
const headers={'xi-api-key':env.ELEVENLABS_API_KEY};
const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
async function readCf(path,body){const r=await fetch(cf+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await r.json();if(!r.ok||b.success!==true)throw Error('Staging verification failed');return b.result;}
async function isolation(verifyRuntime=true){
 const db=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));if(db.name!=='pawspace-staging'||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Isolated demo database required');
 const settings=await readCf('/workers/scripts/pawspace-staging/settings');
 if(settings.annotations?.['workers/message']!=='staging '+env.EXPECTED_SHA)throw Error('Demo staging revision changed');
 const vars=Object.fromEntries(settings.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
 assertDemoPhonePauseMetadata(vars);
 if(verifyRuntime){const readiness=await fetch(origin+'/api/voice-outbound',{headers:{cookie},signal:AbortSignal.timeout(30000)}),body=await readiness.json();if(!readiness.ok)throw Error('Authenticated runtime phone-shutdown read refused');assertDemoRuntimePhonePause(vars,body.data?.gate);}
 if(vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='true'||!settings.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Demo sandbox bindings not proven');
}
async function bookingIds(){const rows=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT id FROM canonical_bookings WHERE customer_id=? ORDER BY id',params:[env.SPECIALIST_CUSTOMER_ID]});return rows[0]?.results?.map(x=>x.id)||[];}
await isolation(false);
const configResponse=await fetch(eleven+'/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),config=await configResponse.json();
if(!configResponse.ok||config.conversation_config?.agent?.prompt?.custom_llm?.url!==origin+'/api/elevenlabs/v1')throw Error('Demo must use the actual PawSpace staging brain');
const login=await fetch(origin+'/api/staging-login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];if(login.status!==200||!cookie.startsWith('pawspace_uat='))throw Error('Authenticated demo login refused');
await isolation();
async function app(body){const r=await fetch(origin+'/api/ai-voice-uat',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)}),b=await r.json();if(!r.ok)throw Error('Governed simulator request refused ('+r.status+')');return b.data;}
const identity=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT primary_phone FROM canonical_customers WHERE id=?',params:[env.SPECIALIST_CUSTOMER_ID]});
const customerPhone=String(identity[0]?.results?.[0]?.primary_phone||'').replace(/\D/g,'');
const testerPhone=authorizedLaunchTester(env).replace(/\D/g,'');
if(![testerPhone,testerPhone.slice(2)].includes(customerPhone))throw Error('Demo customer does not own the authorized tester number');
const before=await bookingIds();await mkdir('voice-demo-results',{recursive:true});const reports=[];
for(const scenario of VOICE_DEMO_SCENARIOS){
 await isolation();
 const context=await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'});
 console.log('::add-mask::'+context.callId);console.log('::add-mask::'+context.threadId);
 const signedResponse=await fetch(eleven+'/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),signed=await signedResponse.json();if(!signedResponse.ok||!signed.signed_url)throw Error('Demo socket authorization refused');console.log('::add-mask::'+signed.signed_url);
 const socket=new WebSocket(signed.signed_url),state=createAudioProbeState();let inputFormat,outputFormat,conversationId,error,closed=false,greetingBytes=0,firstGreeting=0,lastGreeting=0;const returnedAudio=[];let firstAudio=0,lastAudio=0;
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:context.threadId},dynamic_variables:{pawspace_uat:'true'}})));
 socket.addEventListener('message',event=>{try{
  const d=JSON.parse(String(event.data));
  if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
  if(d.type==='conversation_initiation_metadata'){const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;inputFormat=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;audioFormat(outputFormat);if(inputFormat!=='pcm_16000')throw Error('Demo microphone requires PCM16000');console.log('::add-mask::'+conversationId);}
  if(d.type==='audio'){const bytes=Buffer.from(d.audio_event?.audio_base_64||'','base64');if(!state.listening){firstGreeting ||= Date.now();lastGreeting=Date.now();greetingBytes+=bytes.length;}else if(state.transcript){returnedAudio.push(bytes);firstAudio ||=Date.now();lastAudio=Date.now();}}
  applyAudioProbeEvent(state,d,{now:Date.now(),outputFormat});
  if(d.type==='error')throw Error('Demo voice provider error');
 }catch(e){error=e;}});
 socket.addEventListener('error',()=>{error=Error('Demo audio transport failed');});socket.addEventListener('close',()=>{closed=true;});
 async function waitFor(predicate){const until=Date.now()+100000;while(!predicate()){if(error)throw error;if(closed)throw Error('Demo disconnected');if(Date.now()>until)throw Error('Demo timed out');await delay(100);}if(error)throw error;}
 try{
  await waitFor(()=>state.greeting&&inputFormat&&greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstGreeting,lastAudioAt:lastGreeting,bytes:greetingBytes,format:outputFormat}));
  const wav=execFileSync('espeak-ng',['--stdout','-s','150',scenario.text],{maxBuffer:2097152,timeout:10000});
  const pcm=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:2097152,timeout:10000});
  if(pcm.length<1000||pcm.length>960000)throw Error('Invalid synthetic demo audio');
  state.listening=true;const input=Buffer.concat([Buffer.alloc(16000),pcm,Buffer.alloc(64000)]),started=Date.now();
  for(let offset=0;offset<input.length;offset+=3200){if(error)throw error;if(closed)throw Error('Demo disconnected during speech');socket.send(JSON.stringify({user_audio_chunk:input.subarray(offset,offset+3200).toString('base64')}));await delay(100);}
  await waitFor(()=>scenario.recognized.test(state.transcript)&&isSubstantiveVoiceReply(state.reply)&&scenario.reply.test(state.reply)&&state.reply.length>=30&&state.audioBytes>1600&&state.nonSilentBytes>100&&state.playbackEndAt>0&&Date.now()>=state.playbackEndAt+1500&&Date.now()-state.lastAudio>1500);
  console.log('VOICE_DEMO_OBSERVED='+JSON.stringify({scenario:scenario.id,transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes}));
  assertDemoResponse(scenario,state);const playbackCompletedMs=Date.now()-started;socket.close();
  const proof=await verifyFinalConversation({key:env.ELEVENLABS_API_KEY,conversationId,agentId:env.GROOMING_AGENT_ID,turns:[{transcript:state.transcript,reply:state.reply}],liveAudioEvidence:{conversationId,inputMode:'audio',inputBytes:pcm.length,outputBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,playbackComplete:true},request:(url,options)=>fetch(url.replace('https://api.elevenlabs.io',eleven),options)});
  const f=audioFormat(outputFormat),raw=Buffer.concat(returnedAudio);await writeFile('voice-demo-results/'+scenario.id+'.raw',raw);
  execFileSync('ffmpeg',['-loglevel','error','-y','-f',outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(f.rate),'-ac','1','-i','voice-demo-results/'+scenario.id+'.raw','voice-demo-results/'+scenario.id+'.wav']);
  const report={scenario:scenario.id,prompt:scenario.text,transcript:state.transcript,reply:state.reply,inputToPlaybackCompletedMs:playbackCompletedMs,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,proof,dialed:false,engine:'elevenlabs_with_pawspace_brain',carrierVerified:false};reports.push(report);
  await app({action:'complete',callId:context.callId,outcome:'synthetic_audio_demo',disposition:'info_shared'});
  console.log('VOICE_DEMO_RESULT='+JSON.stringify(report));
 }catch(e){
  const failed={passed:false,scenario:scenario.id,transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,error:String(e.message),dialed:false};
  console.log('VOICE_DEMO_FAILED='+JSON.stringify(failed));await writeFile('voice-demo-results/'+scenario.id+'-failed.json',JSON.stringify(failed,null,2));
  socket.close();await app({action:'transport_failure',callId:context.callId,reason:'synthetic_audio_demo_failed',reconnected:false}).catch(()=>{});throw e;
 }
}
await isolation();if(JSON.stringify(before)!==JSON.stringify(await bookingIds()))throw Error('Informational demos changed booking set');
await writeFile('voice-demo-results/conversations.json',JSON.stringify({passed:true,demonstrations:reports,bookingSetUnchanged:true,dialed:false,nativeCarrierCertified:false},null,2));
console.log('THREE_VOICE_DEMOS_PASSED='+JSON.stringify({count:reports.length,dialed:false,bookingSetUnchanged:true,nativeCarrierCertified:false}));
