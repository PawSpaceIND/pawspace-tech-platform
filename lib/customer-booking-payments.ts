import{readPaymentStageSnapshots}from"./payment-stage-snapshot";
import{resolvePaymentStageAmount,type PaymentStage}from"./payment-stage-amount";
import{chunkedIn}from"./d1-chunked-in";

type Db=D1Database;
type Row=Record<string,unknown>;

/**
 * Payment state of the bookings Customer 360 shows for ONE customer (the /team/sales detail).
 * [round-2: Customer 360 showed booking counts but no booking list or payment state]
 *
 * Nothing is recomputed here. Booking amounts come from the snapshot and stage calculation customer
 * checkout and the booking command center already use (lib/payment-stage-snapshot.ts,
 * lib/payment-stage-amount.ts); a food order's state comes from its own food_order_payments row. It is
 * read for a single customer only, so the Customer 360 list read keeps the fan-out budget pinned by
 * tests/customer-360-fanout.test.mjs.
 */
export type BookingPaymentState={status:string;label:string;stage:PaymentStage|null;dueNow:number|null;outstandingBalance:number|null};
type Amounts={stage:PaymentStage|null;dueNow:number|null;outstandingBalance:number|null};

const inr=(value:number)=>`₹${value.toLocaleString("en-IN",{maximumFractionDigits:2})}`;
const FINAL_WORDS:Record<string,string>={refunded:"Refunded",partially_refunded:"Partly refunded",refund_pending:"Refund pending",cancelled:"Payment cancelled",authorized:"Authorised, not yet captured",partial:"Part paid"};
const AWAITING=new Set(["created","pending","payment_pending","order_linked","payment_link_created"]);

/** One short line a sales rep can read out to the customer. */
export function bookingPaymentLabel(state:{status:string}&Partial<Amounts>):string{
 const status=state.status.trim().toLowerCase(),due=Math.max(0,Number(state.dueNow||0)),balance=state.outstandingBalance==null?null:Math.max(0,Number(state.outstandingBalance));
 if(status==="none")return"No payment recorded";
 if(status==="unavailable")return"Payment state unavailable";
 if(status==="captured"||status==="paid"||status==="settled"){
  if(state.stage!=="outstanding_balance"||balance===0)return"Paid";
  return balance===null?"Part paid · balance due":`Part paid · ${inr(balance)} balance due`;
 }
 if(FINAL_WORDS[status])return FINAL_WORDS[status];
 if(status==="failed"||AWAITING.has(status)){
  const lead=status==="failed"?"Payment failed":"Awaiting payment";
  if(state.stage==="first_instalment"&&due>0)return`${lead} · ${inr(due)} due now${balance?`, ${inr(balance)} later`:""}`;
  return due>0?`${lead} · ${inr(due)} due`:lead;
 }
 return`Payment ${status.replaceAll("_"," ")||"status unknown"}`;
}

const missingTable=(error:unknown)=>/no such table/i.test(error instanceof Error?error.message:String(error));
const state=(status:string,amounts:Amounts={stage:null,dueNow:null,outstandingBalance:null}):BookingPaymentState=>({status,label:bookingPaymentLabel({status,...amounts}),...amounts});

export async function customerBookingPayments(db:Db,bookings:ReadonlyArray<{id:string;serviceCode:string}>):Promise<Map<string,BookingPaymentState>>{
 const out=new Map<string,BookingPaymentState>();
 // buildCustomer360 lists food orders in the same timeline as serviceCode "pet_food".
 const bookingIds=bookings.filter(item=>item.serviceCode!=="pet_food").map(item=>item.id),orderIds=bookings.filter(item=>item.serviceCode==="pet_food").map(item=>item.id);
 if(bookingIds.length){
  let snapshots:Awaited<ReturnType<typeof readPaymentStageSnapshots>>|null;
  // A database that never took a payment has no booking_payments table: nothing is recorded. Any
  // other read failure is reported as unavailable, never as "no payment".
  try{snapshots=await readPaymentStageSnapshots(db,bookingIds);}catch(error){snapshots=missingTable(error)?new Map():null;}
  for(const id of bookingIds){
   if(!snapshots){out.set(id,state("unavailable"));continue;}
   const snapshot=snapshots.get(id);
   if(!snapshot){out.set(id,state("none"));continue;}
   const status=String(snapshot.payment.status||"");
   try{
    const amount=resolvePaymentStageAmount(snapshot.payment,snapshot.schedule,snapshot.credits,snapshot.recon);
    out.set(id,state(status,{stage:amount.stage,dueNow:amount.dueNow,outstandingBalance:amount.outstandingBalance}));
   }catch{
    // The stage calculation refuses a credit-funded split without its reconciliation record. The
    // status still stands; the figure is left out rather than guessed.
    const open=Boolean(snapshot.schedule)&&String(snapshot.schedule?.status)!=="paid";
    out.set(id,state(status,{stage:open?"outstanding_balance":null,dueNow:null,outstandingBalance:null}));
   }
  }
 }
 if(orderIds.length){
  let rows:Row[]|null;
  try{rows=await chunkedIn(orderIds,async(slice,placeholders)=>(await db.prepare(`SELECT order_id,status FROM food_order_payments WHERE order_id IN (${placeholders})`).bind(...slice).all<Row>()).results||[]);}catch(error){rows=missingTable(error)?[]:null;}
  const byOrder=new Map((rows||[]).map(row=>[String(row.order_id),String(row.status||"")]));
  for(const id of orderIds)out.set(id,state(rows===null?"unavailable":byOrder.get(id)??"none"));
 }
 return out;
}
