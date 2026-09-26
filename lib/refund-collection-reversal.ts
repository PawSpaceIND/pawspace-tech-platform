import{postCollectionEvent,prepareCollectionEventPosting}from"./collection-ledger";
import{ensurePaymentReconciliationTables,processedRefundStatements}from"./grooming-payment-reconciliation";
import{collectedForBooking}from"./collected-funds";

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

/**
 * A refund that Finance paid back outside the gateway webhook (Boarding records its refund reference by
 * hand) commits the same facts a refund.processed webhook does, in one batch with the service's own ledger
 * update: the canonical refund case is processed, the collection ledger reverses the collection under the
 * refund reference, reconciliation and the booking payment follow, and the booking timeline records it.
 * Keyed by the reference, so the gateway's own refund.processed for the same refund is later recognised
 * as already counted instead of posting twice. Without this, an approved and recorded Boarding refund never
 * reached the finance journal, payment reconciliation, the booking payment status, BCC or the customer.
 */
export async function recordStaffConfirmedRefund(db:Db,input:{refundCaseId:string;reference:string;actorId:string;statements?:D1PreparedStatement[]}){
  const reference=text(input.reference);
  if(!reference)throw new Error("A refund reference is required");
  await ensurePaymentReconciliationTables(db);
  const row=await db.prepare(`SELECT r.id,r.booking_id,r.payment_id,r.amount,r.status,r.gateway_reference,b.customer_id,b.city_id,b.service_code,
      p.id canonical_payment_id,p.customer_id payment_customer_id,p.method payment_method,p.currency,p.amount payment_amount,
      rec.captured_amount,rec.environment
    FROM booking_refund_cases r
    JOIN canonical_bookings b ON b.id=r.booking_id
    LEFT JOIN booking_payments p ON p.booking_id=r.booking_id
    LEFT JOIN payment_reconciliation_records rec ON rec.payment_id=p.id
    WHERE r.id=?`).bind(input.refundCaseId).first<Row>();
  if(!row)throw new Error("Canonical refund case not found");
  if(["processed","completed"].includes(text(row.status))){
    if(text(row.gateway_reference)===reference)return{duplicate:true as const,refundCaseId:text(row.id)};
    throw new Error("This refund was already processed under another reference");
  }
  const paymentId=text(row.payment_id)||text(row.canonical_payment_id),bookingId=text(row.booking_id),amount=money(row.amount);
  if(!paymentId)throw new Error("Refund recording requires the canonical payment");
  if(amount<=0)throw new Error("Refund recording requires a positive refund amount");
  const now=Date.now();
  // A booking paid outside the gateway has no reconciliation row yet; its collected cash still bounds the refund.
  const capturedCurrent=row.captured_amount==null?await collectedForBooking(db,bookingId):money(row.captured_amount);
  const ledger=await prepareCollectionEventPosting(db,{
    event:"refund_completed",bookingId,customerId:text(row.payment_customer_id)||text(row.customer_id)||null,
    cityId:text(row.city_id)||null,serviceCode:text(row.service_code)||null,paymentId,refundReference:reference,amount,
    paymentMethod:text(row.payment_method)||null,refundInstrument:text(row.payment_method).toLowerCase()==="cash"?"cash":"gateway",
    entryDate:new Date(now).toISOString().slice(0,10),transactionAt:now,actorId:input.actorId,manualEntry:true,
  });
  if(!ledger.posted&&!ledger.duplicatePrevented)throw new Error("Refund ledger posting was not permitted by the collection policy");
  await db.batch([
    ...(input.statements??[]),
    ...ledger.statements,
    ...processedRefundStatements(db,{bookingId,paymentId,refundCaseId:text(row.id),gatewayRefundId:reference,eventId:`staff-refund:${reference}`,
      provider:"razorpay",environment:text(row.environment)||"sandbox",expected:money(row.payment_amount),capturedCurrent,currency:text(row.currency)||"INR",now}),
    db.prepare("INSERT OR IGNORE INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,'refund_processed','payment',?,?,?,?)")
      .bind(`PAYREF-staff-${reference}`,bookingId,bookingId,input.actorId,JSON.stringify({gateway:"staff_recorded",gatewayRefundId:reference,amount,refundCaseId:text(row.id)}),now),
  ]);
  return{duplicate:false as const,refundCaseId:text(row.id),paymentId,amount,ledger:{posted:ledger.posted,groupKey:ledger.groupKey,verificationStatus:ledger.verificationStatus}};
}
