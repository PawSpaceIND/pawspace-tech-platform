type Row=Record<string,unknown>;

export const BOOKING_REPLAY_CONFLICT="This booking request conflicts with a booking owned by another customer";
export const BOOKING_WRITE_CONFLICT="This booking request conflicts with another booking operation";
export const SCHEDULING_GROUP_OWNERSHIP_CONFLICT="This scheduling group belongs to another customer";

type ReplayInput={customerId:string;serviceCode:string;idempotencyKey:string;scheduleGroupId:string};

export async function findCustomerReplay(db:D1Database,input:ReplayInput){
  return db.prepare("SELECT * FROM canonical_bookings WHERE customer_id=? AND service_code=? AND (idempotency_key=? OR schedule_group_id=?) LIMIT 1")
    .bind(input.customerId,input.serviceCode,input.idempotencyKey,input.scheduleGroupId).first<Row>();
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
