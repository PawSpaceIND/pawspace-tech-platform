import{ensureCommunicationTables,type CommunicationChannel}from"./communication-engine";
import{conversationAccessPredicate,ensureConversationAccessTables,type ConversationAccessActor}from"./conversation-access";

type Row=Record<string,unknown>;
export type ConversationScope="customer"|"provider"|"staff";

export async function ensureConversationGovernance(db:D1Database){await ensureCommunicationTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS conversation_audit_events (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message_id TEXT,action TEXT NOT NULL,actor_email TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS conversation_assignments (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,assigned_to TEXT NOT NULL,assigned_by TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',reason TEXT,created_at INTEGER NOT NULL,ended_at INTEGER)"),
 db.prepare("CREATE INDEX IF NOT EXISTS conversation_assignment_thread_idx ON conversation_assignments(thread_id,status,created_at)"),
]);}

// The ticket is a decoration on the thread, and on a deployment without the CX module its table does
// not exist, so a raw throw would take the whole queue down for a missing badge. Swallowing EVERY
// error instead would report "no ticket" for a real fault - the confident zero this codebase keeps
// having to remove - so only the absent table is tolerated and anything else still throws.
function missingTableOnly(table:string){
 return (error:unknown)=>{
  const message=error instanceof Error?error.message:String(error);
  if(new RegExp(`no such table: ${table}`,"i").test(message))return null;
  throw error;
 };
}
function conversationMessagePreview(row:Row|null){
 if(!row)return null;
 const{payload_json,...metadata}=row;
 let text="";
 try{const payload=JSON.parse(String(payload_json||"{}"));if(payload&&typeof payload.text==="string")text=Array.from(payload.text.trim()).slice(0,240).join("");}catch{}
 return{...metadata,text};
}

const communicationPendingStates=new Set(["queued","scheduled","retry_pending","dispatching","pending","retry"]);
const communicationFailedStates=new Set(["dead_letter","dlq"]);
async function bookingCommunicationState(db:D1Database,thread:Row){
 const bookingId=String(thread.booking_id||"").trim();if(!bookingId)return null;
 try{
  const row=await db.prepare(`SELECT b.id booking_id,b.status booking_status,p.status payment_status,m.id message_id,m.template_key,m.status message_status,o.status outbox_status,o.attempt_count,o.max_attempts,o.next_attempt_at,o.last_error,dl.id dead_letter_id,dl.reason dead_letter_reason
   FROM canonical_bookings b
   JOIN booking_payments p ON p.booking_id=b.id
   JOIN communication_messages m ON m.booking_id=b.id AND m.thread_id=? AND m.direction='outbound'
   LEFT JOIN communication_outbox o ON o.message_id=m.id
   LEFT JOIN communication_dead_letters dl ON dl.message_id=m.id AND dl.resolved_at IS NULL
   WHERE b.id=? AND b.status IN ('confirmed','assigned','in_progress','completed') AND p.status='captured'
     AND m.purpose IN ('transactional','service_recovery')
     AND (lower(COALESCE(m.template_key,'')) LIKE '%payment_captured%' OR lower(COALESCE(m.template_key,'')) LIKE '%receipt%' OR lower(COALESCE(m.template_key,'')) LIKE '%paid%' OR lower(COALESCE(m.template_key,'')) LIKE '%confirm%')
     AND (dl.id IS NOT NULL OR lower(COALESCE(o.status,'')) IN ('queued','scheduled','retry_pending','dispatching','pending','retry','dead_letter','dlq') OR lower(COALESCE(m.status,'')) IN ('queued','scheduled','retry_pending','pending','retry','dead_letter','dlq'))
   ORDER BY CASE WHEN dl.id IS NOT NULL OR lower(COALESCE(o.status,'')) IN ('dead_letter','dlq') OR lower(COALESCE(m.status,'')) IN ('dead_letter','dlq') THEN 2 ELSE 1 END DESC,COALESCE(o.updated_at,m.updated_at) DESC LIMIT 1`).bind(thread.id,bookingId).first<Row>();
  if(!row)return null;
  const outboxStatus=String(row.outbox_status||"").toLowerCase(),messageStatus=String(row.message_status||"").toLowerCase();
  const failed=Boolean(row.dead_letter_id)||communicationFailedStates.has(outboxStatus)||communicationFailedStates.has(messageStatus);
  if(!failed&&!communicationPendingStates.has(outboxStatus)&&!communicationPendingStates.has(messageStatus))return null;
  return{bookingId:String(row.booking_id),bookingStatus:String(row.booking_status),paymentStatus:String(row.payment_status),messageId:String(row.message_id),templateKey:String(row.template_key||""),state:failed?"failed":"pending",label:failed?"Communication Failed":"Confirmed - Communication Pending",outboxStatus:outboxStatus||messageStatus,attemptCount:Number(row.attempt_count||0),maxAttempts:Number(row.max_attempts||0),nextAttemptAt:row.next_attempt_at==null?null:Number(row.next_attempt_at),lastError:String(row.last_error||row.dead_letter_reason||"")};
 }catch(error){
  const message=error instanceof Error?error.message:String(error);
  if(/no such table: (canonical_bookings|booking_payments)/i.test(message))return null;
  throw error;
 }
}
export async function listConversationThreads(db:D1Database,input:{customerId?:string;status?:string;limit?:number;actor?:ConversationAccessActor}){await ensureConversationGovernance(db);const limit=Math.min(200,Math.max(1,input.limit||100));let query="SELECT t.*,c.name customer_name,c.primary_phone FROM communication_threads t LEFT JOIN canonical_customers c ON c.id=t.customer_id";const binds:unknown[]=[];const where:string[]=[];if(input.actor){await ensureConversationAccessTables(db);const access=conversationAccessPredicate(input.actor,"t");where.push(access.sql);binds.push(...access.binds);}if(input.customerId){where.push("t.customer_id=?");binds.push(input.customerId);}if(input.status){where.push("t.status=?");binds.push(input.status);}if(where.length)query+=` WHERE ${where.join(" AND ")}`;query+=" ORDER BY t.updated_at DESC LIMIT ?";binds.push(limit);let result:{results:Row[]};
 try{result=await db.prepare(query).bind(...binds).all<Row>();}
 catch(error){
  // The customer name is a convenience join onto another module's table. A deployment that has not
  // created canonical_customers yet used to fail the whole CX queue with a raw D1 error, so the
  // screen showed nothing at all rather than the threads it does have.
  if(!/no such table: canonical_customers/i.test(error instanceof Error?error.message:String(error)))throw error;
  result=await db.prepare(query.replace("SELECT t.*,c.name customer_name,c.primary_phone FROM communication_threads t LEFT JOIN canonical_customers c ON c.id=t.customer_id","SELECT t.* FROM communication_threads t")).bind(...binds).all<Row>();
 }const threads=[];for(const row of result.results){const [lastMessage,openTicket,communicationState]=await Promise.all([db.prepare("SELECT id,direction,channel,purpose,status,created_at,payload_json FROM communication_messages WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").bind(row.id).first<Row>(),row.ticket_id?db.prepare("SELECT id,priority,status,subject,sla_due_at FROM customer_experience_tickets WHERE id=?").bind(row.ticket_id).first<Row>().catch(missingTableOnly("customer_experience_tickets")):Promise.resolve(null),bookingCommunicationState(db,row)]);threads.push({...row,customer_name:String(row.customer_name||"Customer"),primary_phone:row.primary_phone?String(row.primary_phone):null,lastMessage:conversationMessagePreview(lastMessage),ticket:openTicket||null,communicationState});}return threads;}

export async function getConversation(db:D1Database,threadId:string,scope:ConversationScope){await ensureConversationGovernance(db);const thread=await db.prepare("SELECT * FROM communication_threads WHERE id=?").bind(threadId).first<Row>();if(!thread)return null;const [participants,messages,assignments]=await Promise.all([db.prepare("SELECT participant_type,participant_id,display_ref,role,created_at FROM communication_participants WHERE thread_id=? ORDER BY created_at").bind(threadId).all<Row>(),db.prepare("SELECT id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,created_by,created_at,updated_at FROM communication_messages WHERE thread_id=? ORDER BY created_at").bind(threadId).all<Row>(),db.prepare("SELECT id,assigned_to,assigned_by,status,reason,created_at,ended_at FROM conversation_assignments WHERE thread_id=? ORDER BY created_at DESC").bind(threadId).all<Row>()]);
 const visibleParticipants=participants.results.filter(item=>scope==="staff"||String(item.participant_type)!=="provider");
 const visibleMessages=messages.results.map(item=>{let payload:Record<string,unknown>={};try{payload=JSON.parse(String(item.payload_json||"{}")) as Record<string,unknown>}catch{}if(scope!=="staff"){delete payload.internalNote;delete payload.providerPhone;delete payload.customerPhone;}const rest={...item};delete rest.payload_json;return{...rest,payload};});
 return{thread,participants:visibleParticipants,messages:visibleMessages,assignments:scope==="staff"?assignments.results:[]};
}

export async function recordInboundMessage(db:D1Database,input:{threadId:string;customerId:string;channel:CommunicationChannel;payload:Record<string,unknown>;provider:string;providerReference:string;eventId:string;createdBy:string}){await ensureConversationGovernance(db);const existing=await db.prepare("SELECT id FROM communication_messages WHERE provider_reference=? AND provider=? LIMIT 1").bind(input.providerReference,input.provider).first<Row>();if(existing)return{id:String(existing.id),duplicatePrevented:true};const thread=await db.prepare("SELECT customer_id,status FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();if(!thread||String(thread.customer_id)!==input.customerId)throw new Error("Conversation thread/customer mismatch");if(String(thread.status)==="closed")throw new Error("Closed conversation cannot accept a new inbound message until reopened");const now=Date.now(),id=`MSG-${crypto.randomUUID().slice(0,14).toUpperCase()}`;await db.batch([
 db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,'inbound',?,'transactional','inbound_message',?,'delivered',?,?,?,'{}',?,?,?)").bind(id,input.threadId,input.customerId,input.channel,JSON.stringify(input.payload),input.provider,input.providerReference,`inbound:${input.provider}:${input.eventId}`,input.createdBy,now,now),
 db.prepare("UPDATE communication_threads SET updated_at=? WHERE id=?").bind(now,input.threadId),
 db.prepare("INSERT INTO communication_message_delivery_events (id,message_id,provider,event_id,event_type,detail_json,created_at) VALUES (?,?,?,?, 'delivered','{}',?)").bind(crypto.randomUUID(),id,input.provider,input.eventId,now),
 db.prepare("INSERT INTO conversation_audit_events (id,thread_id,message_id,action,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,'{}',?)").bind(crypto.randomUUID(),input.threadId,id,"inbound_recorded",input.createdBy,now),
 ]);return{id,duplicatePrevented:false};}

export async function assignConversation(db:D1Database,input:{threadId:string;assignedTo:string;assignedBy:string;reason?:string;slaMinutes?:number}){await ensureConversationGovernance(db);const thread=await db.prepare("SELECT id,status FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();if(!thread)throw new Error("Conversation thread not found");const now=Date.now(),id=`ASG-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.batch([
 db.prepare("UPDATE conversation_assignments SET status='ended',ended_at=? WHERE thread_id=? AND status='active'").bind(now,input.threadId),
 db.prepare("INSERT INTO conversation_assignments (id,thread_id,assigned_to,assigned_by,status,reason,created_at) VALUES (?,?,?,?, 'active',?,?)").bind(id,input.threadId,input.assignedTo,input.assignedBy,input.reason||null,now),
 db.prepare("UPDATE communication_threads SET assigned_to=?,sla_due_at=?,updated_at=? WHERE id=?").bind(input.assignedTo,input.slaMinutes&&input.slaMinutes>0?now+input.slaMinutes*60_000:null,now,input.threadId),
 db.prepare("INSERT INTO conversation_audit_events (id,thread_id,action,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),input.threadId,"assigned",input.assignedBy,JSON.stringify({assignedTo:input.assignedTo,reason:input.reason||null,slaMinutes:input.slaMinutes||null}),now),
 ]);return{id,assignedTo:input.assignedTo};}

export async function setConversationStatus(db:D1Database,input:{threadId:string;status:"open"|"pending_customer"|"resolved"|"closed";actorEmail:string;reason?:string}){await ensureConversationGovernance(db);const now=Date.now();await db.batch([db.prepare("UPDATE communication_threads SET status=?,updated_at=? WHERE id=?").bind(input.status,now,input.threadId),db.prepare("INSERT INTO conversation_audit_events (id,thread_id,action,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),input.threadId,`status_${input.status}`,input.actorEmail,JSON.stringify({reason:input.reason||null}),now)]);return{threadId:input.threadId,status:input.status};}