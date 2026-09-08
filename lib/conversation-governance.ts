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
async function linkedConversationTicket(db:D1Database,thread:Row){
 if(!thread.ticket_id)return null;
 const args=[thread.ticket_id,thread.customer_id,thread.booking_id??null,thread.booking_id??null];
 const unified=await db.prepare("SELECT id,severity AS priority,status,title AS subject,first_response_due_at AS sla_due_at,resolution_due_at,'unified_case' AS source_kind FROM unified_cases WHERE id=? AND customer_id=? AND (? IS NULL OR booking_id IS NULL OR booking_id=?)").bind(...args).first<Row>().catch(missingTableOnly("unified_cases"));
 if(unified)return unified;
 return db.prepare("SELECT id,priority,status,subject,sla_due_at,'legacy_ticket' AS source_kind FROM customer_experience_tickets WHERE id=? AND customer_id=? AND (? IS NULL OR booking_id IS NULL OR booking_id=?)").bind(...args).first<Row>().catch(missingTableOnly("customer_experience_tickets"));
}
async function conversationStaffContext(db:D1Database,thread:Row){
 const [customer,booking,ticket]=await Promise.all([
  db.prepare("SELECT name,primary_phone FROM canonical_customers WHERE id=?").bind(thread.customer_id).first<Row>().catch(missingTableOnly("canonical_customers")),
  thread.booking_id?db.prepare("SELECT id,service_code,package_name,status,scheduled_start,scheduled_end FROM canonical_bookings WHERE id=? AND customer_id=?").bind(thread.booking_id,thread.customer_id).first<Row>().catch(missingTableOnly("canonical_bookings")):Promise.resolve(null),
  linkedConversationTicket(db,thread),
 ]);
 return {...thread,customer_name:customer?.name??null,primary_phone:customer?.primary_phone??null,booking:booking??null,ticket:ticket??null};
}
export async function listConversationThreads(db:D1Database,input:{customerId?:string;status?:string;limit?:number;actor?:ConversationAccessActor;query?:string;channel?:string;ownership?:string;before?:{at:number;id:string}}){
 const limit=input.limit??100;
 if(!Number.isInteger(limit)||limit<1||limit>201)throw new Response("Invalid conversation limit",{status:400});
 if(input.status&&!["open","pending_customer","resolved","closed"].includes(input.status))throw new Response("Invalid conversation status filter",{status:400});
 if(input.channel&&!["whatsapp","sms","email","push","chat","voice"].includes(input.channel))throw new Response("Invalid conversation channel",{status:400});
 if(input.ownership&&!["unassigned","human"].includes(input.ownership))throw new Response("Invalid ownership filter",{status:400});
 if(input.query&&input.query.length>200)throw new Response("Conversation search is too long",{status:400});
 if(input.before&&(!Number.isSafeInteger(input.before.at)||input.before.at<0||typeof input.before.id!=="string"||!input.before.id||input.before.id.length>100))throw new Response("Invalid conversation cursor",{status:400});
 await ensureConversationGovernance(db);
 let query="SELECT t.*,c.name customer_name,c.primary_phone FROM communication_threads t LEFT JOIN canonical_customers c ON c.id=t.customer_id";
 const binds:unknown[]=[],where:string[]=[];
 if(input.actor){await ensureConversationAccessTables(db);const access=conversationAccessPredicate(input.actor,"t");where.push(access.sql);binds.push(...access.binds);}
 if(input.customerId){where.push("t.customer_id=?");binds.push(input.customerId);}
 if(input.status){where.push("t.status=?");binds.push(input.status);}
 if(input.channel){where.push("EXISTS (SELECT 1 FROM communication_messages channel_message WHERE channel_message.thread_id=t.id AND channel_message.channel=?)");binds.push(input.channel);}
 if(input.ownership==="unassigned")where.push("COALESCE(trim(t.assigned_to),'')=''");
 if(input.ownership==="human")where.push("COALESCE(trim(t.assigned_to),'') NOT IN ('','ai-orchestrator')");
 if(input.query?.trim()){
  where.push("instr(lower(t.id||' '||t.customer_id||' '||COALESCE(t.booking_id,'')||' '||COALESCE(t.lead_id,'')||' '||COALESCE(c.name,'')||' '||COALESCE(c.primary_phone,'')),lower(?))>0");
  binds.push(input.query.trim());
 }
 if(input.before){where.push("(t.updated_at<? OR (t.updated_at=? AND t.id<?))");binds.push(input.before.at,input.before.at,input.before.id);}
 if(where.length)query+=` WHERE ${where.join(" AND ")}`;
 query+=" ORDER BY t.updated_at DESC,t.id DESC LIMIT ?";binds.push(limit);
 let result:{results:Row[]};
 try{result=await db.prepare(query).bind(...binds).all<Row>();}
 catch(error){
  if(!/no such table: canonical_customers/i.test(error instanceof Error?error.message:String(error)))throw error;
  const fallback=query.replace("SELECT t.*,c.name customer_name,c.primary_phone FROM communication_threads t LEFT JOIN canonical_customers c ON c.id=t.customer_id","SELECT t.* FROM communication_threads t").replaceAll("COALESCE(c.name,'')","''").replaceAll("COALESCE(c.primary_phone,'')","''");
  result=await db.prepare(fallback).bind(...binds).all<Row>();
 }
 const threads:Row[]=[];
 for(const row of result.results){const [lastMessage,openTicket]=await Promise.all([db.prepare("SELECT id,direction,channel,purpose,status,created_at FROM communication_messages WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 1").bind(row.id).first<Row>(),linkedConversationTicket(db,row)]);threads.push({...row,customer_name:String(row.customer_name||"Customer"),primary_phone:row.primary_phone?String(row.primary_phone):null,lastMessage:lastMessage||null,ticket:openTicket||null});}
 return threads;
}

export async function getConversation(db:D1Database,threadId:string,scope:ConversationScope){await ensureConversationGovernance(db);const thread=await db.prepare("SELECT * FROM communication_threads WHERE id=?").bind(threadId).first<Row>();if(!thread)return null;const [participants,messages,assignments]=await Promise.all([db.prepare("SELECT participant_type,participant_id,display_ref,role,created_at FROM communication_participants WHERE thread_id=? ORDER BY created_at").bind(threadId).all<Row>(),db.prepare("SELECT id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,created_by,created_at,updated_at FROM communication_messages WHERE thread_id=? ORDER BY created_at").bind(threadId).all<Row>(),db.prepare("SELECT id,assigned_to,assigned_by,status,reason,created_at,ended_at FROM conversation_assignments WHERE thread_id=? ORDER BY created_at DESC").bind(threadId).all<Row>()]);
 const visibleParticipants=participants.results.filter(item=>scope==="staff"||String(item.participant_type)!=="provider");
 const visibleMessages=messages.results.map(item=>{let payload:Record<string,unknown>={};try{payload=JSON.parse(String(item.payload_json||"{}")) as Record<string,unknown>}catch{}if(scope!=="staff"){delete payload.internalNote;delete payload.providerPhone;delete payload.customerPhone;}const rest={...item};delete rest.payload_json;return{...rest,payload};});
 return{thread:scope==="staff"?await conversationStaffContext(db,thread):thread,participants:visibleParticipants,messages:visibleMessages,assignments:scope==="staff"?assignments.results:[],notes:scope==="staff"?await conversationInternalNotes(db,threadId):[]};
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

export async function setConversationStatus(db:D1Database,input:{threadId:string;status:"open"|"pending_customer"|"resolved"|"closed";actorEmail:string;reason?:string}){
 if(!["open","pending_customer","resolved","closed"].includes(input.status))throw new Response("Unsupported conversation status",{status:400});
 await ensureConversationGovernance(db);const now=Date.now();
 const results=await db.batch([
  db.prepare("UPDATE communication_threads SET status=?,updated_at=? WHERE id=?").bind(input.status,now,input.threadId),
  db.prepare("INSERT INTO conversation_audit_events (id,thread_id,action,actor_email,detail_json,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM communication_threads WHERE id=?)").bind(crypto.randomUUID(),input.threadId,`status_${input.status}`,input.actorEmail,JSON.stringify({reason:input.reason||null}),now,input.threadId),
 ]);
 if(Number(results[0]?.meta?.changes||0)!==1)throw new Response("Conversation thread not found",{status:404});
 return{threadId:input.threadId,status:input.status};
}

export async function recordConversationInternalNote(db:D1Database,input:{threadId:string;actorEmail:string;body:string;idempotencyKey:string}){
 if(typeof input.body!=="string"||!input.body.trim()||input.body.trim().length>4096||typeof input.idempotencyKey!=="string"||!input.idempotencyKey||input.idempotencyKey.length>120)throw new Response("A note of 1–4096 characters and a request key are required",{status:400});
 await ensureConversationGovernance(db);
 const body=input.body.trim(),digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([input.threadId,input.idempotencyKey]))),id=`CNOTE-${Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("")}`,now=Date.now();
 const [result]=await db.batch([
  db.prepare("INSERT OR IGNORE INTO conversation_audit_events (id,thread_id,action,actor_email,detail_json,created_at) SELECT ?,?,'internal_note',?,?,? WHERE EXISTS (SELECT 1 FROM communication_threads WHERE id=?)").bind(id,input.threadId,input.actorEmail,JSON.stringify({body}),now,input.threadId),
  db.prepare("UPDATE communication_threads SET updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM conversation_audit_events WHERE id=? AND created_at=?)").bind(now,input.threadId,id,now),
 ]);
 const stored=await db.prepare("SELECT e.thread_id,e.actor_email,e.detail_json FROM conversation_audit_events e JOIN communication_threads t ON t.id=e.thread_id WHERE e.id=?").bind(id).first<Row>();
 if(!stored)throw new Response("Conversation thread not found",{status:404});
 if(stored.thread_id!==input.threadId||stored.actor_email!==input.actorEmail||JSON.parse(String(stored.detail_json)).body!==body)throw new Response("Note request key was already used for different content",{status:409});
 return{id,duplicatePrevented:Number(result.meta?.changes||0)===0};
}

async function conversationInternalNotes(db:D1Database,threadId:string){
 const result=await db.prepare("SELECT id,actor_email,detail_json,created_at FROM conversation_audit_events WHERE thread_id=? AND action='internal_note' ORDER BY created_at DESC,id DESC LIMIT 100").bind(threadId).all<Row>();
 return result.results.map(row=>{const detail=JSON.parse(String(row.detail_json||"{}"));return{id:row.id,actorEmail:row.actor_email,body:typeof detail.body==="string"?detail.body:"",createdAt:row.created_at};});
}
