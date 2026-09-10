import{paymentStageAmount}from"./payment-stage-amount";

type Db=D1Database;
type Row=Record<string,unknown>;

const round2=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
const money=(value:number)=>round2(Math.max(0,value));

export async function verifyCurrentPaymentStageCaptureAmount(
 db:Db,
 input:{bookingId:string;storedExpected:number;receivedAmount:number}
){
 const storedExpected=round2(input.storedExpected);
 const received=round2(input.receivedAmount);
 const stage=await paymentStageAmount(db,input.bookingId);

 if(!stage)return{
  ok:false as const,
  reason:"payment_stage_missing",
  storedExpected,
  liveExpected:0,
  expectedForCapture:storedExpected,
  received,
  staleOrder:false,
  stage:null
 };

 const payment=await db.prepare(
  "SELECT amount,mode FROM booking_payments WHERE booking_id=?"
 ).bind(input.bookingId).first<Row>().catch(()=>null);

 let liveExpected=round2(stage.dueNow);
 const creditSensitive=stage.creditsApplied>0;

 // Pay-after-service keeps amount_due_now at zero until collection.
 // When credits exist, recompute its cash component from the booking value.
 if(
  creditSensitive &&
  stage.stage!=="settled" &&
  String(payment?.mode||"")==="pay_after_service"
 ){
  liveExpected=money(
   Number(payment?.amount??stage.bookingTotal)-stage.creditsApplied
  );
 }

 // Existing gateway orders remain authoritative when no post-booking credit changed
 // the amount. The live-stage comparison is specifically the stale-credit-order guard.
 const expectedForCapture=creditSensitive?liveExpected:storedExpected;
 const staleOrder=
  creditSensitive &&
  Math.abs(storedExpected-liveExpected)>0.009;

 const receivedMismatch=
  Math.abs(received-expectedForCapture)>0.009;

 return{
  ok:!staleOrder&&!receivedMismatch,
  reason:staleOrder
   ?"stale_order_amount_after_credit"
   :receivedMismatch
    ?"capture_amount_mismatch"
    :null,
  storedExpected,
  liveExpected,
  expectedForCapture,
  received,
  staleOrder,
  stage:stage.stage,
  creditsApplied:stage.creditsApplied,
  walletCreditApplied:stage.walletCreditApplied,
  pawPointsCreditApplied:stage.pawPointsCreditApplied
 };
}
