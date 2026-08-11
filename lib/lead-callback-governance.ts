type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
/** How long past the customer's requested time a rep has before it counts as genuinely missed - real phone calls don't land to the exact minute, but a callback the customer specifically asked for going untouched for longer than this is a real service failure worth surfacing. */
const missedGraceMinutes=15;

export async function ensureLeadCallbackTables(db:Db){await db.batch([
 // Explicit, governed record: every scheduled callback is a real, separate row - never just an
 // overwrite of a single "next action" field, so a lead's full callback history stays visible and
 // a rep who reschedules can't quietly lose the trail of promises already made to the customer.
 db.prepare("CREATE TABLE IF NOT EXISTS lead_callbacks (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,requested_at INTEGER NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',completed_at INTEGER,completed_outcome TEXT,missed_at INTEGER,scheduled_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_callbacks_lead ON lead_callbacks(lead_id,status)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_callbacks_due ON lead_callbacks(status,requested_at)"),
 db.prepare("CREATE TABLE IF NOT EXISTS lead_callback_events (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,callback_id TEXT NOT NULL,lead_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

async function emit(db:Db,input:{callbackId:string;leadId:string;eventType:string;actorId:string;idempotencyKey:string;detail?:unknown}){
 const result=await db.prepare("INSERT OR IGNORE INTO lead_callback_events (id,idempotency_key,callback_id,lead_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
   .bind(uid("LCBE"),input.idempotencyKey,input.callbackId,input.leadId,input.eventType,input.actorId,JSON.stringify(input.detail||{}),Date.now()).run();
 return Number(result.meta?.changes||0)>0;
}

/**
 * Schedules a real callback for exactly when the customer asked to be called, not a generic SLA
 * delay. Also moves the lead's own next_action_at to this same real time, so the standard lead
 * worklist and this dedicated callback queue never disagree about when this lead is next due.
 */
export async function scheduleLeadCallback(db:Db,input:{leadId:string;requestedAt:number;reason:string;actorId:string}){
 await ensureLeadCallbackTables(db);
 if(!text(input.leadId))throw new Error("Lead is required");
 if(!Number.isFinite(input.requestedAt)||input.requestedAt<=Date.now())throw new Error("Callback time must be a real, future time - not a placeholder");
 if(input.reason.trim().length<8)throw new Error("A real reason (what the customer actually asked for) is required to schedule a callback");
 const lead=await db.prepare("SELECT id FROM lead_work_items WHERE id=?").bind(input.leadId).first<Row>();
 if(!lead)throw new Error("Lead not found");
 // Superseding a still-open callback for the same lead, rather than letting two live promises
 // coexist and confuse whoever picks this lead up next.
 const now=Date.now();
 await db.prepare("UPDATE lead_callbacks SET status='superseded',updated_at=? WHERE lead_id=? AND status='scheduled'").bind(now,input.leadId).run();
 const id=uid("LCB");
 await db.prepare("INSERT INTO lead_callbacks (id,lead_id,requested_at,reason,status,scheduled_by,created_at,updated_at) VALUES (?,?,?,?,'scheduled',?,?,?)")
   .bind(id,input.leadId,input.requestedAt,input.reason.trim(),input.actorId,now,now).run();
 await db.prepare("UPDATE lead_work_items SET next_action_at=?,updated_at=? WHERE id=?").bind(input.requestedAt,now,input.leadId).run();
 await emit(db,{callbackId:id,leadId:input.leadId,eventType:"scheduled",actorId:input.actorId,idempotencyKey:`schedule:${id}`,detail:{requestedAt:input.requestedAt,reason:input.reason.trim()}});
 return{id,leadId:input.leadId,requestedAt:input.requestedAt,reason:input.reason.trim(),status:"scheduled"};
}

/** A rep genuinely made the call - completes the real, open callback for this lead, real outcome required. */
export async function completeLeadCallback(db:Db,input:{callbackId:string;outcome:string;actorId:string}){
 await ensureLeadCallbackTables(db);
 if(!text(input.outcome))throw new Error("A real call outcome is required to complete a callback");
 const callback=await db.prepare("SELECT * FROM lead_callbacks WHERE id=?").bind(input.callbackId).first<Row>();
 if(!callback)throw new Error("Callback not found");
 if(text(callback.status)==="completed")return{id:input.callbackId,status:"completed",duplicatePrevented:true};
 if(text(callback.status)!=="scheduled"&&text(callback.status)!=="missed")throw new Error(`Callback status ${text(callback.status)} cannot be completed`);
 const now=Date.now();
 await db.prepare("UPDATE lead_callbacks SET status='completed',completed_at=?,completed_outcome=?,updated_at=? WHERE id=?").bind(now,input.outcome.trim(),now,input.callbackId).run();
 await emit(db,{callbackId:input.callbackId,leadId:text(callback.lead_id),eventType:"completed",actorId:input.actorId,idempotencyKey:`complete:${input.callbackId}`,detail:{outcome:input.outcome.trim(),wasMissed:text(callback.status)==="missed"}});
 return{id:input.callbackId,status:"completed",duplicatePrevented:false};
}

/**
 * The real reminder feed: what's due now, what's coming up, and what's already overdue - scoped
 * to one rep by default (their own leads only), or the whole team if explicitly asked for (a
 * manager view), never the reverse by accident.
 */
export async function dueLeadCallbacks(db:Db,input:{ownerEmail?:string;asOf?:number;lookAheadMinutes?:number}){
 await ensureLeadCallbackTables(db);
 const asOf=input.asOf??Date.now(),lookAhead=asOf+(input.lookAheadMinutes??60)*60000;
 const where=["c.status IN ('scheduled','missed')","c.requested_at<=?"],binds:unknown[]=[lookAhead];
 if(input.ownerEmail){where.push("l.owner=?");binds.push(input.ownerEmail);}
 const rows=await db.prepare(`SELECT c.*,l.owner,l.customer_id,l.service FROM lead_callbacks c JOIN lead_work_items l ON l.id=c.lead_id WHERE ${where.join(" AND ")} ORDER BY c.requested_at ASC`).bind(...binds).all<Row>();
 return rows.results.map(row=>({
   id:text(row.id),leadId:text(row.lead_id),owner:text(row.owner),customerId:text(row.customer_id),service:text(row.service),
   requestedAt:Number(row.requested_at),reason:text(row.reason),status:text(row.status),
   overdue:Number(row.requested_at)<asOf,minutesUntilDue:Math.round((Number(row.requested_at)-asOf)/60000),
 }));
}

/**
 * Real sweep, same pattern as the SLA breach sweep: any scheduled callback whose requested time
 * plus the real grace period has passed with no completion gets marked missed and a real event is
 * emitted - visible to a manager, not silently dropped.
 */
export async function runLeadCallbackSweep(db:Db,input:{actorId:string;asOf?:number}){
 await ensureLeadCallbackTables(db);
 const asOf=input.asOf??Date.now(),cutoff=asOf-missedGraceMinutes*60000;
 const rows=await db.prepare("SELECT * FROM lead_callbacks WHERE status='scheduled' AND requested_at<=?").bind(cutoff).all<Row>();
 let missed=0;
 for(const row of rows.results){
   await db.prepare("UPDATE lead_callbacks SET status='missed',missed_at=?,updated_at=? WHERE id=? AND status='scheduled'").bind(asOf,asOf,row.id).run();
   if(await emit(db,{callbackId:text(row.id),leadId:text(row.lead_id),eventType:"missed",actorId:input.actorId,idempotencyKey:`missed:${text(row.id)}`,detail:{requestedAt:Number(row.requested_at),graceMinutes:missedGraceMinutes}}))missed++;
 }
 return{processed:rows.results.length,missed};
}

export async function leadCallbackHistory(db:Db,leadId:string){
 await ensureLeadCallbackTables(db);
 const rows=await db.prepare("SELECT * FROM lead_callbacks WHERE lead_id=? ORDER BY created_at DESC").bind(leadId).all<Row>();
 return rows.results;
}
