import{ensureProviderCapacityTables}from"./provider-capacity-governance";
import{ensureWorkforcePersonLinkTables}from"./workforce-person-linkage";
type Db=D1Database;type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim(),IST=330*60_000;
const tableExists=async(db:Db,name:string)=>Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());
const startUtc=(d:string)=>new Date(Date.parse(d+"T00:00:00.000Z")-IST).toISOString();
const endUtc=(d:string)=>new Date(Date.parse(d+"T00:00:00.000Z")+86_400_000-IST).toISOString();
export async function ensureProviderLeaveBridgeTables(db:Db){
 await ensureProviderCapacityTables(db);await ensureWorkforcePersonLinkTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS provider_leave_blocks (request_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,employee_id TEXT NOT NULL,unavailability_id TEXT NOT NULL UNIQUE,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_leave_blocks_provider ON provider_leave_blocks(provider_id,status,starts_at,ends_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)")
 ]);
}
async function linkedProvider(db:Db,employeeId:string){
 const row=await db.prepare("SELECT l.provider_id,p.provider_model FROM provider_people_links l JOIN provider_capacity_profiles p ON p.id=l.provider_id WHERE l.employee_id=? AND l.status='active' AND p.status='active' AND p.live=1 LIMIT 1").bind(employeeId).first<Row>();
 return row&&text(row.provider_model)==="full_time"?text(row.provider_id):null;
}
async function affected(db:Db,providerId:string,startsAt:string,endsAt:string){
 return(await db.prepare("SELECT id,customer_id,schedule_group_id,service_code FROM canonical_bookings WHERE provider_id=? AND scheduled_start<? AND scheduled_end>? AND status NOT IN ('completed','cancelled','refunded') ORDER BY scheduled_start").bind(providerId,endsAt,startsAt).all<Row>()).results;
}
async function openHandoffs(db:Db,input:{requestId:string;providerId:string;startsAt:string;endsAt:string;actorId:string}){
 const bookings=await affected(db,input.providerId,input.startsAt,input.endsAt),now=Date.now();let opened=0;
 for(const booking of bookings){
  const bookingId=text(booking.id),groupId=text(booking.schedule_group_id)||bookingId;
  const prior=await db.prepare("SELECT id FROM provider_recovery_cases WHERE booking_id=? AND failed_provider_id=? AND reason_code='provider_leave_pending' AND status IN ('open','ops_escalation') LIMIT 1").bind(bookingId,input.providerId).first<Row>();
  if(prior)continue;const id="leave-recovery-"+crypto.randomUUID();
  await db.batch([
   db.prepare("INSERT INTO provider_recovery_cases (id,group_id,booking_id,failed_provider_id,reason_code,status,replacement_provider_id,detail_json,opened_at,resolved_at,updated_at) VALUES (?,?,?,?,?,'open',NULL,?,?,NULL,?)").bind(id,groupId,bookingId,input.providerId,"provider_leave_pending",JSON.stringify({leaveRequestId:input.requestId,bookingPreserved:true,customerNotificationDeferredUntilApproval:true,serviceCode:text(booking.service_code)}),now,now),
   db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,"provider_leave_recovery_opened","booking",bookingId,input.actorId,JSON.stringify({leaveRequestId:input.requestId,providerId:input.providerId,bookingPreserved:true}),now)
  ]);opened++;
 }
 return{affectedBookings:bookings.length,recoveryCasesOpened:opened};
}
export async function bridgePendingProviderLeave(db:Db,input:{requestId:string;employeeId:string;startDate:string;endDate:string;actorId:string}){
 if(!await tableExists(db,"provider_people_links")||!await tableExists(db,"provider_capacity_profiles"))return null;
 await ensureProviderLeaveBridgeTables(db);const providerId=await linkedProvider(db,input.employeeId);if(!providerId)return null;
 const prior=await db.prepare("SELECT * FROM provider_leave_blocks WHERE request_id=?").bind(input.requestId).first<Row>();
 if(prior)return{providerId,unavailabilityId:text(prior.unavailability_id),duplicatePrevented:true,...await openHandoffs(db,{requestId:input.requestId,providerId,startsAt:text(prior.starts_at),endsAt:text(prior.ends_at),actorId:input.actorId})};
 const startsAt=startUtc(input.startDate),endsAt=endUtc(input.endDate),now=Date.now(),unavailabilityId="PLEAVE-"+crypto.randomUUID().slice(0,12).toUpperCase();
 await db.batch([
  db.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)").bind(unavailabilityId,providerId,startsAt,endsAt,"Pending leave request "+input.requestId,input.actorId,now,now),
  db.prepare("INSERT INTO provider_leave_blocks (request_id,provider_id,employee_id,unavailability_id,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)").bind(input.requestId,providerId,input.employeeId,unavailabilityId,startsAt,endsAt,now,now)
 ]);
 return{providerId,unavailabilityId,duplicatePrevented:false,...await openHandoffs(db,{requestId:input.requestId,providerId,startsAt,endsAt,actorId:input.actorId})};
}
export async function resolveProviderLeaveBridge(db:Db,input:{requestId:string;decision:"approved"|"rejected";actorId:string}){
 if(!await tableExists(db,"provider_leave_blocks"))return null;
 await ensureProviderLeaveBridgeTables(db);const link=await db.prepare("SELECT * FROM provider_leave_blocks WHERE request_id=?").bind(input.requestId).first<Row>();if(!link)return null;
 const now=Date.now(),providerId=text(link.provider_id),unavailabilityId=text(link.unavailability_id);
 if(input.decision==="rejected"){
  const nowIso=new Date(now).toISOString();await db.batch([
   db.prepare("UPDATE provider_unavailability SET status='cleared',ends_at=CASE WHEN ends_at>? THEN ? ELSE ends_at END,updated_at=? WHERE id=? AND status='active'").bind(nowIso,nowIso,now,unavailabilityId),
   db.prepare("UPDATE provider_leave_blocks SET status='rejected',updated_at=? WHERE request_id=?").bind(now,input.requestId),
   db.prepare("UPDATE provider_recovery_cases SET status='cancelled',resolved_at=?,updated_at=? WHERE failed_provider_id=? AND reason_code='provider_leave_pending' AND status='open' AND json_extract(detail_json,'$.leaveRequestId')=?").bind(now,now,providerId,input.requestId)
  ]);return{providerId,status:"rejected",dispatchBlockCleared:true};
 }
 await db.prepare("UPDATE provider_leave_blocks SET status='approved',updated_at=? WHERE request_id=?").bind(now,input.requestId).run();
 const rows=await db.prepare("SELECT id,booking_id FROM provider_recovery_cases WHERE failed_provider_id=? AND reason_code='provider_leave_pending' AND status='open' AND json_extract(detail_json,'$.leaveRequestId')=?").bind(providerId,input.requestId).all<Row>();let notificationsQueued=0;
 for(const recovery of rows.results){const booking=await db.prepare("SELECT id,customer_id FROM canonical_bookings WHERE id=?").bind(recovery.booking_id).first<Row>();if(!booking)continue;
  const eventId=crypto.randomUUID(),bookingId=text(booking.id),message="Your PawSpace provider has approved leave affecting this booking. Your booking is preserved while Operations arranges and confirms cover.";
  await db.batch([
   db.prepare("UPDATE provider_recovery_cases SET status='ops_escalation',updated_at=? WHERE id=? AND status='open'").bind(now,recovery.id),
   db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(eventId,bookingId,"provider_leave_approved_recovery","booking",bookingId,input.actorId,JSON.stringify({leaveRequestId:input.requestId,providerId,bookingPreserved:true}),now),
   ...["push","whatsapp"].map(channel=>db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,'queued',?,?)").bind(crypto.randomUUID(),bookingId,text(booking.customer_id),channel,"provider_recovery",message,eventId,now))
  ]);notificationsQueued+=2;
 }
 return{providerId,status:"approved",dispatchBlockCleared:false,recoveryCasesEscalated:rows.results.length,notificationsQueued};
}
