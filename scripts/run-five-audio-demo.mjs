// Diagnostic only: five fixed scenarios via audio WebSockets. No telephone dialing APIs.
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {audioDemoScenarios} from './five-audio-demo-scenarios.mjs';
import {audioFormat,createAudioProbeState,applyAudioProbeEvent,isHandoffReply} from './voice-audio-proof.mjs';
const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
const scenario=audioDemoScenarios.find(x=>x.id===Number(env.DEMO_ID));
if(env.NO_PHONE_DEMOS_APPROVED!=='true'||!scenario||!/^\d+$/.test(env.GITHUB_RUN_ID||''))throw Error('Explicit fixed no-phone diagnostic required');
const key=env.ELEVENLABS_API_KEY,agentId=scenario.agent==='training'?env.TRAINING_AGENT_ID:env.GROOMING_AGENT_ID;
const eh={'xi-api-key':key},cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
const ch={authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
const result={id:scenario.id,title:scenario.title,agent:scenario.agent,dialed:false,startedAt:new Date().toISOString(),questionsPlanned:scenario.questions.length,turns:[],issues:[],finalTranscript:[],passed:false};
const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function api(url,headers,init={}){const r=await fetch(url,{headers,...init,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Diagnostic request refused: '+r.status);return r.json();}
async function cfApi(path,init={}){const b=await api(cf+path,ch,init);if(!b.success)throw Error('Staging API rejected diagnostic');return b.result;}
const dbPath='/d1/database/'+encodeURIComponent(env.STAGING_D1_ID);
async function query(sql,params=[]){const b=await cfApi(dbPath+'/query',{method:'POST',body:JSON.stringify({sql,params})});if(b.some(x=>!x.success))throw Error('Staging query failed');return b.flatMap(x=>x.results||[]);}
let customerId,threadId,before,versionId,socket,pump,state,format,outputFormat,conversationId,greeting='',greetingEnd=0,lastGreeting=0,phase='greeting',frame=null,frameOffset=0,error,closed=false,firstReplyAudio=0,lastSpeechAt=0;
const businessSnapshot=async()=>({bookings:await query('SELECT id,status,total_amount FROM canonical_bookings WHERE customer_id=? ORDER BY id',[customerId]),payments:await query('SELECT id,status,amount FROM booking_payments WHERE customer_id=? ORDER BY id',[customerId])});
async function waitFor(predicate,timeout=100000){const end=Date.now()+timeout;while(!predicate()){if(error)throw error;if(closed)throw Error('Audio connection closed before the turn completed');if(Date.now()>end)throw Error('Audio turn timed out');await delay(100);}if(error)throw error;}
function pcm(text){if(!scenario.questions.includes(text))throw Error('Only fixed scenario speech is permitted');const wav=execFileSync('espeak-ng',['--stdout','-s','150',text],{maxBuffer:3e6,timeout:10000});const b=execFileSync('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,maxBuffer:1500000,timeout:10000});if(b.length<1000||b.length>1280000)throw Error('Speech fixture out of bounds');return b;}
function complete(){return Boolean(state?.transcript&&state.reply)&&state.audioBytes>1600&&state.nonSilentBytes>100&&state.playbackEndAt>0&&Date.now()>=state.playbackEndAt+1600&&Date.now()-state.lastAudio>=1600;}
try{
 const meta=await cfApi(dbPath);if(meta.name!=='pawspace-staging')throw Error('Database is not isolated staging');
 const dep=await cfApi('/workers/scripts/pawspace-staging/deployments'),versions=dep.deployments?.[0]?.versions;
 if(versions?.length!==1||versions[0].percentage!==100)throw Error('Staging version is ambiguous');versionId=versions[0].version_id;
 const version=await cfApi('/workers/scripts/pawspace-staging/versions/'+versionId),bindings=version.resources?.bindings||[];
 const vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text??b.value]));
 if(version.annotations?.['workers/message']!=='staging '+env.EXPECTED_STAGING_SHA||vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='true'||!bindings.some(b=>b.type==='d1'&&(b.id??b.database_id)===env.STAGING_D1_ID))throw Error('Exact certified staging isolation is not verified');
 result.deployedSha=env.EXPECTED_STAGING_SHA;result.workerVersion=versionId;
 const [call]=await query('SELECT customer_id,mode,phone_last4 FROM voice_call_orders WHERE id=?',[env.UAT_VOICE_CALL_ID]);
 if(!call?.customer_id||call.mode!=='uat'||call.phone_last4!==env.EXPECTED_DESTINATION_LAST4)throw Error('Known UAT context does not match');customerId=call.customer_id;
 const config=await api('https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(agentId),eh);
 if(config.conversation_config?.agent?.prompt?.custom_llm?.url!==origin+'/api/elevenlabs/v1')throw Error('Agent is not using the certified staging backend');
 result.agentVersion=config.version_id;result.agentId=agentId;result.agentCallLimits=config.platform_settings?.call_limits??null;result.runnerSha=env.GITHUB_SHA;
 threadId='THREAD-AUDIO-DEMO-'+env.GITHUB_RUN_ID+'-'+(env.GITHUB_RUN_ATTEMPT||'1')+'-'+scenario.id;
 if((await query('SELECT id FROM communication_threads WHERE id=?',[threadId])).length)throw Error('A fresh per-call context is required');
 const now=Date.now();
 // Separate synthetic profiles have no dialable phone or email. Never edit the tester's account.
 customerId='UAT-AUDIO-DEMO-'+env.GITHUB_RUN_ID+'-'+(env.GITHUB_RUN_ATTEMPT||'1')+'-'+scenario.id;
 await query("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,'blr','Audio Demo Customer','NO-PHONE',NULL,NULL,'uat_audio_demo','{}',?,?)",[customerId,now,now]);
 await query("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,age_years,weight_kg,source_pet_id,created_at,updated_at) VALUES (?,?,'Bruno','dog','Mixed','not_provided',3,15,'uat_audio_demo',?,?)",[customerId+'-BRUNO',customerId,now,now]);
 result.syntheticProfile=true;result.hasDialableNumber=false;
 await query("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open','ai-orchestrator',NULL,?,?)",[threadId,customerId,now,now]);
 await query("INSERT INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,'customer',?,?,'customer',?)",[crypto.randomUUID(),threadId,customerId,customerId,now]);
 result.threadId=threadId;before=await businessSnapshot();
 const signed=await api('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(agentId),eh);
 if(!signed.signed_url||new URL(signed.signed_url).protocol!=='wss:'||new URL(signed.signed_url).hostname!=='api.elevenlabs.io')throw Error('Unapproved audio socket URL');
 // Construct a real voice connection. No user_message/text injection, phone number, or dial request.
 socket=new WebSocket(signed.signed_url);
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_customer_id:customerId,pawspace_thread_id:threadId},dynamic_variables:{pawspace_uat:'true'}})));
 socket.addEventListener('error',()=>{error=Error('Audio WebSocket transport failure');});
 socket.addEventListener('close',event=>{closed=true;result.closeCode=event.code;result.closeReason=String(event.reason||'').replace(/[\r\n]/g,' ').slice(0,400);});
 socket.addEventListener('message',event=>{try{
  const d=JSON.parse(String(event.data)),now=Date.now();
  if(d.type==='ping')socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));
  if(d.type==='conversation_initiation_metadata'){const m=d.conversation_initiation_metadata_event;conversationId=m.conversation_id;format=m.user_input_audio_format;outputFormat=m.agent_output_audio_format;if(format!=='pcm_16000')throw Error('Synthetic speech needs PCM16000');audioFormat(outputFormat);result.conversationId=conversationId;}
  if(phase==='greeting'){
   if(d.type==='agent_response')greeting=String(d.agent_response_event?.agent_response||'');
   if(d.type==='audio'){const b=Buffer.from(d.audio_event?.audio_base_64||'','base64'),f=audioFormat(outputFormat);greetingEnd=Math.max(now,greetingEnd)+b.length/(f.rate*f.bytesPerSample)*1000;lastGreeting=now;}
  }else if(state){
   const change=applyAudioProbeEvent(state,d,{now,outputFormat});
   if(change==='audio'&&!firstReplyAudio)firstReplyAudio=now;
   if(change==='transcript')console.log('DEMO_ASR='+JSON.stringify({id:scenario.id,turn:result.turns.length+1,text:state.segments.at(-1)}));
  }
  if(d.type==='error'||d.type==='client_error'){result.providerError=String(d.message||d.error?.message||d.error||d.client_error_event?.message||'unspecified').slice(0,400);throw Error('Agent returned a conversation error');}
 }catch(e){error=e;}});
 await waitFor(()=>format&&greeting&&greetingEnd>0&&Date.now()>greetingEnd+1000&&Date.now()-lastGreeting>1000,60000);
 result.greeting=greeting;phase='turn';
 pump=setInterval(()=>{if(socket.readyState!==WebSocket.OPEN)return;const live=frame&&frameOffset<frame.length;const b=live?frame.subarray(frameOffset,frameOffset+3200):Buffer.alloc(3200);if(live){frameOffset+=b.length;lastSpeechAt=Date.now();}socket.send(JSON.stringify({user_audio_chunk:b.toString('base64')}));},100);
 for(let index=0;index<scenario.questions.length;index++){
  const question=scenario.questions[index],audio=pcm(question);
  state={...createAudioProbeState(),greeting:true,listening:true};firstReplyAudio=0;lastSpeechAt=0;frameOffset=0;frame=Buffer.concat([Buffer.alloc(16000),audio]);
  const started=Date.now();
  await waitFor(()=>frameOffset>=frame.length&&complete());
  const spoken={number:index+1,question,transcript:state.transcript,reply:state.reply,inputAudioBytes:audio.length,outputAudioBytes:state.audioBytes,nonSilentBytes:state.nonSilentBytes,asrSegments:state.segments.length,interrupted:state.replyInterrupted,playbackComplete:true,elapsedMs:Date.now()-started,replyAudioAfterInputMs:firstReplyAudio?Math.max(0,firstReplyAudio-lastSpeechAt):null};
  result.turns.push(spoken);console.log('DEMO_TURN='+JSON.stringify({id:scenario.id,...spoken}));
  if(state.replyInterrupted||state.segments.length!==1){result.issues.push('Interrupted or split/duplicate user turn '+(index+1));break;}
  if(isHandoffReply(state.reply)&&scenario.expectedHandoffAt!==index+1){result.issues.push('Unexpected human handoff at turn '+(index+1));break;}
 }
}catch(e){result.issues.push(String(e.message||e));if(state?.transcript||state?.reply)result.partialTurn={question:scenario.questions[result.turns.length],transcript:state.transcript,reply:state.reply,outputAudioBytes:state.audioBytes,interrupted:state.replyInterrupted};}
finally{clearInterval(pump);if(socket&&socket.readyState<2)socket.close(1000,'no-phone demo complete');}
try{
 if(conversationId){
  let detail;
  for(let attempt=0;attempt<30;attempt++){detail=await api('https://api.elevenlabs.io/v1/convai/conversations/'+encodeURIComponent(conversationId),eh);if(['done','failed'].includes(detail.status))break;await delay(2000);}
  result.providerStatus=detail.status;result.finalTranscript=(detail.transcript||[]).map(t=>({role:t.role,message:String(t.message||''),timeInCallSeconds:t.time_in_call_secs,interrupted:Boolean(t.interrupted)}));
  result.durationSeconds=detail.metadata?.call_duration_secs;
  if(detail.status!=='done'||detail.agent_id!==agentId||detail.conversation_id!==conversationId||detail.metadata?.text_only===true||detail.metadata?.phone_call?.call_sid)result.issues.push('Final audio conversation identity or transport did not match');
  const users=result.finalTranscript.map((row,index)=>({row,index})).filter(x=>x.row.role==='user');
  if(users.length!==result.turns.length||users.length!==scenario.questions.length)result.issues.push('Not all four question/answer turns completed');
  for(let i=0;i<result.turns.length;i++){
   const turn=result.turns[i],u=users[i],end=users[i+1]?.index??result.finalTranscript.length;
   const answers=u?result.finalTranscript.slice(u.index+1,end).filter(x=>x.role==='agent'):[];
   if(!u||norm(u.row.message)!==norm(turn.transcript)||norm(answers.map(x=>x.message).join(' '))!==norm(turn.reply)||answers.some(x=>x.interrupted||/\.{3}|…/.test(x.message)))result.issues.push('Final transcript mismatch/interruption at turn '+(i+1));
   const wanted=new Set(norm(turn.question).split(' ').filter(x=>x.length>3));const heard=new Set(norm(turn.transcript).split(' '));
   turn.recognitionCoverage=[...wanted].filter(x=>heard.has(x)).length/Math.max(1,wanted.size);
   if(turn.recognitionCoverage<0.65)result.issues.push('Speech recognition lost substantial content at turn '+(i+1));
  }
  result.finalTranscriptMatched=!result.issues.some(x=>/transcript|turns completed/.test(x));
 }
 if(threadId&&before){
  const after=await businessSnapshot();result.businessStateUnchanged=fingerprint(before)===fingerprint(after);
  const messages=await query("SELECT count(*) n FROM communication_messages WHERE thread_id=? AND direction='outbound' AND channel<>'voice'",[threadId]);
  result.nonVoiceMessages=Number(messages[0]?.n||0);if(!result.businessStateUnchanged||result.nonVoiceMessages)result.issues.push('Unexpected business-state change or non-voice message');
  const handoffs=await query("SELECT status,reason FROM ai_handoffs WHERE thread_id=? AND status IN ('queued','staff_active')",[threadId]);result.handoffs=handoffs;
  if(scenario.expectedHandoffAt&&!handoffs.length)result.issues.push('Requested staff handoff was not persisted');
  const dep=await cfApi('/workers/scripts/pawspace-staging/deployments');if(dep.deployments?.[0]?.versions?.[0]?.version_id!==versionId)result.issues.push('Staging version changed during the demo');
 }
}catch(e){result.issues.push('Post-call verification: '+String(e.message||e));}
result.passed=result.turns.length===scenario.questions.length&&result.issues.length===0;result.finishedAt=new Date().toISOString();
await writeFile('audio-demo-'+scenario.id+'.json',JSON.stringify(result,null,2));console.log('DEMO_RESULT='+JSON.stringify(result));if(!result.passed)process.exitCode=1;
