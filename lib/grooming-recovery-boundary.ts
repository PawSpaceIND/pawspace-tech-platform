import {governedJsonError} from "./governed-http-error";
type Row=Record<string,unknown>;
const bookingStates=new Set(["confirmed","assigned","on_the_way","arrived"]);
const workStates=new Set(["awaiting_acceptance","assigned","reassignment_needed","on_the_way","arrived"]);
export function requireRecoverableGroomingState(booking:Row,work:Row){
  if(!bookingStates.has(String(booking.status))||!workStates.has(String(work.status)))throw governedJsonError({error:"This job is no longer awaiting service. Use the appropriate service incident or cancellation workflow.",code:"RECOVERY_STATE_CONFLICT"},409);
  if(String(booking.provider_id)!==String(work.provider_id))throw governedJsonError({error:"Booking and work assignment disagree. Operations reconciliation is required.",code:"RECOVERY_STATE_CONFLICT"},409);
}
/** Protect all writes against completion, cancellation or another assignment after the initial read. */
export async function mutateCurrentGroomingAssignment(db:D1Database,booking:Row,work:Row,offer:Row|null,statements:D1PreparedStatement[],capacity?:{sql:string;values:unknown[]}){
  const id=`recovery-${crypto.randomUUID()}`;
  const offerPredicate=offer?"EXISTS (SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND provider_id IS ? AND status IS ? AND expires_at IS ? AND updated_at IS ?)":"NOT EXISTS (SELECT 1 FROM provider_assignment_offers WHERE group_id=?)";
  const predicate=`EXISTS (SELECT 1 FROM canonical_bookings WHERE id=? AND provider_id IS ? AND status IS ? AND updated_at IS ?) AND EXISTS (SELECT 1 FROM provider_work_orders WHERE booking_id=? AND provider_id IS ? AND status IS ? AND updated_at IS ?) AND ${offerPredicate}`;
  const values=[booking.id,booking.provider_id,booking.status,booking.updated_at,booking.id,work.provider_id,work.status,work.updated_at,booking.schedule_group_id,...(offer?[offer.provider_id,offer.status,offer.expires_at,offer.updated_at]:[])].map(value=>value??null);
  const check=db.prepare(`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END ok`).bind(...values);
  const guard=db.prepare(`INSERT INTO scheduling_dispatch_assertions(id,ok,created_at) SELECT ?,CASE WHEN ${predicate} THEN 1 ELSE 0 END,?`).bind(id,...values,Date.now());
  const capacityId=`capacity-${id}`;
  const capacityGuard=capacity?db.prepare(`INSERT INTO scheduling_dispatch_assertions(id,ok,created_at) SELECT ?,CASE WHEN ${capacity.sql} THEN 1 ELSE 0 END,?`).bind(capacityId,...capacity.values,Date.now()):null;
  try{return await db.batch([guard,...(capacityGuard?[capacityGuard]:[]),...statements,...(capacityGuard?[db.prepare("DELETE FROM scheduling_dispatch_assertions WHERE id=?").bind(capacityId)]:[]),db.prepare("DELETE FROM scheduling_dispatch_assertions WHERE id=?").bind(id)]);}
  catch(error){if(!(await check.first<{ok:number}>())?.ok)throw governedJsonError({error:"This assignment changed while recovery was being processed. Refresh the job before retrying.",code:"RECOVERY_STATE_CONFLICT"},409);if(capacity&&!(await db.prepare(`SELECT CASE WHEN ${capacity.sql} THEN 1 ELSE 0 END ok`).bind(...capacity.values).first<{ok:number}>())?.ok)throw governedJsonError({error:"Replacement availability changed. Refresh and retry recovery.",code:"RECOVERY_CAPACITY_CONFLICT"},409);throw error;}
}
