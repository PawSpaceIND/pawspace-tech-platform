import{ensureCommunicationTables}from"./communication-engine";
import{endInboundAiVoiceSession}from"./inbound-ai-telephony";
import{reconcileVerifiedElevenLabsCompletion}from"./voice-outbound-governance";

type Env=Record<string,unknown>;type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const bytes=(value:string)=>new TextEncoder().encode(value);
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer)).map(v=>v.toString(16).padStart(2,"0")).join("");

export async function verifyElevenLabsWebhook(rawBody:string,signature:string,env:Env,nowSeconds=Math.floor(Date.now()/1000)){
 const secret=text(env.ELEVENLABS_WEBHOOK_SECRET);if(!secret)return{verified:false as const,reason:"ElevenLabs post-call webhook secret is not configured"};
 const parts=Object.fromEntries(signature.split(",").map(part=>part.trim().split("=",2)).filter(pair=>pair.length===2));
 const timestamp=Number(parts.t),provided=text(parts.v0);if(!Number.isFinite(timestamp)||!provided)return{verified:false as const,reason:"ElevenLabs signature is malformed"};
 if(Math.abs(nowSeconds-timestamp)>30*60)return{verified:false as const,reason:"ElevenLabs signature is stale"};
 const key=await crypto.subtle.importKey("raw",bytes(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const expected=hex(await crypto.subtle.sign("HMAC",key,bytes(`${parts.t}.${rawBody}`)));
 if(expected.length!==provided.length)return{verified:false as const,reason:"ElevenLabs signature mismatch"};
 let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^provided.charCodeAt(i);
 return diff===0?{verified:true as const}:{verified:false as const,reason:"ElevenLabs signature mismatch"};
}

export async function ensureElevenLabsPostCallTables(db:D1Database){await ensureCommunicationTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS elevenlabs_voice_webhooks (event_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,event_type TEXT NOT NULL,status TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,processed_at INTEGER)"),
 db.prepare("CREATE INDEX IF NOT EXISTS elevenlabs_voice_webhooks_conversation_idx ON elevenlabs_voice_webhooks(conversation_id,created_at)")
]);}

function initiationVariables(data:Row){const client=data.conversation_initiation_client_data as Row|undefined;const dynamic=(client?.dynamic_variables||{})as Row;return dynamic;}
function transcriptRows(data:Row){return Array.isArray(data.transcript)?data.transcript.filter(v=>v&&typeof v==="object")as Row[]:[];}
async function stableMessageId(conversationId:string,index:number){const digest=await crypto.subtle.digest("SHA-256",bytes(`${conversationId}:${index}`));return`MSG-EL-${hex(digest).slice(0,20).toUpperCase()}`;}

export async function reconcileElevenLabsPostCall(db:D1Database,payload:Row){
 await ensureElevenLabsPostCallTables(db);
 const type=text(payload.type),data=(payload.data||{})as Row,conversationId=text(data.conversation_id),eventTimestamp=Number(payload.event_timestamp||0);
 if(!conversationId||!["post_call_transcription","call_initiation_failure"].includes(type))throw new Response("Unsupported or incomplete ElevenLabs post-call event",{status:400});
 const eventId=`${type}:${conversationId}:${Number.isFinite(eventTimestamp)?eventTimestamp:0}`,now=Date.now();
 const prior=await db.prepare("SELECT status FROM elevenlabs_voice_webhooks WHERE event_id=?").bind(eventId).first<Row>();
 if(prior&&text(prior.status)==="processed")return{duplicatePrevented:true,conversationId,status:"processed"};
 await db.prepare("INSERT OR IGNORE INTO elevenlabs_voice_webhooks (event_id,conversation_id,event_type,status,detail_json,created_at) VALUES (?,?,?,'processing','{}',?)").bind(eventId,conversationId,type,now).run();

 const vars=initiationVariables(data),sessionId=text(vars.pawspace_voice_session_id),voiceCallId=text(vars.pawspace_voice_call_id);
 if(type==="call_initiation_failure"){
  if(sessionId)await endInboundAiVoiceSession(db,{sessionId,outcome:"elevenlabs_call_initiation_failure"}).catch(()=>null);
  if(voiceCallId)await reconcileVerifiedElevenLabsCompletion(db,{callId:voiceCallId,conversationId,completed:false,asOf:now}).catch(()=>null);
  await db.prepare("UPDATE elevenlabs_voice_webhooks SET status='processed',detail_json=?,processed_at=? WHERE event_id=?").bind(JSON.stringify({outcome:"call_initiation_failure",sessionId:sessionId||null,voiceCallId:voiceCallId||null}),now,eventId).run();
  return{duplicatePrevented:false,conversationId,status:"processed",outcome:"call_initiation_failure"};
 }
 let session:Row|null=null,threadId="",customerId="";
 if(sessionId){
  session=await db.prepare("SELECT * FROM inbound_ai_voice_sessions WHERE id=?").bind(sessionId).first<Row>();
  if(!session)throw new Response("PawSpace voice session was not found for ElevenLabs post-call event",{status:409});
  threadId=text(session.thread_id);customerId=text(session.customer_id);
 }else if(voiceCallId){
  const call=await db.prepare("SELECT id,customer_id,lead_id,booking_id FROM voice_call_orders WHERE id=?").bind(voiceCallId).first<Row>();
  if(!call||!text(call.customer_id))throw new Response("PawSpace outbound voice call was not found for ElevenLabs post-call event",{status:409});
  customerId=text(call.customer_id);const open=await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<Row>();threadId=text(open?.id);
  if(!threadId){threadId=`THREAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.batch([
   db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,?,NULL,'open','ai-orchestrator',NULL,?,?)").bind(threadId,customerId,text(call.booking_id)||null,text(call.lead_id)||null,now,now),
   db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(crypto.randomUUID(),threadId,"customer",customerId,customerId,now),
  ]);}
 }else throw new Response("PawSpace voice identity is missing from ElevenLabs dynamic variables",{status:409});

 let persisted=0;const transcript=transcriptRows(data);
 for(let index=0;index<transcript.length;index++){
  const turn=transcript[index],role=text(turn.role).toLowerCase(),message=text(turn.message||turn.text);
  if(!message||!["user","agent","assistant"].includes(role))continue;
  const messageId=await stableMessageId(conversationId,index),direction=role==="user"?"inbound":"outbound";
  const result=await db.prepare("INSERT OR IGNORE INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,?,'voice','transactional','elevenlabs_post_call',?,'received','elevenlabs',?,?,?,?,?,?)")
   .bind(messageId,threadId,customerId,direction,JSON.stringify({text:message,conversationId,turnIndex:index,source:"post_call_transcription"}),conversationId,`elevenlabs:${conversationId}:${index}`,JSON.stringify({postCallVerified:true,authority:"transcript_only"}),"system:elevenlabs-post-call",now,now).run();
  persisted+=Number(result.meta?.changes||0);
 }
 const analysis=(data.analysis||{})as Row,summary=text(analysis.transcript_summary||analysis.summary);
 const metadata=(data.metadata||{})as Row;
 if(session)await db.prepare("UPDATE ai_voice_calls SET disposition=COALESCE(NULLIF(?,''),disposition),outcome=COALESCE(outcome,'completed'),ended_at=COALESCE(ended_at,?) WHERE id=?")
  .bind(summary.slice(0,1000),now,text(vars.pawspace_ai_call_id||session.ai_call_id)).run().catch(()=>undefined);
 const completion=sessionId?await endInboundAiVoiceSession(db,{sessionId,outcome:"elevenlabs_completed"}).catch(()=>null):null;
 const voiceCompletion=voiceCallId?await reconcileVerifiedElevenLabsCompletion(db,{callId:voiceCallId,conversationId,completed:true,asOf:now}).catch(()=>null):null;
 await db.prepare("UPDATE elevenlabs_voice_webhooks SET status='processed',detail_json=?,processed_at=? WHERE event_id=?")
  .bind(JSON.stringify({sessionId:sessionId||null,voiceCallId:voiceCallId||null,persistedTurns:persisted,transcriptTurns:transcript.length,summary:summary.slice(0,500),callDurationSecs:Number(metadata.call_duration_secs||metadata.call_duration_seconds||0)||null}),now,eventId).run();
 return{duplicatePrevented:false,conversationId,status:"processed",sessionId:sessionId||null,voiceCallId:voiceCallId||null,persistedTurns:persisted,completion,voiceCompletion};
}

export function elevenLabsTransferReadiness(env:Env){
 const enabled=text(env.PAWSPACE_VOICE_RUNTIME).toLowerCase()==="elevenlabs";
 const destination=text(env.PAWSPACE_VOICE_HUMAN_TRANSFER_NUMBER);
 return{
  enabled,
  destinationConfigured:Boolean(destination),
  exotelConnectAppletRequired:true,
  connectAppletUrl:text(env.ELEVENLABS_EXOTEL_CONNECT_URL)||"https://api.in.residency.elevenlabs.io/v1/convai/exotel/connect-applet",
  transferTool:"transfer_to_number",
  productionReady:false,
  reason:!enabled?"ElevenLabs runtime is not selected":!destination?"Human transfer destination is not configured":"Carrier Connect applet and live transfer still require UAT proof",
 };
}
