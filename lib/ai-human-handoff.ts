import{ensureConversationGovernance}from"./conversation-governance";
import{actorCanAccessConversation,conversationAccessPredicate,ensureConversationAccessTables}from"./conversation-access";
import{requireCustomerOwnership,type AuthenticatedActor}from"./server-auth";

type Row=Record<string,unknown>;
export type AiHandoffReason="customer_requested_human"|"low_confidence"|"provider_unavailable"|"provider_error"|"provider_unsupported"|"policy_risk"|"complaint"|"safety"|"refund_payment_dispute"|"urgent_funeral_memorial"|"sensitive_relocation"|"unsupported_request"|"rollout_gated"|"high_value_enterprise_objection";
export type AiHandoffAction="take_over"|"resume_ai";

const text=(value:unknown)=>String(value??"").trim();
function isStaff(actor:AuthenticatedActor){return actor.permissions.includes("*")||actor.permissions.includes("communications.manage")||actor.permissions.includes("customers.manage");}
function queueFor(reason:AiHandoffReason){if(reason==="high_value_enterprise_objection")return{queue:"sales-hot",slaMinutes:5};if(reason==="refund_payment_dispute")return{queue:"finance-cx",slaMinutes:10};if(reason==="safety")return{queue:"cx-safety",slaMinutes:5};if(reason==="urgent_funeral_memorial")return{queue:"cx-sensitive-care",slaMinutes:5};if(reason==="sensitive_relocation")return{queue:"cx-relocation",slaMinutes:15};if(reason==="complaint")return{queue:"cx-service-recovery",slaMinutes:10};return{queue:"cx-ai-handoff",slaMinutes:15};}

export async function ensureAiHumanHandoff(db:D1Database){await ensureConversationGovernance(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS ai_handoffs (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,session_id TEXT,reason TEXT NOT NULL,confidence REAL,queue_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',summary_json TEXT NOT NULL,requested_by TEXT NOT NULL,taken_over_by TEXT,resumed_by TEXT,created_at INTEGER NOT NULL,taken_over_at INTEGER,resumed_at INTEGER)"),
 db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS ai_handoff_active_thread_idx ON ai_handoffs(thread_id) WHERE status IN ('queued','staff_active')"),
 db.prepare("CREATE INDEX IF NOT EXISTS ai_handoff_queue_idx ON ai_handoffs(status,queue_code,created_at)"),
 db.prepare("CREATE TABLE IF NOT EXISTS ai_handoff_events (id TEXT PRIMARY KEY,handoff_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_email TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS ai_lead_ownership (lead_id TEXT PRIMARY KEY,contact_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ai_owned',clarification_count INTEGER NOT NULL DEFAULT 0,max_clarifications INTEGER NOT NULL DEFAULT 2,escalation_reason TEXT,human_owner TEXT,enterprise_objection INTEGER NOT NULL DEFAULT 0,customer_requested_human INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS crm_tasks (id TEXT PRIMARY KEY,contact_id TEXT,title TEXT NOT NULL,owner TEXT NOT NULL,due_at INTEGER,priority TEXT DEFAULT 'Normal',status TEXT DEFAULT 'Open',created_at INTEGER NOT NULL)"),
]);}

async function sessionUpdate(db:D1Database,threadId:string,status:string,now:number,eventId:string){
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_conversation_sessions'").first<Row>();
 return exists?[db.prepare("UPDATE ai_conversation_sessions SET status=?,updated_at=? WHERE thread_id=? AND EXISTS (SELECT 1 FROM ai_handoff_events WHERE id=?)").bind(status,now,threadId,eventId)]:[];
}
function assignmentStatements(db:D1Database,input:{threadId:string;assignedTo:string;actorEmail:string;reason:string;slaMinutes?:number},now:number,eventId:string){
 const guard="EXISTS (SELECT 1 FROM ai_handoff_events WHERE id=?)";
 return[
  db.prepare(`UPDATE conversation_assignments SET status='ended',ended_at=? WHERE thread_id=? AND status='active' AND ${guard}`).bind(now,input.threadId,eventId),
  db.prepare(`INSERT INTO conversation_assignments (id,thread_id,assigned_to,assigned_by,status,reason,created_at) SELECT ?,?,?,?,'active',?,? WHERE ${guard}`).bind(`ASG-${crypto.randomUUID()}`,input.threadId,input.assignedTo,input.actorEmail,input.reason,now,eventId),
  db.prepare(`UPDATE communication_threads SET assigned_to=?,sla_due_at=?,updated_at=? WHERE id=? AND ${guard}`).bind(input.assignedTo,input.slaMinutes?now+input.slaMinutes*60000:null,now,input.threadId,eventId),
  db.prepare(`INSERT INTO conversation_audit_events (id,thread_id,action,actor_email,detail_json,created_at) SELECT ?,?,'assigned',?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),input.threadId,input.actorEmail,JSON.stringify({assignedTo:input.assignedTo,reason:input.reason,slaMinutes:input.slaMinutes??null}),now,eventId),
 ];
}
async function authorizeThread(db:D1Database,actor:AuthenticatedActor,threadId:string,customerId:string){const thread=await db.prepare("SELECT id,customer_id,status,booking_id,ticket_id,assigned_to,sla_due_at FROM communication_threads WHERE id=?").bind(threadId).first<Row>();if(!thread||text(thread.customer_id)!==customerId)throw new Response("Conversation thread/customer mismatch",{status:403});if(isStaff(actor)){if(!(await actorCanAccessConversation(db,actor,threadId)))throw new Response("Conversation access denied",{status:403});}else await requireCustomerOwnership(db,actor,customerId);return thread;}
async function summary(db:D1Database,threadId:string,customerId:string,reason:AiHandoffReason,confidence?:number|null){const messages=await db.prepare("SELECT direction,channel,payload_json,created_at FROM communication_messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 12").bind(threadId).all<Row>();const transcript=messages.results.reverse().map(row=>{let payload:Record<string,unknown>={};try{payload=JSON.parse(text(row.payload_json)||"{}")as Record<string,unknown>}catch{}return{direction:text(row.direction),channel:text(row.channel),text:text(payload.text||payload.message||payload.body||payload.content).slice(0,500),createdAt:Number(row.created_at||0)};});const latestTurn=await db.prepare("SELECT intent_code,intent_confidence,handoff_reason,context_id,policy_decision,outcome FROM ai_conversation_turns WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").bind(threadId).first<Row>().catch(()=>null);return{threadId,customerId,reason,confidence:confidence??(latestTurn?Number(latestTurn.intent_confidence||0):null),latestIntent:latestTurn?text(latestTurn.intent_code):null,policyDecision:latestTurn?text(latestTurn.policy_decision):null,contextId:latestTurn?text(latestTurn.context_id):null,transcript};}

async function markAttachedLeadHumanOwned(db:D1Database,input:{threadId:string;reason:AiHandoffReason;queue:string;now:number}){
 await ensureConversationAccessTables(db);
 const thread=await db.prepare("SELECT lead_id FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();const leadId=text(thread?.lead_id);if(!leadId)return;const lead=await db.prepare("SELECT customer_id FROM lead_work_items WHERE id=?").bind(leadId).first<Row>().catch(()=>null);if(!lead)return;const contactId=text(lead.customer_id);
 await db.batch([
  db.prepare("UPDATE ai_lead_ownership SET status='human_escalated',escalation_reason=?,human_owner=?,customer_requested_human=CASE WHEN ?='customer_requested_human' THEN 1 ELSE customer_requested_human END,updated_at=? WHERE lead_id=?").bind(input.reason,input.queue,input.reason,input.now,leadId),
  db.prepare("UPDATE lead_work_items SET owner=?,manager='Human Sales Manager',next_action_at=?,updated_at=? WHERE id=?").bind(input.queue,input.now,input.now,leadId),
  db.prepare("UPDATE crm_contacts SET owner=?,next_action=?,updated_at=? WHERE id=?").bind(input.queue,`AI escalation: ${input.reason}`,input.now,contactId),
  db.prepare("INSERT OR IGNORE INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,'High','Open',?)").bind(`AI-ESC-${leadId}`,contactId,`AI escalation: ${input.reason}`,input.queue,input.now,input.now),
 ]);
}

export async function requestAiHumanHandoff(db:D1Database,input:{actorEmail:string;threadId:string;customerId:string;sessionId?:string|null;reason:AiHandoffReason;confidence?:number|null}){
 await ensureAiHumanHandoff(db);
 const thread=await db.prepare("SELECT customer_id FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
 if(!thread||text(thread.customer_id)!==input.customerId)throw new Response("Conversation thread/customer mismatch",{status:403});
 const existing=await db.prepare("SELECT * FROM ai_handoffs WHERE thread_id=? AND status IN ('queued','staff_active') ORDER BY created_at DESC LIMIT 1").bind(input.threadId).first<Row>();
 if(existing)return{handoff:existing,duplicatePrevented:true,aiPaused:true};
 const routing=queueFor(input.reason),snapshot=await summary(db,input.threadId,input.customerId,input.reason,input.confidence),now=Date.now(),id=`AIHO-${crypto.randomUUID()}`,eventId=`AIHEVT-${crypto.randomUUID()}`;
 const statements=[
  db.prepare("INSERT INTO ai_handoffs (id,thread_id,customer_id,session_id,reason,confidence,queue_code,status,summary_json,requested_by,created_at) VALUES (?,?,?,?,?,?,?,'queued',?,?,?)").bind(id,input.threadId,input.customerId,input.sessionId||null,input.reason,input.confidence??null,routing.queue,JSON.stringify(snapshot),input.actorEmail,now),
  db.prepare("INSERT INTO ai_handoff_events (id,handoff_id,event_type,actor_email,detail_json,created_at) VALUES (?,?,'handoff_requested',?,?,?)").bind(eventId,id,input.actorEmail,JSON.stringify({reason:input.reason,queue:routing.queue,slaMinutes:routing.slaMinutes,confidence:input.confidence??null}),now),
  ...assignmentStatements(db,{threadId:input.threadId,assignedTo:routing.queue,actorEmail:input.actorEmail,reason:`ai:${input.reason}`,slaMinutes:routing.slaMinutes},now,eventId),
  ...await sessionUpdate(db,input.threadId,"human_handoff",now,eventId),
 ];
 try{await db.batch(statements);}catch(error){
  if(/unique constraint/i.test(error instanceof Error?error.message:String(error))){const raced=await db.prepare("SELECT * FROM ai_handoffs WHERE thread_id=? AND customer_id=? AND status IN ('queued','staff_active')").bind(input.threadId,input.customerId).first<Row>();if(raced)return{handoff:raced,duplicatePrevented:true,aiPaused:true};}
  throw error;
 }
 await markAttachedLeadHumanOwned(db,{threadId:input.threadId,reason:input.reason,queue:routing.queue,now});
 return{handoff:await db.prepare("SELECT * FROM ai_handoffs WHERE id=?").bind(id).first<Row>(),duplicatePrevented:false,aiPaused:true};
}

export async function manageAiHumanHandoff(db:D1Database,input:{actor:AuthenticatedActor;threadId:string;customerId:string;action:AiHandoffAction;reason?:string}){
 await ensureAiHumanHandoff(db);if(!isStaff(input.actor))throw new Response("Staff conversation permission required",{status:403});
 await authorizeThread(db,input.actor,input.threadId,input.customerId);
 if(!["take_over","resume_ai"].includes(input.action))throw new Response("Unsupported handoff action",{status:400});
 const handoff=await db.prepare("SELECT * FROM ai_handoffs WHERE thread_id=? AND status IN ('queued','staff_active') ORDER BY created_at DESC LIMIT 1").bind(input.threadId).first<Row>();
 if(!handoff)throw new Response("Active AI handoff not found",{status:409});
 const taking=input.action==="take_over",expected=taking?"queued":"staff_active";
 if(text(handoff.status)!==expected)throw new Response(taking?"Handoff has already been taken over":"AI can resume only after explicit staff takeover",{status:409});
 if(!taking&&!text(input.reason))throw new Response("Resume reason is required",{status:400});
 const now=Date.now(),id=text(handoff.id),eventId=`AIHEVT-${crypto.randomUUID()}`,target=taking?"staff_active":"resumed",assignedTo=taking?input.actor.email:"ai-orchestrator",reason=taking?input.reason||"staff_takeover":`governed_ai_resume:${input.reason}`;
 // The conditional event is the transaction's claim. Every related write depends on this exact event.
 const results=await db.batch([
  db.prepare("INSERT INTO ai_handoff_events (id,handoff_id,event_type,actor_email,detail_json,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM ai_handoffs WHERE id=? AND status=?)").bind(eventId,id,taking?"staff_takeover":"ai_resumed",input.actor.email,JSON.stringify({reason:input.reason||null}),now,id,expected),
  db.prepare(`UPDATE ai_handoffs SET status=?,${taking?"taken_over_by=?,taken_over_at=?":"resumed_by=?,resumed_at=?"} WHERE id=? AND status=? AND EXISTS (SELECT 1 FROM ai_handoff_events WHERE id=?)`).bind(target,input.actor.email,now,id,expected,eventId),
  ...assignmentStatements(db,{threadId:input.threadId,assignedTo,actorEmail:input.actor.email,reason,...(taking?{slaMinutes:15}:{})},now,eventId),
  ...await sessionUpdate(db,input.threadId,taking?"staff_active":"ai_active",now,eventId),
 ]);
 if(Number(results[0]?.meta?.changes||0)!==1)throw new Response("Handoff changed concurrently; refresh and retry",{status:409});
 return{handoff:await db.prepare("SELECT * FROM ai_handoffs WHERE id=?").bind(id).first<Row>(),aiPaused:taking};
}

export async function aiHumanHandoffSnapshot(db:D1Database,input:{actor:AuthenticatedActor;threadId:string;customerId:string}){await ensureAiHumanHandoff(db);await authorizeThread(db,input.actor,input.threadId,input.customerId);const current=await db.prepare("SELECT * FROM ai_handoffs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").bind(input.threadId).first<Row>(),events=current?await db.prepare("SELECT * FROM ai_handoff_events WHERE handoff_id=? ORDER BY created_at").bind(current.id).all<Row>():{results:[]};let parsedSummary:Record<string,unknown>|null=null;if(current)try{parsedSummary=JSON.parse(text(current.summary_json)||"{}")as Record<string,unknown>}catch{}return{current:current?{...current,summary:parsedSummary}:null,events:events.results,aiPaused:Boolean(current&&["queued","staff_active"].includes(text(current.status))),sameCanonicalThread:true};}

/**
 * The live escalation queue: every conversation the AI has handed to a human and no one has closed.
 *
 * /team/ai/handoff had no way to ask this question, so it opened on whichever conversation happened
 * to sort first and reported "no handoff is active or recorded for this thread" — on a platform that
 * had escalations waiting. Cold-DB safe: an environment that has never run a turn returns an empty
 * queue rather than an error.
 */
export async function listAiHandoffQueue(db:D1Database,input:{limit?:number;actor?:AuthenticatedActor}={}){await ensureAiHumanHandoff(db);const limit=Math.min(100,Math.max(1,input.limit||50)),access=input.actor?(await ensureConversationAccessTables(db),conversationAccessPredicate(input.actor,"t")):{sql:"1=1",binds:[]as unknown[]};const [visibleRows,totalRows]=await Promise.all([db.prepare(`SELECT h.id,h.thread_id,h.customer_id,h.reason,h.queue_code,h.status,h.confidence,h.created_at,h.taken_over_by,h.taken_over_at,t.booking_id,t.sla_due_at FROM ai_handoffs h JOIN communication_threads t ON t.id=h.thread_id WHERE h.status IN ('queued','staff_active') AND ${access.sql} ORDER BY h.created_at LIMIT ?`).bind(...access.binds,limit).all<Row>(),db.prepare(`SELECT h.status,COUNT(*) count FROM ai_handoffs h JOIN communication_threads t ON t.id=h.thread_id WHERE h.status IN ('queued','staff_active') AND ${access.sql} GROUP BY h.status`).bind(...access.binds).all<Row>()]);const totals=new Map<string,number>();for(const row of totalRows.results||[])totals.set(text(row.status),Number(row.count||0));return{queue:(visibleRows.results||[]).map(row=>({id:text(row.id),threadId:text(row.thread_id),customerId:text(row.customer_id),reason:text(row.reason),queueCode:text(row.queue_code),status:text(row.status),confidence:row.confidence==null?null:Number(row.confidence),bookingId:row.booking_id?text(row.booking_id):null,createdAt:Number(row.created_at||0),takenOverBy:row.taken_over_by?text(row.taken_over_by):null,takenOverAt:row.taken_over_at?Number(row.taken_over_at):null})),byStatus:Object.fromEntries(totals),waiting:totals.get("queued")||0,withStaff:totals.get("staff_active")||0};}

export async function assertAiMayReply(db:D1Database,threadId:string){await ensureAiHumanHandoff(db);const active=await db.prepare("SELECT id,status FROM ai_handoffs WHERE thread_id=? AND status IN ('queued','staff_active') ORDER BY created_at DESC LIMIT 1").bind(threadId).first<Row>();if(active)throw new Response("AI replies are paused while the conversation is owned by staff",{status:409});}
