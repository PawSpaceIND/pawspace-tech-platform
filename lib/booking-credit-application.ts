/**
 * How much CREDIT has already been applied to a booking, across every credit instrument.
 *
 * Wallet credit and PawPoints each capped their own redemption against canonical_bookings.total_amount
 * and neither wrote the booking down, so a customer holding both could apply them to the same booking
 * and give themselves more discount than the order was worth: Rs 5,000 of wallet (Rs 4,545.45 spent plus
 * a Rs 454.55 bonus) plus Rs 1,000 of points against a Rs 5,000 booking - 120% of order value, from two
 * ordinary self-service calls with no staff involved. lib/unit-economics.ts then books the whole
 * Rs 6,000 as real discount against a Rs 5,000 GMV line, so contribution goes negative with nothing
 * flagging the over-application.
 *
 * The ceiling was never wrong; it was measured per instrument. This reads what the booking has ALREADY
 * received so each instrument can cap against what is still payable. Both ledgers are read defensively:
 * a missing table means that instrument has never been used, which is genuinely nothing applied - it
 * cannot mask a redemption, because a redemption would have created the table.
 *
 * The points rate lives here so both readers agree on one number without the two governance modules
 * having to import each other; lib/paw-points-governance.ts re-exports it under its own name.
 */
type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(value:number)=>Math.round(value*100)/100;

/** 1 point = Rs.0.50 off. */
export const REDEEM_RUPEE_PER_POINT=0.5;

/** Rupee value of the credit already applied to this booking, from every instrument. */
export async function creditsAppliedToBooking(db:Db,bookingId:string){
 const wallet=await db.prepare("SELECT COALESCE(SUM(applied_value),0) total FROM pawspace_wallet_ledger WHERE entry_type='redeem' AND source_type='booking' AND source_id=?").bind(bookingId).first<Row>().catch(()=>null);
 const points=await db.prepare("SELECT COALESCE(SUM(-points),0) points FROM paw_points_ledger WHERE entry_type='redeemed' AND booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 return round2(Number(wallet?.total||0)+Number(points?.points||0)*REDEEM_RUPEE_PER_POINT);
}

/** What is still payable on a booking after the credit already applied to it. Never negative. */
export async function remainingPayableForCredit(db:Db,bookingId:string,bookingTotal:number){
 return round2(Math.max(0,round2(Number(bookingTotal||0))-await creditsAppliedToBooking(db,bookingId)));
}
