import{postCollectionEvent}from"./collection-ledger";

type Db=D1Database;
type Row=Record<string,unknown>;

const text=(value:unknown)=>String(value??"").trim();
const money=(value:unknown)=>Math.round(Math.max(0,Number(value||0))*100)/100;

export type BookingRefundReversalInput={
  gatewayRefundId?:string|null;
  amountSubunits?:number|null;
  createdAt?:number|null;
};

/**
 * Bridges a verified Razorpay refund into the canonical collection ledger.
 *
 * The gateway refund id is the accounting identity. postCollectionEvent derives its durable group key
 * from refundReference, so an exact webhook replay, a logically duplicated Razorpay notification, or a
 * reconciliation retry can all call this safely without creating a second reversal.
 */
export async function postBookingRefundCollectionReversal(db:Db,input:BookingRefundReversalInput){
  const refundReference=text(input.gatewayRefundId);
  if(!refundReference)return{handled:false as const,reason:"refund_reference_missing"};

  const row=await db.prepare(`SELECT
      r.id refund_case_id,r.booking_id,r.payment_id,r.amount refund_amount,r.status refund_status,
      b.customer_id,b.city_id,b.service_code,
      p.customer_id payment_customer_id,p.method payment_method
    FROM booking_refund_cases r
    JOIN canonical_bookings b ON b.id=r.booking_id
    LEFT JOIN booking_payments p ON p.id=r.payment_id AND p.booking_id=r.booking_id
    WHERE r.gateway_reference=?
    ORDER BY r.created_at DESC LIMIT 1`)
    .bind(refundReference).first<Row>().catch(()=>null);
  if(!row)return{handled:false as const,reason:"booking_refund_case_not_found"};

  const expected=money(row.refund_amount);
  const received=Number.isFinite(Number(input.amountSubunits))?money(Number(input.amountSubunits)/100):expected;
  if(expected<=0)throw new Error("Refund ledger reversal requires a positive refund amount");
  if(Math.abs(received-expected)>0.009)throw new Error(`Refund ledger amount mismatch (${received} received, ${expected} expected)`);
  const paymentId=text(row.payment_id);
  if(!paymentId)throw new Error("Refund ledger reversal requires the canonical payment id");

  const transactionAt=Number.isFinite(Number(input.createdAt))&&Number(input.createdAt)>0?Number(input.createdAt):Date.now();
  const posted=await postCollectionEvent(db,{
    event:"refund_completed",
    bookingId:text(row.booking_id),
    customerId:text(row.payment_customer_id)||text(row.customer_id)||null,
    cityId:text(row.city_id)||null,
    serviceCode:text(row.service_code)||null,
    paymentId,
    refundReference,
    amount:expected,
    paymentMethod:text(row.payment_method)||null,
    refundInstrument:"gateway",
    entryDate:new Date(transactionAt).toISOString().slice(0,10),
    transactionAt,
    actorId:"razorpay_webhook",
  });
  return{handled:true as const,refundCaseId:text(row.refund_case_id),posted};
}
