/**
 * PawSpace Operations Work Queue / Exception Engine.
 *
 * Instead of managers discovering problems across WhatsApp, spreadsheets and dashboards, the sweep
 * turns REAL exception conditions in canonical tables into owned, SLA-tracked tasks routed to the
 * right queue. Every task carries owner, priority, SLA/due time, status, notes, the
 * booking/customer/provider link, and an escalation flag once its SLA is breached. Detection is
 * idempotent (one task per real-world entity instance, UNIQUE source_key), so re-running the sweep
 * or the cron never duplicates work. Detectors only read tables that exist (sqlite_master-guarded),
 * so a cold database sweeps to zero instead of crashing.
 *
 * Detectors (rule -> queue), each reading the owning surface's real columns:
 *   provider_unassigned          provider_work_orders awaiting_acceptance past grace  -> operations
 *   refund_requested             booking_refund_cases status='requested'              -> finance
 *   payment_exception            payment_reconciliation_exceptions status='open'      -> finance
 *   low_rating_callback          service_reviews stars<=2                             -> qc
 *   relocation_enquiry           relocation_enquiries status='new'                    -> sales_relocation
 *   food_renewal_payment_overdue food_subscription_renewals payment_pending past due  -> retention
 *   lead_response_overdue        lead_work_items active, first action overdue, none   -> crm_escalation
 */

type Db=D1Database;
type Row=Record<string,unknown>;

export type WorkQueueName="operations"|"finance"|"qc"|"sales_relocation"|"retention"|"crm_escalation";
export type WorkQueueTaskStatus="open"|"acknowledged"|"in_progress"|"resolved"|"dismissed";
export type WorkQueueAction="claim"|"acknowledge"|"start"|"resolve"|"dismiss"|"add_note";

const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const OPEN_STATUSES=["open","acknowledged","in_progress"];
export const UNASSIGNED_GRACE_MS=30*60_000;      // work order awaiting acceptance for 30min -> task
export const RENEWAL_OVERDUE_MS=24*3_600_000;    // food renewal unpaid 24h past due -> retention task

export async function ensureWorkQueueTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS ops_work_queue_tasks (id TEXT PRIMARY KEY,rule TEXT NOT NULL,queue TEXT NOT NULL,priority TEXT NOT NULL,title TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',booking_id TEXT,customer_id TEXT,provider_id TEXT,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,source_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'open',owner TEXT,sla_minutes INTEGER NOT NULL,due_at INTEGER NOT NULL,escalated INTEGER NOT NULL DEFAULT 0,escalated_at INTEGER,resolution_note TEXT,resolved_by TEXT,resolved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_ops_work_queue_open ON ops_work_queue_tasks(status,queue,due_at)"),
 db.prepare("CREATE TABLE IF NOT EXISTS ops_work_queue_events (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,note TEXT,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_ops_work_queue_events_task ON ops_work_queue_events(task_id,created_at)"),
]);}

async function tableExists(db:Db,name:string){const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();return Boolean(row);}
async function addTaskEvent(db:Db,taskId:string,eventType:string,actorId:string,note:string|null=null){await db.prepare("INSERT INTO ops_work_queue_events (id,task_id,event_type,actor_id,note,created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),taskId,eventType,actorId,note,Date.now()).run();}

type Candidate={rule:string;queue:WorkQueueName;priority:"critical"|"high"|"medium";title:string;bookingId?:string|null;customerId?:string|null;providerId?:string|null;entityType:string;entityId:string;slaMinutes:number;detail?:Record<string,unknown>};

async function openTask(db:Db,candidate:Candidate,now:number){
 const sourceKey=`${candidate.rule}:${candidate.entityId}`;
 const inserted=await db.prepare("INSERT OR IGNORE INTO ops_work_queue_tasks (id,rule,queue,priority,title,detail_json,booking_id,customer_id,provider_id,entity_type,entity_id,source_key,status,owner,sla_minutes,due_at,escalated,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',NULL,?,?,0,?,?)")
  .bind(uid("WQT"),candidate.rule,candidate.queue,candidate.priority,candidate.title,JSON.stringify(candidate.detail??{}),candidate.bookingId??null,candidate.customerId??null,candidate.providerId??null,candidate.entityType,candidate.entityId,sourceKey,candidate.slaMinutes,now+candidate.slaMinutes*60_000,now,now).run();
 return Number(inserted.meta?.changes||0)>0;
}

/** Detect exception conditions from the canonical tables and open one task per instance. */
export async function sweepWorkQueue(db:Db,input:{actorId:string;now?:number}={actorId:"system:work-queue"}){
 await ensureWorkQueueTables(db);
 const now=input.now??Date.now(),created:Record<string,number>={};
 const record=async(candidate:Candidate)=>{if(await openTask(db,candidate,now))created[candidate.rule]=(created[candidate.rule]||0)+1;};

 if(await tableExists(db,"provider_work_orders")){
  const rows=await db.prepare("SELECT id,booking_id,provider_id,provider_name,service_code,scheduled_start,created_at FROM provider_work_orders WHERE status='awaiting_acceptance' AND created_at<? ORDER BY created_at LIMIT 200").bind(now-UNASSIGNED_GRACE_MS).all<Row>();
  for(const row of rows.results)await record({rule:"provider_unassigned",queue:"operations",priority:"high",title:`Work order ${String(row.id)} still awaiting provider acceptance (${String(row.service_code)})`,bookingId:String(row.booking_id),providerId:String(row.provider_id),entityType:"work_order",entityId:String(row.id),slaMinutes:60,detail:{providerName:row.provider_name,scheduledStart:row.scheduled_start}});
 }
 if(await tableExists(db,"booking_refund_cases")){
  const rows=await db.prepare("SELECT id,booking_id,amount,reason,requested_by,created_at FROM booking_refund_cases WHERE status='requested' ORDER BY created_at LIMIT 200").all<Row>();
  for(const row of rows.results)await record({rule:"refund_requested",queue:"finance",priority:"high",title:`Refund requested on booking ${String(row.booking_id)}`,bookingId:String(row.booking_id),entityType:"refund_case",entityId:String(row.id),slaMinutes:240,detail:{amount:Number(row.amount||0),reason:row.reason,requestedBy:row.requested_by}});
 }
 if(await tableExists(db,"payment_reconciliation_exceptions")){
  const rows=await db.prepare("SELECT id,booking_id,payment_id,exception_type,severity,created_at FROM payment_reconciliation_exceptions WHERE status='open' ORDER BY created_at LIMIT 200").all<Row>();
  for(const row of rows.results)await record({rule:"payment_exception",queue:"finance",priority:String(row.severity)==="critical"?"critical":"high",title:`Payment reconciliation exception: ${String(row.exception_type)}`,bookingId:row.booking_id?String(row.booking_id):null,entityType:"payment_exception",entityId:String(row.id),slaMinutes:120,detail:{exceptionType:row.exception_type,severity:row.severity,paymentId:row.payment_id}});
 }
 if(await tableExists(db,"service_reviews")){
  const rows=await db.prepare("SELECT id,booking_id,customer_id,stars,created_at FROM service_reviews WHERE stars<=2 ORDER BY created_at LIMIT 200").all<Row>();
  for(const row of rows.results)await record({rule:"low_rating_callback",queue:"qc",priority:"high",title:`Low rating (${Number(row.stars)}★) on booking ${String(row.booking_id)} — QC callback`,bookingId:String(row.booking_id),customerId:String(row.customer_id),entityType:"service_review",entityId:String(row.id),slaMinutes:480,detail:{stars:Number(row.stars)}});
 }
 if(await tableExists(db,"relocation_enquiries")){
  const rows=await db.prepare("SELECT id,customer_name,pet_type,pickup_location,drop_location,created_at FROM relocation_enquiries WHERE status='new' ORDER BY created_at LIMIT 200").all<Row>();
  for(const row of rows.results)await record({rule:"relocation_enquiry",queue:"sales_relocation",priority:"medium",title:`New relocation enquiry from ${String(row.customer_name)} (${String(row.pickup_location)} → ${String(row.drop_location)})`,entityType:"relocation_enquiry",entityId:String(row.id),slaMinutes:240,detail:{petType:row.pet_type}});
 }
 if(await tableExists(db,"food_subscription_renewals")){
  const rows=await db.prepare("SELECT r.id,r.subscription_id,r.total_amount,r.due_at,s.customer_id FROM food_subscription_renewals r JOIN food_subscriptions s ON s.id=r.subscription_id WHERE r.status='payment_pending' AND r.due_at<? ORDER BY r.due_at LIMIT 200").bind(now-RENEWAL_OVERDUE_MS).all<Row>();
  for(const row of rows.results)await record({rule:"food_renewal_payment_overdue",queue:"retention",priority:"medium",title:`Food subscription renewal unpaid ${Math.round((now-Number(row.due_at))/3_600_000)}h past due`,customerId:String(row.customer_id),entityType:"food_subscription_renewal",entityId:String(row.id),slaMinutes:1440,detail:{subscriptionId:row.subscription_id,amount:Number(row.total_amount||0),dueAt:Number(row.due_at)}});
 }
 if(await tableExists(db,"lead_work_items")){
  const rows=await db.prepare("SELECT id,customer_id,owner,service,first_action_due_at FROM lead_work_items WHERE status='active' AND first_action_at IS NULL AND opt_out=0 AND first_action_due_at<? ORDER BY first_action_due_at LIMIT 200").bind(now).all<Row>();
  for(const row of rows.results)await record({rule:"lead_response_overdue",queue:"crm_escalation",priority:"high",title:`Lead ${String(row.id)} (${String(row.service)}) has no first response past its due time`,customerId:String(row.customer_id),entityType:"lead_work_item",entityId:String(row.id),slaMinutes:120,detail:{leadOwner:row.owner,firstActionDueAt:Number(row.first_action_due_at)}});
 }

 // Escalation pass: any still-open task past its SLA due time is flagged exactly once.
 const overdue=await db.prepare("SELECT id,queue,rule FROM ops_work_queue_tasks WHERE status IN ('open','acknowledged','in_progress') AND escalated=0 AND due_at<? LIMIT 500").bind(now).all<Row>();
 let escalatedCount=0;
 for(const row of overdue.results){
  const flagged=await db.prepare("UPDATE ops_work_queue_tasks SET escalated=1,escalated_at=?,updated_at=? WHERE id=? AND escalated=0").bind(now,now,row.id).run();
  if(Number(flagged.meta?.changes||0)>0){escalatedCount++;await addTaskEvent(db,String(row.id),"escalated",input.actorId,`SLA breached in ${String(row.queue)} queue`);}
 }
 const totalCreated=Object.values(created).reduce((sum,n)=>sum+n,0);
 return{created,totalCreated,escalated:escalatedCount,sweptAt:now,backgroundSchedulerConfigured:false};
}

/** Owner/status mutations with a full event trail. Terminal states are final; lost races are governed errors. */
export async function mutateWorkQueueTask(db:Db,input:{taskId:string;action:WorkQueueAction;actorId:string;note?:string;owner?:string}){
 await ensureWorkQueueTables(db);
 if(!input.taskId||!input.action||!input.actorId)throw new Response("Task, action and actor are required",{status:400});
 const task=await db.prepare("SELECT * FROM ops_work_queue_tasks WHERE id=?").bind(input.taskId).first<Row>();
 if(!task)throw new Response("Work queue task not found",{status:404});
 const now=Date.now(),note=String(input.note||"").trim();

 if(input.action==="add_note"){
  if(note.length<3)throw new Response("A meaningful note is required",{status:400});
  await addTaskEvent(db,input.taskId,"note",input.actorId,note);
  return{taskId:input.taskId,status:String(task.status),noted:true};
 }
 if(input.action==="claim"){
  const owner=String(input.owner||input.actorId).trim();
  const claimed=await db.prepare("UPDATE ops_work_queue_tasks SET owner=?,status=CASE WHEN status='open' THEN 'acknowledged' ELSE status END,updated_at=? WHERE id=? AND status IN ('open','acknowledged','in_progress')").bind(owner,now,input.taskId).run();
  if(!Number(claimed.meta?.changes||0))throw new Response("Only an open task can be claimed",{status:409});
  await addTaskEvent(db,input.taskId,"claimed",input.actorId,owner);
  return{taskId:input.taskId,status:String(task.status)==="open"?"acknowledged":String(task.status),owner};
 }
 if(input.action==="acknowledge"||input.action==="start"){
  const nextStatus=input.action==="start"?"in_progress":"acknowledged";
  const allowedFrom=input.action==="start"?["open","acknowledged"]:["open"];
  const moved=await db.prepare(`UPDATE ops_work_queue_tasks SET status=?,updated_at=? WHERE id=? AND status IN (${allowedFrom.map(()=>"?").join(",")})`).bind(nextStatus,now,input.taskId,...allowedFrom).run();
  if(!Number(moved.meta?.changes||0))throw new Response(`Task cannot ${input.action} from ${String(task.status)}`,{status:409});
  await addTaskEvent(db,input.taskId,nextStatus,input.actorId);
  return{taskId:input.taskId,status:nextStatus};
 }
 if(input.action==="resolve"||input.action==="dismiss"){
  if(note.length<5)throw new Response(`A clear ${input.action} note is required`,{status:400});
  const nextStatus=input.action==="resolve"?"resolved":"dismissed";
  const closed=await db.prepare("UPDATE ops_work_queue_tasks SET status=?,resolution_note=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=? AND status IN ('open','acknowledged','in_progress')").bind(nextStatus,note,input.actorId,now,now,input.taskId).run();
  if(!Number(closed.meta?.changes||0))throw new Response("Task is already closed",{status:409});
  await addTaskEvent(db,input.taskId,nextStatus,input.actorId,note);
  return{taskId:input.taskId,status:nextStatus,resolvedBy:input.actorId};
 }
 throw new Response("Unsupported work queue action",{status:400});
}

/** One-screen TODAY block (Business Command Centre) + queues, from the same canonical tables. */
export async function workQueueSnapshot(db:Db,input:{now?:number}={}){
 await ensureWorkQueueTables(db);
 const now=input.now??Date.now(),today=new Date(now).toISOString().slice(0,10);
 const tasks=await db.prepare("SELECT * FROM ops_work_queue_tasks ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,due_at LIMIT 500").all<Row>();
 const open=tasks.results.filter(row=>OPEN_STATUSES.includes(String(row.status)));
 const queues:Record<string,{open:number;escalated:number;tasks:Row[]}>={};
 for(const row of tasks.results){const queue=String(row.queue);queues[queue]??={open:0,escalated:0,tasks:[]};queues[queue].tasks.push(row);if(OPEN_STATUSES.includes(String(row.status))){queues[queue].open++;if(Number(row.escalated)===1)queues[queue].escalated++;}}

 let commandCentre:Record<string,unknown>={available:false};
 if(await tableExists(db,"canonical_bookings")){
  const todays=await db.prepare("SELECT id,service_code,status,total_amount,scheduled_start FROM canonical_bookings WHERE substr(scheduled_start,1,10)=?").bind(today).all<Row>();
  // Revenue recognition matches lib/pnl-reporting.ts and buildCompanyAnalytics: cancelled AND
  // draft bookings carry a total_amount but are not recognized revenue. Excluding only cancelled
  // made the founder's headline TODAY number disagree with the P&L for the same day.
  const recognized=(row:Row)=>!["cancelled","draft"].includes(String(row.status));
  const active=todays.results.filter(recognized);
  const byService:Record<string,{bookings:number;revenue:number;completed:number;cancelled:number}>={};
  for(const row of todays.results){const service=String(row.service_code);byService[service]??={bookings:0,revenue:0,completed:0,cancelled:0};const bucket=byService[service];if(String(row.status)==="cancelled")bucket.cancelled++;else if(recognized(row)){bucket.bookings++;bucket.revenue+=Number(row.total_amount||0);}if(String(row.status)==="completed")bucket.completed++;}
  let openComplaints=0;
  if(await tableExists(db,"customer_experience_tickets")){const row=await db.prepare("SELECT COUNT(*) count FROM customer_experience_tickets WHERE status NOT IN ('resolved','closed')").first<Row>();openComplaints=Number(row?.count||0);}
  commandCentre={
   available:true,date:today,
   bookings:active.length,
   revenue:Math.round(active.reduce((sum,row)=>sum+Number(row.total_amount||0),0)*100)/100,
   completed:todays.results.filter(row=>String(row.status)==="completed").length,
   upcoming:active.filter(row=>new Date(String(row.scheduled_start)).getTime()>now&&String(row.status)!=="completed").length,
   cancelled:todays.results.filter(row=>String(row.status)==="cancelled").length,
   unassigned:open.filter(row=>String(row.rule)==="provider_unassigned").length,
   refundPending:open.filter(row=>String(row.rule)==="refund_requested").length,
   openComplaints,
   byService,
  };
 }
 return{
  generatedAt:now,
  metrics:{total:tasks.results.length,open:open.length,escalated:open.filter(row=>Number(row.escalated)===1).length,critical:open.filter(row=>String(row.priority)==="critical").length,resolvedToday:tasks.results.filter(row=>String(row.status)==="resolved"&&Number(row.resolved_at||0)>=new Date(today).getTime()).length},
  queues,commandCentre,
  truth:{source:"canonical tables only",detectors:["provider_unassigned","refund_requested","payment_exception","low_rating_callback","relocation_enquiry","food_renewal_payment_overdue","lead_response_overdue"],backgroundSchedulerConfigured:false,productionReady:false},
 };
}

export async function workQueueTaskWithEvents(db:Db,taskId:string){
 await ensureWorkQueueTables(db);
 const task=await db.prepare("SELECT * FROM ops_work_queue_tasks WHERE id=?").bind(taskId).first<Row>();
 if(!task)return null;
 const events=await db.prepare("SELECT event_type,actor_id,note,created_at FROM ops_work_queue_events WHERE task_id=? ORDER BY created_at DESC LIMIT 50").bind(taskId).all<Row>();
 return{task,events:events.results};
}
