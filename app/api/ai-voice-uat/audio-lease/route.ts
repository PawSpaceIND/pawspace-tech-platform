import {NEXT_AUDIO_INSERT_THREAD_SQL,NEXT_AUDIO_ATTACH_CALL_SQL,NEXT_AUDIO_ADMISSION_READBACK_SQL,assertNextAudioAdmission} from "../../../../lib/next-audio-admission";
import {resolveWorkersAiStt} from "../../../../lib/voice-workers-ai";
import {synthesizeNativeCarrierTts} from "../../../../lib/voice-native-tts";
import {runElevenLabsGroundedTurn} from "../../../../lib/elevenlabs-custom-llm";
import {authError,database,requireCustomerOwnership,requirePermission,resolveActor} from "../../../../lib/server-auth";
import {ensureCustomerAccountTables} from "../../../../lib/customer-account";
import {ensureAiVoiceUatTables} from "../../../../lib/ai-voice-uat";
import {ensureCommunicationTables} from "../../../../lib/communication-engine";
import {isVoiceAllowlisted} from "../../../../lib/voice-call-gate";
import {decodeInlineAudio,readBoundedRequestText} from "../../../../lib/voice-safe-fetch";
import {readBoundedText} from "../../../../lib/provider-response-bounds";
import {NextAudioReadinessFailure,reserveNextAudioSpeech,claimNextAudioBatch,requireNextAudioBatch,ensureNextAudioBudget,NEXT_AUDIO_BUDGET_ID,NEXT_AUDIO_THREAD_PREFIX,provisionNextAudioBudget,reserveNextAudioLease,validateAudioRateReceipt,type AudioRateReceipt} from "../../../../lib/next-audio-budget";
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const refuse=(reason:string)=>{throw new Response(reason,{status:403});};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
async function context(request:Request){
 let stage="authentication";try{
 if(request.headers.get("origin")!==new URL(request.url).origin)refuse("next_audio_same_origin_required");
 const actor=await resolveActor(request);requirePermission(actor,"communications.call");
 if(actor.email!=="founder@pawspace.in"||actor.developmentPreview)refuse("next_audio_founder_auth_required");
 const {env}=await import("cloudflare:workers"),e=env as unknown as Row;
 if(text(e.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||text(e.FORBID_PRODUCTION)!=="true"||text(e.PAWSPACE_VOICE_PHONE_TESTS_PAUSED)!=="true"||text(e.PAWSPACE_PAYMENT_ENV)!=="sandbox"||text(e.PAWSPACE_PAYMENT_LIVE_APPROVED)!=="false"||text(e.PAWSPACE_RAZORPAYX_ENV)!=="sandbox"||text(e.PAWSPACE_RAZORPAYX_LIVE_APPROVED)!=="false")refuse("next_audio_isolation_refused");
 if(!/^[a-f0-9]{40}$/.test(text(e.PAWSPACE_STAGING_BUILD_SHA)))refuse("next_audio_version_missing");
 const db=await database();stage="customer_schema";await ensureCustomerAccountTables(db);stage="voice_schema";await ensureAiVoiceUatTables(db);stage="budget_schema";await ensureNextAudioBudget(db);
 stage="rate_evidence";
 // Only existing privileged D1 administration can provision evidence. HTTP bodies cannot supply rates.
 await db.prepare("CREATE TABLE IF NOT EXISTS next_audio_rate_evidence (id TEXT PRIMARY KEY,region TEXT NOT NULL,receipt_json TEXT NOT NULL)").run();
 const evidence=await db.prepare("SELECT region,receipt_json FROM next_audio_rate_evidence WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 if(!evidence)refuse("next_audio_account_charge_ceiling_not_attested");
 stage="receipt_validation";const receipt=JSON.parse(String(evidence!.receipt_json)) as AudioRateReceipt;validateAudioRateReceipt(receipt,Date.now());
 if(/UNIT TEST|invented/i.test(receipt.evidenceReference)||receipt.sourceSha!==text(e.PAWSPACE_STAGING_BUILD_SHA)||text(e.PAWSPACE_AI_PROVIDER)!==receipt.provider||text(e.PAWSPACE_AI_VOICE_MODEL)!==receipt.model)refuse("next_audio_runtime_rate_or_source_mismatch");
 const region=text(e.ELEVENLABS_API_BASE)||"https://api.in.residency.elevenlabs.io";
 if((region!=="https://api.elevenlabs.io"&&region!=="https://api.in.residency.elevenlabs.io")||region!==evidence!.region||!text(e.ELEVENLABS_API_KEY)||!text(e.ELEVENLABS_GROOMING_AGENT_ID))refuse("next_audio_region_or_agent_unproven");
 stage="native_url";const nativeUrl=new URL(`${region}/v1/convai/agents/${encodeURIComponent(text(e.ELEVENLABS_GROOMING_AGENT_ID))}`);
 stage="native_headers";const nativeHeaders=new Headers({"xi-api-key":text(e.ELEVENLABS_API_KEY)});
 stage="native_request_base";const nativeBase=new Request(nativeUrl.href,{headers:nativeHeaders,redirect:"manual"});
 stage="native_timeout";const nativeSignal=AbortSignal.timeout(15000);
 stage="native_request";const nativeRequest=new Request(nativeBase,{signal:nativeSignal});
 stage="native_fetch";const response=await fetch(nativeRequest);
 if(response.status>=300&&response.status<400)refuse("next_audio_native_redirect_refused");
 if(!response.ok)refuse("next_audio_agent_config_read_refused");
 stage="native_json";const agent=JSON.parse(await readBoundedText(response,512*1024)) as Row;
 stage="native_hash";const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(agent)))),b=>b.toString(16).padStart(2,"0")).join("");
 const c=agent.conversation_config as Row,p=(c?.agent as Row)?.prompt as Row,duration=Number((c?.conversation as Row)?.max_duration_seconds);
 if(hash!==receipt.agentConfigSha256||(p?.custom_llm as Row)?.url!=="https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1"||!Number.isInteger(duration)||duration<60||duration>120)refuse("next_audio_native_hard_duration_or_config_unproven");
 stage="budget_provision";await provisionNextAudioBudget(db,receipt,Date.now());
 return {actor,db,e,receipt,duration,hash};
 }catch(error){if(error instanceof Response)throw error;throw new NextAudioReadinessFailure(stage,error);}
}
export async function GET(request:Request){try{
 const c=await context(request),budget=await c.db.prepare("SELECT cap_micros,reserved_micros,conversations,expires_at FROM next_audio_budget WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 return json({data:{paidExecutionAllowed:true,sourceSha:c.receipt.sourceSha,agentConfigSha256:c.hash,providerHardDurationSeconds:c.duration,budget,workersSpeechReady:Boolean(c.e.AI)&&c.e.VOICE_STT_MODEL==="@cf/openai/whisper-large-v3-turbo"&&c.e.VOICE_CARRIER_TTS_MODEL==="@cf/deepgram/aura-2-en",phoneDialed:false}});
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);if(error instanceof NextAudioReadinessFailure)return json({error:error.message,diagnostic:{stage:error.stage,kind:error.kind}},500);return authError(error,"Next audio readiness refused");}}
export async function POST(request:Request){try{
 const c=await context(request),raw=await readBoundedRequestText(request,2*1024*1024);
 const body=JSON.parse(raw) as Row;if(!text(body.action).startsWith("workers_")&&raw.length>4096)refuse("next_audio_payload_too_large");const customerId=text(body.customerId),callId=text(body.callId);
 if(body.action==="claim_batch"){
  const token=await claimNextAudioBatch(c.db,text(body.runId),c.receipt.sourceSha,Date.now());
  return json({data:{batchToken:token,budgetId:NEXT_AUDIO_BUDGET_ID,sourceSha:c.receipt.sourceSha}},201);
 }
 await requireNextAudioBatch(c.db,text(body.batchToken),c.receipt.sourceSha);
 await requireCustomerOwnership(c.db,c.actor,customerId);
 const customer=await c.db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
 if(!customer||!isVoiceAllowlisted(c.e,customer.primary_phone))refuse("next_audio_test_customer_not_allowlisted");
 const call=await c.db.prepare("SELECT thread_id FROM ai_voice_calls WHERE id=? AND customer_id=? AND status='active' AND transport_provider='sandbox_simulator' AND consent_status='verified'").bind(callId,customerId).first<Row>();
 if(text(body.action).startsWith("workers_")){
  if(!call||!text(call.thread_id).startsWith(NEXT_AUDIO_THREAD_PREFIX)||!c.e.AI||c.e.VOICE_STT_MODEL!=="@cf/openai/whisper-large-v3-turbo"||c.e.VOICE_CARRIER_TTS_MODEL!=="@cf/deepgram/aura-2-en")refuse("next_audio_workers_speech_unproven");
  const threadId=text(call!.thread_id),now=Date.now(),speechText=text(body.text);
  try{
   if(body.action==="workers_stt"){
    const audio=decodeInlineAudio(text(body.audioRef),{maxBytes:960044,allowedMediaTypes:["audio/wav"]}).bytes,v=new DataView(audio.buffer,audio.byteOffset,audio.byteLength);
    if(audio.length<46||new TextDecoder().decode(audio.slice(0,4))!=="RIFF"||new TextDecoder().decode(audio.slice(8,16))!=="WAVEfmt "||v.getUint32(16,true)!==16||v.getUint16(20,true)!==1||v.getUint16(22,true)!==1||v.getUint32(24,true)!==16000||v.getUint16(34,true)!==16||new TextDecoder().decode(audio.slice(36,40))!=="data"||v.getUint32(40,true)!==audio.length-44||(audio.length-44)%2!==0)refuse("next_audio_fixed_pcm_wav_required");
    await reserveNextAudioSpeech(c.db,{threadId,customerId,kind:"stt",units:audio.length-44,now});
    const r=await resolveWorkersAiStt(c.e).transcribe({audioRef:text(body.audioRef),language:"en"});return json({data:{...r,confidenceReportedByProvider:false,model:c.e.VOICE_STT_MODEL,engine:"workers_ai"}});
   }
   if(body.action==="workers_tts"){
    await reserveNextAudioSpeech(c.db,{threadId,customerId,kind:"tts",units:new TextEncoder().encode(speechText).length,now});
    const r=await synthesizeNativeCarrierTts({AI:c.e.AI,VOICE_CARRIER_TTS_MODEL:c.e.VOICE_CARRIER_TTS_MODEL,VOICE_CARRIER_TTS_SPEAKER:c.e.VOICE_CARRIER_TTS_SPEAKER,VOICE_SPEECH_TIMEOUT_MS:c.e.VOICE_SPEECH_TIMEOUT_MS,PAWSPACE_VOICE_NATIVE_TTS_PROVIDER:"workers_ai",PAWSPACE_VOICE_NATIVE_TTS_FALLBACK:"none"},speechText,16000,{signal:request.signal});return new Response(r.result,{headers:{"content-type":"audio/pcm","x-pawspace-engine":"workers_ai","x-pawspace-model":r.model,"cache-control":"no-store"}});
   }
   if(body.action==="workers_brain"){
    await reserveNextAudioSpeech(c.db,{threadId,customerId,kind:"brain",units:speechText.length,now});
    const rows=await c.db.prepare("SELECT direction,payload_json FROM communication_messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 20").bind(threadId).all<Row>();
    const history=(rows.results??[]).reverse().map(r=>({role:r.direction==="inbound"?"user":"assistant",content:text((JSON.parse(text(r.payload_json)) as Row).text)}));
    const r=await runElevenLabsGroundedTurn(c.db,{messages:[...history,{role:"user",content:speechText}],metadata:{pawspace_customer_id:customerId,pawspace_thread_id:threadId}},undefined,undefined,{signal:request.signal,emit:()=>false});return json({data:{...r,engine:"canonical_pawspace_brain",speechEngine:"workers_ai"}});
   }
   refuse("next_audio_workers_action_invalid");
  }catch(error){if(error instanceof Error&&/^next_audio_speech_/.test(error.message))refuse(error.message);throw error;}
 }
 if(!call||text(call.thread_id).startsWith(NEXT_AUDIO_THREAD_PREFIX))refuse("next_audio_active_synthetic_call_required");
 const threadId=NEXT_AUDIO_THREAD_PREFIX+crypto.randomUUID(),now=Date.now();
 const lease=await reserveNextAudioLease(c.db,{threadId,customerId,sourceSha:c.receipt.sourceSha,agentConfigSha256:c.hash,providerHardDurationSeconds:c.duration,now});
 await ensureCommunicationTables(c.db);
 // Closing/completing a synthetic call also prevents further paid model attempts on its lease.
 await c.db.prepare("CREATE TRIGGER IF NOT EXISTS next_audio_call_stop AFTER UPDATE OF status ON ai_voice_calls WHEN NEW.status<>'active' BEGIN UPDATE next_audio_leases SET expires_at=MIN(expires_at,CAST(strftime('%s','now') AS INTEGER)*1000) WHERE thread_id=OLD.thread_id; END").run();
 const updates=await c.db.batch([
  c.db.prepare(NEXT_AUDIO_INSERT_THREAD_SQL).bind(threadId,customerId,now,now),
  c.db.prepare(NEXT_AUDIO_ATTACH_CALL_SQL).bind(threadId,callId,customerId,call!.thread_id),
  c.db.prepare(NEXT_AUDIO_ADMISSION_READBACK_SQL).bind(callId,customerId,threadId,NEXT_AUDIO_BUDGET_ID,now),
 ]);
 // Trigger writes contribute to D1 meta.changes; returned identities and owned live state prove admission.
 try{assertNextAudioAdmission(updates,{callId,threadId,customerId,now:Date.now()});}catch{refuse("next_audio_call_changed_during_admission");}
 return json({data:{threadId,customerId,callId,...lease,sourceSha:c.receipt.sourceSha,agentConfigSha256:c.hash,providerHardDurationSeconds:c.duration,phoneDialed:false}},201);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);if(error instanceof Error&&/^next_audio_batch_/.test(error.message))return json({error:error.message},403);return authError(error,"Next audio lease refused");}}
