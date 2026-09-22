// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import {ensureBookingConversationOnInsert} from "./booking-conversation.ts";

type Row=Record<string,unknown>;

export const BOOKING_REPLAY_CONFLICT="This booking request conflicts with a booking owned by another customer";
export const BOOKING_WRITE_CONFLICT="This booking request conflicts with another booking operation";
export const SCHEDULING_GROUP_OWNERSHIP_CONFLICT="This scheduling group belongs to another customer";

type ReplayInput={customerId:string;serviceCode:string;idempotencyKey:string;scheduleGroupId:string};

/**
 * A REPLAY IS A RETRY OF A BOOKING THAT IS STILL OPEN - never an answer about a finished one. [LP-N19]
 *
 * The request key is a stable fingerprint of the booking's inputs (lib/booking-input-fingerprint.ts),
 * so a customer who books the SAME pet, package and slot again after that booking has been served
 * presents the same key. Matching on the key alone returned the finished booking with a 200 and the
 * same bookingId, and the app told the customer "Your groomer is reserved" about a job already done.
 * Closed bookings are therefore excluded from the replay match; the caller reports them as the
 * conflict they are, rather than as a live reservation.
 */
const CLOSED_BOOKING_STATUSES=["completed","cancelled","refunded","failed","no_show"];
export function isClosedBookingRow(row:Row|null|undefined){return Boolean(row)&&CLOSED_BOOKING_STATUSES.includes(String(row?.status??""));}

async function findCustomerBookingForRequest(db:D1Database,input:ReplayInput){
  return db.prepare("SELECT * FROM canonical_bookings WHERE customer_id=? AND service_code=? AND (idempotency_key=? OR schedule_group_id=?) LIMIT 1")
    .bind(input.customerId,input.serviceCode,input.idempotencyKey,input.scheduleGroupId).first<Row>();
}

export async function findCustomerReplay(db:D1Database,input:ReplayInput){
  const replay=await findCustomerBookingForRequest(db,input);
  if(!replay)await ensureBookingConversationOnInsert(db);
  return isClosedBookingRow(replay)?null:replay;
}

/** The customer's own booking for this request that is already closed, when one exists. */
export async function findClosedCustomerBooking(db:D1Database,input:ReplayInput){
  const row=await findCustomerBookingForRequest(db,input);
  return isClosedBookingRow(row)?row:null;
}

export function closedBookingRequestRefusal(row:Row){
  const status=String(row.status??"closed").replaceAll("_"," ");
  return{
    error:`Booking ${String(row.id)} for this request is already ${status}, so it cannot be reserved again. Choose a new date or time to book this service again.`,
    code:"booking_request_already_closed",
    bookingId:String(row.id),
    bookingStatus:String(row.status??""),
  };
}

export async function hasForeignReplayConflict(db:D1Database,input:ReplayInput){
  const row=await db.prepare("SELECT id FROM canonical_bookings WHERE customer_id<>? AND (idempotency_key=? OR schedule_group_id=?) LIMIT 1")
    .bind(input.customerId,input.idempotencyKey,input.scheduleGroupId).first<Row>();
  return Boolean(row);
}

export async function hasReplayConflict(db:D1Database,input:ReplayInput){
  const row=await db.prepare("SELECT id FROM canonical_bookings WHERE idempotency_key=? OR schedule_group_id=? LIMIT 1")
    .bind(input.idempotencyKey,input.scheduleGroupId).first<Row>();
  return Boolean(row);
}

export function schedulingGroupBelongsToCustomer(reservations:Row[],customerId:string){
  return reservations.every(row=>String(row.customer_id)===customerId);
}

export function isUniqueConstraintError(error:unknown){
  const message=error instanceof Error?error.message:String(error);
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed|unique(?:ness)? (?:constraint )?violation|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY|D1_ERROR.*UNIQUE/i.test(message);
}
