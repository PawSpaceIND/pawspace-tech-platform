import{convertLeadOnPaymentCaptured}from"./lead-conversion-attribution";
import{cancelRecoveryEntitlements}from"./payment-recovery-governance";
import{activateSubscriptionOnCapture,failSubscriptionOnPaymentFailure}from"./subscription-payment-activation";
import{tryQualifyLinkedReferral}from"./referral-booking-governance";
import{createSandboxPaymentLink}from"./razorpay-client";

type Db=D1Database;
type Row=Record<string,unknown>;

export type GatewayEvent={provider:"razorpay";environment:"sandbox"|"live";eventId:string;eventType:string;bookingId?:string;gatewayOrderId?:string;gatewayPaymentLinkId?:string;gatewayPaymentId?:string;gatewayRefundId?:string;amountSubunits?:number;currency?:string;createdAt?:number;signatureVerified:boolean;payloadHash:string;detail?:Record<string,unknown>};

export async function ensurePaymentReconciliationTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS payment_gateway_links (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,payment_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,environment TEXT NOT NULL,gateway_order_id TEXT UNIQUE,gateway_payment_link_id TEXT UNIQUE,gateway_payment_id TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS payment_gateway_events (id TEXT PRIMARY KEY,provider TEXT NOT NULL,environment TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,booking_id TEXT,payment_id TEXT,gateway_order_id TEXT,gateway_payment_id TEXT,gateway_refund_id TEXT,amount_subunits INTEGER,currency TEXT,signature_verified INTEGER NOT NULL,payload_hash TEXT NOT NULL,processing_status TEXT NOT NULL DEFAULT 'received',failure_reason TEXT,detail_json TEXT NOT NULL DEFAULT '{}',received_at INTEGER NOT NULL,processed_at INTEGER,UNIQUE(provider,event_id))"),
  db.prepare("CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT NOT NULL,environment TEXT NOT NULL,expected_amount REAL NOT NULL,captured_amount REAL NOT NULL DEFAULT 0,refunded_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,gateway_status TEXT NOT NULL DEFAULT 'not_started',reconciliation_status TEXT NOT NULL DEFAULT 'pending',variance_amount REAL NOT NULL DEFAULT 0,last_event_id TEXT,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,event_id TEXT,exception_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),
  db.prepare("CREATE TABLE IF NOT EXISTS post_service_payment_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,payment_id TEXT NOT NULL,provider_id TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'awaiting_payment',payment_path TEXT NOT NULL,qr_payload TEXT NOT NULL,expires_at INTEGER NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);await ensurePaymentLinkColumn(db);}

async function ensurePaymentLinkColumn(db:Db){const columns=await db.prepare("PRAGMA table_info(payment_gateway_links)").all<Row>();if(!columns.results.some(row=>String(row.name)==="gateway_payment_link_id")){try{await db.prepare("ALTER TABLE payment_gateway_links ADD COLUMN gateway_payment_link_id TEXT").run();}catch(error){const refreshed=await db.prepare("PRAGMA table_info(payment_gateway_links)").all<Row>();if(!refreshed.results.some(row=>String(row.name)==="gateway_payment_link_id"))throw error;}}await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_gateway_links_payment_link ON payment_gateway_links(gateway_payment_link_id)").run();}

function postServiceMappingStatements(db:Db,input:{id:string;bookingId:string;paymentId:string;amount:number;currency:string;now:number}){return[
 db.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,gateway_payment_link_id,status,created_at,updated_at) SELECT ?,?,?,?, ?,?,'active',?,? WHERE EXISTS (SELECT 1 FROM post_service_payment_requests WHERE id=? AND booking_id=?) ON CONFLICT(booking_id) DO UPDATE SET gateway_payment_link_id=excluded.gateway_payment_link_id,provider=excluded.provider,environment=excluded.environment,status='active',updated_at=excluded.updated_at").bind(`PAYLINK-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.bookingId,input.paymentId,"razorpay","sandbox",input.id,input.now,input.now,input.id,input.bookingId),
 db.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) SELECT ?,?,?,?,?,0,0,?,'payment_link_created','pending',0,NULL,? WHERE EXISTS (SELECT 1 FROM post_service_payment_requests WHERE id=? AND booking_id=?) ON CONFLICT(payment_id) DO UPDATE SET gateway=excluded.gateway,environment=excluded.environment,expected_amount=excluded.expected_amount,currency=excluded.currency,gateway_status=CASE WHEN payment_reconciliation_records.gateway_status IN ('captured','refunded','partially_refunded') THEN payment_reconciliation_records.gateway_status ELSE 'payment_link_created' END,updated_at=excluded.updated_at").bind(input.paymentId,input.bookingId,"razorpay","sandbox",input.amount,input.currency,input.now,input.id,input.bookingId),
];}

/**
 * Creates the provider-shareable UAT request used for pay-after-service. This is deliberately not a
 * capture operation: only a signature-verified gateway event may move booking_payments to captured.
 */
export async function createPostServicePaymentRequest(db:Db,env:Record<string,unknown>,input:{bookingId:string;providerId:string;actorId:string}){
 await ensurePaymentReconciliationTables(db);
 const row=await db.prepare("SELECT b.status booking_status,b.provider_id,b.customer_id,p.id payment_id,p.amount,p.currency,p.status payment_status,p.mode FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").bind(input.bookingId).first<Row>();
 if(!row)throw new Error("Canonical booking payment was not found");
 if(String(row.provider_id)!==input.providerId)throw new Error("This booking is not assigned to this provider");
 if(String(row.booking_status)!=="completed")throw new Error("Post-service payment can be requested only after service completion");
 if(["captured","refunded","partially_refunded"].includes(String(row.payment_status)))throw new Error("This booking is already paid or refunded");
 if(String(row.mode)!=="pay_after_service")throw new Error("This booking is not configured for pay after service");
 const existing=await db.prepare("SELECT * FROM post_service_payment_requests WHERE booking_id=?").bind(input.bookingId).first<Row>();
 if(existing&&Number(existing.expires_at)>Date.now()){const now=Date.now();await db.batch(postServiceMappingStatements(db,{id:String(existing.id),bookingId:input.bookingId,paymentId:String(row.payment_id),amount:Number(row.amount||0),currency:String(row.currency||"INR"),now}));return paymentRequestView(existing,String(row.payment_status),now);}
 const requestedExpiresAt=Date.now()+24*60*60*1000;
 const paymentId=String(row.payment_id),referenceId=`${paymentId.slice(0,23)}-${crypto.randomUUID().replaceAll("-","").slice(0,16)}`;
 const link=await createSandboxPaymentLink(env,{bookingId:input.bookingId,paymentId,referenceId,customerId:String(row.customer_id),amount:Number(row.amount||0),currency:String(row.currency||"INR"),expiresAt:requestedExpiresAt});
 if(!link.connected)throw new Error(link.reason);
 const now=Date.now(),id=String(link.paymentLink.id),path=String(link.paymentLink.short_url),qrPayload=path,providerExpireBy=Number(link.paymentLink.expire_by),expiresAt=Number.isFinite(providerExpireBy)&&providerExpireBy>0?providerExpireBy*1000:requestedExpiresAt,amount=Number(row.amount||0),currency=String(row.currency||"INR");
 const requestStatement=existing
  ?db.prepare("UPDATE post_service_payment_requests SET id=?,payment_id=?,provider_id=?,amount=?,currency=?,status='awaiting_payment',payment_path=?,qr_payload=?,expires_at=?,created_by=?,created_at=?,updated_at=? WHERE booking_id=? AND expires_at<=?").bind(id,row.payment_id,input.providerId,amount,currency,path,qrPayload,expiresAt,input.actorId,now,now,input.bookingId,now)
  :db.prepare("INSERT INTO post_service_payment_requests (id,booking_id,payment_id,provider_id,amount,currency,status,payment_path,qr_payload,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'awaiting_payment',?,?,?,?,?,?)").bind(id,input.bookingId,row.payment_id,input.providerId,amount,currency,path,qrPayload,expiresAt,input.actorId,now,now);
 const results=await db.batch([requestStatement,...postServiceMappingStatements(db,{id,bookingId:input.bookingId,paymentId:String(row.payment_id),amount,currency,now})]);
 if(Number(results[0]?.meta?.changes||0)!==1){const winner=await db.prepare("SELECT * FROM post_service_payment_requests WHERE booking_id=?").bind(input.bookingId).first<Row>();if(winner)return paymentRequestView(winner,String(row.payment_status));throw new Error("Post-service payment request was not persisted");}
 return{id,bookingId:input.bookingId,amount,currency,status:"awaiting_payment",paymentStatus:String(row.payment_status),paymentPath:path,qrPayload,providerReference:id,collectable:expiresAt>now,expiresAt,sandboxOnly:true,liveCapture:false};
}

function paymentRequestView(row:Row,paymentStatus:string,now=Date.now()){const paymentPath=String(row.payment_path),expiresAt=Number(row.expires_at),settled=["captured","refunded","partially_refunded"].includes(paymentStatus),expired=!Number.isFinite(expiresAt)||expiresAt<=now;return{id:String(row.id),bookingId:String(row.booking_id),amount:Number(row.amount||0),currency:String(row.currency||"INR"),status:settled?paymentStatus:expired?"expired":String(row.status),paymentStatus,paymentPath,qrPayload:String(row.qr_payload),providerReference:String(row.id),collectable:!settled&&!expired&&paymentPath.startsWith("https://"),expiresAt,sandboxOnly:true,liveCapture:false};}

export async function getPostServicePaymentRequest(db:Db,input:{bookingId:string;providerId:string}){
 await ensurePaymentReconciliationTables(db);const row=await db.prepare("SELECT r.*,p.status payment_status FROM post_service_payment_requests r JOIN booking_payments p ON p.id=r.payment_id WHERE r.booking_id=? AND r.provider_id=?").bind(input.bookingId,input.providerId).first<Row>();return row?paymentRequestView(row,String(row.payment_status)):null;
}

const round2=(value:number)=>Math.round(value*100)/100;

/**
 * The 50/50 split schedule, when this booking has one. Read directly rather than through
 * lib/stay-split-payments so the webhook never runs DDL: if the table is absent there is no split.
 */
async function splitSchedule(db:Db,bookingId:string){
 return db.prepare("SELECT paid_now_amount,balance_amount,status FROM stay_payment_schedules WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
}

/**
 * The identity of the money, not of the notification.
 *
 * One gateway capture can arrive as several webhook events: Razorpay sends `payment.captured` AND
 * `order.paid` for a single payment, each with its own event id, so deduplication on event_id does not
 * merge them. What identifies the underlying capture is the gateway payment id (falling back to the
 * order id, then the event id when a provider sends neither).
 */
/**
 * Both references, because a provider does not always send both. `order.paid` can arrive carrying only
 * the order id while `payment.captured` for the SAME money carried a payment id, so matching on a single
 * preferred key would treat one capture as two. A prior capture counts as the same money if EITHER
 * reference matches. Each stage of a split opens its own order, so this cannot merge two real stages.
 */
function captureRefs(event:GatewayEvent){
 return [event.gatewayPaymentId,event.gatewayOrderId].map(value=>String(value||"")).filter(Boolean);
}

/**
 * The gateway captures already collected against this payment, as reference pairs. Derived from the
 * event log rather than stored, so there is one source of truth and no new table to keep in step.
 * `exceptRowId` excludes the event currently being processed.
 */
async function collectedCaptures(db:Db,paymentId:string,exceptRowId:string){
 const rows=await db.prepare("SELECT gateway_payment_id,gateway_order_id,event_id FROM payment_gateway_events WHERE payment_id=? AND event_type IN ('payment.captured','order.paid','payment_link.paid') AND processing_status='processed' AND id<>?")
   .bind(paymentId,exceptRowId).all<Row>().catch(()=>({results:[] as Row[]}));
 return rows.results.map(row=>({
  refs:[row.gateway_payment_id,row.gateway_order_id].map(value=>String(value||"")).filter(Boolean),
  eventId:String(row.event_id||""),
 }));
}

/** Distinct captures among a collected set: entries sharing any reference are the same money. */
function distinctCaptureCount(collected:Array<{refs:string[];eventId:string}>){
 const groups:string[][]=[];
 for(const item of collected){
  const key=item.refs.length?item.refs:[item.eventId];
  const existing=groups.find(group=>group.some(value=>key.includes(value)));
  if(existing)existing.push(...key);else groups.push([...key]);
 }
 return groups.length;
}

/**
 * Settle the split schedule when the gateway captures the outstanding balance.
 *
 * lib/stay-split-payments.payStayBalance does this for the sandbox path. The gateway path did not, so
 * after a real balance capture the schedule stayed `pending_balance` while booking_payments read
 * 'captured' — and that is exactly the state lib/payment-stage-amount reports as `outstanding_balance`
 * with a positive amount, so createBookingPaymentOrder would open ANOTHER balance order for a stay
 * that was fully paid. Same guarded transition and the same event trail as the sandbox path, so the
 * two cannot disagree, and keyed on the gateway event so a replay cannot record a second capture.
 */
async function settleStayBalance(db:Db,input:{bookingId:string;eventId:string;paymentRef:string|null;now:number}){
 const updated=await db.prepare("UPDATE stay_payment_schedules SET status='paid',paid_at=?,payment_ref=?,updated_at=? WHERE booking_id=? AND status IN ('pending_balance','overdue')")
   .bind(input.now,input.paymentRef??`GW-${input.eventId}`,input.now,input.bookingId).run().catch(()=>null);
 if(!updated||!Number(updated.meta?.changes||0))return false;
 try{
  await db.prepare("INSERT INTO stay_payment_events (id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(`SPE-${crypto.randomUUID().slice(0,12).toUpperCase()}`,input.bookingId,"balance_captured","razorpay_webhook",`gateway:${input.eventId}`,JSON.stringify({gateway:"razorpay",eventId:input.eventId,paymentRef:input.paymentRef}),input.now).run();
 }catch(error){
  if(!(error instanceof Error&&/UNIQUE/i.test(error.message)))throw error;
 }
 return true;
}

async function addException(db:Db,input:{bookingId?:string;paymentId?:string;eventId?:string;type:string;severity?:"warning"|"critical";detail:unknown}){await db.prepare("INSERT INTO payment_reconciliation_exceptions (id,booking_id,payment_id,event_id,exception_type,severity,status,detail_json,created_at) VALUES (?,?,?,?,?,?,'open',?,?)").bind(`PAYEX-${crypto.randomUUID().slice(0,12).toUpperCase()}`,input.bookingId??null,input.paymentId??null,input.eventId??null,input.type,input.severity??"critical",JSON.stringify(input.detail),Date.now()).run();}
async function lifecycle(db:Db,bookingId:string,eventType:string,detail:unknown){const now=Date.now();await db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)").run();await db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,"payment",bookingId,"razorpay_webhook",JSON.stringify(detail),now).run();}

export async function linkSandboxGatewayOrder(db:Db,input:{bookingId:string;gatewayOrderId:string;actorId:string}){await ensurePaymentReconciliationTables(db);const payment=await db.prepare("SELECT id,amount,currency FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!payment)throw new Error("Canonical payment record not found");const now=Date.now();await db.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,gateway_order_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT(booking_id) DO UPDATE SET gateway_order_id=excluded.gateway_order_id,provider=excluded.provider,environment=excluded.environment,status='active',updated_at=excluded.updated_at").bind(`PAYLINK-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.bookingId,payment.id,"razorpay","sandbox",input.gatewayOrderId,now,now).run();await db.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,?,?,?,0,0,?,'order_linked','pending',0,NULL,?) ON CONFLICT(payment_id) DO UPDATE SET gateway=excluded.gateway,environment=excluded.environment,expected_amount=excluded.expected_amount,currency=excluded.currency,gateway_status=CASE WHEN payment_reconciliation_records.gateway_status IN ('captured','refunded','partially_refunded') THEN payment_reconciliation_records.gateway_status ELSE 'order_linked' END,updated_at=excluded.updated_at").bind(payment.id,input.bookingId,"razorpay","sandbox",Number(payment.amount||0),String(payment.currency||"INR"),now).run();return{bookingId:input.bookingId,paymentId:String(payment.id),gatewayOrderId:input.gatewayOrderId};}

async function resolvePayment(db:Db,event:GatewayEvent){if(event.bookingId){const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(event.bookingId).first<Row>();if(payment)return{bookingId:event.bookingId,payment};}if(event.gatewayPaymentLinkId){const link=await db.prepare("SELECT booking_id,payment_id FROM payment_gateway_links WHERE gateway_payment_link_id=?").bind(event.gatewayPaymentLinkId).first<Row>();if(link){const payment=await db.prepare("SELECT * FROM booking_payments WHERE id=?").bind(link.payment_id).first<Row>();if(payment)return{bookingId:String(link.booking_id),payment};}}if(event.gatewayPaymentId){const link=await db.prepare("SELECT booking_id,payment_id FROM payment_gateway_links WHERE gateway_payment_id=?").bind(event.gatewayPaymentId).first<Row>();if(link){const payment=await db.prepare("SELECT * FROM booking_payments WHERE id=?").bind(link.payment_id).first<Row>();if(payment)return{bookingId:String(link.booking_id),payment};}}if(event.gatewayOrderId){const link=await db.prepare("SELECT booking_id,payment_id FROM payment_gateway_links WHERE gateway_order_id=?").bind(event.gatewayOrderId).first<Row>();if(link){const payment=await db.prepare("SELECT * FROM booking_payments WHERE id=?").bind(link.payment_id).first<Row>();if(payment)return{bookingId:String(link.booking_id),payment};}}return null;}

export async function processGatewayEvent(db:Db,event:GatewayEvent){
  await ensurePaymentReconciliationTables(db);if(!event.signatureVerified)throw new Error("Gateway event signature is not verified");
  const existing=await db.prepare("SELECT id,processing_status,event_type,booking_id FROM payment_gateway_events WHERE provider=? AND event_id=?").bind(event.provider,event.eventId).first<Row>();
  if(existing){
    // A redelivery of an already-recorded event is still allowed to COMPLETE a subscription transition
    // that a transient dependent-write failure rolled back on the first pass — otherwise a one-off failure
    // would strand a genuinely paid entitlement at pending_payment forever (exact-eventId redelivery is
    // the gateway's own retry). The transition helpers are idempotent and touch ONLY the subscription /
    // usage / lifecycle tables, so this repairs a pending transition, no-ops a completed one, and never
    // re-enters the capture path: captured_amount, settlement and gateway-reference idempotency are
    // untouched, and no money is recounted.
    const repairBookingId=String(existing.booking_id||event.bookingId||"").trim();
    if(repairBookingId){
      if(["payment.captured","order.paid","payment_link.paid"].includes(String(existing.event_type)))await activateSubscriptionOnCapture(db,{bookingId:repairBookingId,eventId:event.eventId}).catch(()=>null);
      else if(String(existing.event_type)==="payment.failed")await failSubscriptionOnPaymentFailure(db,{bookingId:repairBookingId,eventId:event.eventId}).catch(()=>null);
    }
    return{duplicate:true,status:String(existing.processing_status)};
  }
  const now=Date.now(),rowId=`PAYEV-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.prepare("INSERT INTO payment_gateway_events (id,provider,environment,event_id,event_type,booking_id,payment_id,gateway_order_id,gateway_payment_id,gateway_refund_id,amount_subunits,currency,signature_verified,payload_hash,processing_status,detail_json,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,'received',?,?)").bind(rowId,event.provider,event.environment,event.eventId,event.eventType,event.bookingId??null,null,event.gatewayOrderId??null,event.gatewayPaymentId??null,event.gatewayRefundId??null,event.amountSubunits??null,event.currency??null,event.payloadHash,JSON.stringify(event.detail||{}),now).run();
  const finish=async(status:"processed"|"exception",reason?:string)=>db.prepare("UPDATE payment_gateway_events SET processing_status=?,failure_reason=?,processed_at=? WHERE id=?").bind(status,reason??null,now,rowId).run();
  const resolved=await resolvePayment(db,event);if(!resolved){await addException(db,{eventId:event.eventId,type:"unmatched_gateway_event",detail:{eventType:event.eventType,gatewayOrderId:event.gatewayOrderId,gatewayPaymentId:event.gatewayPaymentId}});await finish("exception","No canonical payment mapping");return{duplicate:false,status:"exception",reason:"unmatched_gateway_event"};}
  const{bookingId,payment}=resolved,paymentId=String(payment.id),currency=String(payment.currency||"INR"),amount=Number(event.amountSubunits||0)/100;// Verify against what the ORDER was opened for, not the booking price: on a 50/50 stay a correct
  // Rs 5,000 capture would otherwise be recorded as a Rs 5,000 shortfall against a Rs 10,000 total.
  const linkedExpected=await db.prepare("SELECT expected_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first<Row>().catch(()=>null);
  const expected=Number(linkedExpected?.expected_amount??payment.amount??0);await db.prepare("UPDATE payment_gateway_events SET booking_id=?,payment_id=? WHERE id=?").bind(bookingId,paymentId,rowId).run();
  if(event.currency&&event.currency!==currency){await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"currency_mismatch",detail:{expected:currency,received:event.currency}});await finish("exception","Currency mismatch");return{duplicate:false,status:"exception",reason:"currency_mismatch"};}
  if(event.gatewayPaymentId)await db.prepare("UPDATE payment_gateway_links SET gateway_payment_id=COALESCE(gateway_payment_id,?),updated_at=? WHERE booking_id=?").bind(event.gatewayPaymentId,now,bookingId).run();
  // expected_amount stays the amount THIS order was opened for. An earlier attempt stored the
  // booking-level total here, which fed straight back into the variance check on the next event: a
  // second notification for a Rs 4,000 instalment was compared against a Rs 8,000 booking and raised a
  // false capture_amount_mismatch. Booking-level truth is captured_amount plus the schedule, never this.
  const upsert=async(status:string,recon:string,captured:number,refunded:number,variance:number)=>db.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(payment_id) DO UPDATE SET gateway=excluded.gateway,environment=excluded.environment,expected_amount=excluded.expected_amount,captured_amount=excluded.captured_amount,refunded_amount=excluded.refunded_amount,currency=excluded.currency,gateway_status=excluded.gateway_status,reconciliation_status=excluded.reconciliation_status,variance_amount=excluded.variance_amount,last_event_id=excluded.last_event_id,updated_at=excluded.updated_at").bind(paymentId,bookingId,event.provider,event.environment,expected,captured,refunded,currency,status,recon,variance,event.eventId,now).run();
  const current=await db.prepare("SELECT captured_amount,refunded_amount,gateway_status,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first<Row>();const capturedCurrent=Number(current?.captured_amount||0),refundedCurrent=Number(current?.refunded_amount||0),gatewayCurrent=String(current?.gateway_status||"not_started"),reconCurrent=String(current?.reconciliation_status||"pending"),varianceCurrent=Number(current?.variance_amount||0);const settled=["captured","refunded","partially_refunded"].includes(gatewayCurrent)||["captured","refunded","partially_refunded"].includes(String(payment.status));

  if(event.eventType==="payment.authorized"){
    if(settled){await finish("processed","Out-of-order authorization ignored after settled state");return{duplicate:false,status:"processed",ignored:true,reason:"out_of_order_authorized"};}
    await upsert("authorized","pending",capturedCurrent,refundedCurrent,0);
  }else if(event.eventType==="payment.captured"||event.eventType==="order.paid"||event.eventType==="payment_link.paid"){
    // Financial idempotency is per CAPTURE, not per event. A second notification for money already
    // collected must change nothing at all: not the collected total, not the schedule, and it must not
    // be measured against an expectation it was never opened for. Deciding this BEFORE the variance
    // check is what stops `order.paid` following `payment.captured` from raising a false mismatch.
    const refs=captureRefs(event);
    const alreadyCollected=await collectedCaptures(db,paymentId,rowId);
    const isRepeat=alreadyCollected.some(item=>item.refs.some(value=>refs.includes(value)));
    if(isRepeat){
      // Same money, a different notification: it must NOT be recounted (captured_amount and the schedule
      // stay exactly as they are). But it may still complete a subscription transition left pending by a
      // transiently failed first pass — idempotent, and no money moves here.
      await activateSubscriptionOnCapture(db,{bookingId,eventId:event.eventId,at:now}).catch(()=>null);
      await finish("processed","Repeat notification for a capture already collected");
      return{duplicate:false,status:"processed",ignored:true,reason:"capture_already_collected"};
    }
    const variance=Math.round((amount-expected)*100)/100;if(Math.abs(variance)>0.009){await upsert("captured","amount_mismatch",amount,refundedCurrent,variance);await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"capture_amount_mismatch",detail:{expected,received:amount,variance}});await finish("exception","Capture amount mismatch");return{duplicate:false,status:"exception",reason:"capture_amount_mismatch"};}
    // A 50/50 stay pays in TWO captures against ONE payment row and ONE reconciliation record. The
    // variance check above is per ORDER and must stay that way, but what the record REPORTS has to be
    // the booking: captured_amount was being overwritten with the latest capture, so a fully paid
    // Rs 10,000 stay reported Rs 5,000 collected — and captured_amount is what lib/revenue-mission-control
    // and app/api/revenue-crm read as collections, so the under-report reached revenue reporting.
    const schedule=await splitSchedule(db,bookingId);
    const scheduleTotal=schedule?round2(Number(schedule.paid_now_amount||0)+Number(schedule.balance_amount||0)):0;
    // Cumulative, because one record serves both instalments: captured_amount was being overwritten by
    // each capture, so a fully paid Rs 8,000 stay reported Rs 4,000 collected — and that column is what
    // lib/revenue-mission-control and app/api/revenue-crm read as collections.
    const capturedTotal=round2(capturedCurrent+amount);
    // A schedule settles only once TWO genuinely distinct captures have been collected. Inferring the
    // balance from `amount == balance_amount` was wrong: the default split is total/2, so the first
    // instalment and the balance are the SAME figure and a repeated first capture closed the schedule
    // with half the money. Counting distinct captures cannot be fooled that way, and the cumulative
    // check means a short second capture still cannot settle a stay.
    const stagesCollected=distinctCaptureCount([...alreadyCollected,{refs,eventId:event.eventId}]);
    const settlesBalance=Boolean(schedule)&&String(schedule?.status)!=="paid"&&stagesCollected>=2&&capturedTotal+0.009>=scheduleTotal;
    const collectedInFull=schedule?capturedTotal+0.009>=scheduleTotal:capturedTotal+0.009>=expected;
    await db.prepare("UPDATE booking_payments SET status='captured',gateway=?,detail_json=json_set(detail_json,'$.gatewayPaymentId',?,'$.gatewayOrderId',?,'$.lastGatewayEventId',?),updated_at=? WHERE id=?").bind(event.environment==="sandbox"?"razorpay_sandbox":"razorpay",event.gatewayPaymentId??null,event.gatewayOrderId??null,event.eventId,now,paymentId).run();
    await upsert("captured",collectedInFull?"matched":"partially_captured",capturedTotal,refundedCurrent,0);
    if(collectedInFull)await db.prepare("UPDATE provider_settlement_readiness SET status=CASE WHEN payout_amount IS NULL THEN 'payment_verified_rule_pending' ELSE 'eligible' END,reason=CASE WHEN payout_amount IS NULL THEN reason ELSE 'Verified gateway capture reconciled; eligible after the recorded hold period' END,updated_at=? WHERE booking_id=?").bind(now,bookingId).run().catch(()=>null);
    if(settlesBalance)await settleStayBalance(db,{bookingId,eventId:event.eventId,paymentRef:event.gatewayPaymentId??null,now});
    await lifecycle(db,bookingId,"payment_captured",{gateway:event.provider,environment:event.environment,gatewayPaymentId:event.gatewayPaymentId,eventId:event.eventId,amount,capturedTotal,stagesCollected,settledStayBalance:settlesBalance});
    // Referral qualification requires both completion and verified payment. Calling it from each
    // side makes event order irrelevant; the referral bridge is idempotent and a referral failure
    // must never roll back or counterfeit a verified gateway capture.
    await tryQualifyLinkedReferral(db,{bookingId,actorId:"razorpay_webhook"}).catch(async(error)=>{await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"referral_qualification_failed",severity:"warning",detail:{stage:"verified_capture",message:error instanceof Error?error.message:String(error)}}).catch(()=>null);});
    // A verified capture is the ONLY thing that may activate a subscription entitlement (PAY-002). The
    // purchase wrote it pending with zero sessions reserved; this reserves them, exactly once — the
    // atomic, guarded transition means a replayed capture (or an order.paid following payment.captured)
    // changes nothing, and it no-ops for any booking that is not a subscription purchase. A dependent-
    // write failure rolls the whole transition back (it stays pending) and is surfaced as a governed
    // exception rather than swallowed, so it is never silently stranded — the next verified capture /
    // redelivery completes it, and the payment capture itself is never held hostage to it.
    await activateSubscriptionOnCapture(db,{bookingId,eventId:event.eventId,at:now}).catch(async(error)=>{await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"subscription_activation_failed",severity:"critical",detail:{stage:"capture",message:error instanceof Error?error.message:String(error)}}).catch(()=>null);});
    // funnel closure: payment succeeded -> convert the Sales lead and cancel any ₹300 recovery entitlement (belt-and-braces; never breaks payment processing)
    const paidCustomerId=String(payment.customer_id||"");if(paidCustomerId){await convertLeadOnPaymentCaptured(db,{customerId:paidCustomerId,bookingId}).catch(()=>{});await cancelRecoveryEntitlements(db,{customerId:paidCustomerId,bookingId,reason:"payment_captured",at:now}).catch(()=>{});}
  }else if(event.eventType==="payment.failed"){
    if(settled){await upsert(gatewayCurrent,reconCurrent,capturedCurrent,refundedCurrent,varianceCurrent);await finish("processed","Out-of-order failure ignored after settled state");return{duplicate:false,status:"processed",ignored:true,reason:"out_of_order_failed"};}
    await db.prepare("UPDATE booking_payments SET status='failed',gateway=?,detail_json=json_set(detail_json,'$.lastGatewayEventId',?),updated_at=? WHERE id=?").bind(event.environment==="sandbox"?"razorpay_sandbox":"razorpay",event.eventId,now,paymentId).run();await upsert("failed","gateway_failed",capturedCurrent,refundedCurrent,0);await lifecycle(db,bookingId,"payment_failed",{gateway:event.provider,eventId:event.eventId});
    // a verified failure on a subscription purchase leaves no usable credits behind (PAY-002); the
    // close is atomic, and a dependent-write failure is surfaced as a governed exception (retryable on
    // the next failure event) rather than swallowed
    await failSubscriptionOnPaymentFailure(db,{bookingId,eventId:event.eventId,at:now}).catch(async(error)=>{await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"subscription_failure_recording_failed",severity:"critical",detail:{stage:"failure",message:error instanceof Error?error.message:String(error)}}).catch(()=>null);});
  }else if(["refund.created","refund.processed","refund.failed"].includes(event.eventType)){
    const refund=await db.prepare("SELECT * FROM booking_refund_cases WHERE booking_id=? ORDER BY created_at DESC LIMIT 1").bind(bookingId).first<Row>();if(!refund){await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"orphan_gateway_refund",detail:{gatewayRefundId:event.gatewayRefundId,amount}});await finish("exception","No internal refund case");return{duplicate:false,status:"exception",reason:"orphan_gateway_refund"};}
    const expectedRefund=Number(refund.amount||0),sameGatewayRefund=Boolean(event.gatewayRefundId&&String(refund.gateway_reference||"")===event.gatewayRefundId),alreadyProcessed=String(refund.status)==="processed"&&sameGatewayRefund;
    if(event.eventType==="refund.processed"&&alreadyProcessed){await finish("processed","Duplicate logical refund ignored");return{duplicate:false,status:"processed",ignored:true,reason:"refund_already_processed"};}
    if(event.eventType!=="refund.failed"&&Math.abs(amount-expectedRefund)>0.009){await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"refund_amount_mismatch",detail:{expected:expectedRefund,received:amount}});await finish("exception","Refund amount mismatch");return{duplicate:false,status:"exception",reason:"refund_amount_mismatch"};}
    if(event.eventType==="refund.created"&&String(refund.status)!=="processed")await db.prepare("UPDATE booking_refund_cases SET status='processing',gateway_reference=?,updated_at=? WHERE id=?").bind(event.gatewayRefundId??null,now,refund.id).run();
    if(event.eventType==="refund.failed"){
      if(alreadyProcessed){await finish("processed","Out-of-order refund failure ignored after processed refund");return{duplicate:false,status:"processed",ignored:true,reason:"out_of_order_refund_failed"};}
      await db.prepare("UPDATE booking_refund_cases SET status='failed',gateway_reference=?,updated_at=? WHERE id=?").bind(event.gatewayRefundId??null,now,refund.id).run();await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"refund_failed",severity:"critical",detail:{gatewayRefundId:event.gatewayRefundId,amount}});await upsert("refund_failed","exception",capturedCurrent,refundedCurrent,0);
    }
    if(event.eventType==="refund.processed"){
      const nextRefunded=Math.round((refundedCurrent+amount)*100)/100;await db.prepare("UPDATE booking_refund_cases SET status='processed',gateway_reference=?,updated_at=? WHERE id=?").bind(event.gatewayRefundId??null,now,refund.id).run();await db.prepare("UPDATE booking_payments SET status=?,detail_json=json_set(detail_json,'$.lastGatewayEventId',?,'$.lastGatewayRefundId',?),updated_at=? WHERE id=?").bind(nextRefunded>=expected?"refunded":"partially_refunded",event.eventId,event.gatewayRefundId??null,now,paymentId).run();const overage=Math.round((nextRefunded-expected)*100)/100;await upsert(nextRefunded>=expected?"refunded":"partially_refunded",overage>0.009?"refund_overage":"matched",capturedCurrent,nextRefunded,overage>0?overage:0);if(overage>0.009)await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"refund_overage",detail:{expected,refunded:nextRefunded}});await lifecycle(db,bookingId,"refund_processed",{gateway:event.provider,eventId:event.eventId,gatewayRefundId:event.gatewayRefundId,amount});
    }
  }else{await upsert(gatewayCurrent||event.eventType,"ignored",capturedCurrent,refundedCurrent,varianceCurrent);}
  await finish("processed");return{duplicate:false,status:"processed",bookingId,paymentId};
}

/** Environment-aware order link (verify-first customer path). Sandbox/live both supported. */
export async function linkGatewayOrder(db:Db,input:{bookingId:string;gatewayOrderId:string;environment:"sandbox"|"live";actorId:string;expectedAmount?:number}){await ensurePaymentReconciliationTables(db);const payment=await db.prepare("SELECT id,amount,currency FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!payment)throw new Error("Canonical payment record not found");const now=Date.now();await db.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,gateway_order_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT(booking_id) DO UPDATE SET gateway_order_id=excluded.gateway_order_id,provider=excluded.provider,environment=excluded.environment,status='active',updated_at=excluded.updated_at").bind(`PAYLINK-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.bookingId,payment.id,"razorpay",input.environment,input.gatewayOrderId,now,now).run();await db.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,?,?,?,0,0,?,'order_linked','pending',0,NULL,?) ON CONFLICT(payment_id) DO UPDATE SET gateway=excluded.gateway,environment=excluded.environment,expected_amount=excluded.expected_amount,currency=excluded.currency,gateway_status=CASE WHEN payment_reconciliation_records.gateway_status IN ('captured','refunded','partially_refunded') THEN payment_reconciliation_records.gateway_status ELSE 'order_linked' END,updated_at=excluded.updated_at").bind(payment.id,input.bookingId,"razorpay",input.environment,Number(input.expectedAmount??payment.amount??0),String(payment.currency||"INR"),now).run();return{bookingId:input.bookingId,paymentId:String(payment.id),gatewayOrderId:input.gatewayOrderId,environment:input.environment};}

/** Finance view of open (or all) payment reconciliation exceptions. */
export async function listPaymentExceptions(db:Db,input:{status?:string}={}){await ensurePaymentReconciliationTables(db);const status=String(input.status||"open");const rows=await db.prepare("SELECT id,booking_id,payment_id,event_id,exception_type,severity,status,detail_json,created_at,resolved_at,resolved_by FROM payment_reconciliation_exceptions WHERE (?='all' OR status=?) ORDER BY created_at DESC LIMIT 200").bind(status,status).all<Row>();return rows.results.map((r:Row)=>({id:String(r.id),bookingId:r.booking_id?String(r.booking_id):null,paymentId:r.payment_id?String(r.payment_id):null,eventId:r.event_id?String(r.event_id):null,type:String(r.exception_type),severity:String(r.severity),status:String(r.status),detail:JSON.parse(String(r.detail_json||"{}")),createdAt:Number(r.created_at),resolvedAt:r.resolved_at?Number(r.resolved_at):null,resolvedBy:r.resolved_by?String(r.resolved_by):null}));}

const EXCEPTION_RESOLUTIONS=["attach_to_booking","mark_refund","investigate","dismiss"];
/**
 * Finance manual resolution of a payment reconciliation exception. attach_to_booking links an
 * unmatched gateway payment to the correct booking and marks it captured (amount+currency must
 * match); mark_refund / investigate / dismiss record a governed decision with a note. Nothing calls
 * the gateway here - a refund still goes through the refund flow.
 */
export async function resolvePaymentException(db:Db,input:{exceptionId:string;action:string;bookingId?:string;actorId:string;note:string}){await ensurePaymentReconciliationTables(db);if(!EXCEPTION_RESOLUTIONS.includes(input.action))throw new Error("Unknown resolution action");if(!input.note||input.note.trim().length<5)throw new Error("A resolution note is required");const ex=await db.prepare("SELECT * FROM payment_reconciliation_exceptions WHERE id=?").bind(input.exceptionId).first<Row>();if(!ex)throw new Error("Payment exception not found");if(["resolved","dismissed"].includes(String(ex.status)))throw new Error("This exception has already been resolved");const now=Date.now();
  if(input.action==="attach_to_booking"){
    if(String(ex.exception_type)!=="unmatched_gateway_event")throw new Error("Only an unmatched gateway payment can be attached to a booking");
    const bookingId=String(input.bookingId||"").trim();if(!bookingId)throw new Error("A target booking is required to attach the payment");
    const event=await db.prepare("SELECT * FROM payment_gateway_events WHERE event_id=? ORDER BY received_at DESC LIMIT 1").bind(String(ex.event_id||"")).first<Row>();if(!event)throw new Error("Underlying gateway event not found");
    const payment=await db.prepare("SELECT id,amount,currency,status FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>();if(!payment)throw new Error("Target booking has no payment record");
    const expected=Number(payment.amount||0),currency=String(payment.currency||"INR"),evCurrency=String(event.currency||currency),amount=Number(event.amount_subunits||0)/100;
    if(evCurrency!==currency)throw new Error(`Currency mismatch: booking is ${currency}, payment is ${evCurrency} - investigate instead`);
    if(Math.abs(amount-expected)>0.009)throw new Error(`Amount mismatch: booking expects ${expected}, payment is ${amount} - refund or investigate instead`);
    const paymentId=String(payment.id),environment=String(event.environment||"sandbox");
    await db.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,gateway_order_id,gateway_payment_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?, 'active',?,?) ON CONFLICT(booking_id) DO UPDATE SET gateway_order_id=COALESCE(excluded.gateway_order_id,payment_gateway_links.gateway_order_id),gateway_payment_id=COALESCE(excluded.gateway_payment_id,payment_gateway_links.gateway_payment_id),status='active',updated_at=excluded.updated_at").bind(`PAYLINK-${crypto.randomUUID().slice(0,10).toUpperCase()}`,bookingId,paymentId,"razorpay",environment,event.gateway_order_id||null,event.gateway_payment_id||null,now,now).run();
    await db.prepare("UPDATE booking_payments SET status='captured',gateway=?,detail_json=json_set(detail_json,'$.manualAttach',1,'$.attachedEventId',?),updated_at=? WHERE id=?").bind(environment==="sandbox"?"razorpay_sandbox":"razorpay",String(ex.event_id||""),now,paymentId).run();
    await db.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,?,?,?,?,0,?,'captured','matched',0,?,?) ON CONFLICT(payment_id) DO UPDATE SET captured_amount=excluded.captured_amount,gateway_status='captured',reconciliation_status='matched',variance_amount=0,last_event_id=excluded.last_event_id,updated_at=excluded.updated_at").bind(paymentId,bookingId,"razorpay",environment,expected,amount,currency,String(ex.event_id||""),now).run();
    await db.prepare("UPDATE payment_gateway_events SET booking_id=?,payment_id=?,processing_status='processed',processed_at=? WHERE event_id=?").bind(bookingId,paymentId,now,String(ex.event_id||"")).run();
    await lifecycle(db,bookingId,"payment_manually_attached",{paymentId,amount,attachedBy:input.actorId,note:input.note.trim()});
    await db.prepare("UPDATE payment_reconciliation_exceptions SET status='resolved',resolved_by=?,resolved_at=?,detail_json=json_set(detail_json,'$.resolution','attach_to_booking','$.bookingId',?,'$.note',?) WHERE id=?").bind(input.actorId,now,bookingId,input.note.trim(),input.exceptionId).run();
    return{exceptionId:input.exceptionId,status:"resolved",action:"attach_to_booking",bookingId,paymentId,amount};
  }
  const newStatus=input.action==="investigate"?"investigating":input.action==="dismiss"?"dismissed":"resolved";
  await db.prepare("UPDATE payment_reconciliation_exceptions SET status=?,resolved_by=?,resolved_at=?,detail_json=json_set(detail_json,'$.resolution',?,'$.note',?) WHERE id=?").bind(newStatus,newStatus==="investigating"?null:input.actorId,newStatus==="investigating"?null:now,input.action,input.note.trim(),input.exceptionId).run();
  return{exceptionId:input.exceptionId,status:newStatus,action:input.action};}
