import{ensurePaymentReconciliationTables,listPaymentExceptions}from"./grooming-payment-reconciliation";
import{FINANCE_SERVICES,type FinanceServiceCode}from"./finance-services";

/**
 * Read-only Finance views over the canonical money trail, for every service in one place.
 *
 * /team/finance listed Grooming bookings only (its ledger read WHERE service_code='grooming'), and the open
 * payment exceptions - over-collection, refund overage, a capture Razorpay took that no booking owns - plus
 * captures stuck in the webhook inbox or in their post-commit work were visible only through the API. These
 * reads feed the Finance home and /team/finance/reconciliation. Nothing here writes.
 */
type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const round2=(value:number)=>Math.round(value*100)/100;

const SERVICE_CODES:readonly string[]=FINANCE_SERVICES.map(service=>service.code);

/** Reconciliation states Finance has to look at. partially_captured (a deposit paid, the balance not yet due) is normal. */
export const RECONCILIATION_ATTENTION_STATES=["over_collected","refund_overage","amount_mismatch","exception","pending_refund"] as const;
const COLLECTED=["captured","paid","partially_refunded","refunded"];
const CAPTURE_EVENTS="('payment.captured','order.paid','payment_link.paid')";
/** A webhook younger than this may still be in flight; the capture saga retries every minute, so give it ten. */
export const WEBHOOK_SETTLE_MS=2*60_000;
export const CAPTURE_EFFECTS_GRACE_MS=10*60_000;

async function tablesPresent(db:Db,names:string[]){
  const rows=await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map(()=>"?").join(",")})`).bind(...names).all<Row>();
  return new Set(rows.results.map(row=>text(row.name)));
}
const inList=(values:readonly string[])=>values.map(value=>`'${value}'`).join(",");

/**
 * The newest bookings of every service (or one service) with their payment state: the booking_payments row,
 * the split or booking-fee schedule, what the gateway captured and refunded, the reconciliation status, open
 * exceptions and the invoice. Totals per service cover every booking, not only the rows listed.
 */
export async function listFinanceBookingPayments(db:Db,input:{service?:FinanceServiceCode|null;limit?:number}={}){
  await ensurePaymentReconciliationTables(db);
  const limit=Math.max(1,Math.min(300,Math.trunc(Number(input.limit)||200)));
  const services=input.service?[input.service]:[...SERVICE_CODES];
  const tables=await tablesPresent(db,["canonical_bookings","booking_payments","booking_invoices","stay_payment_schedules","taxi_payment_schedules"]);
  if(!tables.has("canonical_bookings")||!tables.has("booking_payments"))return{services:[],items:[],openExceptions:0,limit};
  const stay=tables.has("stay_payment_schedules"),taxi=tables.has("taxi_payment_schedules"),invoices=tables.has("booking_invoices");
  const where=`b.service_code IN (${services.map(()=>"?").join(",")})`;
  const [list,totals,open]=await Promise.all([
    db.prepare(`SELECT b.id booking_id,b.service_code,b.package_name,b.status booking_status,b.total_amount,b.currency,b.scheduled_start,b.updated_at,
        p.id payment_id,p.status payment_status,p.mode payment_mode,p.amount payment_amount,p.amount_due_now,
        r.captured_amount,r.refunded_amount,r.gateway_status,r.reconciliation_status,r.variance_amount,
        COALESCE(x.open_exceptions,0) open_exceptions,
        ${invoices?"(SELECT i.invoice_number FROM booking_invoices i WHERE i.booking_id=b.id ORDER BY i.created_at LIMIT 1)":"NULL"} invoice_number,
        ${stay?"s.status":"NULL"} stay_schedule_status,${stay?"s.balance_amount":"NULL"} stay_balance,
        ${taxi?"t.status":"NULL"} taxi_schedule_status,${taxi?"t.balance_amount":"NULL"} taxi_balance
      FROM canonical_bookings b
      LEFT JOIN booking_payments p ON p.booking_id=b.id
      LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id
      LEFT JOIN (SELECT payment_id,COUNT(*) open_exceptions FROM payment_reconciliation_exceptions WHERE status='open' AND payment_id IS NOT NULL GROUP BY payment_id) x ON x.payment_id=p.id
      ${stay?"LEFT JOIN stay_payment_schedules s ON s.booking_id=b.id":""}
      ${taxi?"LEFT JOIN taxi_payment_schedules t ON t.booking_id=b.id":""}
      WHERE ${where} ORDER BY b.updated_at DESC,b.id LIMIT ?`).bind(...services,limit).all<Row>(),
    db.prepare(`SELECT b.service_code,COUNT(*) bookings,
        SUM(CASE WHEN p.status IN (${inList(COLLECTED)}) THEN 1 ELSE 0 END) paid_bookings,
        ROUND(COALESCE(SUM(r.captured_amount),0),2) captured,ROUND(COALESCE(SUM(r.refunded_amount),0),2) refunded,
        SUM(CASE WHEN r.reconciliation_status IN (${inList(RECONCILIATION_ATTENTION_STATES)}) THEN 1 ELSE 0 END) attention
      FROM canonical_bookings b LEFT JOIN booking_payments p ON p.booking_id=b.id LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id
      WHERE ${where} GROUP BY b.service_code`).bind(...services).all<Row>(),
    db.prepare("SELECT COUNT(*) n FROM payment_reconciliation_exceptions WHERE status='open'").first<Row>(),
  ]);
  const byService=new Map(totals.results.map(row=>[text(row.service_code),row]));
  const items=list.results.map(row=>{
    const scheduleStatus=text(row.stay_schedule_status)||text(row.taxi_schedule_status)||null;
    const balance=row.stay_schedule_status!=null?Number(row.stay_balance||0):row.taxi_schedule_status!=null?Number(row.taxi_balance||0):null;
    const captured=row.captured_amount==null?null:round2(Number(row.captured_amount)),refunded=row.refunded_amount==null?null:round2(Number(row.refunded_amount));
    return{bookingId:text(row.booking_id),serviceCode:text(row.service_code),packageName:text(row.package_name),bookingStatus:text(row.booking_status),
      scheduledStart:text(row.scheduled_start)||null,bookingTotal:round2(Number(row.total_amount||0)),currency:text(row.currency)||"INR",updatedAt:Number(row.updated_at||0),
      paymentId:text(row.payment_id)||null,paymentStatus:text(row.payment_status)||null,paymentMode:text(row.payment_mode)||null,
      amountDueNow:row.amount_due_now==null?null:round2(Number(row.amount_due_now)),
      scheduleStatus,balanceAmount:balance==null?null:round2(balance),
      capturedAmount:captured,refundedAmount:refunded,netCollected:captured==null?null:round2(Math.max(0,captured-(refunded??0))),
      gatewayStatus:text(row.gateway_status)||null,reconciliationStatus:text(row.reconciliation_status)||null,varianceAmount:row.variance_amount==null?null:round2(Number(row.variance_amount)),
      openExceptions:Number(row.open_exceptions||0),invoiceNumber:text(row.invoice_number)||null};
  });
  return{
    services:services.map(code=>{const row=byService.get(code),meta=FINANCE_SERVICES.find(service=>service.code===code)!;return{code,label:meta.label,workspace:meta.workspace,
      bookings:Number(row?.bookings||0),paidBookings:Number(row?.paid_bookings||0),captured:round2(Number(row?.captured||0)),refunded:round2(Number(row?.refunded||0)),attention:Number(row?.attention||0)};}),
    items,openExceptions:Number(open?.n||0),limit,
  };
}

/**
 * Everything Finance has to clear, read-only: the payment exceptions (open by default), reconciliation records in
 * a state that needs a person, capture webhooks FAILED, DEFERRED or stuck in flight, and verified captures whose
 * post-commit work (collection posting, confirmation, timeline) has not finished after its grace period.
 */
export async function paymentReconciliationOverview(db:Db,input:{status?:string;now?:number}={}){
  await ensurePaymentReconciliationTables(db);
  const now=input.now??Date.now();
  const exceptions=await listPaymentExceptions(db,{status:input.status});
  const tables=await tablesPresent(db,["canonical_bookings","gateway_webhook_events","financial_outbox"]);
  const bookings=tables.has("canonical_bookings");
  const attention=await db.prepare(`SELECT r.payment_id,r.booking_id,r.expected_amount,r.captured_amount,r.refunded_amount,r.gateway_status,r.reconciliation_status,r.variance_amount,r.updated_at,
      ${bookings?"b.service_code,b.package_name,b.status booking_status":"NULL service_code,NULL package_name,NULL booking_status"}
    FROM payment_reconciliation_records r ${bookings?"LEFT JOIN canonical_bookings b ON b.id=r.booking_id":""}
    WHERE r.reconciliation_status IN (${inList(RECONCILIATION_ATTENTION_STATES)}) ORDER BY r.updated_at DESC LIMIT 200`).all<Row>();
  const payload=(path:string)=>`CASE WHEN json_valid(w.raw_payload) THEN json_extract(w.raw_payload,'${path}') END`;
  const webhooks=tables.has("gateway_webhook_events")?(await db.prepare(`SELECT q.*,
      EXISTS (SELECT 1 FROM payment_gateway_events e WHERE e.provider='razorpay' AND e.processing_status='processed' AND e.event_type IN ${CAPTURE_EVENTS}
        AND ((COALESCE(q.gateway_payment_id,'')<>'' AND e.gateway_payment_id=q.gateway_payment_id) OR (COALESCE(q.gateway_order_id,'')<>'' AND e.gateway_order_id=q.gateway_order_id))) capture_recorded
    FROM (SELECT w.id,w.event_id,w.event_type,w.environment,w.processing_status,w.failure_reason,w.received_at,w.processed_at,
        COALESCE(${payload("$.payload.payment.entity.order_id")},${payload("$.payload.order.entity.id")}) gateway_order_id,
        ${payload("$.payload.payment.entity.id")} gateway_payment_id,
        COALESCE(${payload("$.payload.payment.entity.amount")},${payload("$.payload.order.entity.amount_paid")}) amount_subunits,
        COALESCE(${payload("$.payload.payment.entity.notes.booking_id")},${payload("$.payload.order.entity.notes.booking_id")},${payload("$.payload.payment_link.entity.notes.booking_id")}) claimed_booking_id
      FROM gateway_webhook_events w
      WHERE w.provider='razorpay' AND w.event_type IN ${CAPTURE_EVENTS}
        AND (w.processing_status IN ('FAILED','DEFERRED') OR (w.processing_status IN ('RECEIVED','PROCESSING') AND w.received_at<?))
      ORDER BY w.received_at DESC LIMIT 100) q`).bind(now-WEBHOOK_SETTLE_MS).all<Row>()).results:[];
  const effects=tables.has("financial_outbox")?(await db.prepare(`SELECT id,status,attempts,last_error,created_at,updated_at,next_attempt_at,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.bookingId') END booking_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.gatewayPaymentId') END gateway_payment_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.amountPaise') END amount_paise
    FROM financial_outbox WHERE event_type='RAZORPAY_CAPTURE_POST_COMMIT' AND status<>'SUCCEEDED' AND created_at<?
    ORDER BY created_at DESC LIMIT 100`).bind(now-CAPTURE_EFFECTS_GRACE_MS).all<Row>()).results:[];
  const records=attention.results.map(row=>({paymentId:text(row.payment_id),bookingId:text(row.booking_id),serviceCode:text(row.service_code)||null,packageName:text(row.package_name)||null,bookingStatus:text(row.booking_status)||null,
    expectedAmount:round2(Number(row.expected_amount||0)),capturedAmount:round2(Number(row.captured_amount||0)),refundedAmount:round2(Number(row.refunded_amount||0)),
    gatewayStatus:text(row.gateway_status),reconciliationStatus:text(row.reconciliation_status),varianceAmount:round2(Number(row.variance_amount||0)),updatedAt:Number(row.updated_at||0)}));
  const stuckWebhooks=webhooks.map(row=>({id:text(row.id),eventId:text(row.event_id),eventType:text(row.event_type),environment:text(row.environment),status:text(row.processing_status),failureReason:text(row.failure_reason)||null,
    receivedAt:Number(row.received_at||0),gatewayOrderId:text(row.gateway_order_id)||null,gatewayPaymentId:text(row.gateway_payment_id)||null,
    amount:row.amount_subunits==null?null:round2(Number(row.amount_subunits)/100),claimedBookingId:text(row.claimed_booking_id)||null,captureRecorded:Number(row.capture_recorded||0)===1}));
  const pendingEffects=effects.map(row=>({id:text(row.id),status:text(row.status),attempts:Number(row.attempts||0),lastError:text(row.last_error)||null,createdAt:Number(row.created_at||0),
    nextAttemptAt:Number(row.next_attempt_at||0),bookingId:text(row.booking_id)||null,gatewayPaymentId:text(row.gateway_payment_id)||null,amount:row.amount_paise==null?null:round2(Number(row.amount_paise)/100)}));
  const open=exceptions.filter(item=>item.status==="open");
  return{
    generatedAt:now,
    summary:{openExceptions:open.length,criticalExceptions:open.filter(item=>item.severity==="critical").length,
      overCollected:records.filter(item=>item.reconciliationStatus==="over_collected").length,refundOverage:records.filter(item=>item.reconciliationStatus==="refund_overage").length,
      needsAttention:records.length,stuckWebhooks:stuckWebhooks.length,uncountedCaptures:stuckWebhooks.filter(item=>!item.captureRecorded).length,pendingCaptureEffects:pendingEffects.length},
    exceptions,records,stuckCaptures:{webhooks:stuckWebhooks,effects:pendingEffects},
  };
}
