import{ensureLeadSlaTables,runLeadSlaGovernance}from"./lead-sla-governance";
import{ensureUnifiedCaseTables,runUnifiedCaseEscalations,syncNativeCases}from"./unified-case-center";
import{enqueueCommunication}from"./communication-engine";
import{repsWithIncompleteClosure}from"./rep-daily-closure-governance";
import{authorizeStaffAlertAction}from"./staff-alert-authority";

type Db=D1Database;
type Row=Record<string,unknown>;
export type StaffAlertStatus="open"|"acknowledged"|"resolved";
const text=(value:unknown)=>String(value??"").trim();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export async function ensureStaffAlertTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS staff_alerts (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,alert_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',source_type TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,team_code TEXT,recipient_role TEXT,recipient_email TEXT,customer_id TEXT,booking_id TEXT,lead_id TEXT,case_id TEXT,due_at INTEGER NOT NULL,acknowledged_at INTEGER,acknowledged_by TEXT,resolved_at INTEGER,resolved_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS staff_alerts_queue_idx ON staff_alerts(status,severity,due_at,team_code,recipient_role,recipient_email)"),
 db.prepare("CREATE TABLE IF NOT EXISTS staff_alert_events (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,alert_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

async function emit(db:Db,input:{key:string;alertType:string;severity:"medium"|"high"|"critical";sourceType:string;sourceId:string;title:string;body:string;teamCode?:string|null;recipientRole?:string|null;recipientEmail?:string|null;customerId?:string|null;bookingId?:string|null;leadId?:string|null;caseId?:string|null;dueAt:number;actorId:string}){await ensureStaffAlertTables(db);const prior=await db.prepare("SELECT id,status FROM staff_alerts WHERE idempotency_key=?").bind(input.key).first<Row>();if(prior)return{duplicatePrevented:true,alertId:text(prior.id),status:text(prior.status)};const now=Date.now(),id=uid("ALERT");await db.batch([
 db.prepare("INSERT INTO staff_alerts (id,idempotency_key,alert_type,severity,status,source_type,source_id,title,body,team_code,recipient_role,recipient_email,customer_id,booking_id,lead_id,case_id,due_at,created_at,updated_at) VALUES (?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,input.key,input.alertType,input.severity,input.sourceType,input.sourceId,input.title,input.body,input.teamCode??null,input.recipientRole??null,input.recipientEmail??null,input.customerId??null,input.bookingId??null,input.leadId??null,input.caseId??null,input.dueAt,now,now),
 db.prepare("INSERT INTO staff_alert_events (id,idempotency_key,alert_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,'{}',?)").bind(uid("ALE"),`${input.key}:created`,id,"created",input.actorId,now),
]);return{duplicatePrevented:false,alertId:id,status:"open"};}

async function tableExists(db:Db,name:string){const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();return Boolean(row);}

async function leadAlerts(db:Db,asOf:number,actorId:string){
 // lead_work_items is part of the same guard: the query LEFT JOINs it, and SQLite errors on a JOIN
 // to a missing table even when it is a LEFT JOIN — on a cold DB the whole sweep 500'd.
 if(!(await tableExists(db,"lead_sla_clocks"))||!(await tableExists(db,"lead_assignments"))||!(await tableExists(db,"lead_work_items")))return{created:0,skipped:true};const rows=await db.prepare("SELECT c.id clock_id,c.lead_id,c.clock_type,c.status,c.due_at,c.manager_escalation_due_at,c.reassignment_due_at,a.employee_email,a.team_code,l.customer_id FROM lead_sla_clocks c JOIN lead_assignments a ON a.id=c.assignment_id LEFT JOIN lead_work_items l ON l.id=c.lead_id WHERE c.status IN ('running','breached') AND (c.due_at<=? OR c.manager_escalation_due_at<=? OR c.reassignment_due_at<=?) ORDER BY c.due_at").bind(asOf,asOf,asOf).all<Row>();let created=0;for(const row of rows.results){const clockId=text(row.clock_id),leadId=text(row.lead_id),clockType=text(row.clock_type),owner=text(row.employee_email),team=text(row.team_code)||"sales",customerId=text(row.customer_id)||null;
  if(Number(row.due_at)<=asOf){const r=await emit(db,{key:`lead:${clockId}:sla_due`,alertType:"lead_sla_breach",severity:"medium",sourceType:"lead_sla_clock",sourceId:clockId,title:`Lead SLA overdue · ${leadId}`,body:`${clockType.replaceAll("_"," ")} is overdue for ${leadId}. Owner action is required.`,teamCode:team,recipientRole:"owner",recipientEmail:owner,customerId,leadId,dueAt:Number(row.due_at),actorId});if(!r.duplicatePrevented)created++;}
  if(Number(row.manager_escalation_due_at)<=asOf){const r=await emit(db,{key:`lead:${clockId}:manager`,alertType:"lead_manager_escalation",severity:"high",sourceType:"lead_sla_clock",sourceId:clockId,title:`Manager escalation · ${leadId}`,body:`${clockType.replaceAll("_"," ")} exceeded the configured manager-escalation threshold. Review the owner, next action and customer risk.`,teamCode:team,recipientRole:"manager",customerId,leadId,dueAt:Number(row.manager_escalation_due_at),actorId});if(!r.duplicatePrevented)created++;}
  if(Number(row.reassignment_due_at)<=asOf){const r=await emit(db,{key:`lead:${clockId}:reassignment`,alertType:"lead_reassignment_due",severity:"critical",sourceType:"lead_sla_clock",sourceId:clockId,title:`Lead reassignment due · ${leadId}`,body:`${leadId} exceeded the configured reassignment threshold. This lead is automatically reassigned to the next eligible agent; this alert is for manager visibility, not action.`,teamCode:team,recipientRole:"manager",customerId,leadId,dueAt:Number(row.reassignment_due_at),actorId});if(!r.duplicatePrevented)created++;}}
 return{created,scanned:rows.results.length,skipped:false};}

async function caseAlerts(db:Db,asOf:number,actorId:string){if(!(await tableExists(db,"unified_cases")))return{created:0,skipped:true};const rows=await db.prepare("SELECT id,case_type,severity,status,title,owner_team,owner_email,customer_id,booking_id,lead_id,first_response_due_at,manager_escalation_due_at,resolution_due_at,first_responded_at FROM unified_cases WHERE status NOT IN ('resolved','closed') AND (first_response_due_at<=? OR manager_escalation_due_at<=? OR resolution_due_at<=?) ORDER BY created_at").bind(asOf,asOf,asOf).all<Row>();let created=0;for(const row of rows.results){const caseId=text(row.id),team=text(row.owner_team)||"operations",owner=text(row.owner_email)||null,base={sourceType:"unified_case",sourceId:caseId,teamCode:team,customerId:text(row.customer_id)||null,bookingId:text(row.booking_id)||null,leadId:text(row.lead_id)||null,caseId,actorId};
  if(!row.first_responded_at&&row.first_response_due_at!=null&&Number(row.first_response_due_at)<=asOf){const r=await emit(db,{...base,key:`case:${caseId}:first_response`,alertType:"case_first_response_overdue",severity:"high",title:`Case response overdue · ${caseId}`,body:`${text(row.title)} has crossed its configured first-response SLA.`,recipientRole:owner?"owner":"manager",recipientEmail:owner,dueAt:Number(row.first_response_due_at)});if(!r.duplicatePrevented)created++;}
  if(row.manager_escalation_due_at!=null&&Number(row.manager_escalation_due_at)<=asOf){const r=await emit(db,{...base,key:`case:${caseId}:manager`,alertType:"case_manager_escalation",severity:text(row.severity)==="critical"?"critical":"high",title:`Manager case escalation · ${caseId}`,body:`${text(row.title)} crossed its configured manager-escalation threshold.`,recipientRole:"manager",dueAt:Number(row.manager_escalation_due_at)});if(!r.duplicatePrevented)created++;}
  if(row.resolution_due_at!=null&&Number(row.resolution_due_at)<=asOf){const r=await emit(db,{...base,key:`case:${caseId}:resolution`,alertType:"case_resolution_overdue",severity:"critical",title:`Case resolution overdue · ${caseId}`,body:`${text(row.title)} crossed its configured resolution SLA.`,recipientRole:"manager",dueAt:Number(row.resolution_due_at)});if(!r.duplicatePrevented)created++;}}
 return{created,scanned:rows.results.length,skipped:false};}

/**
 * Customer notices are never sent for a FUTURE sweep clock.
 *
 * asOf is a supported simulation input on the staff-alert side - the runner's own tests advance it to
 * prove an alert fires once and then auto-resolves as the clock clears - and that side is recoverable:
 * a staff alert raised early can be resolved. A CUSTOMER notice is not. Measured with
 * asOf:9999999999999 on a case created seconds earlier with 90 minutes still to run: created=3 and
 * customerNotifications {attempted:2, enqueued:2} - real "your case is overdue" messages to a real
 * customer. And because the communication idempotency key omits the sweep clock, the GENUINE later
 * notice is then permanently duplicatePrevented: the customer gets the wrong message now and never gets
 * the right one.
 *
 * So the bound is here, on the irreversible half only, rather than on the route - which would have
 * removed a capability the platform deliberately has and tests.
 */
async function caseCustomerNotifications(db:Db,asOf:number,actorId:string){const empty={attempted:0,enqueued:0,suppressed:0,duplicatePrevented:0,skipped:0,errors:[] as string[],transport:"canonical_chat_outbox",externalDelivery:false};if(asOf>Date.now())return{...empty,skippedFutureClock:true};try{if(!(await tableExists(db,"unified_cases"))||!(await tableExists(db,"canonical_customers")))return{...empty,unavailable:true};const rows=await db.prepare("SELECT c.id,c.title,c.status,c.customer_id,c.booking_id,c.owner_email,c.first_response_due_at,c.resolution_due_at,c.first_responded_at,cc.city_id FROM unified_cases c JOIN canonical_customers cc ON cc.id=c.customer_id WHERE c.status NOT IN ('resolved','closed') AND c.customer_id IS NOT NULL AND c.booking_id IS NOT NULL AND ((c.first_responded_at IS NULL AND c.first_response_due_at IS NOT NULL AND c.first_response_due_at<=?) OR (c.resolution_due_at IS NOT NULL AND c.resolution_due_at<=?)) ORDER BY c.created_at").bind(asOf,asOf).all<Row>();let attempted=0,enqueued=0,suppressed=0,duplicatePrevented=0,skipped=0;const errors:string[]=[];for(const row of rows.results){const caseId=text(row.id),customerId=text(row.customer_id),bookingId=text(row.booking_id),cityId=text(row.city_id),owner=text(row.owner_email)||undefined;if(!caseId||!customerId||!bookingId||!cityId){skipped++;continue;}const events:Array<{kind:"first_response"|"resolution";templateKey:string;dueAt:number;notice:string}>=[];if(!row.first_responded_at&&row.first_response_due_at!=null&&Number(row.first_response_due_at)<=asOf)events.push({kind:"first_response",templateKey:"case_first_response_overdue",dueAt:Number(row.first_response_due_at),notice:"Your PawSpace support case has crossed its first-response target and is being escalated for staff attention."});if(row.resolution_due_at!=null&&Number(row.resolution_due_at)<=asOf)events.push({kind:"resolution",templateKey:"case_resolution_overdue",dueAt:Number(row.resolution_due_at),notice:"Your PawSpace support case has crossed its resolution target and remains escalated for staff attention."});for(const item of events){attempted++;try{const result=await enqueueCommunication(db,{customerId,cityId,channel:"chat",purpose:"service_recovery",idempotencyKey:`case:${caseId}:customer:${item.kind}`,templateKey:item.templateKey,payload:{caseId,title:text(row.title),status:text(row.status),escalationType:item.kind,dueAt:item.dueAt,notice:item.notice},createdBy:actorId,bookingId,assignedTo:owner});if(result.duplicatePrevented)duplicatePrevented++;else if(result.status==="suppressed")suppressed++;else enqueued++;}catch(error){errors.push(`case:${caseId}:${item.kind}:${error instanceof Error?error.message:String(error)}`);}}}return{attempted,enqueued,suppressed,duplicatePrevented,skipped,errors,transport:"canonical_chat_outbox",externalDelivery:false,unavailable:false};}catch(error){return{...empty,errors:[error instanceof Error?error.message:String(error)],unavailable:true};}}

// Boarding stays stuck awaiting host acceptance past the host's offer timeout. Real columns from
// the owning DDLs: boarding_stays (lib/boarding-governance.ts), canonical_bookings
// (schedule_group_id), provider_assignment_offers (lib/provider-capacity-governance.ts: group_id,
// status, expires_at).
async function boardingAcceptanceAlerts(db:Db,asOf:number,actorId:string){if(!(await tableExists(db,"boarding_stays"))||!(await tableExists(db,"canonical_bookings"))||!(await tableExists(db,"provider_assignment_offers")))return{created:0,skipped:true};const rows=await db.prepare("SELECT s.id stay_id,s.booking_id,s.customer_id,s.host_provider_id,s.check_in_at,o.expires_at FROM boarding_stays s JOIN canonical_bookings b ON b.id=s.booking_id JOIN provider_assignment_offers o ON o.group_id=b.schedule_group_id WHERE s.status='awaiting_host_acceptance' AND o.status='pending' AND o.expires_at<=?").bind(asOf).all<Row>();let created=0;for(const row of rows.results){const stayId=text(row.stay_id);const r=await emit(db,{key:`boarding:${stayId}:acceptance_timeout`,alertType:"boarding_acceptance_timeout",severity:"high",sourceType:"boarding_stay",sourceId:stayId,title:`Boarding host has not accepted · ${text(row.booking_id)}`,body:`Host ${text(row.host_provider_id)} has not accepted the stay (check-in ${text(row.check_in_at)}) and the acceptance offer has expired. Reassign or contact the host before the customer is impacted.`,teamCode:"operations",recipientRole:"manager",customerId:text(row.customer_id)||null,bookingId:text(row.booking_id)||null,dueAt:Number(row.expires_at),actorId});if(!r.duplicatePrevented)created++;}return{created,scanned:rows.results.length,skipped:false};}

// Failed canonical payments. Real columns from the booking_payments DDL (canonical booking routes):
// id, booking_id, customer_id, amount, method, status, updated_at.
async function paymentFailureAlerts(db:Db,asOf:number,actorId:string){if(!(await tableExists(db,"booking_payments")))return{created:0,skipped:true};const rows=await db.prepare("SELECT id,booking_id,customer_id,amount,method,updated_at FROM booking_payments WHERE status='failed'").all<Row>();let created=0;for(const row of rows.results){const paymentId=text(row.id);const r=await emit(db,{key:`payment:${paymentId}:failed`,alertType:"payment_failure",severity:"critical",sourceType:"booking_payment",sourceId:paymentId,title:`Payment failed · ${text(row.booking_id)}`,body:`Payment ${paymentId} (${text(row.method)} · ₹${Number(row.amount||0)}) is in failed state. Finance follow-up is required before the booking can settle.`,teamCode:"finance",recipientRole:"manager",customerId:text(row.customer_id)||null,bookingId:text(row.booking_id)||null,dueAt:Number(row.updated_at)||asOf,actorId});if(!r.duplicatePrevented)created++;}return{created,scanned:rows.results.length,skipped:false};}

// Condition-backed alerts must clear themselves when the underlying condition clears — a resolved
// payment or an accepted stay must not leave a stale open alert for staff to chase.
async function autoResolveClearedAlerts(db:Db,asOf:number,actorId:string){
 const clearedChecks:Array<{types:string[];cleared:(sourceId:string)=>Promise<boolean>}>=[
  {types:["boarding_acceptance_timeout"],cleared:async sourceId=>{if(!(await tableExists(db,"boarding_stays")))return false;const row=await db.prepare("SELECT status FROM boarding_stays WHERE id=?").bind(sourceId).first<Row>();return Boolean(row)&&text(row!.status)!=="awaiting_host_acceptance";}},
  {types:["payment_failure"],cleared:async sourceId=>{if(!(await tableExists(db,"booking_payments")))return false;const row=await db.prepare("SELECT status FROM booking_payments WHERE id=?").bind(sourceId).first<Row>();return Boolean(row)&&text(row!.status)!=="failed";}},
  {types:["lead_sla_breach","lead_manager_escalation","lead_reassignment_due"],cleared:async sourceId=>{if(!(await tableExists(db,"lead_sla_clocks")))return false;const row=await db.prepare("SELECT status FROM lead_sla_clocks WHERE id=?").bind(sourceId).first<Row>();return Boolean(row)&&!["running","breached"].includes(text(row!.status));}},
 ];
 let resolved=0;
 for(const check of clearedChecks){
  const open=await db.prepare(`SELECT id,source_id FROM staff_alerts WHERE status!='resolved' AND alert_type IN (${check.types.map(()=>"?").join(",")})`).bind(...check.types).all<Row>();
  for(const alert of open.results){
   if(!(await check.cleared(text(alert.source_id))))continue;
   const changed=await db.prepare("UPDATE staff_alerts SET status='resolved',resolved_at=?,resolved_by=?,updated_at=? WHERE id=? AND status!='resolved'").bind(asOf,actorId,asOf,alert.id).run();
   if(Number(changed.meta?.changes||0)===0)continue;
   await db.prepare("INSERT OR IGNORE INTO staff_alert_events (id,idempotency_key,alert_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(uid("ALE"),`alert:${text(alert.id)}:auto_resolved`,alert.id,"auto_resolved",actorId,JSON.stringify({reason:"condition_cleared"}),asOf).run();
   resolved++;
  }
 }
 return{resolved};
}

async function dailyClosureAlerts(db:Db,asOf:number,actorId:string){if(!(await tableExists(db,"lead_assignments"))||!(await tableExists(db,"rep_daily_closures")))return{created:0,skipped:true};const closureDate=new Date(asOf-86400000).toISOString().slice(0,10);const incomplete=await repsWithIncompleteClosure(db,{closureDate});let created=0;for(const rep of incomplete){const r=await emit(db,{key:`daily-closure:${rep.repEmail}:${closureDate}`,alertType:"rep_daily_closure_incomplete",severity:"high",sourceType:"rep_daily_closure",sourceId:`${rep.repEmail}:${closureDate}`,title:`Day not closed · ${rep.repEmail} · ${closureDate}`,body:`${rep.repEmail} did not close ${closureDate} - either an assigned lead had no logged activity that day, or the required 3.5 hours of talk time was not met. For manager review, not automatic action.`,teamCode:rep.teamCode||"sales",recipientRole:"manager",recipientEmail:null,dueAt:asOf,actorId});if(!r.duplicatePrevented)created++;}return{created,skipped:false};}

export async function runStaffAlertSweep(db:Db,input:{actorId:string;asOf?:number}){const asOf=input.asOf??Date.now();await ensureStaffAlertTables(db);const warnings:string[]=[];try{await ensureLeadSlaTables(db);await runLeadSlaGovernance(db,{actorId:input.actorId,asOf});}catch(error){warnings.push(`lead_sla:${error instanceof Error?error.message:String(error)}`);}try{await ensureUnifiedCaseTables(db);await syncNativeCases(db,input.actorId);await runUnifiedCaseEscalations(db,{actorId:input.actorId,asOf});}catch(error){warnings.push(`case_sync:${error instanceof Error?error.message:String(error)}`);}const leads=await leadAlerts(db,asOf,input.actorId),cases=await caseAlerts(db,asOf,input.actorId),boarding=await boardingAcceptanceAlerts(db,asOf,input.actorId),payments=await paymentFailureAlerts(db,asOf,input.actorId),customerNotifications=await caseCustomerNotifications(db,asOf,input.actorId);let dailyClosure={created:0,skipped:true as boolean};try{dailyClosure=await dailyClosureAlerts(db,asOf,input.actorId);}catch(error){warnings.push(`daily_closure:${error instanceof Error?error.message:String(error)}`);}let autoResolved={resolved:0};try{autoResolved=await autoResolveClearedAlerts(db,asOf,input.actorId);}catch(error){warnings.push(`auto_resolve:${error instanceof Error?error.message:String(error)}`);}if(customerNotifications.errors.length)warnings.push(...customerNotifications.errors.map(error=>`customer_notification:${error}`));return{asOf,created:leads.created+cases.created+boarding.created+payments.created+dailyClosure.created,leads,cases,boarding,payments,dailyClosure,autoResolved,customerNotifications,warnings,automaticMode:"governed_runner_available",runnerBoundary:"/api/staff-alert-runner",backgroundSchedulerConfigured:false,customerNotificationTransport:"canonical_chat_outbox",externalDelivery:false,productionReady:false};}

export async function staffAlertDirectory(db:Db){await ensureStaffAlertTables(db);const now=Date.now(),alerts=await db.prepare("SELECT * FROM staff_alerts ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,due_at ASC LIMIT 250").all<Row>(),summary=await db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open,SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) acknowledged,SUM(CASE WHEN status='open' AND severity='critical' THEN 1 ELSE 0 END) critical,SUM(CASE WHEN status='open' AND due_at<=? THEN 1 ELSE 0 END) overdue FROM staff_alerts").bind(now).first<Row>();return{summary,alerts:alerts.results,truth:{thresholds:"source_policy_derived",hardcodedTwentyMinuteRule:false,automaticMode:"governed_runner_available",runnerBoundary:"/api/staff-alert-runner",backgroundSchedulerConfigured:false,customerNotificationTransport:"canonical_chat_outbox",externalDelivery:false,productionReady:false}};}

/** Thrown when the actor may not act on this particular alert. The route turns it into a 403. */
export class StaffAlertAuthorityError extends Error{
 readonly status=403;
 readonly owner:string;
 constructor(message:string,owner:string){super(message);this.name="StaffAlertAuthorityError";this.owner=owner;}
}

/**
 * Acknowledge or resolve one alert.
 *
 * Authority is decided per alert, not per endpoint - a Manager's `customers.manage` is authority over
 * Sales and Operations alerts and is NOT authority over a Finance payment failure. See
 * lib/staff-alert-authority.ts for the policy and why it fails closed.
 *
 * Resolution is write-once. The UPDATE carries its own `status!='resolved'` guard and the event is
 * written only when that UPDATE actually changed a row, which gives two properties that used to be
 * missing: a second resolver cannot rewrite `resolved_by`/`resolved_at` (the first resolution is the
 * record), and the alert row can never disagree with its event history - previously the row was
 * overwritten while the `INSERT OR IGNORE` dropped the duplicate event, leaving the row crediting one
 * person and the audit trail crediting another.
 */
export async function updateStaffAlert(db:Db,input:{alertId:string;action:"acknowledge"|"resolve";actorId:string;actorPermissions:string[]}){await ensureStaffAlertTables(db);const row=await db.prepare("SELECT * FROM staff_alerts WHERE id=?").bind(input.alertId).first<Row>();if(!row)throw new Error("Staff alert not found");
 const decision=authorizeStaffAlertAction({email:input.actorId,permissions:input.actorPermissions},row,input.action);
 // Refused before any write: an unauthorised attempt must leave both tables exactly as it found them.
 if(!decision.allowed)throw new StaffAlertAuthorityError(decision.reason,decision.authority.owner);
 const now=Date.now(),eventKey=`alert:${input.alertId}:${input.action}`;
 if(input.action==="acknowledge"){
  if(text(row.status)==="resolved")throw new Error("Resolved alert cannot be acknowledged");
  const changed=await db.prepare("UPDATE staff_alerts SET status='acknowledged',acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_by=COALESCE(acknowledged_by,?),updated_at=? WHERE id=? AND status!='resolved'").bind(now,input.actorId,now,input.alertId).run();
  if(Number(changed.meta?.changes||0)>0)await db.prepare("INSERT OR IGNORE INTO staff_alert_events (id,idempotency_key,alert_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,'{}',?)").bind(uid("ALE"),eventKey,input.alertId,input.action,input.actorId,now).run();
  const after=await db.prepare("SELECT acknowledged_at,acknowledged_by FROM staff_alerts WHERE id=?").bind(input.alertId).first<Row>();
  return{alertId:input.alertId,status:"acknowledged" as const,acknowledgedBy:text(after?.acknowledged_by)||null,acknowledgedAt:after?.acknowledged_at==null?null:Number(after.acknowledged_at),alreadyAcknowledged:text(row.status)==="acknowledged"};
 }
 const changed=await db.prepare("UPDATE staff_alerts SET status='resolved',resolved_at=?,resolved_by=?,updated_at=? WHERE id=? AND status!='resolved'").bind(now,input.actorId,now,input.alertId).run();
 const firstResolution=Number(changed.meta?.changes||0)>0;
 // Only a resolution that actually changed the row writes an event, so the two can never diverge.
 if(firstResolution)await db.prepare("INSERT OR IGNORE INTO staff_alert_events (id,idempotency_key,alert_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,'{}',?)").bind(uid("ALE"),eventKey,input.alertId,input.action,input.actorId,now).run();
 const after=await db.prepare("SELECT resolved_at,resolved_by FROM staff_alerts WHERE id=?").bind(input.alertId).first<Row>();
 return{alertId:input.alertId,status:"resolved" as const,resolvedBy:text(after?.resolved_by)||null,resolvedAt:after?.resolved_at==null?null:Number(after.resolved_at),alreadyResolved:!firstResolution};}
