// 50/50 split payment for stays (founder policy): Boarding and Pet Sitting customers may pay
// 50% at booking confirmation with the remaining 50% due 24 hours before the stay starts.
// Every other service pays in full. 100% refund / zero cancellation fee remains platform-wide,
// so an unpaid balance never accrues a penalty — it only blocks check-in until settled.
// Money stays sandboxed (PAWSPACE_PAYMENT_ENV=sandbox): the balance "capture" is a governed
// sandbox capture exactly like the booking-time payment, never a live charge.

type Db=D1Database;
type Row=Record<string,unknown>;

export type StayPaymentMode="prepaid"|"split_50_50";
export type StayScheduleStatus="pending_balance"|"paid"|"overdue";
export type StayPaymentSchedule={bookingId:string;serviceCode:string;customerId:string;totalAmount:number;paidNowAmount:number;balanceAmount:number;balanceDueAt:number;status:StayScheduleStatus;paidAt:number|null;paymentRef:string|null;createdAt:number;updatedAt:number};

export const SPLIT_ELIGIBLE_SERVICES=new Set(["boarding","pet_sitting"]);
export const BALANCE_LEAD_MS=24*3_600_000;

const round2=(value:number)=>Math.round(value*100)/100;

/** Pure split plan. Throws 409 when the stay starts within 24h — the balance would be due
 *  immediately, so those bookings must pay in full. */
export function splitPaymentPlan(input:{totalAmount:number;scheduledStart:string;now?:number}):{dueNow:number;balance:number;balanceDueAt:number}{
 const now=input.now??Date.now(),startMs=new Date(input.scheduledStart).getTime();
 if(!Number.isFinite(startMs))throw new Response("A valid stay start is required for split payment",{status:400});
 const total=Number(input.totalAmount);
 if(!Number.isFinite(total)||total<=0)throw new Response("A positive total is required for split payment",{status:400});
 if(startMs-now<=BALANCE_LEAD_MS)throw new Response("Split payment needs the stay to start more than 24 hours from now; pay in full instead",{status:409});
 const dueNow=round2(total/2),balance=round2(total-dueNow);
 return{dueNow,balance,balanceDueAt:startMs-BALANCE_LEAD_MS};
}

const stayPaymentTablesEnsured=new WeakSet<Db>();
export async function ensureStayPaymentTables(db:Db){
 if(stayPaymentTablesEnsured.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT NOT NULL,customer_id TEXT NOT NULL,total_amount REAL NOT NULL,paid_now_amount REAL NOT NULL,balance_amount REAL NOT NULL,balance_due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending_balance',paid_at INTEGER,payment_ref TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_stay_payment_due ON stay_payment_schedules(status,balance_due_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS stay_payment_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,idempotency_key TEXT UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
 ]);
 stayPaymentTablesEnsured.add(db);
}

function rowToSchedule(row:Row):StayPaymentSchedule{
 return{bookingId:String(row.booking_id),serviceCode:String(row.service_code),customerId:String(row.customer_id),totalAmount:Number(row.total_amount),paidNowAmount:Number(row.paid_now_amount),balanceAmount:Number(row.balance_amount),balanceDueAt:Number(row.balance_due_at),status:String(row.status) as StayScheduleStatus,paidAt:row.paid_at==null?null:Number(row.paid_at),paymentRef:row.payment_ref==null?null:String(row.payment_ref),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)};
}

/** Prepared INSERT for the booking-creation batch — the schedule is created atomically with the booking. */
export function staySplitScheduleStatement(db:Db,input:{bookingId:string;serviceCode:string;customerId:string;totalAmount:number;paidNowAmount:number;balanceAmount:number;balanceDueAt:number}){
 const now=Date.now();
 return db.prepare("INSERT INTO stay_payment_schedules (booking_id,service_code,customer_id,total_amount,paid_now_amount,balance_amount,balance_due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending_balance',?,?)").bind(input.bookingId,input.serviceCode,input.customerId,input.totalAmount,input.paidNowAmount,input.balanceAmount,input.balanceDueAt,now,now);
}

export async function getStayPaymentSchedule(db:Db,bookingId:string):Promise<StayPaymentSchedule|null>{
 await ensureStayPaymentTables(db);
 const row=await db.prepare("SELECT * FROM stay_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>();
 return row?rowToSchedule(row):null;
}

/** Sandbox-capture the outstanding balance. Idempotent per idempotencyKey AND terminal-state safe:
 *  paying an already-paid schedule returns it unchanged with duplicatePrevented. */
export async function payStayBalance(db:Db,input:{bookingId:string;actorId:string;idempotencyKey:string}):Promise<{schedule:StayPaymentSchedule;duplicatePrevented:boolean}>{
 await ensureStayPaymentTables(db);
 const bookingId=String(input.bookingId||"").trim(),idempotencyKey=String(input.idempotencyKey||"").trim();
 if(!bookingId||!idempotencyKey)throw new Response("Booking and idempotency key are required",{status:400});
 // stay_payment_events.idempotency_key is UNIQUE GLOBALLY, and this used to flip the schedule to 'paid'
 // first and record the capture second, swallowing a UNIQUE collision as "the same request already
 // recorded its capture". Reused across two bookings, the SECOND booking was marked paid and its
 // balance_captured event silently discarded - a settled schedule with no capture behind it. Keys are
 // client-supplied, so two customers both sending "pay-balance" collide by accident. Checked before any
 // mutation, so a foreign key settles nothing at all. [PTJA-P1-F16]
 const claimed=await db.prepare("SELECT booking_id FROM stay_payment_events WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
 if(claimed&&String(claimed.booking_id)!==bookingId)throw new Response("An idempotency key settles one booking; this key already settled a different one",{status:409});
 const existing=await getStayPaymentSchedule(db,bookingId);
 if(!existing)throw new Response("No split payment schedule exists for this booking",{status:404});
 if(existing.status==="paid")return{schedule:existing,duplicatePrevented:true};
 const now=Date.now(),paymentRef=`SBX-BAL-${crypto.randomUUID().slice(0,10).toUpperCase()}`;
 // Atomic transition: only one caller can move pending/overdue -> paid.
 const updated=await db.prepare("UPDATE stay_payment_schedules SET status='paid',paid_at=?,payment_ref=?,updated_at=? WHERE booking_id=? AND status IN ('pending_balance','overdue')").bind(now,paymentRef,now,bookingId).run();
 if(!Number(updated.meta.changes)){const race=await getStayPaymentSchedule(db,bookingId);if(race?.status==="paid")return{schedule:race,duplicatePrevented:true};throw new Response("Stay balance could not be captured",{status:409});}
 try{
  await db.prepare("INSERT INTO stay_payment_events (id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(`SPE-${crypto.randomUUID().slice(0,12).toUpperCase()}`,bookingId,"balance_captured",input.actorId,idempotencyKey,JSON.stringify({paymentRef,sandbox:true}),now).run();
 }catch(error){
  // UNIQUE(idempotency_key) collision. Keep the paid state only if the row that owns the key is THIS
  // booking's - otherwise a key claimed between the check above and here belongs to somebody else.
  if(!(error instanceof Error&&/UNIQUE/i.test(error.message)))throw error;
  const owner=await db.prepare("SELECT booking_id FROM stay_payment_events WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if(owner&&String(owner.booking_id)!==bookingId){await db.prepare("UPDATE stay_payment_schedules SET status=?,paid_at=NULL,payment_ref=NULL,updated_at=? WHERE booking_id=? AND payment_ref=?").bind(existing.status,Date.now(),bookingId,paymentRef).run();throw new Response("An idempotency key settles one booking; this key already settled a different one",{status:409});}
 }
 const schedule=await getStayPaymentSchedule(db,bookingId);
 return{schedule:schedule!,duplicatePrevented:false};
}

/** Mark schedules whose balance-due time has passed as overdue. Returns the affected bookings so
 *  callers (ops alerts / cron) can act. Idempotent — already-overdue rows are untouched. */
export async function sweepOverdueStayBalances(db:Db,now=Date.now()):Promise<{marked:number;overdue:StayPaymentSchedule[]}>{
 await ensureStayPaymentTables(db);
 const result=await db.prepare("UPDATE stay_payment_schedules SET status='overdue',updated_at=? WHERE status='pending_balance' AND balance_due_at<?").bind(now,now).run();
 const rows=await db.prepare("SELECT * FROM stay_payment_schedules WHERE status='overdue' ORDER BY balance_due_at ASC").all<Row>();
 return{marked:Number(result.meta.changes||0),overdue:rows.results.map(rowToSchedule)};
}
