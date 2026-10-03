import {NEXT_FIVE_AUDIO_SCENARIOS} from './next-ten-audio-scenarios.mjs';
import {createAudioEventReceipt,finalizeAudioScenario} from './next-audio-evidence.mjs';
// One bounded genuine ASR -> canonical PawSpace brain -> TTS sessions. No telephony dial API.
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
 if(vars.PAWSPACE_RAZORPAYX_ENV!=='sandbox'||vars.PAWSPACE_RAZORPAYX_LIVE_APPROVED!=='false'||vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED!=='false'||!settings.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Demo sandbox bindings not proven');
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
async function leaseRequest(body){const r=await fetch(origin+'/api/ai-voice-uat/audio-lease',{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok)throw Error('Audio budget lease refused ('+r.status+'): '+String(b.error||'unproven'));return b.data;}
const batchReadiness=await leaseRequest();if(batchReadiness.sourceSha!==env.EXPECTED_SHA||batchReadiness.paidExecutionAllowed!==true)throw Error('Exact guarded batch is not ready');
if(env.NEXT_AUDIO_ENGINE==='workers_ai'&&batchReadiness.workersSpeechReady!==true)throw Error('Configured bounded Workers AI models not ready');
const batchClaim=await leaseRequest({action:'claim_batch',runId:env.GITHUB_RUN_ID});
if(batchClaim.budgetId!=='next-ten-audio-additional-usd5-20261002'||batchClaim.sourceSha!==env.EXPECTED_SHA||!batchClaim.batchToken)throw Error('Durable batch admission refused');
const scrub=t=>String(t||'').replace(/\+?\d{10,15}/g,'[number]').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[email]');
async function runScenario(scenario){
 const result={id:scenario.id,service:scenario.service,goal:scenario.goal,startedAt:new Date().toISOString(),turns:[],errors:[],phoneDialed:false,plannedTurns:scenario.prompts.length};
 let socket,context,deadlineTimer,eventReceipt=createAudioEventReceipt(()=>Date.now()),conversationId;
 let providerAudio=[],callerAudio=[];
 try{
  await isolation();
  context=validateDemoContext(await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'}));
  const lease=await leaseRequest({customerId:env.SPECIALIST_CUSTOMER_ID,callId:context.callId,batchToken:batchClaim.batchToken}),threadId=lease.threadId;
  if(!threadId.startsWith('THREAD-VOICE-NDEMO-NEXT-AUDIO-')||lease.sourceSha!==env.EXPECTED_SHA||lease.providerHardDurationSeconds>120||lease.deadline<=Date.now())throw Error('Bounded native lease invalid');
  result.lease={deadline:lease.deadline,nativeBound:lease.nativeBound,sourceSha:lease.sourceSha,agentConfigSha256:lease.agentConfigSha256};
  const signedResponse=await fetch(eleven+'/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),signed=await readDemoJson(signedResponse);if(!signedResponse.ok)throw Error('Demo socket authorization refused');
  const signedUrl=validateDemoSignedUrl(signed.signed_url);console.log(actionsMaskCommand(signedUrl));console.log(actionsMaskCommand(threadId));
  socket=new WebSocket(signedUrl);
  deadlineTimer=setTimeout(()=>socket.close(),Math.max(0,lease.deadline-Date.now()));
  const boundary=createDemoEventBoundary();let state=createAudioProbeState(),inputFormat,outputFormat,error,closed=false,greetingBytes=0,firstGreeting=0,lastGreeting=0,turnAudio=[],firstResponseAt=0,lastAsrAt=0;
  socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:threadId},dynamic_variables:{pawspace_uat:'true'}})));
  socket.addEventListener('message',event=>{if(error)return;try{
   const {event:d,audio}=boundary.parse(event.data),now=Date.now();eventReceipt.receive(d);
   if(d.type==='audio'&&audio.length)providerAudio.push({atMs:now,format:outputFormat,pcm:Buffer.from(audio)});
   if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
   if(d.type==='conversation_initiation_metadata'){const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;inputFormat=m.user_input_audio_format;if(inputFormat!=='pcm_16000')throw Error('Native synthetic input format must be pcm_16000');outputFormat=m.agent_output_audio_format;audioFormat(outputFormat);}
   if(d.type==='user_transcript'&&state.listening)lastAsrAt=now;
   if(d.type==='audio'){if(!state.listening){firstGreeting ||=now;lastGreeting=now;greetingBytes+=audio.length;}else {firstResponseAt ||=now;turnAudio.push(audio);}}
   applyAudioProbeEvent(state,d,{now,outputFormat});if(d.type==='error')throw Error('Demo provider error');
  }catch(e){error=e;socket.close();}});
  socket.addEventListener('error',()=>{error=Error('Demo audio transport failed');});socket.addEventListener('close',()=>{closed=true;});
  async function waitFor(predicate,microphoneOpen=false){const until=Math.min(Date.now()+75000,lease.deadline);while(!predicate()){if(error)throw error;if(closed)throw Error('Demo disconnected');if(Date.now()>until)throw Error('No completed audible reply within 75 seconds');if(microphoneOpen)socket.send(JSON.stringify({user_audio_chunk:Buffer.alloc(3200).toString('base64')}));await delay(100);}if(error)throw error;}
  await waitFor(()=>state.greeting&&inputFormat&&greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstGreeting,lastAudioAt:lastGreeting,bytes:greetingBytes,format:outputFormat}));
  for(let index=0;index<scenario.prompts.length;index++){
   const prompt=scenario.prompts[index],turn={index:index+1,prompt,transcript:'',reply:'',audioBytes:0,responseAfterAsrMs:null};
   state=createAudioProbeState();state.greeting=true;state.listening=true;turnAudio=[];firstResponseAt=0;lastAsrAt=0;eventReceipt=createAudioEventReceipt(()=>Date.now());
   try{
    const wav=execFileSync('espeak-ng',['--stdout','-s','165',prompt],{maxBuffer:2097152,timeout:10000});
    const pcm=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:2097152,timeout:10000});
    callerAudio.push({atMs:Date.now()+500,format:'pcm_16000',pcm:Buffer.from(pcm)});
    const input=Buffer.concat([Buffer.alloc(16000),pcm,Buffer.alloc(64000)]);
    for(let offset=0;offset<input.length;offset+=3200){if(offset>=16000+pcm.length&&offset<16000+pcm.length+3200)eventReceipt.callerSpeechEnded();if(Date.now()>=lease.deadline)throw Error('Native lease duration exhausted');if(error)throw error;if(closed)throw Error('Demo disconnected during speech');socket.send(JSON.stringify({user_audio_chunk:input.subarray(offset,offset+3200).toString('base64')}));await delay(100);}
    if(scenario.plannedBargeIn?.turn===index+1){
     await waitFor(()=>turnAudio.length>0,true);await delay(scenario.plannedBargeIn.delayMs);
     const interruptText='Sorry to interrupt. Return at one p.m., not noon.',iw=execFileSync('espeak-ng',['--stdout','-s','165',interruptText]),ip=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:iw});
     callerAudio.push({atMs:Date.now(),format:'pcm_16000',pcm:Buffer.from(ip)});turn.injectedInterruption={text:interruptText,atMs:Date.now(),duringAgentPlayback:Date.now()<state.playbackEndAt};
     for(let off=0;off<ip.length;off+=3200){if(Date.now()>=lease.deadline)throw Error('Native lease duration exhausted');socket.send(JSON.stringify({user_audio_chunk:ip.subarray(off,off+3200).toString('base64')}));await delay(100);}eventReceipt.callerSpeechEnded();
    }
    await waitFor(()=>state.transcript&&state.reply&&state.audioBytes>1600&&state.nonSilentBytes>100&&!state.replyInterrupted&&state.playbackEndAt>0&&Date.now()>=state.playbackEndAt+1500&&Date.now()-state.lastAudio>1500,true);
   }catch(e){turn.error=scrub(e.message);}
   Object.assign(turn,{transcript:scrub(state.transcript),reply:scrub(state.reply),audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,firstAudioAfterCallerEndMs:eventReceipt.snapshot().firstAudioAfterCallerEndMs,latencyMeasurement:eventReceipt.snapshot().measurement,audioEvents:eventReceipt.snapshot().events,listened:false,interrupted:state.replyInterrupted});
   turn.handoff=/routing this.*PawSpace team member|AI voice cannot continue|contact the PawSpace team for help/i.test(turn.reply);
   turn.nonEnglish=/[\u0900-\u0dff]/u.test(turn.reply);
   if(turnAudio.length){const f=audioFormat(outputFormat),rawPath=`voice-audit-results/${scenario.id}-${index+1}.raw`,wavPath=`voice-audit-results/${scenario.id}-${index+1}.wav`;await writeFile(rawPath,Buffer.concat(turnAudio));execFileSync('ffmpeg',['-loglevel','error','-y','-f',outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(f.rate),'-ac','1','-i',rawPath,wavPath]);}
   result.turns.push(turn);await writeFile(`voice-audit-results/${scenario.id}.json`,JSON.stringify(result,null,2));
   console.log('MAYA_AUDIO_AUDIT_TURN='+JSON.stringify({scenario:scenario.id,...turn}));
   if(turn.error){result.errors.push(turn.error);break;}
  }
  socket.close();
  if(conversationId){for(let n=0;n<10;n++){await delay(3000);const r=await fetch(eleven+'/v1/convai/conversations/'+encodeURIComponent(conversationId),{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)break;const final=await readDemoJson(r);result.providerConversationId=conversationId;result.providerCostFiat=final.metadata?.cost_fiat??null;result.providerCostCredits=final.metadata?.cost??null;result.providerCharging=final.metadata?.charging??null;result.billingCurrency='unverified; retain provider units without converting';result.providerStatus=final.status;result.providerDurationSeconds=final.metadata?.call_duration_secs;result.providerUserTurns=(final.transcript||[]).filter(x=>x.role==='user').length;result.finalTranscript=(final.transcript||[]).map(x=>({role:x.role,time:x.time_in_call_secs,text:scrub(x.message)}));if(final.status==='done'||final.status==='failed')break;}}
 }catch(e){result.errors.push(scrub(e.message));}
 finally{
  clearTimeout(deadlineTimer);try{socket?.close();}catch(e){result.errors.push('Socket close failed: '+scrub(e.message));}
  if(conversationId)result.providerConversationId=conversationId;
  result.completedAllPlannedTurns=result.turns.length===result.plannedTurns&&result.turns.every(t=>!t.error);result.acceptancePassed=false;result.qualityReview='Pending semantic and listening review; completion is not a pass';
  await finalizeAudioScenario({result,recordings:[['caller',callerAudio],['agent',providerAudio]],scrub,
   exportRecording:async(label,chunks)=>{const rawPath=`voice-audit-results/${scenario.id}-${label}-all.raw`,wavPath=`voice-audit-results/${scenario.id}-${label}-all.wav`;await writeFile(rawPath,Buffer.concat(chunks.map(x=>x.pcm)));const rate=audioFormat(chunks[0].format).rate;execFileSync('ffmpeg',['-loglevel','error','-y','-f',chunks[0].format.startsWith('pcm')?'s16le':'mulaw','-ar',String(rate),'-ac','1','-i',rawPath,wavPath]);},
   completeCall:async()=>{if(context){await app({action:'complete',callId:context.callId,outcome:'synthetic_multiturn_audio_audit',disposition:'info_shared'});result.syntheticCallCompleted=true;}},
   persist:()=>writeFile(`voice-audit-results/${scenario.id}.json`,JSON.stringify(result,null,2))});
 }
 reports.push(result);console.log('MAYA_AUDIO_AUDIT_SCENARIO='+JSON.stringify({id:result.id,completedTurns:result.turns.length,plannedTurns:result.plannedTurns,errors:result.errors,handoffs:result.turns.filter(t=>t.handoff).length,providerStatus:result.providerStatus}));
}
async function runWorkersScenario(scenario){
 const result={id:scenario.id,service:scenario.service,engine:'workers_ai_whisper_aura2_with_actual_pawspace_brain',turns:[],errors:[],listened:false,phoneDialed:false,carrierCertified:false,liveInterruptionCertified:false,plannedTurns:scenario.prompts.length};let context,lease;
 try{
  await isolation();context=validateDemoContext(await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'}));
  lease=await leaseRequest({customerId:env.SPECIALIST_CUSTOMER_ID,callId:context.callId,batchToken:batchClaim.batchToken});
  const common={customerId:env.SPECIALIST_CUSTOMER_ID,callId:context.callId,batchToken:batchClaim.batchToken};
  const request=async body=>{
   if(Date.now()>=lease.deadline)throw Error('Bounded lease expired');
   const r=await fetch(origin+'/api/ai-voice-uat/audio-lease',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({...common,...body}),signal:AbortSignal.timeout(Math.max(1,Math.min(30000,lease.deadline-Date.now())))});
   if(!r.ok)throw Error('Bounded speech/brain refused ('+r.status+')');return r;
  };
  for(let index=0;index<scenario.prompts.length;index++){
   const turn={index:index+1,prompt:scenario.prompts[index],listened:false,engine:'workers_ai',callerAudioPath:`voice-audit-results/${scenario.id}-${index+1}-caller.wav`,agentAudioPath:`voice-audit-results/${scenario.id}-${index+1}.wav`};
   result.turns.push(turn);
   try{
    const rendered=execFileSync('espeak-ng',['--stdout','-s','165',turn.prompt],{maxBuffer:2097152,timeout:10000}),pcm=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:rendered,maxBuffer:960000,timeout:10000});
    if(pcm.length===0||pcm.length>960000||pcm.length%2)throw Error('Fixed caller audio limit');
    const wav=Buffer.alloc(44+pcm.length);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);await writeFile(turn.callerAudioPath,wav);
    const submittedAt=Date.now();turn.callerDurationSeconds=pcm.length/32000;
    const stt=(await readDemoJson(await request({action:'workers_stt',audioRef:'data:audio/wav;base64,'+wav.toString('base64')}))).data;
    turn.transcript=scrub(stt.text);turn.sttMs=Date.now()-submittedAt;turn.recognitionConfidence=null;
    const brainAt=Date.now(),brain=(await readDemoJson(await request({action:'workers_brain',text:stt.text}))).data;
    turn.reply=scrub(brain.output);turn.brainMs=Date.now()-brainAt;turn.brainPath=brain.path;turn.turnId=brain.turnId;turn.modelRef=brain.modelRef;
    const spoken=String(brain.output??'');if(!spoken||Buffer.byteLength(spoken,'utf8')>2500)throw Error('TTS reply exceeds deterministic character allowance; no synthesis requested');
    const ttsAt=Date.now(),response=await request({action:'workers_tts',text:spoken});
    if(response.headers.get('x-pawspace-engine')!=='workers_ai'||response.headers.get('x-pawspace-model')!=='@cf/deepgram/aura-2-en')throw Error('Actual TTS model mismatch');
    const reader=response.body.getReader(),chunks=[];let bytes=0,firstAudioAt=null;
    for(;;){const next=await reader.read();if(next.done)break;firstAudioAt??=Date.now();bytes+=next.value.length;if(bytes>8*1024*1024){await reader.cancel();throw Error('Actual recording exceeds output bound');}chunks.push(Buffer.from(next.value));}
    const audio=Buffer.concat(chunks);turn.audioBytes=audio.length;turn.ttsFirstPacketMs=firstAudioAt===null?null:firstAudioAt-ttsAt;turn.batchFirstAudioAfterSubmissionMs=firstAudioAt===null?null:firstAudioAt-submittedAt;turn.latencyMeasurement='Batch processing from prerecorded WAV submission, not live microphone endpoint latency';turn.nonSilentBytes=audio.reduce((n,b)=>n+(b!==0),0);
    if(audio.length<1600||audio.length%2||turn.nonSilentBytes<100)throw Error('Actual non-silent PCM reply not proven');
    const raw=`voice-audit-results/${scenario.id}-${index+1}.raw`;await writeFile(raw,audio);execFileSync('ffmpeg',['-loglevel','error','-y','-f','s16le','-ar','16000','-ac','1','-i',raw,turn.agentAudioPath],{timeout:10000});
    turn.actualAudioCaptured=true;turn.ttsChargedCharacterUpper=Buffer.byteLength(spoken,'utf8');console.log('ACTUAL_WORKERS_AUDIO_READY='+JSON.stringify({scenario:scenario.id,turn:index+1,path:turn.agentAudioPath,bytes:audio.length}));
   }catch(e){turn.error=scrub(e.message);result.errors.push(turn.error);break;}
   await writeFile(`voice-audit-results/${scenario.id}.json`,JSON.stringify(result,null,2));
  }
 }catch(e){result.errors.push(scrub(e.message));}
 finally{
  result.completedAllPlannedTurns=result.turns.length===result.plannedTurns&&result.turns.every(t=>!t.error);result.acceptancePassed=false;result.qualityReview='Pending semantic and listening review; Workers AI recording is not ElevenLabs native quality proof';
  await finalizeAudioScenario({result,recordings:[],scrub,exportRecording:async()=>{},completeCall:async()=>{if(context){await app({action:'complete',callId:context.callId,outcome:'synthetic_workers_audio_audit',disposition:'info_shared'});result.syntheticCallCompleted=true;}},persist:()=>writeFile(`voice-audit-results/${scenario.id}.json`,JSON.stringify(result,null,2))});
 }
 reports.push(result);
}
if(env.NEXT_AUDIO_ENGINE==='workers_ai'&&batchReadiness.workersSpeechReady!==true)throw Error('Configured bounded Workers AI models not ready');
for(const scenario of NEXT_FIVE_AUDIO_SCENARIOS.slice(0,1))await (env.NEXT_AUDIO_ENGINE==='workers_ai'?runWorkersScenario(scenario):runScenario(scenario));

await isolation();const after=await bookingIds();
const summary={budgetId:'next-ten-audio-additional-usd5-20261002',capUsd:10,initialBatchSize:1,aggregateBrainReservationCapUsd:1,listened:false,continuousTiming:'Actual packet timestamps retained; concatenated WAV omits gaps. Do not infer conversation latency from WAV duration.',startedOnRevision:env.EXPECTED_SHA,phoneDialed:false,engine:env.NEXT_AUDIO_ENGINE==='workers_ai'?'workers_ai_whisper_aura2_with_actual_pawspace_staging_brain':'elevenlabs_audio_with_actual_pawspace_staging_brain',inputVoice:'espeak_synthetic_English',carrierCertified:false,bookingSetUnchanged:JSON.stringify(before)===JSON.stringify(after),reports};
await writeFile('voice-audit-results/one-conversation.json',JSON.stringify(summary,null,2));
console.log('MAYA_ONE_AUDIO_AUDIT_COMPLETE='+JSON.stringify({scenarios:reports.length,turns:reports.reduce((n,r)=>n+r.turns.length,0),phoneDialed:false,bookingSetUnchanged:summary.bookingSetUnchanged}));
