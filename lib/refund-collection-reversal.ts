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

const refundCaseTableReady=new WeakSet<Db>();
/**
 * booking_refund_cases with the columns an approved service refund writes. The DDL the Boarding module has
 * always run, shared so Pet Sitting, Pet Taxi and Training can open the same canonical cases.
 */
export async function ensureCanonicalRefundCaseTable(db:Db){
  if(refundCaseTableReady.has(db))return;
  await db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  for(const column of["approved_by TEXT","policy_json TEXT NOT NULL DEFAULT '{}'"])await db.prepare(`ALTER TABLE booking_refund_cases ADD COLUMN ${column}`).run().catch((error:unknown)=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
  refundCaseTableReady.add(db);
}

/**
 * An approved service refund (Boarding, Pet Sitting, Pet Taxi, Training) is also a canonical refund case, so BCC, the
 * Finance queues, P&L and the refund webhook see it (STAFF-05). Staff approval already happened, so the case
 * is approved, but it is not automatic: nothing is sent to the gateway on its own. Same id as the service's
 * refund ledger row.
 */
export function approvedServiceRefundCase(db:Db,input:{refundId:string;bookingId:string;amount:number;reason:string;requestedBy:string;approvedBy:string;service:string;cancellationRequestId:string;policySource:string;now:number}){
  return db.prepare("INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,policy_json,created_at,updated_at) VALUES (?,?,(SELECT id FROM booking_payments WHERE booking_id=?),?,?,'approved',?,?,?,?,?)")
    .bind(input.refundId,input.bookingId,input.bookingId,input.amount,input.reason,input.requestedBy,input.approvedBy,JSON.stringify({automatic:false,requiresApproval:false,policySource:input.policySource,service:input.service,cancellationRequestId:input.cancellationRequestId}),input.now,input.now);
}

/** The service refund ledgers whose staff-typed reference records a refund. */
export type ServiceRefundLedger="boarding_refund_ledger"|"sitting_refund_ledger"|"taxi_refund_ledger";
const SERVICE_REFUND_LEDGERS:ReadonlySet<string>=new Set<ServiceRefundLedger>(["boarding_refund_ledger","sitting_refund_ledger","taxi_refund_ledger"]);

/**
 * Records a service's pending refund under the reference Finance typed, through the same canonical chain for
 * every service: the canonical case (opened now for a refund approved before cases existed) is processed,
 * the collection ledger reverses the collection, reconciliation, the booking payment and the timeline
 * follow, and the service ledger row turns sandbox_recorded in the same batch. Pet Sitting and Pet Taxi
 * refunds used to stop at their own ledger, so the books, reconciliation and the payment status never
 * saw them. `collected` is the service's own collected figure for a booking with no reconciliation row.
 */
export async function recordServiceLedgerRefund(db:Db,input:{ledger:ServiceRefundLedger;service:string;refund:Row;cancellation:Row|null;reference:string;actorId:string;policySource:string;fallbackReason:string;collected?:number;now:number}){
  if(!SERVICE_REFUND_LEDGERS.has(input.ledger))throw new Error("Unknown service refund ledger");
  await ensureCanonicalRefundCaseTable(db);
  const refundId=text(input.refund.id),createdBy=text(input.refund.created_by);
  await approvedServiceRefundCase(db,{refundId,bookingId:text(input.refund.booking_id),amount:Number(input.refund.amount),reason:text(input.cancellation?.decision_reason)||input.fallbackReason,
    requestedBy:text(input.cancellation?.requested_by)||createdBy,approvedBy:text(input.cancellation?.decision_by)||createdBy,service:input.service,
    cancellationRequestId:text(input.refund.cancellation_request_id),policySource:input.policySource,now:input.now}).run();
  try{
    return await recordStaffConfirmedRefund(db,{refundCaseId:refundId,reference:input.reference,actorId:input.actorId,collected:input.collected,
      statements:[db.prepare(`UPDATE ${input.ledger} SET status='sandbox_recorded',reference=?,updated_at=? WHERE id=? AND status='sandbox_pending'`).bind(input.reference,input.now,refundId)]});
  }catch(error){if(error instanceof Response)throw error;throw new Response(`The refund could not be recorded: ${error instanceof Error?error.message:String(error)}`,{status:409});}
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
export async function recordStaffConfirmedRefund(db:Db,input:{refundCaseId:string;reference:string;actorId:string;statements?:D1PreparedStatement[];collected?:number}){
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
    if(text(row.gateway_reference)!==reference)throw new Error("This refund was already processed under another reference");
    // Already in the books (the gateway's refund.processed settled the case first): only the service's own
    // ledger still has to say so. Its statements are guarded, so a replay changes nothing.
    if(input.statements?.length)await db.batch(input.statements);
    return{duplicate:true as const,refundCaseId:text(row.id)};
  }
  const paymentId=text(row.payment_id)||text(row.canonical_payment_id),bookingId=text(row.booking_id),amount=money(row.amount);
  if(!paymentId)throw new Error("Refund recording requires the canonical payment");
  if(amount<=0)throw new Error("Refund recording requires a positive refund amount");
  // One reference is one refund, across every service: the reversal is keyed by it, so a second refund recorded
  // under the same reference would be counted as already posted and never reach the books.
  const reused=await db.prepare("SELECT id FROM booking_refund_cases WHERE gateway_reference=? AND id<>? LIMIT 1").bind(reference,text(row.id)).first<Row>();
  if(reused)throw new Error("Refund reference was already used for another refund");
  const now=Date.now();
  // A booking paid outside the gateway has no reconciliation row yet; its collected cash still bounds the refund.
  const capturedCurrent=row.captured_amount!=null?money(row.captured_amount):Number.isFinite(input.collected)?money(input.collected):await collectedForBooking(db,bookingId);
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
