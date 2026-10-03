import {MAYA_AUDIO_SCENARIOS} from './maya-ten-audio-scenarios.mjs';
// Three genuine ASR -> canonical PawSpace brain -> TTS sessions. No telephony dial API.
import {execFileSync} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
import {assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';
import {createAudioProbeState,applyAudioProbeEvent,audioFormat,greetingPlaybackFinished} from './voice-audio-proof.mjs';
import {verifyFinalConversation} from './voice-final-conversation-proof.mjs';
import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
import {readDemoJson,validateDemoContext,validateDemoSignedUrl,actionsMaskCommand,createDemoEventBoundary,demoArtifactPaths,DEMO_SUMMARY_PATH,validatedDemoReport,serializeDemoReport,serializeDemoSummary} from './voice-demo-output-boundary.mjs';
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
async function bookingIds(){const rows=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT id FROM canonical_bookings WHERE customer_id=? ORDER BY id',params:[env.SPECIALIST_CUSTOMER_ID]});return rows[0]?.results?.map(x=>x.id)||[];}
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

await mkdir('voice-audit-results',{recursive:true});
const before=await bookingIds(),reports=[];
const scrub=t=>String(t||'').replace(/\+?\d{10,15}/g,'[number]').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[email]');
async function runScenario(scenario){
 const result={id:scenario.id,service:scenario.service,goal:scenario.goal,startedAt:new Date().toISOString(),turns:[],errors:[],phoneDialed:false,plannedTurns:scenario.turns.length};
 let socket,context;
 try{
  await isolation();
  context=validateDemoContext(await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'}));
  // Each scenario has an independent synthetic thread; do not inherit a previous staff handoff.
  const threadId='THREAD-AUDIOAUDIT-'+crypto.randomUUID().replaceAll('-','').slice(0,20),now=Date.now();
  await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:"INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open','ai-orchestrator',NULL,?,?)",params:[threadId,env.SPECIALIST_CUSTOMER_ID,now,now]});
  const signedResponse=await fetch(eleven+'/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),signed=await readDemoJson(signedResponse);if(!signedResponse.ok)throw Error('Demo socket authorization refused');
  const signedUrl=validateDemoSignedUrl(signed.signed_url);console.log(actionsMaskCommand(signedUrl));console.log(actionsMaskCommand(threadId));
  socket=new WebSocket(signedUrl);
  const boundary=createDemoEventBoundary();let state=createAudioProbeState(),inputFormat,outputFormat,conversationId,error,closed=false,greetingBytes=0,firstGreeting=0,lastGreeting=0,turnAudio=[],firstResponseAt=0,lastAsrAt=0;
  socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:threadId},dynamic_variables:{pawspace_uat:'true'}})));
  socket.addEventListener('message',event=>{if(error)return;try{
   const {event:d,audio}=boundary.parse(event.data),now=Date.now();
   if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
   if(d.type==='conversation_initiation_metadata'){const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;inputFormat=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;audioFormat(outputFormat);}
   if(d.type==='user_transcript'&&state.listening)lastAsrAt=now;
   if(d.type==='audio'){if(!state.listening){firstGreeting ||=now;lastGreeting=now;greetingBytes+=audio.length;}else if(state.transcript){firstResponseAt ||=now;turnAudio.push(audio);}}
   applyAudioProbeEvent(state,d,{now,outputFormat});if(d.type==='error')throw Error('Demo provider error');
  }catch(e){error=e;socket.close();}});
  socket.addEventListener('error',()=>{error=Error('Demo audio transport failed');});socket.addEventListener('close',()=>{closed=true;});
  async function waitFor(predicate,microphoneOpen=false){const until=Date.now()+75000;while(!predicate()){if(error)throw error;if(closed)throw Error('Demo disconnected');if(Date.now()>until)throw Error('No completed audible reply within 75 seconds');if(microphoneOpen)socket.send(JSON.stringify({user_audio_chunk:Buffer.alloc(3200).toString('base64')}));await delay(100);}if(error)throw error;}
  await waitFor(()=>state.greeting&&inputFormat&&greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstGreeting,lastAudioAt:lastGreeting,bytes:greetingBytes,format:outputFormat}));
  for(let index=0;index<scenario.turns.length;index++){
   const prompt=scenario.turns[index],turn={index:index+1,prompt,transcript:'',reply:'',audioBytes:0,responseAfterAsrMs:null};
   state=createAudioProbeState();state.greeting=true;state.listening=true;turnAudio=[];firstResponseAt=0;lastAsrAt=0;
   try{
    const wav=execFileSync('espeak-ng',['--stdout','-s','165',prompt],{maxBuffer:2097152,timeout:10000});
    const pcm=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:2097152,timeout:10000});
    await writeFile(`voice-audit-results/${scenario.id}-${index+1}-caller.wav`,wav);
    const input=Buffer.concat([Buffer.alloc(16000),pcm,Buffer.alloc(64000)]);
    for(let offset=0;offset<input.length;offset+=3200){if(error)throw error;if(closed)throw Error('Demo disconnected during speech');socket.send(JSON.stringify({user_audio_chunk:input.subarray(offset,offset+3200).toString('base64')}));await delay(100);}
    await waitFor(()=>state.transcript&&state.reply&&state.audioBytes>1600&&state.nonSilentBytes>100&&!state.replyInterrupted&&state.playbackEndAt>0&&Date.now()>=state.playbackEndAt+1500&&Date.now()-state.lastAudio>1500,true);
   }catch(e){turn.error=scrub(e.message);}
   Object.assign(turn,{transcript:scrub(state.transcript),reply:scrub(state.reply),audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,responseAfterAsrMs:null,latencyMeasurementValid:false,interrupted:state.replyInterrupted});
   turn.handoff=/routing this.*PawSpace team member|AI voice cannot continue|contact the PawSpace team for help/i.test(turn.reply);
   turn.nonEnglish=/[\u0900-\u0dff]/u.test(turn.reply);
   if(turnAudio.length){const f=audioFormat(outputFormat),rawPath=`voice-audit-results/${scenario.id}-${index+1}.raw`,wavPath=`voice-audit-results/${scenario.id}-${index+1}.wav`;await writeFile(rawPath,Buffer.concat(turnAudio));execFileSync('ffmpeg',['-loglevel','error','-y','-f',outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(f.rate),'-ac','1','-i',rawPath,wavPath]);}
   result.turns.push(turn);await writeFile(`voice-audit-results/${scenario.id}.json`,JSON.stringify(result,null,2));
   console.log('MAYA_AUDIO_AUDIT_TURN='+JSON.stringify({scenario:scenario.id,...turn}));
   if(turn.error){result.errors.push(turn.error);break;}
  }
  socket.close();
  if(conversationId){for(let n=0;n<10;n++){await delay(3000);const r=await fetch(eleven+'/v1/convai/conversations/'+encodeURIComponent(conversationId),{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)break;const final=await readDemoJson(r);result.providerStatus=final.status;result.providerDurationSeconds=final.metadata?.call_duration_secs;result.providerUserTurns=(final.transcript||[]).filter(x=>x.role==='user').length;result.finalTranscript=(final.transcript||[]).map(x=>({role:x.role,time:x.time_in_call_secs,text:scrub(x.message)}));if(final.status==='done'||final.status==='failed')break;}}
 }catch(e){result.errors.push(scrub(e.message));}
 finally{socket?.close();if(context)await app({action:'complete',callId:context.callId,outcome:'synthetic_multiturn_audio_audit',disposition:'info_shared'}).catch(()=>{});}
 result.completedAt=new Date().toISOString();await writeFile(`voice-audit-results/${scenario.id}.json`,JSON.stringify(result,null,2));reports.push(result);console.log('MAYA_AUDIO_AUDIT_SCENARIO='+JSON.stringify({id:result.id,completedTurns:result.turns.length,plannedTurns:result.plannedTurns,errors:result.errors,handoffs:result.turns.filter(t=>t.handoff).length,providerStatus:result.providerStatus}));
}
for(const scenario of MAYA_AUDIO_SCENARIOS)await runScenario(scenario);
await isolation();const after=await bookingIds();
const summary={startedOnRevision:env.EXPECTED_SHA,phoneDialed:false,engine:'elevenlabs_audio_with_actual_pawspace_staging_brain',inputVoice:'espeak_synthetic_English',carrierCertified:false,bookingSetUnchanged:JSON.stringify(before)===JSON.stringify(after),reports};
await writeFile('voice-audit-results/four-conversations.json',JSON.stringify(summary,null,2));
console.log('MAYA_FOUR_AUDIO_AUDIT_COMPLETE='+JSON.stringify({scenarios:reports.length,turns:reports.reduce((n,r)=>n+r.turns.length,0),phoneDialed:false,bookingSetUnchanged:summary.bookingSetUnchanged}));
