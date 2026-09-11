import{creditBreakdownAppliedToBooking}from"./booking-credit-application";

/**
 * How much is payable RIGHT NOW for a booking — the amount a gateway order must be opened for.
 *
 * PawSpace has two monetary concepts and the canonical layer models both:
 *
 *   booking_payments.amount           the whole booking is worth this
 *   booking_payments.amount_due_now   this instalment is payable now
 *
 * lib/payment-order-intent.ts collapsed them by reading `amount`, so a 50/50 stay worth Rs 10,000
 * opened a Razorpay order for Rs 10,000 instead of the Rs 5,000 due. The adapter converts with
 * `Math.round(amount * 100)`, so this reached the real gateway order, not just a screen.
 *
 * A split booking has THREE stages, and the fix is wrong if it collapses them a different way:
 *
 *   full                  no split schedule: the instalment due now IS the whole price
 *   first_instalment      the split's first payment has not been captured yet -> pay the due-now part
 *   outstanding_balance   the first payment is captured and the schedule still owes the rest ->
 *                         pay the BALANCE, not the due-now amount again and not the total
 *   settled               nothing is outstanding
 *
 * The stage comes from state the platform already keeps: `booking_payments.status` for whether the
 * first instalment has been captured, and `stay_payment_schedules` (written at booking creation by
 * app/api/canonical-bookings and app/api/sitting-bookings) for what the split owes. Nothing new is
 * stored, and no amount is recomputed from a price.
 */
type Db=D1Database;
type Row=Record<string,unknown>;

export type PaymentStage="full"|"first_instalment"|"outstanding_balance"|"settled";
export type PaymentStageAmount={stage:PaymentStage;dueNow:number;bookingTotal:number;outstandingBalance:number;currency:string;paymentId:string;paymentStatus:string;creditsApplied:number;walletCreditApplied:number;pawPointsCreditApplied:number};

/** booking_payments.status values meaning that instalment's money is in. */
const CAPTURED=["captured","refunded","partially_refunded"];

const round2=(value:number)=>Math.round(value*100)/100;
const money=(value:number)=>round2(Math.max(0,value));

/**
 * Resolves the current payment stage and its amount. Returns null when the booking has no canonical
 * payment record, so the caller can fail rather than invent a figure.
 */
export async function paymentStageAmount(db:Db,bookingId:string):Promise<PaymentStageAmount|null>{
 const payment=await db.prepare("SELECT id,amount,amount_due_now,currency,status FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>();
 if(!payment)return null;

 const bookingTotal=round2(Number(payment.amount||0));
 // booking_payments already stores the governed post-coupon/referral total. Only post-booking credits
 // are subtracted here, otherwise checkout would double-apply a coupon.
 const dueNowStored=Math.min(round2(Number(payment.amount_due_now||0)),bookingTotal);
 const paymentStatus=String(payment.status||"");
 const firstCaptured=CAPTURED.includes(paymentStatus);
 const credits=await creditBreakdownAppliedToBooking(db,bookingId);
 const base={bookingBase:true,currency:String(payment.currency||"INR"),paymentId:String(payment.id),paymentStatus,bookingTotal,creditsApplied:credits.totalApplied,walletCreditApplied:credits.walletApplied,pawPointsCreditApplied:credits.pawPointsApplied};

 const staySchedule=await db.prepare("SELECT paid_now_amount,balance_amount,status,'stay' schedule_kind FROM stay_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 const taxiSchedule=staySchedule?null:await db.prepare("SELECT booking_fee_amount paid_now_amount,balance_amount,status,'taxi' schedule_kind FROM taxi_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 const schedule=staySchedule??taxiSchedule;
 if(!schedule){
  const stage:PaymentStage=firstCaptured?"settled":"full";
  const cashDue=firstCaptured?0:money(dueNowStored-credits.totalApplied);
  return{...base,stage,dueNow:cashDue,outstandingBalance:cashDue};
 }

 const balance=money(Number(schedule.balance_amount||0));
 const paidNow=money(Number(schedule.paid_now_amount||0));
 if(String(schedule.status)==="paid")return{...base,stage:"settled",dueNow:0,outstandingBalance:0};
 if(!firstCaptured){
  const stageBase=Math.min(paidNow||dueNowStored,bookingTotal);
  const cashDue=money(stageBase-Math.min(credits.totalApplied,stageBase));
  return{...base,stage:"first_instalment",dueNow:cashDue,outstandingBalance:balance};
 }
 // A credit used on the first instalment must not be used again on the balance. The gateway
 // reconciliation row is the durable proof of how much cash actually funded the first stage.
 const recon=await db.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(payment.id).first<Row>().catch(()=>null);
 if(credits.totalApplied>0&&!recon)throw new Error("Credit-funded split payment requires a gateway reconciliation record before another order can be opened");
 const capturedCash=money(Number(recon?.captured_amount??paidNow));
 const firstCash=Math.min(paidNow,capturedCash);
 const creditsUsedFirst=Math.min(credits.totalApplied,money(paidNow-firstCash));
 const remainingCredits=money(credits.totalApplied-creditsUsedFirst);
 const cashTowardBalance=money(capturedCash-firstCash);
 const cashDue=money(balance-remainingCredits-cashTowardBalance);
 return{...base,stage:"outstanding_balance",dueNow:cashDue,outstandingBalance:cashDue};
}
