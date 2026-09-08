import {governedJsonError} from "./governed-http-error";
type Db = D1Database;
export type SchedulingDecisionSnapshot={updatedAt:number;shortlistJson:string};
const pendingPredicate="EXISTS (SELECT 1 FROM scheduling_assignment_decisions WHERE group_id=? AND status='awaiting_admin' AND selected_provider_id IS NULL AND updated_at=? AND shortlist_json=?)";
const pendingValues=(groupId:string,snapshot:SchedulingDecisionSnapshot)=>[groupId,snapshot.updatedAt,snapshot.shortlistJson];
export async function requirePendingSchedulingDecision(db:Db,groupId:string,snapshot:SchedulingDecisionSnapshot){
  const row=await db.prepare(`SELECT ${pendingPredicate} AS current`).bind(...pendingValues(groupId,snapshot)).first<{current:number}>();
  if(!row?.current)throw governedJsonError({error:"This request changed while you were assigning it. Refresh the day board before trying again.",code:"SCHEDULING_DECISION_CHANGED"},409);
}
async function hasBookingsTable(db:Db){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first());}

export async function requireUnbookedSchedulingGroup(db:Db,groupId:string){
  if(!await hasBookingsTable(db))return;
  const booking=await db.prepare("SELECT id,service_code FROM canonical_bookings WHERE schedule_group_id=? LIMIT 1").bind(groupId).first<{id:string;service_code:string}>();
  if(booking)throw governedJsonError({error:"This group belongs to a confirmed booking. Use its service recovery or cancellation workflow.",code:"BOOKING_RECOVERY_REQUIRED",bookingId:booking.id,serviceCode:booking.service_code},409);
}

/** The CHECK and mutations share a D1 transaction: confirmation cannot slip between them. */
export async function mutateUnbookedSchedulingGroup(db:Db,groupId:string,statements:D1PreparedStatement[],snapshot?:SchedulingDecisionSnapshot){
  const hasBookings=await hasBookingsTable(db),id=`unbooked-${crypto.randomUUID()}`;
  // On a cold schema, reject if another writer creates the booking table before this batch.
  const predicate=hasBookings?"NOT EXISTS (SELECT 1 FROM canonical_bookings WHERE schedule_group_id=?)":"NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_bookings')";
  const guard=db.prepare(`INSERT INTO scheduling_dispatch_assertions(id,ok,created_at) SELECT ?,CASE WHEN (${predicate})${snapshot?` AND (${pendingPredicate})`:""} THEN 1 ELSE 0 END,?`).bind(id,...(hasBookings?[groupId]:[]),...(snapshot?pendingValues(groupId,snapshot):[]),Date.now());
  try{
    const results=await db.batch([guard,...statements,db.prepare("DELETE FROM scheduling_dispatch_assertions WHERE id=?").bind(id)]);
    return results.slice(1,-1);
  }catch(error){await requireUnbookedSchedulingGroup(db,groupId);if(snapshot)await requirePendingSchedulingDecision(db,groupId,snapshot);throw error;}
}

/** Opaque revision binds a staff screen to the complete saved decision, including its request. */
export async function schedulingDecisionRevision(row:{group_id:unknown;status:unknown;selected_provider_id?:unknown;updated_at:unknown;shortlist_json:unknown}){
  const bytes=new TextEncoder().encode(JSON.stringify([row.group_id,row.status,row.selected_provider_id??null,row.updated_at,row.shortlist_json]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");
}
