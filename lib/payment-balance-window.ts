type Db=D1Database;
type Row=Record<string,unknown>;

/**
 * When the outstanding balance of a split booking may be paid, once its first instalment is captured.
 *
 *   Boarding / Pet Sitting (stay_payment_schedules)  the balance is due 24 h before the stay starts; paying it
 *                                                    earlier is allowed, so it is payable now with a due date.
 *   Pet Taxi ride (taxi_payment_schedules)           the final balance is only known after drop-off (waiting,
 *                                                    parking and cleaning adjustments), so it becomes payable
 *                                                    only once trip completion has recorded it as due.
 *
 * Without this, the customer booking page presented the balance as a fresh "Due now" right after the deposit
 * was captured, and a Pet Taxi balance could be paid before the trip and then raised again at completion.
 */
export type BalanceWindow={payable:boolean;dueAt:number|null;kind:"stay"|"taxi"|"other"};

const WINDOW_TABLES=["stay_payment_schedules","taxi_payment_schedules","taxi_trip_payment_events"];

/** Fails closed: a missing table means "no such schedule", but any query error propagates rather than
 *  falling through to a payable balance. */
export async function outstandingBalanceWindow(db:Db,bookingId:string):Promise<BalanceWindow>{
 const present=new Set(((await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${WINDOW_TABLES.map(()=>"?").join(",")})`).bind(...WINDOW_TABLES).all<Row>()).results||[]).map(row=>String(row.name)));
 const stay=present.has("stay_payment_schedules")?await db.prepare("SELECT * FROM stay_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>():null;
 if(stay){const dueAt=Number(stay.balance_due_at);return{payable:true,dueAt:Number.isFinite(dueAt)&&dueAt>0?dueAt:null,kind:"stay"};}
 const taxi=present.has("taxi_payment_schedules")?await db.prepare("SELECT booking_id FROM taxi_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>():null;
 if(taxi){
  const due=present.has("taxi_trip_payment_events")?await db.prepare("SELECT id FROM taxi_trip_payment_events WHERE booking_id=? AND status='due' LIMIT 1").bind(bookingId).first<Row>():null;
  return{payable:Boolean(due),dueAt:null,kind:"taxi"};
 }
 return{payable:true,dueAt:null,kind:"other"};
}
