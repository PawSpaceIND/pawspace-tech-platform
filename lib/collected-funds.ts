/**
 * How much money a booking has ACTUALLY collected — the ceiling for any refund.
 *
 * A refund can only return money that was taken. Boarding and Pet Sitting capped approved refunds at
 * `canonical_bookings.total_amount` instead, so a cancellation could approve a refund for the full
 * price of a stay that had been paid in half, paid not at all, or whose payment attempt failed. Taxi,
 * Walking and Food already compare against captured value; this is that same invariant, in one place,
 * so the five services cannot drift apart again.
 *
 * The collected figure is not a single column, which is why reading one was the mistake:
 *
 *   booking_payments.amount           the FULL booking price, whatever has been paid so far
 *   booking_payments.amount_due_now   the instalment taken at booking time (== amount when prepaid)
 *   booking_payments.status           'created' and 'failed' mean nothing was collected at all
 *   stay_payment_schedules            for a 50/50 split: what was paid now, what is still owed, and
 *                                     whether the balance has since been paid
 *
 * The schedule wins whenever it exists. It has to: lib/boarding-finance-governance.ts's date-change
 * path overwrites booking_payments.amount_due_now with the new full total, so on a split booking that
 * changed dates, that column reports more than was ever collected. lib/stay-split-payments.ts also
 * settles the balance without touching booking_payments at all, so that column reports less than was
 * collected once the balance is paid. Only the schedule knows both halves.
 */
type Db=D1Database;
type Row=Record<string,unknown>;

/**
 * booking_payments.status values that mean money changed hands. 'created' and 'failed' do not.
 * 'refunded' and 'partially_refunded' DO: money was collected before any of it went back, so a
 * reconciliation that excluded them would under-report real collections. Capping a NEW refund at that
 * collected value is still an upper bound — you can never return more than was taken.
 */
export const COLLECTED_PAYMENT_STATUSES=["captured","paid","refunded","partially_refunded"] as const;

const round2=(value:number)=>Math.round(value*100)/100;

/**
 * Money collected against this booking, in rupees. Zero when there is no payment row, when the payment
 * was never captured, or when the captured amount is zero — each of which must make any positive refund
 * impossible rather than merely unusual.
 */
export async function collectedForBooking(db:Db,bookingId:string):Promise<number>{
 const payment=await db.prepare("SELECT amount,amount_due_now,status FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 if(!payment)return 0;
 if(!COLLECTED_PAYMENT_STATUSES.includes(String(payment.status) as typeof COLLECTED_PAYMENT_STATUSES[number]))return 0;

 // A split booking's truth lives in its schedule: the first instalment always, plus the balance only
 // once it has actually been paid.
 const schedule=await db.prepare("SELECT paid_now_amount,balance_amount,status FROM stay_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 if(schedule){
  const paidNow=Number(schedule.paid_now_amount||0);
  const balance=String(schedule.status)==="paid"?Number(schedule.balance_amount||0):0;
  return Math.max(0,round2(paidNow+balance));
 }

 // Prepaid: the instalment due at booking IS the whole price. Bounded by `amount` so a mutated
 // due-now column can never report more than the booking is worth.
 const dueNow=Number(payment.amount_due_now||0),total=Number(payment.amount||0);
 return Math.max(0,round2(Math.min(dueNow,total)));
}
