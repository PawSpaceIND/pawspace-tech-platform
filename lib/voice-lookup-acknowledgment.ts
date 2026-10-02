/** A fixed, non-commercial phrase is eligible only while a real availability lookup is pending. */
export const LOOKUP_ACKNOWLEDGMENT="Let me check the available times for you. ";
type Claim={suppress:()=>Promise<unknown>};
export function pendingLookupAcknowledgment(input:{signal:AbortSignal;claim:()=>Promise<Claim|null>;emit:(text:string)=>boolean;delayMs?:number}){
 let pending=true;
 const stop=()=>{pending=false;clearTimeout(timer);input.signal.removeEventListener("abort",stop);};
 const timer=setTimeout(()=>{void(async()=>{
  if(!pending||input.signal.aborted)return;
  let claim:Claim|null=null;
  try{
   claim=await input.claim();
   if(!claim)return;
   if(!pending||input.signal.aborted||!input.emit(LOOKUP_ACKNOWLEDGMENT))await claim.suppress();
  }catch{if(claim)await claim.suppress().catch(()=>{});/* A courtesy phrase must not fail the lookup. */}
 })();},input.delayMs??1000);
 input.signal.addEventListener("abort",stop,{once:true});
 if(input.signal.aborted)stop();
 return stop;
}
/** Atomic cooldown and current-turn fence. 'ready' means generated, never evidence of heard audio. */
export async function claimVoiceLookupAcknowledgment(db:D1Database,input:{threadId:string;customerId:string;messageId:string}):Promise<Claim|null>{
 const now=Date.now(),id=`MSG-VOICE-ACK-${crypto.randomUUID()}`;
 const result=await db.prepare(`INSERT INTO communication_messages
 (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at)
 SELECT ?,?,?,NULL,NULL,NULL,'outbound','voice','transactional','voice_lookup_ack',?,'ready','deterministic_lookup_ack',NULL,?,'{}','elevenlabs-voice@system.pawspace',?,?
 WHERE EXISTS (SELECT 1 FROM communication_threads WHERE id=? AND customer_id=? AND status='open' AND (assigned_to IS NULL OR assigned_to='' OR assigned_to='ai-orchestrator'))
 AND NOT EXISTS (SELECT 1 FROM ai_handoffs WHERE thread_id=? AND status IN ('queued','staff_active'))
 AND EXISTS (SELECT 1 FROM communication_messages current WHERE current.id=? AND current.thread_id=? AND current.customer_id=? AND current.direction='inbound'
 AND NOT EXISTS (SELECT 1 FROM communication_messages newer WHERE newer.thread_id=current.thread_id AND newer.customer_id=current.customer_id AND newer.direction='inbound' AND (newer.created_at>current.created_at OR (newer.created_at=current.created_at AND newer.rowid>current.rowid))))
 AND NOT EXISTS (SELECT 1 FROM communication_messages WHERE thread_id=? AND customer_id=? AND template_key='voice_lookup_ack' AND status<>'suppressed' AND created_at>?)`)
 .bind(id,input.threadId,input.customerId,JSON.stringify({text:LOOKUP_ACKNOWLEDGMENT,source:"pending_availability_lookup"}),`voice-lookup-ack:${id}`,now,now,input.threadId,input.customerId,input.threadId,input.messageId,input.threadId,input.customerId,input.threadId,input.customerId,now-60000).run();
 if(Number(result.meta?.changes||0)!==1)return null;
 return{suppress:()=>db.prepare("UPDATE communication_messages SET status='suppressed',updated_at=? WHERE id=? AND status='ready'").bind(Date.now(),id).run()};
}
