// Three genuine ASR -> canonical PawSpace brain -> TTS sessions. No telephony dial API.
import {execFileSync,spawn} from 'node:child_process';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
import {VOICE_DEMO_SCENARIOS,assertDemoResponse,assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';
import {createAudioProbeState,applyAudioProbeEvent,audioFormat,audioEventKind,greetingPlaybackFinished} from './voice-audio-proof.mjs';
import {verifyFinalConversation} from './voice-final-conversation-proof.mjs';
import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
import {readDemoJson,validateDemoContext,validateDemoSignedUrl,actionsMaskCommand,createDemoEventBoundary,demoArtifactPaths,DEMO_SUMMARY_PATH,validatedDemoReport,serializeDemoReport,serializeDemoSummary} from './voice-demo-output-boundary.mjs';
async function runLegacyDemo(){
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
const before=await bookingIds();await mkdir('voice-demo-results',{recursive:true});const reports=[];
for(const scenario of VOICE_DEMO_SCENARIOS){
 const paths=demoArtifactPaths(scenario.id),boundary=createDemoEventBoundary();
 await isolation();
 const context=validateDemoContext(await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'}));
 console.log(actionsMaskCommand(context.callId));console.log(actionsMaskCommand(context.threadId));
 const signedResponse=await fetch(eleven+'/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),signed=await readDemoJson(signedResponse);if(!signedResponse.ok)throw Error('Demo socket authorization refused');const signedUrl=validateDemoSignedUrl(signed.signed_url);console.log(actionsMaskCommand(signedUrl));
 const socket=new WebSocket(signedUrl),state=createAudioProbeState();let inputFormat,outputFormat,conversationId,error,closed=false,greetingBytes=0,firstGreeting=0,lastGreeting=0;const returnedAudio=[];let firstAudio=0,lastAudio=0;
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:context.threadId},dynamic_variables:{pawspace_uat:'true'}})));
 socket.addEventListener('message',event=>{if(error)return;try{
  const {event:d,audio}=boundary.parse(event.data);
  if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
  if(d.type==='conversation_initiation_metadata'){const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;inputFormat=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;audioFormat(outputFormat);if(inputFormat!=='pcm_16000')throw Error('Demo microphone requires PCM16000');}
  if(d.type==='audio'){const bytes=audio;if(!state.listening){firstGreeting ||= Date.now();lastGreeting=Date.now();greetingBytes+=bytes.length;}else if(state.transcript){returnedAudio.push(bytes);firstAudio ||=Date.now();lastAudio=Date.now();}}
  applyAudioProbeEvent(state,d,{now:Date.now(),outputFormat});
  if(d.type==='error')throw Error('Demo voice provider error');
 }catch(e){error=e;socket.close();}});
 socket.addEventListener('error',()=>{error=Error('Demo audio transport failed');});socket.addEventListener('close',()=>{closed=true;});
 async function waitFor(predicate,{microphoneOpen=false}={}){const until=Date.now()+100000;while(!predicate()){if(error)throw error;if(closed)throw Error('Demo disconnected');if(Date.now()>until)throw Error('Demo timed out');
  // Match an open SDK microphone: silence is still input audio while the agent answers.
  // Stopping chunks is a transport gap, not an explicit end-of-turn signal.
  if(microphoneOpen)socket.send(JSON.stringify({user_audio_chunk:Buffer.alloc(3200).toString('base64')}));
  await delay(100);}if(error)throw error;}
 try{
  await waitFor(()=>state.greeting&&inputFormat&&greetingPlaybackFinished({now:Date.now(),firstAudioAt:firstGreeting,lastAudioAt:lastGreeting,bytes:greetingBytes,format:outputFormat}));
  const wav=execFileSync('espeak-ng',['--stdout','-s','150',scenario.text],{maxBuffer:2097152,timeout:10000});
  const pcm=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:2097152,timeout:10000});
  if(pcm.length<1000||pcm.length>960000)throw Error('Invalid synthetic demo audio');
  state.listening=true;const input=Buffer.concat([Buffer.alloc(16000),pcm,Buffer.alloc(64000)]),started=Date.now();
  for(let offset=0;offset<input.length;offset+=3200){if(error)throw error;if(closed)throw Error('Demo disconnected during speech');socket.send(JSON.stringify({user_audio_chunk:input.subarray(offset,offset+3200).toString('base64')}));await delay(100);}
  await waitFor(()=>scenario.recognized.test(state.transcript)&&isSubstantiveVoiceReply(state.reply)&&scenario.reply.test(state.reply)&&state.reply.length>=30&&state.audioBytes>1600&&state.nonSilentBytes>100&&state.playbackEndAt>0&&Date.now()>=state.playbackEndAt+1500&&Date.now()-state.lastAudio>1500,{microphoneOpen:true});
  console.log('VOICE_DEMO_OBSERVED='+JSON.stringify({scenario:scenario.id,transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes}));
  assertDemoResponse(scenario,state);const playbackCompletedMs=Date.now()-started;socket.close();
  const proof=await verifyFinalConversation({key:env.ELEVENLABS_API_KEY,conversationId,agentId:env.GROOMING_AGENT_ID,turns:[{transcript:state.transcript,reply:state.reply}],liveAudioEvidence:{conversationId,inputMode:'audio',inputBytes:pcm.length,outputBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,playbackComplete:true},request:async(url,options)=>{const response=await fetch(url.replace('https://api.elevenlabs.io',eleven),options);return response.ok?Response.json(await readDemoJson(response),{status:response.status}):response;}});
  const f=audioFormat(outputFormat),raw=Buffer.concat(returnedAudio);await writeFile(paths.raw,raw);
  execFileSync('ffmpeg',['-loglevel','error','-y','-f',outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(f.rate),'-ac','1','-i',paths.raw,paths.wav]);
  const report=validatedDemoReport({scenario:scenario.id,transcript:state.transcript,reply:state.reply,inputToPlaybackCompletedMs:playbackCompletedMs,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,proof});reports.push(report);
  await app({action:'complete',callId:context.callId,outcome:'synthetic_audio_demo',disposition:'info_shared'});
  console.log('VOICE_DEMO_RESULT='+JSON.stringify(report));
 }catch(e){
  socket.close();
  try{
   const failed=validatedDemoReport({passed:false,scenario:scenario.id,transcript:state.transcript,reply:state.reply,audioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,error:String(e.message)});
   console.log('VOICE_DEMO_FAILED='+JSON.stringify(failed));await writeFile(paths.failed,serializeDemoReport(failed));
  }finally{await app({action:'transport_failure',callId:context.callId,reason:'synthetic_audio_demo_failed',reconnected:false}).catch(()=>{});}
  throw e;
 }
}
await isolation();if(JSON.stringify(before)!==JSON.stringify(await bookingIds()))throw Error('Informational demos changed booking set');
await writeFile(DEMO_SUMMARY_PATH,serializeDemoSummary(reports));
console.log('THREE_VOICE_DEMOS_PASSED='+JSON.stringify({count:reports.length,dialed:false,bookingSetUnchanged:true,nativeCarrierCertified:false}));

}

// Managed multi-turn mode is test-only. Importing this module performs no provider work.
export const MANAGED_DEMO_LIMITS=Object.freeze({sessions:5,turnsPerSession:6,aggregateMs:12*60_000,sessionMs:120_000,sessionRetries:0,confirmationsAllowed:false,audioBytes:16*1024*1024});
const MANAGED_IDS=['grooming_price_value','puppy_vaccination_tamil','training_fit_upgrade','boarding_payment','sitting_price_handoff'];
const MANAGED_ORIGIN='https://pawspace-staging.karthik-fce.workers.dev';
const TEST_PATHS=['.github/workflows/elevenlabs-provider-preflight.yml','scripts/demo-three-voice-conversations.mjs','scripts/fixtures/maya-managed-sales-scenarios.json','tests/maya-managed-sales-demo-boundaries.test.mjs'];
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const gate=(code,receipt)=>Object.assign(Error(code),{code,receipt});

export function createManagedDeadline({endAt,code,parentSignal,now=()=>Date.now()}){
 if(!Number.isFinite(endAt)||typeof code!=='string')throw gate('managed_deadline_boundary');
 const controller=new AbortController();
 const abort=reason=>{if(!controller.signal.aborted)controller.abort(reason||gate(code));};
 const onParent=()=>abort(parentSignal.reason);
 if(parentSignal?.aborted)onParent();else parentSignal?.addEventListener('abort',onParent,{once:true});
 const timer=setTimeout(()=>abort(gate(code)),Math.max(1,endAt-now()));
 const scope={deadline:endAt,code,signal:controller.signal,remaining:()=>Math.max(0,endAt-now()),check(){if(now()>=endAt)abort(gate(code));if(controller.signal.aborted)throw controller.signal.reason;},dispose(){clearTimeout(timer);parentSignal?.removeEventListener('abort',onParent);},async sleep(ms){scope.check();const wakeAt=now()+ms;while(now()<wakeAt){try{await delay(Math.min(wakeAt-now(),scope.remaining()),undefined,{signal:scope.signal});}catch(e){throw scope.signal.reason||e;}scope.check();}scope.check();}};
 return scope;
}

export function createManagedSessionDeadline(runScope,{startedAt=Date.now(),sessionMs=MANAGED_DEMO_LIMITS.sessionMs,onExpire=()=>{}}={}){
 runScope.check();const endAt=Math.min(runScope.deadline,startedAt+sessionMs),scope=createManagedDeadline({endAt,code:endAt===runScope.deadline?runScope.code:'managed_session_deadline',parentSignal:runScope.signal});
 scope.signal.addEventListener('abort',()=>onExpire(scope.signal.reason),{once:true});return scope;
}

export async function runManagedSubprocess(file,args,{scope,input,maxMs=10_000,maxOutputBytes=2*1024*1024}={}){
 scope.check();const endAt=Math.min(scope.deadline,Date.now()+maxMs),childScope=createManagedDeadline({endAt,code:endAt===scope.deadline?scope.code:'managed_subprocess_deadline',parentSignal:scope.signal});
 return new Promise((resolve,reject)=>{
  let child,settled=false,bytes=0;const chunks=[];
  const finish=(error,value)=>{if(settled)return;settled=true;childScope.dispose();childScope.signal.removeEventListener('abort',onAbort);error?reject(error):resolve(value);};
  const onAbort=()=>{child?.kill('SIGKILL');finish(childScope.signal.reason);};
  childScope.signal.addEventListener('abort',onAbort,{once:true});
  try{
   child=spawn(file,args,{stdio:['pipe','pipe','pipe'],shell:false});
   child.on('error',()=>finish(gate('managed_subprocess_start_failed')));
   child.stdin.on('error',()=>{});
   child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes){child.kill('SIGKILL');finish(gate('managed_subprocess_output_limit'));}else chunks.push(chunk);});
   child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes){child.kill('SIGKILL');finish(gate('managed_subprocess_output_limit'));}});
   child.on('close',status=>finish(status===0?null:gate('managed_subprocess_failed'),Buffer.concat(chunks)));
   child.stdin.end(input);
   if(childScope.signal.aborted)onAbort();
  }catch(e){child?.kill('SIGKILL');finish(gate('managed_subprocess_start_failed'));}
 });
}

export async function prepareManagedCallerAudio(scenario,{scope,process=runManagedSubprocess}={}){
 const prepared=[];
 for(const turn of scenario.turns){
  scope.check();const wav=await process('espeak-ng',['--stdout','-v',scenario.language,'-s','160',turn.text],{scope});
  const pcm=await process('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{scope,input:wav});
  if(pcm.length<1000||pcm.length>960000)throw gate('managed_caller_audio_boundary');
  const callerWav=await process('ffmpeg',['-loglevel','error','-f','s16le','-ar','16000','-ac','1','-i','pipe:0','-f','wav','pipe:1'],{scope,input:pcm});
  prepared.push({pcm,callerWav,speechEndByte:managedSpeechEndByte(pcm)});
 }
 return prepared;
}

export function assertManagedCases(fixture){
 if(fixture?.version!==1||fixture.confirmationsAllowed!==false||!Array.isArray(fixture.scenarios)||fixture.scenarios.length!==5)throw gate('managed_case_count_or_consent');
 fixture.scenarios.forEach((s,i)=>{
  if(s.id!==MANAGED_IDS[i]||!['en','ta'].includes(s.language)||!Array.isArray(s.turns)||s.turns.length<2||s.turns.length>6)throw gate('managed_case_boundary');
  if(s.handoffAllowed&&s.id!=='sitting_price_handoff')throw gate('managed_handoff_scope');
  s.turns.forEach((t,n)=>{
   if(typeof t.text!=='string'||t.text.length<15||t.text.length>650||!Array.isArray(t.recognition)||!t.recognition.length||t.recognition.some(x=>typeof x!=='string'||x.length<2||x.length>60))throw gate('managed_turn_boundary');
   // No mutating confirmation: this suite never tests booking/payment completion.
   if(/^(?:yes|okay|ok|confirm|proceed|book it|pay now|ஆம்|சரி)[.!\s]*$/iu.test(t.text.trim())||/\b(?:book me|charge my|send (?:me|a) (?:link|message)|confirm (?:this|the) booking)\b/i.test(t.text))throw gate('managed_mutating_confirmation');
   if(t.interruptPrevious&&n===0)throw gate('managed_interrupt_without_previous');
   if(t.expectHandoff&&(!s.handoffAllowed||n!==s.turns.length-1))throw gate('managed_handoff_must_end_session');
  });
 });return fixture.scenarios;
}

export function assertManagedSource(expected,head,changedPaths,runAttempt){
 if(!/^[a-f0-9]{40}$/.test(expected||'')||!/^[a-f0-9]{40}$/.test(head||''))throw gate('managed_source_pin_required');
 if(String(runAttempt)!=='1')throw gate('managed_rerun_refused');
 if(head!==expected&&(!Array.isArray(changedPaths)||changedPaths.length===0||changedPaths.some(p=>!TEST_PATHS.includes(p))))throw gate('managed_source_not_test_only_delta');
 return {deployedSha:expected,runnerSha:head,testOnlyDelta:head!==expected,changedPaths};
}

export async function readManagedDemoBudget({settings,query,readEleven,now=Date.now()}){
 const receipt={readAt:new Date(now).toISOString(),allowed:false,gates:[],runtime:null,speech:null};
 const names=['PAWSPACE_AI_PROVIDER','PAWSPACE_AI_VOICE_MODEL','PAWSPACE_AI_PROVIDER_MODEL','PAWSPACE_AI_MAX_REQUESTS_PER_MINUTE','PAWSPACE_AI_MAX_RESERVED_TOKENS_PER_DAY','PAWSPACE_AI_ESTIMATED_COST_MICROS_PER_1K_TOKENS','PAWSPACE_AI_MAX_ESTIMATED_COST_MICROS_PER_DAY'];
 const vars={};
 for(const name of names){const b=settings.bindings?.find(x=>x.name===name);if(b&&b.type!=='plain_text')receipt.gates.push('encrypted_effective_binding:'+name);else if(b)vars[name]=String(b.text??b.value??'').trim();}
 const provider=vars.PAWSPACE_AI_PROVIDER==='openai'?'openai':'anthropic';
 const model=vars.PAWSPACE_AI_VOICE_MODEL||vars.PAWSPACE_AI_PROVIDER_MODEL;
 if(!model)receipt.gates.push('effective_voice_model_not_readable');
 const integer=(key,fallback,min,max)=>{const n=Number(vars[key]);return !Number.isFinite(n)||n<=0?fallback:Math.min(max,Math.max(min,Math.floor(n)));};
 const caps={requestsPerMinute:integer(names[3],240,1,10000),reservedTokensPerDay:integer(names[4],5000000,1000,1000000000),costMicrosPer1kTokens:integer(names[5],0,0,1000000000),costMicrosPerDay:integer(names[6],0,0,2000000000)};
 if(!receipt.gates.length){
  try{
   const minute=await query("SELECT COUNT(*) count FROM ai_provider_runtime_requests WHERE created_at>=? AND status IN ('reserved','completed','failed')",[now-60000]);
   const daily=await query("SELECT COALESCE(SUM(reserved_tokens),0) tokens,COALESCE(SUM(reserved_cost_micros),0) cost FROM ai_provider_runtime_requests WHERE created_at>=? AND status IN ('reserved','completed','failed')",[Math.floor(now/86400000)*86400000]);
   const circuit=await query('SELECT open_until FROM ai_provider_runtime_circuit WHERE provider=? AND model_ref=? LIMIT 1',[provider,model]);
   const count=Number(minute[0]?.count),tokens=Number(daily[0]?.tokens),cost=Number(daily[0]?.cost),openUntil=Number(circuit[0]?.open_until||0);
   if(![count,tokens,cost,openUntil].every(x=>Number.isFinite(x)&&x>=0))throw gate('runtime_quota_receipt_invalid');
   receipt.runtime={provider,model,caps,remainingRequestsThisMinute:Math.max(0,caps.requestsPerMinute-count),remainingReservedTokensToday:Math.max(0,caps.reservedTokensPerDay-tokens),remainingEstimatedCostMicrosToday:caps.costMicrosPerDay>0?Math.max(0,caps.costMicrosPerDay-cost):null,costCapConfigured:caps.costMicrosPerDay>0,circuitOpenUntil:openUntil||null,serverAtomicReservationEnforced:true};
   if(openUntil>now)receipt.gates.push('runtime_circuit_open');
   if(count>=caps.requestsPerMinute||tokens>=caps.reservedTokensPerDay||(caps.costMicrosPerDay>0&&cost>=caps.costMicrosPerDay))receipt.gates.push('runtime_existing_quota_exhausted');
  }catch(e){receipt.gates.push(e.code||'runtime_quota_read_denied');}
 }
 const responses=await Promise.allSettled(['/v1/user','/v1/user/subscription'].map(path=>readEleven(path)));
 responses.forEach((r,i)=>{if(r.status==='rejected')receipt.gates.push('speech_budget_read_denied:'+['/v1/user','/v1/user/subscription'][i]+':'+String(r.reason?.status||'unavailable'));});
 if(responses.every(r=>r.status==='fulfilled')){
  const user=responses[0].value,subscription=responses[1].value,usage=user.subscription_extras?.usage;
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  receipt.speech={characterCount:numeric(subscription.character_count),characterLimit:numeric(subscription.character_limit),usageBasedExtension:subscription.max_credit_limit_extension==='unlimited'?'unlimited':numeric(subscription.max_credit_limit_extension),status:['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired'].includes(subscription.status)?subscription.status:'unknown',includedCredits:usage?Object.fromEntries(['rollover_credits_quota','rollover_credits_used','subscription_cycle_credits_quota','subscription_cycle_credits_used','manually_gifted_credits_quota','manually_gifted_credits_used'].map(k=>[k,numeric(usage[k])])):null,agentsMinutesRemaining:null,allowanceUnitVerified:false};
  if(receipt.speech.usageBasedExtension!==0)receipt.gates.push('speech_usage_based_extension_not_disabled');
  // User/subscription expose character credits. They do not attest the separate Agents
  // included-minute allowance. Never turn a TTS character count into call-minute headroom.
  receipt.gates.push('elevenlabs_agents_included_minutes_headroom_not_exposed_by_existing_reads');
 }
 receipt.allowed=receipt.gates.length===0;return receipt;
}

export async function readManagedNoOutboundGate({query,settings,customerId}){
 const receipt={allowed:false,readAt:new Date().toISOString(),scope:'all_potential_notification_recipients',callerNoSendVerified:false,allPotentialRecipientsVerified:false,gates:[],channels:['whatsapp','sms','email','push'],potentialRecipientClasses:['customer','caregiver','provider','staff']};
 try{
  const prefs=await query('SELECT service_updates,marketing FROM communication_preferences WHERE customer_id=?',[customerId]);
  receipt.callerNoSendVerified=prefs[0]?.service_updates===0&&prefs[0]?.marketing===0;
  if(!receipt.callerNoSendVerified)receipt.gates.push('existing_customer_no_send_preferences_not_proven');
  const adapters=await query("SELECT channel,adapter_name,environment,status,credentials_status FROM communication_adapter_configs WHERE channel IN ('whatsapp','sms','email','push','all') ORDER BY channel,adapter_name,environment LIMIT 101");
  if(adapters.length>100)throw gate('managed_no_outbound_adapter_limit');
  receipt.adapterMetadata=adapters.map(r=>Object.fromEntries(['channel','adapter_name','environment','status','credentials_status'].map(k=>[k,String(r[k]||'').slice(0,80)])));
  receipt.configuredExternalAdapters=adapters.filter(r=>r.adapter_name!=='sandbox_simulator'&&['sandbox_ready','live_ready'].includes(r.status)&&r.credentials_status==='configured').length;
  if(receipt.configuredExternalAdapters)receipt.gates.push('configured_notification_adapter_present');
  receipt.notificationCredentialBindingNames=(settings.bindings||[]).map(b=>b.name).filter(name=>/^(?:PAWSPACE_COMMUNICATION_PROVIDER_TOKEN|META_WHATSAPP_(?:UAT_)?ACCESS_TOKEN|INTERAKT_API_KEY|RESEND_API_KEY|SENDGRID_API_KEY|SMTP_PASSWORD|FCM_SERVICE_ACCOUNT)$/.test(name));
  // Customer preferences do not cover provider/caregiver/staff notifications. Adapter
  // metadata and secret binding names are also not an authoritative global send ban.
  // No existing read here attests that complete recipient boundary: fail BEFORE start/sign.
  receipt.gates.push('all_potential_notification_recipients_not_attested_by_existing_read_routes');
 }catch(e){receipt.gates.push(e.code||'pre_execution_no_outbound_read_denied');}
 return receipt;
}

export function assertManagedState(before,after){
 const keys=['bookings','payments','reservations','confirmationGuards','messages','outbox','deliveries','confirmedOffers','payoutInstructions','schedulerActivation'];
 for(const key of keys){if(!before?.[key]||!after?.[key]||JSON.stringify(before[key])!==JSON.stringify(after[key]))throw gate('managed_forbidden_state_change:'+key);}
 return {unchanged:keys,transactionCompletionTested: false};
}

export function assertManagedFinalTranscript(detail,{agentId,turns,allowInterrupted=false}){
 if(detail?.status!=='done'||detail.agent_id!==agentId||!Array.isArray(detail.transcript))throw gate('managed_final_provider_receipt');
 const groups=[];for(const item of detail.transcript){if(item.role==='user')groups.push({user:item.message,agent:[]});else if(item.role==='agent'&&groups.length)groups.at(-1).agent.push(item);}
 if(groups.length!==turns.length)throw gate('managed_final_user_turn_count');
 groups.forEach((g,i)=>{
  const t=turns[i];if(!normalized(t.transcript)||normalized(g.user)!==normalized(t.transcript))throw gate('managed_final_recognition_mismatch:'+i);
  const reply=g.agent.map(x=>x.message).join(' '),interrupted=g.agent.some(x=>x.interrupted);
  if(!reply||!t.reply)throw gate('managed_final_missing_reply:'+i);
  if(interrupted&&!(allowInterrupted&&t.intentionalInterruption&&t.interruptionObserved))throw gate('managed_unexpected_interruption:'+i);
  if(interrupted&&!normalized(t.reply).startsWith(normalized(reply))&&!normalized(reply).startsWith(normalized(t.reply)))throw gate('managed_interrupted_reply_mismatch:'+i);
  if(t.intentionalInterruption&&t.interruptionObserved&&!interrupted)throw gate('managed_final_interruption_receipt_missing:'+i);
  if(!interrupted&&normalized(reply)!==normalized(t.reply))throw gate('managed_final_reply_mismatch:'+i);
  if(!t.acceptedAudioBytes||!t.nonSilentBytes)throw gate('managed_final_missing_actual_audio:'+i);
 });
 return {providerStatus:'done',userTurns:groups.length,actualBidirectionalAudio:true,handsetPlaybackVerified:false,listened: false,transactionCompletionTested: false};
}

export function createManagedRecorder(now=()=>Date.now()){
 const recorder={turns:[],events:[],chunks:[],bytes:0,state:createAudioProbeState(),responseTurn:-1,currentTurn:-1,outputFormat:null,greeting:{bytes:0,first:0,last:0},lastOutputAt:0};
 recorder.begin=(turn)=>{recorder.currentTurn=recorder.turns.length;recorder.turns.push({text:turn.text,transcript:'',reply:'',recognitionAt:null,endOfSpeechAt:null,firstAudioAt:null,acceptedAudioBytes:0,nonSilentBytes:0,interruptionObserved:false,intentionalInterruption:false,corrections:[],inputPcm:null});};
 recorder.event=(d,audio)=>{
  const at=now();if(recorder.events.length>=4096)throw gate('managed_event_limit');
  if(d.type==='conversation_initiation_metadata')recorder.outputFormat=d.conversation_initiation_metadata_event.agent_output_audio_format;
  if(d.type==='user_transcript'&&recorder.currentTurn>=0){
   if(recorder.responseTurn!==recorder.currentTurn){const interruptedEventId=recorder.state.interruptedEventId;recorder.state=createAudioProbeState();Object.assign(recorder.state,{greeting:true,listening:true,interruptedEventId});recorder.responseTurn=recorder.currentTurn;}
  }
  const outcome=applyAudioProbeEvent(recorder.state,d,{now:at,outputFormat:recorder.outputFormat});
  const t=recorder.turns[recorder.responseTurn];
  const entry={at,type:audioEventKind(d.type),turn:recorder.responseTurn,outcome:outcome||null};
  if(d.type==='interruption'){entry.eventId=d.interruption_event.event_id;if(t)t.interruptionObserved=true;}
  if(d.type==='agent_response_correction'&&t){const c=d.agent_response_correction_event;t.corrections.push({at,original:c.original_agent_response,corrected:c.corrected_agent_response,applied:outcome==='correction'});}
  if(d.type==='audio'){
   if(!Buffer.isBuffer(audio)||!audio.length)throw gate('managed_empty_audio');
   recorder.bytes+=audio.length;if(recorder.bytes>MANAGED_DEMO_LIMITS.audioBytes)throw gate('managed_audio_limit');
   entry.eventId=d.audio_event.event_id;entry.bytes=audio.length;entry.cancelled=outcome==='cancelled-audio';
   recorder.chunks.push({turn:recorder.responseTurn,at,eventId:entry.eventId,cancelled:entry.cancelled,bytes:audio});recorder.lastOutputAt=at;
   if(recorder.responseTurn<0){recorder.greeting.first ||=at;recorder.greeting.last=at;recorder.greeting.bytes+=audio.length;}
   if(t&&outcome==='audio')t.firstAudioAt ??=at;
  }
  if(t){t.transcript=recorder.state.transcript;t.reply=recorder.state.reply;t.acceptedAudioBytes=recorder.state.audioBytes;t.nonSilentBytes=recorder.state.nonSilentBytes;if(outcome==='transcript'){t.recognitionAt ??=at;t.firstAudioAt=null;}}
  recorder.events.push(entry);return outcome;
 };
 return recorder;
}

export function managedSpeechEndByte(pcm){
 if(!Buffer.isBuffer(pcm)||pcm.length%2)throw gate('managed_pcm_boundary');
 for(let i=pcm.length-2;i>=0;i-=2)if(Math.abs(pcm.readInt16LE(i))>64)return i+2;
 throw gate('managed_caller_audio_silent');
}

const STATE_SQL={
 bookings:'SELECT id,status,total_amount FROM canonical_bookings WHERE customer_id=? ORDER BY id LIMIT 1001',
 payments:'SELECT id,status,amount,amount_due_now FROM booking_payments WHERE customer_id=? ORDER BY id LIMIT 1001',
 reservations:'SELECT id,status,group_id,lease_expires_at FROM scheduling_reservations WHERE customer_id=? ORDER BY id LIMIT 1001',
 confirmationGuards:'SELECT group_id,checked_at FROM booking_reservation_confirmation_guards ORDER BY group_id LIMIT 1001',
 messages:"SELECT id,status,purpose,template_key FROM communication_messages WHERE customer_id=? AND direction='outbound' AND channel IN ('whatsapp','sms','email') ORDER BY id LIMIT 1001",
 outbox:'SELECT o.message_id,o.status,o.attempt_count FROM communication_outbox o JOIN communication_messages m ON m.id=o.message_id WHERE m.customer_id=? ORDER BY o.message_id LIMIT 1001',
 deliveries:'SELECT e.id,e.event_type FROM communication_message_delivery_events e JOIN communication_messages m ON m.id=e.message_id WHERE m.customer_id=? ORDER BY e.id LIMIT 1001',
 confirmedOffers:"SELECT id,status,result_json FROM voice_sales_offers WHERE customer_id=? AND status IN ('confirming','confirmed','completed') ORDER BY id LIMIT 1001",
 payoutInstructions:'SELECT id,status,amount FROM partner_payout_instructions ORDER BY id LIMIT 1001',
 schedulerActivation:'SELECT id,active FROM report_export_schedules ORDER BY id LIMIT 1001'
};
async function managedState(query,customerId){const receipt={};for(const [key,sql]of Object.entries(STATE_SQL)){const rows=await query(sql,sql.includes('customer_id=?')?[customerId]:[]);if(rows.length>1000)throw gate('managed_state_receipt_limit:'+key);receipt[key]={count:rows.length,sha256:digest(rows),table:/ FROM ([a-z_]+)/i.exec(sql)?.[1],scope:sql.includes('customer_id=?')?'owned_customer':'staging_global'};}return receipt;}
async function managedToolReceipts(query,threadId){
 const rows=await query('SELECT tool_code,mode,canonical_service,status,policy_decision,confirmation_required,confirmed_at,result_json FROM ai_tool_execution_requests WHERE thread_id=? ORDER BY created_at LIMIT 101',[threadId]);
 if(rows.length>100)throw gate('managed_tool_receipt_limit');
 return rows.map(({result_json,...row})=>({...row,resultSha256:result_json==null?null:digest(String(result_json))}));
}

export async function writeManagedAudio(directory,recorder,scope){
 const artifacts=[],conversions=[];let conversionGate=null;
 // Save every turn's raw source/received audio first. A later conversion timeout
 // cannot discard later turns' caller input or agent output.
 for(let index=-1;index<recorder.turns.length;index++){
  const stem=index<0?'greeting':`turn-${index+1}`,t=recorder.turns[index];
  if(t?.inputPcm){const sent=t.inputPcm.subarray(0,t.inputSentBytes||0);await writeFile(directory+'/'+stem+'-caller.pcm',sent);artifacts.push({path:stem+'-caller.pcm',bytes:sent.length,sha256:digest(sent),inputSentBytes:sent.length});if(t.inputWav){await writeFile(directory+'/'+stem+'-caller-prepared.wav',t.inputWav);artifacts.push({path:stem+'-caller-prepared.wav',bytes:t.inputWav.length,sha256:digest(t.inputWav),preparedBeforeConnection:true,completeInputSent:sent.length===t.inputPcm.length});}}
  const selected=recorder.chunks.filter(c=>c.turn===index),raw=Buffer.concat(selected.map(c=>c.bytes));if(!raw.length)continue;
  await writeFile(directory+'/'+stem+'-agent.raw',raw);const containsCancelledFrames=selected.some(c=>c.cancelled);
  artifacts.push({path:stem+'-agent.raw',bytes:raw.length,sha256:digest(raw),containsCancelledFrames});conversions.push({stem,raw,containsCancelledFrames});
 }
 for(const {stem,raw,containsCancelledFrames}of conversions){
  if(scope.signal.aborted||scope.remaining()<=0){conversionGate=scope.signal.reason?.code||'managed_aggregate_deadline';break;}
  try{
   const f=audioFormat(recorder.outputFormat);await runManagedSubprocess('ffmpeg',['-loglevel','error','-y','-f',recorder.outputFormat.startsWith('pcm')?'s16le':'mulaw','-ar',String(f.rate),'-ac','1','-i',directory+'/'+stem+'-agent.raw',directory+'/'+stem+'-agent.wav'],{scope});
   const captured=await readFile(directory+'/'+stem+'-agent.wav');artifacts.push({path:stem+'-agent.wav',bytes:captured.length,sha256:digest(captured),rawAudioBytes:raw.length,containsCancelledFrames,frameAttribution:'response-active-on-arrival'});
  }catch(e){conversionGate=e.code||'managed_audio_conversion_failed';break;}
 }
 return {artifacts,conversionGate};
}

async function runManagedDemo(){
 const env=process.env,started=Date.now(),deadline=started+MANAGED_DEMO_LIMITS.aggregateMs,activeSockets=new Set();
 const runScope=createManagedDeadline({endAt:deadline,code:'managed_aggregate_deadline'});let currentSession=null;
 runScope.signal.addEventListener('abort',()=>{for(const socket of activeSockets)try{socket.close();}catch{}},{once:true});
 const check=()=>runScope.check();
 const root='voice-demo-results/managed-five';await mkdir(root,{recursive:true});let budget;
 const report={suite:'managed-five-sales',startedAt:new Date(started).toISOString(),limits:MANAGED_DEMO_LIMITS,dialed:false,sessionRetries:0,runtimeProviderRetriesVerified:false,transactionCompletionTested: false,handsetPlaybackVerified:false,listened: false,scenarios:[]};
 try{
  authorizedLaunchTester(env);
  for(const k of ['SPECIALIST_CUSTOMER_ID','ELEVENLABS_API_KEY','GROOMING_AGENT_ID','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','STAGING_D1_ID','PRODUCTION_D1_ID','PAWSPACE_UAT_ACCESS_CODE'])if(!env[k])throw gate('managed_missing_prerequisite:'+k);
  if(!/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA||''))throw gate('managed_source_pin_required');
  const head=(await runManagedSubprocess('git',['rev-parse','HEAD'],{scope:runScope})).toString('utf8').trim();
  const changed=head===env.EXPECTED_SHA?[]:(await runManagedSubprocess('git',['diff','--name-only',env.EXPECTED_SHA,head],{scope:runScope})).toString('utf8').trim().split('\n');
  report.source=assertManagedSource(env.EXPECTED_SHA,head,changed,env.GITHUB_RUN_ATTEMPT);
  if((await runManagedSubprocess('git',['status','--porcelain','--untracked-files=no'],{scope:runScope})).toString('utf8').trim())throw gate('managed_dirty_source');
  const scenarios=assertManagedCases(JSON.parse(await readFile(new URL('./fixtures/maya-managed-sales-scenarios.json',import.meta.url),'utf8')));
  report.scenarios=scenarios.map(s=>({scenario:s.id,service:s.service,language:s.language,status:'not_run',artifacts:[],listened:false,transactionCompletionTested:false}));
  const eleven=(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
  if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(eleven))throw gate('managed_provider_region');
  const read=async(url,options={})=>{check();currentSession?.check();const signal=AbortSignal.any([runScope.signal,...(currentSession?[currentSession.signal]:[]),AbortSignal.timeout(Math.max(1,Math.min(20000,runScope.remaining())))]);try{const response=await fetch(url,{...options,redirect:'error',signal});if(!response.ok)throw Object.assign(gate('managed_read_denied'),{status:response.status});return await readDemoJson(response);}catch(e){throw signal.reason||e;}};
  const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const readCf=async(path,body)=>{const b=await read(cf+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(b.success!==true)throw gate('managed_cloudflare_read_denied');return b.result;};
  const query=async(sql,params=[])=>{if(!sql.startsWith('SELECT '))throw gate('managed_sql_read_only');const table=/ FROM ([a-z_]+)/i.exec(sql)?.[1]||'unknown';try{const rows=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql,params});if(rows[0]?.success!==true||!Array.isArray(rows[0]?.results))throw gate('managed_d1_read_denied');return rows[0].results;}catch(e){throw gate('managed_d1_read_denied:'+table+(e.status?':'+e.status:''));}};
  const readEleven=path=>read(eleven+path,{headers:{'xi-api-key':env.ELEVENLABS_API_KEY}});
  let cookie='';
  const isolation=async()=>{
   const db=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));if(db.name!=='pawspace-staging'||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw gate('managed_isolated_staging_database');
   const settings=await readCf('/workers/scripts/pawspace-staging/settings');if(settings.annotations?.['workers/message']!=='staging '+env.EXPECTED_SHA||!settings.bindings?.some(b=>b.type==='d1'&&b.name==='DB'&&b.id===env.STAGING_D1_ID))throw gate('managed_deployed_revision_or_binding_changed');
   const effective=name=>{const b=settings.bindings.find(x=>x.name===name);if(b&&b.type!=='plain_text')throw gate('encrypted_isolation_binding:'+name);return String(b?.text??b?.value??'');};
   for(const [name,value]of Object.entries({PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false'}))if(effective(name)!==value)throw gate('managed_isolation_not_proven:'+name);
   if(cookie){const body=await read(MANAGED_ORIGIN+'/api/voice-outbound',{headers:{cookie}}),g=body.data?.gate;if(g?.mode!=='disabled'||g.enabled!==false||g.uatApproved!==false||g.salesOutboundApproved!==false)throw gate('managed_runtime_phone_pause');}
   return settings;
  };
  const settings=await isolation();
  const config=await readEleven('/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID));
  if(config.conversation_config?.agent?.prompt?.custom_llm?.url!==MANAGED_ORIGIN+'/api/elevenlabs/v1')throw gate('managed_actual_staging_brain_required');
  report.provider={region:eleven,customLlmOrigin:MANAGED_ORIGIN,agentConfigurationSha256:digest(config.conversation_config),input:'synthetic_microphone',output:'actual_provider_audio'};
  budget=await readManagedDemoBudget({settings,query,readEleven});await writeFile(root+'/budget.json',JSON.stringify(budget,null,2));
  if(!budget.allowed)throw gate('managed_budget_gate',budget);
  const login=await fetch(MANAGED_ORIGIN+'/api/staging-login',{method:'POST',headers:{'content-type':'application/json',origin:MANAGED_ORIGIN},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.any([runScope.signal,AbortSignal.timeout(Math.max(1,Math.min(20000,runScope.remaining())))])});
  cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];if(login.status!==200||!cookie.startsWith('pawspace_uat='))throw gate('managed_authenticated_context_denied');
  await isolation();
  const identity=await query('SELECT primary_phone FROM canonical_customers WHERE id=?',[env.SPECIALIST_CUSTOMER_ID]),phone=String(identity[0]?.primary_phone||'').replace(/\D/g,''),tester=authorizedLaunchTester(env).replace(/\D/g,'');if(![tester,tester.slice(2)].includes(phone))throw gate('managed_owned_test_recipient_required');
  report.noOutbound=await readManagedNoOutboundGate({query,settings:await isolation(),customerId:env.SPECIALIST_CUSTOMER_ID});
  if(!report.noOutbound.allowed)throw gate('managed_pre_execution_no_outbound_unproven',report.noOutbound);
  report.recipient={ownedTester:true,existingNoSendVerified:true,confirmationsAllowed: false};
  const app=async(body)=>{const b=await read(MANAGED_ORIGIN+'/api/ai-voice-uat',{method:'POST',headers:{cookie,origin:MANAGED_ORIGIN,'content-type':'application/json'},body:JSON.stringify(body)});return b.data;};
  report.before=await managedState(query,env.SPECIALIST_CUSTOMER_ID);
  const asOf=new Date().toISOString();
  const packages=await query('SELECT service_code,package_code,name,base_price,currency,version FROM service_packages WHERE active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY package_code LIMIT 1001',[asOf,asOf]);
  const training=await query('SELECT package_code,name,sessions,validity_days,base_price,currency,version FROM training_commercial_packages WHERE active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY package_code LIMIT 1001',[asOf,asOf]);
  const rates=await query("SELECT provider_id,service_code,package_code,city_id,zone_id,rate,version FROM provider_service_rates WHERE status='active' AND service_code IN ('boarding','pet_sitting') AND effective_from<=? ORDER BY service_code,provider_id,version LIMIT 1001",[asOf]);
  if([packages,training,rates].some(rows=>rows.length>1000))throw gate('managed_grounding_reference_limit');
  report.groundingReference={asOf,packages,training,caregiverRates:rates.map(({provider_id,...rate})=>({...rate,providerIdSha256:digest(provider_id)})),stayPolicy:'caregiver_priced_app_only',reviewed:false};
  for(const scenario of scenarios){
   check();await isolation();const currentBudget=await readManagedDemoBudget({settings:await isolation(),query,readEleven});if(!currentBudget.allowed)throw gate('managed_budget_changed',currentBudget);
   const directory=root+'/'+scenario.id;await mkdir(directory,{recursive:true});
   const result={scenario:scenario.id,service:scenario.service,status:'failed',language:scenario.language,groundingReviewed:false,naturalnessReviewed:false,listened: false,transactionCompletionTested: false,turns:[],artifacts:[]};report.scenarios[scenarios.indexOf(scenario)]=result;
   const recorder=createManagedRecorder();let socket,context,error,closed=false,inputFormat,conversationId,sessionScope;
   const requestClose=()=>{if(socket){result.connection.closeRequestedAt ??=Date.now();try{socket.close();}catch{}}};
   const until=async(predicate,{silence=false,maxMs=75000}={})=>{const turnDeadline=Math.min(sessionScope.deadline,Date.now()+maxMs);while(!predicate()){check();sessionScope.check();if(error)throw error;if(closed)throw gate('managed_audio_disconnected');if(Date.now()>=turnDeadline)throw gate('managed_turn_deadline');if(silence&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({user_audio_chunk:Buffer.alloc(3200).toString('base64')}));await sessionScope.sleep(100);}sessionScope.check();if(error)throw error;};
   try{
    result.noOutbound=await readManagedNoOutboundGate({query,settings:await isolation(),customerId:env.SPECIALIST_CUSTOMER_ID});
    if(!result.noOutbound.allowed)throw gate('managed_pre_execution_no_outbound_unproven',result.noOutbound);
    const prepared=await prepareManagedCallerAudio(scenario,{scope:runScope});
    result.callerAudioPreparedBeforeConnection=true;
    context=validateDemoContext(await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:scenario.language}));
    console.log(actionsMaskCommand(context.callId));console.log(actionsMaskCommand(context.threadId));
    const signed=await readEleven('/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID));const signedUrl=validateDemoSignedUrl(signed.signed_url);
    result.connection={startedAt:Date.now(),endedAt:null,closeRequestedAt:null,sessionLimitMs:MANAGED_DEMO_LIMITS.sessionMs,endVerified:false};
    sessionScope=createManagedSessionDeadline(runScope,{startedAt:result.connection.startedAt,onExpire:reason=>{error=reason;requestClose();}});currentSession=sessionScope;
    socket=new WebSocket(signedUrl);activeSockets.add(socket);const boundary=createDemoEventBoundary();
    socket.addEventListener('open',()=>{try{sessionScope.check();socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:context.threadId},dynamic_variables:{pawspace_uat:'true'}}));}catch(e){error=e;requestClose();}});
    socket.addEventListener('message',event=>{try{sessionScope.check();const {event:d,audio}=boundary.parse(event.data);if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));if(d.type==='conversation_initiation_metadata'){inputFormat=d.conversation_initiation_metadata_event.user_input_audio_format;conversationId=d.conversation_initiation_metadata_event.conversation_id;if(inputFormat!=='pcm_16000')throw gate('managed_input_format');}recorder.event(d,audio);if(d.type==='error')throw gate('managed_provider_audio_error');}catch(e){error=e;requestClose();}});
    socket.addEventListener('error',()=>{error=gate('managed_audio_transport_error');});socket.addEventListener('close',()=>{closed=true;result.connection.endedAt=Date.now();result.connection.endVerified=true;});
    await until(()=>recorder.state.greeting&&inputFormat&&greetingPlaybackFinished({now:Date.now(),firstAudioAt:recorder.greeting.first,lastAudioAt:recorder.greeting.last,bytes:recorder.greeting.bytes,format:recorder.outputFormat}));
    for(let i=0;i<scenario.turns.length;i++){
     const turn=scenario.turns[i];if(turn.interruptPrevious)recorder.turns.at(-1).intentionalInterruption=true;
     recorder.begin(turn);const recorded=recorder.turns.at(-1);
     const {pcm,callerWav,speechEndByte}=prepared[i];recorded.inputPcm=pcm;recorded.inputWav=callerWav;recorded.inputSentBytes=0;const speechEnd=16000+speechEndByte;
     const input=Buffer.concat([Buffer.alloc(16000),pcm,Buffer.alloc(32000)]);for(let offset=0;offset<input.length;offset+=3200){check();sessionScope.check();if(error)throw error;if(closed)throw gate('managed_disconnect_during_input');const frame=input.subarray(offset,offset+3200);socket.send(JSON.stringify({user_audio_chunk:frame.toString('base64')}));recorded.inputSentBytes+=Math.max(0,Math.min(offset+frame.length,16000+pcm.length)-Math.max(offset,16000));if(offset<speechEnd)recorded.endOfSpeechAt=Date.now()+Math.min(3200,speechEnd-offset)/32;await sessionScope.sleep(100);}
     const bargeNext=scenario.turns[i+1]?.interruptPrevious===true;
     await until(()=>recorder.responseTurn===i&&recorded.transcript&&recorded.reply&&recorded.acceptedAudioBytes>1600&&recorded.nonSilentBytes>100&&(bargeNext||(Date.now()>=recorder.state.playbackEndAt+1000&&Date.now()-recorder.state.lastAudio>=1000)),{silence:true});
     const text=normalized(recorded.transcript);if(!turn.recognition.every(anchor=>text.includes(normalized(anchor))))throw gate('managed_asr_anchor_missed:'+i);
     if(i>0&&turn.interruptPrevious&&!recorder.turns[i-1].interruptionObserved)throw gate('managed_requested_interruption_not_observed');
     if(!bargeNext&&recorder.state.replyInterrupted)throw gate('managed_unexpected_interrupted_reply:'+i);
     // Start the planned barge-in while output is queued; D1 reads here would create a
     // microphone gap and could turn the interruption case into an ordinary follow-up.
     if(bargeNext)continue;
     const handoffs=await query('SELECT id,status,queue_code,reason FROM ai_handoffs WHERE thread_id=? ORDER BY created_at',[context.threadId]);
     result.handoff={count:handoffs.length,rows:handoffs.map(r=>({idSha256:digest(r.id),status:r.status,queue:r.queue_code,reason:r.reason}))};
     if(handoffs.length&&!turn.expectHandoff)throw gate('managed_early_handoff_recovery_blocked:'+i);
     if(turn.expectHandoff&&!handoffs.length)throw gate('managed_handoff_not_persisted');
     result.after=await managedState(query,env.SPECIALIST_CUSTOMER_ID);assertManagedState(report.before,result.after);
    }
    requestClose();await until(()=>closed,{maxMs:3000});activeSockets.delete(socket);sessionScope.dispose();currentSession=null;
    let detail;for(let poll=0;poll<15;poll++){check();detail=await readEleven('/v1/convai/conversations/'+encodeURIComponent(conversationId));if(detail.status==='done')break;await runScope.sleep(1000);}
    result.providerReceipt={conversationIdSha256:digest(conversationId),status:detail.status,transcript:detail.transcript.map(t=>({role:t.role,text:t.message,interrupted:Boolean(t.interrupted),timeInCallSeconds:t.time_in_call_secs??null}))};
    result.proof=assertManagedFinalTranscript(detail,{agentId:env.GROOMING_AGENT_ID,turns:recorder.turns,allowInterrupted:true});
    result.canonicalTurns=await query('SELECT provider,model_ref,intent_code,policy_decision,outcome,latency_ms FROM ai_conversation_turns WHERE thread_id=? ORDER BY created_at',[context.threadId]);
    result.persistedVoiceReplies=await query("SELECT provider,provider_reference,status,template_key,created_at FROM communication_messages WHERE thread_id=? AND channel='voice' AND direction='outbound' ORDER BY created_at",[context.threadId]);
    await app({action:'complete',callId:context.callId,outcome:'managed_audio_enquiry',disposition:scenario.handoffAllowed?'human_handoff':'info_shared'});
    result.status='captured_requires_listening_and_grounding_review';
   }catch(e){requestClose();currentSession=null;result.status=socket?'failed':'not_run';result.error=e.code||'managed_session_failed';if(context&&!runScope.signal.aborted)await app({action:'transport_failure',callId:context.callId,reason:'managed_audio_demo_failed',reconnected:false}).catch(()=>{});throw e;
   }finally{
    requestClose();sessionScope?.dispose();currentSession=null;activeSockets.delete(socket);
    if(context&&Date.now()<deadline){
     try{result.after=await managedState(query,env.SPECIALIST_CUSTOMER_ID);result.state=assertManagedState(report.before,result.after);result.canonicalTurns=await query('SELECT provider,model_ref,intent_code,policy_decision,outcome,latency_ms FROM ai_conversation_turns WHERE thread_id=? ORDER BY created_at',[context.threadId]);result.tools=await managedToolReceipts(query,context.threadId);}catch(e){result.stateReceiptError=e.code||'managed_failed_state_read';result.status='failed';}
    }
    result.turns=recorder.turns.map(({inputPcm,inputWav,...t})=>({...t,endOfSpeechToFirstAudioMs:t.firstAudioAt!=null&&t.endOfSpeechAt!=null?t.firstAudioAt-t.endOfSpeechAt:null,recognitionLatencyMs:t.recognitionAt!=null&&t.endOfSpeechAt!=null?t.recognitionAt-t.endOfSpeechAt:null,endOfSpeechEstimated:true,endOfSpeechBasis:'last_synthetic_pcm_sample_above_64',playbackEstimated:true,handsetPlaybackVerified:false,listened: false}));
    try{const capture=await writeManagedAudio(directory,recorder,runScope);result.artifacts=capture.artifacts;if(capture.conversionGate){result.artifactError=capture.conversionGate;result.status='failed';}}catch(e){result.artifactError=e.code||'managed_audio_conversion_failed';result.status='failed';const raw=Buffer.concat(recorder.chunks.map(c=>c.bytes));if(raw.length)await writeFile(directory+'/partial-agent.raw',raw);}
    await writeFile(directory+'/events.json',JSON.stringify(recorder.events,null,2));await writeFile(directory+'/result.json',JSON.stringify(result,null,2));
    if(result.stateReceiptError||result.artifactError)throw gate(result.stateReceiptError||result.artifactError);
   }
  }
  await isolation();report.after=await managedState(query,env.SPECIALIST_CUSTOMER_ID);report.state=assertManagedState(report.before,report.after);
 }catch(e){report.gate=e.code||'managed_preflight_or_session_failed';for(const result of report.scenarios)if(result.status==='not_run')result.gate=report.gate;if(e.receipt)report.gateReceipt=e.receipt;process.exitCode=1;
 }finally{for(const socket of activeSockets)try{socket.close();}catch{};runScope.dispose();report.finishedAt=new Date().toISOString();report.aggregateMs=Date.now()-started;if(budget)report.budget=budget;await writeFile(root+'/summary.json',JSON.stringify(report,null,2));console.log('MANAGED_AUDIO_SUITE='+JSON.stringify({gate:report.gate||null,scenarios:report.scenarios.map(s=>({id:s.scenario,status:s.status})),dialed:false,listened:false,transactionCompletionTested:false}));}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 await (process.env.MANAGED_DEMO_SUITE==='five-sales'?runManagedDemo():runLegacyDemo());
}
