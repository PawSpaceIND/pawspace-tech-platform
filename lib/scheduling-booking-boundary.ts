import {governedJsonError} from "./governed-http-error";
type Db = D1Database;
async function hasBookingsTable(db:Db){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first());}

export async function requireUnbookedSchedulingGroup(db:Db,groupId:string){
  if(!await hasBookingsTable(db))return;
  const booking=await db.prepare("SELECT id,service_code FROM canonical_bookings WHERE schedule_group_id=? LIMIT 1").bind(groupId).first<{id:string;service_code:string}>();
  if(booking)throw governedJsonError({error:"This group belongs to a confirmed booking. Use its service recovery or cancellation workflow.",code:"BOOKING_RECOVERY_REQUIRED",bookingId:booking.id,serviceCode:booking.service_code},409);
}

/** The CHECK and mutations share a D1 transaction: confirmation cannot slip between them. */
export async function mutateUnbookedSchedulingGroup(db:Db,groupId:string,statements:D1PreparedStatement[]){
  const hasBookings=await hasBookingsTable(db),id=`unbooked-${crypto.randomUUID()}`;
  // On a cold schema, reject if another writer creates the booking table before this batch.
  const predicate=hasBookings?"NOT EXISTS (SELECT 1 FROM canonical_bookings WHERE schedule_group_id=?)":"NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_bookings')";
  const guard=db.prepare(`INSERT INTO scheduling_dispatch_assertions(id,ok,created_at) SELECT ?,CASE WHEN ${predicate} THEN 1 ELSE 0 END,?`).bind(id,...(hasBookings?[groupId]:[]),Date.now());
  try{
    const results=await db.batch([guard,...statements,db.prepare("DELETE FROM scheduling_dispatch_assertions WHERE id=?").bind(id)]);
    return results.slice(1,-1);
  }catch(error){await requireUnbookedSchedulingGroup(db,groupId);throw error;}
}
