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
import {creditsAppliedToBooking} from "./booking-credit-application";

type Db=D1Database;
type Row=Record<string,unknown>;

export type PaymentStage="full"|"first_instalment"|"outstanding_balance"|"settled";
export type PaymentStageAmount={stage:PaymentStage;dueNow:number;bookingTotal:number;outstandingBalance:number;currency:string;paymentId:string;paymentStatus:string;appliedCredits?:number};

/** booking_payments.status values meaning that instalment's money is in. */
const CAPTURED=["captured","refunded","partially_refunded"];

const round2=(value:number)=>Math.round(value*100)/100;

/**
 * Resolves the current payment stage and its amount. Returns null when the booking has no canonical
 * payment record, so the caller can fail rather than invent a figure.
 */
export async function paymentStageAmount(db:Db,bookingId:string):Promise<PaymentStageAmount|null>{
 const payment=await db.prepare("SELECT id,amount,amount_due_now,currency,status FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>();
 if(!payment)return null;

 const bookingTotal=round2(Number(payment.amount||0));
 // Bounded by the total: the Boarding date-change path rewrites amount_due_now, and an instalment can
 // never legitimately exceed the booking it belongs to.
 const dueNowStored=Math.min(round2(Number(payment.amount_due_now||0)),bookingTotal);
 const paymentStatus=String(payment.status||"");
 const firstCaptured=CAPTURED.includes(paymentStatus);
 // Credit ledgers preserve gross booking prices. Deduct their applied value once at the cash
 // boundary; do not subtract a wallet debit again (its bonus is already part of applied_value).
 const appliedCredits=await creditsAppliedToBooking(db,bookingId);
 if(!Number.isFinite(appliedCredits)||appliedCredits<0)throw new Error("Applied booking credit is invalid");
 const cashAfterCredits=(gross:number)=>round2(Math.max(0,gross-appliedCredits));
 const base={bookingBase:true,currency:String(payment.currency||"INR"),paymentId:String(payment.id),paymentStatus,bookingTotal,appliedCredits};

 const schedule=await db.prepare("SELECT paid_now_amount,balance_amount,status FROM stay_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 if(!schedule){
  // Full / prepaid. Once captured there is nothing left to collect.
  const stage:PaymentStage=firstCaptured?"settled":"full";
  return{...base,stage,dueNow:firstCaptured?0:cashAfterCredits(dueNowStored),outstandingBalance:firstCaptured?0:cashAfterCredits(dueNowStored)};
 }

 const balance=Math.max(0,round2(Number(schedule.balance_amount||0)));
 const paidNow=Math.max(0,round2(Number(schedule.paid_now_amount||0)));
 if(String(schedule.status)==="paid")return{...base,stage:"settled",dueNow:0,outstandingBalance:0};
 // The first instalment is still unpaid: charge the due-now half, never the total.
 if(!firstCaptured){
  const firstGross=Math.min(paidNow||dueNowStored,bookingTotal);
  const remainingCredit=Math.max(0,round2(appliedCredits-firstGross));
  return{...base,stage:"first_instalment",dueNow:cashAfterCredits(firstGross),outstandingBalance:round2(Math.max(0,balance-remainingCredit))};
 }
 // First instalment captured, balance still owed: charge the BALANCE. Reusing dueNow here is the second
 // defect this function exists to avoid.
 // Once cash has been captured, subtract TOTAL credits and ACTUAL captured cash from the gross
 // total. Subtracting the same credits from both instalments would undercharge the balance.
 // Legacy, no-credit balances retain their existing behaviour. Credit-adjusted balances require
 // capture evidence rather than assuming whether a credit was spent before or after instalment one.
 let cashBalance=balance;
 if(appliedCredits>0){
  const captured=await db.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(String(payment.id)).first<Row>();
  if(!captured||!Number.isFinite(Number(captured.captured_amount))||Number(captured.captured_amount)<0)
   throw new Error("Verified captured cash is required for a credit-adjusted balance");
  cashBalance=Math.min(balance,round2(Math.max(0,bookingTotal-appliedCredits-Number(captured.captured_amount))));
 }
 return{...base,stage:appliedCredits>0&&cashBalance===0?"settled":"outstanding_balance",dueNow:cashBalance,outstandingBalance:cashBalance};
}
