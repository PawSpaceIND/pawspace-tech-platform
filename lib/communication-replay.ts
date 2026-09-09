type Row=Record<string,unknown>;
const unsentReasons=new Set(['unsupported_outbox_channel','canonical_recipient_missing','not_configured','recipient_not_allowlisted','recipient_customer_mismatch','consent_refused']);
const safeReason=(reason:string)=>unsentReasons.has(reason)||/^sandbox_(sms|email|chat)_adapter_not_configured$/.test(reason);

/** Requeue only a definitively unsent failure; receipt/timeout ambiguity requires reconciliation. */
export async function replayCommunication(db:D1Database,input:{messageId:string;requestKey:string;failureCreatedAt:number;reason:string;actorEmail:string;actorRole:string}){
 if(!/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestKey)||!input.messageId||!Number.isSafeInteger(input.failureCreatedAt)||input.reason.trim().length<10||input.reason.length>500)return{status:'invalid',reason:'Message, failure version, request key and a clear recovery reason are required'};
 const auditId=`communication-replay:${input.requestKey}`;
 const previous=await db.prepare('SELECT resource_id,detail_json FROM security_audit_events WHERE id=?').bind(auditId).first<Row>();
 if(previous){const detail=JSON.parse(String(previous.detail_json));return previous.resource_id===input.messageId&&detail.failureCreatedAt===input.failureCreatedAt&&detail.reason===input.reason.trim()?{status:'requeued',duplicatePrevented:true,messageId:input.messageId}:{status:'conflict',reason:'This request key belongs to another recovery action'};}
 const before=await db.prepare(`SELECT m.id,m.status message_status,m.provider,m.provider_reference,m.idempotency_key,o.status outbox_status,o.attempt_count,o.last_error,d.id dead_letter_id,d.reason,d.created_at,d.resolved_at
 FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id JOIN communication_dead_letters d ON d.message_id=m.id WHERE m.id=?`).bind(input.messageId).first<Row>();
 if(!before||before.message_status!=='dead_letter'||before.outbox_status!=='dead_letter'||before.resolved_at!=null||Number(before.created_at)!==input.failureCreatedAt)return{status:'conflict',reason:'The failure changed; refresh the recovery list'};
 if(before.provider_reference||before.provider==='sandbox_simulator'||!safeReason(String(before.reason)))return{status:'conflict',reason:'Reconcile provider delivery before retrying this failure'};
 const accepted=await db.prepare("SELECT id FROM communication_message_delivery_events WHERE message_id=? AND event_type IN ('accepted','sent','delivered','read') LIMIT 1").bind(input.messageId).first<Row>();
 if(accepted)return{status:'conflict',reason:'A provider receipt exists; reconcile delivery before retrying'};
 const now=Date.now(),detail=JSON.stringify({requestKey:input.requestKey,failureCreatedAt:input.failureCreatedAt,reason:input.reason.trim(),before,after:{messageStatus:'queued',outboxStatus:'queued',attemptCount:0,idempotencyKey:before.idempotency_key},executionId:crypto.randomUUID()});
 const claimed="EXISTS (SELECT 1 FROM security_audit_events WHERE id=? AND detail_json=?)";
 await db.batch([
  db.prepare(`INSERT OR IGNORE INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at)
   SELECT ?,?,?,'communication.replay','communication',?,'completed',?,? FROM communication_dead_letters d JOIN communication_messages m ON m.id=d.message_id JOIN communication_outbox o ON o.message_id=m.id
   WHERE d.id=? AND d.created_at=? AND d.resolved_at IS NULL AND d.reason=? AND m.status='dead_letter' AND o.status='dead_letter' AND COALESCE(m.provider_reference,'')='' AND COALESCE(m.provider,'')<>'sandbox_simulator'
   AND NOT EXISTS (SELECT 1 FROM communication_message_delivery_events e WHERE e.message_id=m.id AND e.event_type IN ('accepted','sent','delivered','read'))`).bind(auditId,input.actorEmail,input.actorRole,input.messageId,detail,now,before.dead_letter_id,input.failureCreatedAt,before.reason),
  db.prepare(`UPDATE communication_outbox SET status='queued',attempt_count=0,next_attempt_at=?,last_error=NULL,locked_at=NULL,updated_at=? WHERE message_id=? AND ${claimed}`).bind(now,now,input.messageId,auditId,detail),
  db.prepare(`UPDATE communication_messages SET status='queued',updated_at=? WHERE id=? AND ${claimed}`).bind(now,input.messageId,auditId,detail),
  db.prepare(`UPDATE communication_dead_letters SET resolved_at=?,resolved_by=? WHERE id=? AND ${claimed}`).bind(now,input.actorEmail,before.dead_letter_id,auditId,detail),
 ]);
 const committed=await db.prepare('SELECT resource_id,detail_json FROM security_audit_events WHERE id=?').bind(auditId).first<Row>();
 if(!committed)return{status:'conflict',reason:'The failure changed before recovery; refresh and inspect it'};
 if(committed.resource_id!==input.messageId||JSON.parse(String(committed.detail_json)).failureCreatedAt!==input.failureCreatedAt||JSON.parse(String(committed.detail_json)).reason!==input.reason.trim())return{status:'conflict',reason:'Request key conflict'};
 return{status:'requeued',messageId:input.messageId,duplicatePrevented:committed.detail_json!==detail,externalDelivery:false};
}
