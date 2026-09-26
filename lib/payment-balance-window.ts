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

async function optionalFirst(db:Db,sql:string,bookingId:string){
 return db.prepare(sql).bind(bookingId).first<Row>().catch(()=>null);
}

export async function outstandingBalanceWindow(db:Db,bookingId:string):Promise<BalanceWindow>{
 const stay=await optionalFirst(db,"SELECT balance_due_at FROM stay_payment_schedules WHERE booking_id=?",bookingId);
 if(stay){const dueAt=Number(stay.balance_due_at);return{payable:true,dueAt:Number.isFinite(dueAt)&&dueAt>0?dueAt:null,kind:"stay"};}
 const taxi=await optionalFirst(db,"SELECT status FROM taxi_payment_schedules WHERE booking_id=?",bookingId);
 if(taxi){
  const due=await optionalFirst(db,"SELECT id FROM taxi_trip_payment_events WHERE booking_id=? AND status='due' LIMIT 1",bookingId);
  return{payable:Boolean(due),dueAt:null,kind:"taxi"};
 }
 return{payable:true,dueAt:null,kind:"other"};
}
