import {authError,database,requireCustomerOwnership,requirePermission,resolveActor} from "../../../../lib/server-auth";
import {ensureCommunicationTables} from "../../../../lib/communication-engine";
import {isVoiceAllowlisted} from "../../../../lib/voice-call-gate";
import {readBoundedRequestText} from "../../../../lib/voice-safe-fetch";
import {readBoundedText} from "../../../../lib/provider-response-bounds";
import {claimNextAudioBatch,requireNextAudioBatch,ensureNextAudioBudget,NEXT_AUDIO_BUDGET_ID,NEXT_AUDIO_THREAD_PREFIX,provisionNextAudioBudget,reserveNextAudioLease,validateAudioRateReceipt,type AudioRateReceipt} from "../../../../lib/next-audio-budget";
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const refuse=(reason:string)=>{throw new Response(reason,{status:403});};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
async function context(request:Request){
 if(request.headers.get("origin")!==new URL(request.url).origin)refuse("next_audio_same_origin_required");
 const actor=await resolveActor(request);requirePermission(actor,"communications.call");
 if(actor.email!=="founder@pawspace.in"||actor.developmentPreview)refuse("next_audio_founder_auth_required");
 const {env}=await import("cloudflare:workers"),e=env as unknown as Row;
 if(text(e.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||text(e.FORBID_PRODUCTION)!=="true"||text(e.PAWSPACE_VOICE_PHONE_TESTS_PAUSED)!=="true"||text(e.PAWSPACE_PAYMENT_ENV)!=="sandbox"||text(e.PAWSPACE_PAYMENT_LIVE_APPROVED)!=="false"||text(e.PAWSPACE_RAZORPAYX_ENV)!=="sandbox"||text(e.PAWSPACE_RAZORPAYX_LIVE_APPROVED)!=="false")refuse("next_audio_isolation_refused");
 if(!/^[a-f0-9]{40}$/.test(text(e.PAWSPACE_STAGING_BUILD_SHA)))refuse("next_audio_version_missing");
 const db=await database();await ensureNextAudioBudget(db);
 // Only existing privileged D1 administration can provision evidence. HTTP bodies cannot supply rates.
 await db.prepare("CREATE TABLE IF NOT EXISTS next_audio_rate_evidence (id TEXT PRIMARY KEY,region TEXT NOT NULL,receipt_json TEXT NOT NULL)").run();
 const evidence=await db.prepare("SELECT region,receipt_json FROM next_audio_rate_evidence WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 if(!evidence)refuse("next_audio_account_charge_ceiling_not_attested");
 const receipt=JSON.parse(String(evidence!.receipt_json)) as AudioRateReceipt;validateAudioRateReceipt(receipt,Date.now());
 if(/UNIT TEST|invented/i.test(receipt.evidenceReference)||receipt.sourceSha!==text(e.PAWSPACE_STAGING_BUILD_SHA)||text(e.PAWSPACE_AI_PROVIDER)!==receipt.provider||text(e.PAWSPACE_AI_VOICE_MODEL)!==receipt.model)refuse("next_audio_runtime_rate_or_source_mismatch");
 const region=text(e.ELEVENLABS_API_BASE)||"https://api.in.residency.elevenlabs.io";
 if(!["https://api.elevenlabs.io","https://api.in.residency.elevenlabs.io"].includes(region)||region!==evidence!.region||!text(e.ELEVENLABS_API_KEY)||!text(e.ELEVENLABS_GROOMING_AGENT_ID))refuse("next_audio_region_or_agent_unproven");
 const response=await fetch(`${region}/v1/convai/agents/${encodeURIComponent(text(e.ELEVENLABS_GROOMING_AGENT_ID))}`,{headers:{"xi-api-key":text(e.ELEVENLABS_API_KEY)},redirect:"error",signal:AbortSignal.timeout(15000)});
 if(!response.ok)refuse("next_audio_agent_config_read_refused");
 const agent=JSON.parse(await readBoundedText(response,512*1024)) as Row;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(agent)))),b=>b.toString(16).padStart(2,"0")).join("");
 const c=agent.conversation_config as Row,p=(c?.agent as Row)?.prompt as Row,duration=Number((c?.conversation as Row)?.max_duration_seconds);
 if(hash!==receipt.agentConfigSha256||(p?.custom_llm as Row)?.url!=="https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1"||!Number.isInteger(duration)||duration<60||duration>120)refuse("next_audio_native_hard_duration_or_config_unproven");
 await provisionNextAudioBudget(db,receipt,Date.now());
 return {actor,db,e,receipt,duration,hash};
}
export async function GET(request:Request){try{
 const c=await context(request),budget=await c.db.prepare("SELECT cap_micros,reserved_micros,conversations,expires_at FROM next_audio_budget WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 return json({data:{paidExecutionAllowed:true,sourceSha:c.receipt.sourceSha,agentConfigSha256:c.hash,providerHardDurationSeconds:c.duration,budget,phoneDialed:false}});
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Next audio readiness refused");}}
export async function POST(request:Request){try{
 const c=await context(request),raw=await readBoundedRequestText(request,4096);if(raw.length>4096)refuse("next_audio_payload_too_large");
 const body=JSON.parse(raw) as Row,customerId=text(body.customerId),callId=text(body.callId);
 if(body.action==="claim_batch"){
  const token=await claimNextAudioBatch(c.db,text(body.runId),c.receipt.sourceSha,Date.now());
  return json({data:{batchToken:token,budgetId:NEXT_AUDIO_BUDGET_ID,sourceSha:c.receipt.sourceSha}},201);
 }
 await requireNextAudioBatch(c.db,text(body.batchToken),c.receipt.sourceSha);
 await requireCustomerOwnership(c.db,c.actor,customerId);
 const customer=await c.db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
 if(!customer||!isVoiceAllowlisted(c.e,customer.primary_phone))refuse("next_audio_test_customer_not_allowlisted");
 const call=await c.db.prepare("SELECT thread_id FROM ai_voice_calls WHERE id=? AND customer_id=? AND status='active' AND transport_provider='sandbox_simulator' AND consent_status='verified'").bind(callId,customerId).first<Row>();
 if(!call||text(call.thread_id).startsWith(NEXT_AUDIO_THREAD_PREFIX))refuse("next_audio_active_synthetic_call_required");
 const threadId=NEXT_AUDIO_THREAD_PREFIX+crypto.randomUUID(),now=Date.now();
 const lease=await reserveNextAudioLease(c.db,{threadId,customerId,sourceSha:c.receipt.sourceSha,agentConfigSha256:c.hash,providerHardDurationSeconds:c.duration,now});
 await ensureCommunicationTables(c.db);
 // Closing/completing a synthetic call also prevents further paid model attempts on its lease.
 await c.db.prepare("CREATE TRIGGER IF NOT EXISTS next_audio_call_stop AFTER UPDATE OF status ON ai_voice_calls WHEN NEW.status<>'active' BEGIN UPDATE next_audio_leases SET expires_at=MIN(expires_at,CAST(strftime('%s','now') AS INTEGER)*1000) WHERE thread_id=OLD.thread_id; END").run();
 const updates=await c.db.batch([
  c.db.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?,'open','ai-orchestrator',?,?)").bind(threadId,customerId,now,now),
  c.db.prepare("UPDATE ai_voice_calls SET thread_id=? WHERE id=? AND customer_id=? AND status='active' AND transport_provider='sandbox_simulator' AND thread_id=?").bind(threadId,callId,customerId,call!.thread_id),
 ]);
 if(updates.some(r=>Number(r.meta?.changes)!==1))refuse("next_audio_call_changed_during_admission");
 return json({data:{threadId,customerId,callId,...lease,sourceSha:c.receipt.sourceSha,agentConfigSha256:c.hash,providerHardDurationSeconds:c.duration,phoneDialed:false}},201);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);if(error instanceof Error&&/^next_audio_batch_/.test(error.message))return json({error:error.message},403);return authError(error,"Next audio lease refused");}}
