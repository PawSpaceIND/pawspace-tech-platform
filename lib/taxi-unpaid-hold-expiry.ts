import{cancelUnpaidRideHold,ensureTaxiFinanceTables}from"./taxi-finance-governance";
type Row=Record<string,unknown>;
/**
 * Unpaid Pet Taxi holds expire.
 *
 * Reserving a ride holds one driver and one physical car, and the ride flow tells the customer "Vehicle and
 * driver held for 3 hours. Pay the 50% booking fee to confirm the ride." Nothing ever ended that hold:
 * lib/scheduling-reservation-leases.ts never releases a group that has a canonical booking, and no sweep
 * looked at a payment_pending Pet Taxi booking - so an abandoned hold kept its car and driver for good
 * (round 2 found three on staging, e.g. PS-UAT-TAXI-MUILFO0D-9F16 on TXF-CITROEN-9179).
 *
 * POLICY. An unpaid hold expires at the EARLIER of 3 hours after it was reserved (what the customer was
 * told) and the ride's pickup time (an unpaid ride cannot start). A hold whose checkout is in flight - a
 * payment intent created or updated in the last 15 minutes - waits for the next run.
 *
 * RESULT. The same money-free cancellation the customer's own "Cancel ride" performs
 * (cancelUnpaidRideHold): the booking, work order, trip, driver reservation, car reservation and unpaid
 * payment row end cancelled/released in one batch, and only if the booking is still unpaid when the batch
 * runs, so a capture that lands first keeps its ride. No refund is involved: nothing was collected.
 *
 * Runs every 5 minutes from lib/background-scheduler.ts. Overlapping runs are harmless: the claim inside
 * the batch lets exactly one of them cancel a booking.
 */
export const TAXI_UNPAID_HOLD_MS=3*60*60_000;
export const TAXI_HOLD_CHECKOUT_GRACE_MS=15*60_000;
export const TAXI_HOLD_EXPIRY_ACTOR="system:taxi-unpaid-hold-expiry";
async function tableSet(db:D1Database,names:readonly string[]){const rows=await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map(()=>"?").join(",")})`).bind(...names).all<Row>();return new Set(rows.results.map(row=>String(row.name)));}
export async function releaseExpiredTaxiHolds(db:D1Database,input:{asOf?:number;limit?:number}={}){
 const asOf=input.asOf??Date.now(),limit=Math.max(1,Math.min(50,Math.floor(Number(input.limit)||20)));
 const tables=await tableSet(db,["canonical_bookings","booking_payments","taxi_trips","payment_intents"]);
 if(!tables.has("canonical_bookings")||!tables.has("booking_payments")||!tables.has("taxi_trips"))return{released:0,examined:0,bookings:[] as string[]};
 const graceFrom=asOf-TAXI_HOLD_CHECKOUT_GRACE_MS,intents=tables.has("payment_intents")?" AND NOT EXISTS (SELECT 1 FROM payment_intents i WHERE i.booking_id=b.id AND (i.state IN ('CAPTURED','SETTLED') OR i.created_at>? OR i.updated_at>?))":"";
 const due=await db.prepare(`SELECT b.id,b.schedule_group_id FROM canonical_bookings b JOIN taxi_trips t ON t.booking_id=b.id WHERE b.service_code='pet_taxi' AND b.status='payment_pending' AND (b.created_at<=? OR julianday(b.scheduled_start)<=julianday(?)) AND NOT EXISTS (SELECT 1 FROM booking_payments p WHERE p.booking_id=b.id AND p.status IN ('captured','paid','refunded','partially_refunded','authorized'))${intents} ORDER BY b.created_at LIMIT ?`)
  .bind(asOf-TAXI_UNPAID_HOLD_MS,new Date(asOf).toISOString(),...(intents?[graceFrom,graceFrom]:[]),limit).all<Row>();
 if(!due.results.length)return{released:0,examined:0,bookings:[] as string[]};
 await ensureTaxiFinanceTables(db);
 const bookings:string[]=[];
 for(const row of due.results){
  const bookingId=String(row.id),released=await cancelUnpaidRideHold(db,{bookingId,groupId:String(row.schedule_group_id||""),actorId:TAXI_HOLD_EXPIRY_ACTOR,now:Date.now(),requestId:crypto.randomUUID(),reason:"The booking fee was not paid within 3 hours, so the ride hold was released.",idempotencyKey:null,eventType:"ride_hold_expired_before_payment"});
  if(released)bookings.push(bookingId);
 }
 return{released:bookings.length,examined:due.results.length,bookings};
}
