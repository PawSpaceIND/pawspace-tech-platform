/**
 * Refunds after completion (owner decision D, 27 Sept 2026): "any escalation - we will set the percentage on the refund and
 * process the same to the customer account."
 *
 * This is a separate, explicit path. The cancellation rules that refuse to refund a delivered booking ("A delivered Sitting
 * booking cannot be cancelled or refunded") are untouched: they decide cancellations, not escalations.
 *
 *   1. Operations (bookings.manage) asks for a percentage (1-100, two decimals) of what the customer paid, with a reason of at
 *      least 10 characters and an optional note for the customer. Amount = round2(percent x amount paid), capped at what is
 *      still refundable (captured - already refunded - other requests waiting). Only a completed booking whose payment was
 *      captured online qualifies. One request per booking waits at a time; a retried request is the same request.
 *   2. Finance (finance.manage) approves or rejects. The approver must be a different person from the requester. Two
 *      decisions racing each other resolve to exactly one: the losing one gets 409 and writes nothing, not even an audit row.
 *   3. Approval opens a booking_refund_cases row (purpose post_completion_escalation, id derived from the request, so it is
 *      created once) and runs it through the EXISTING refund path (lib/automatic-booking-refund.ts): the original payment is
 *      refunded in sandbox; live money stays behind the existing live-payment gates.
 *   4. When the gateway reports the refund processed (the refund.processed webhook, or the refund sweep picking it up), the
 *      settlement below runs once per refund case: the Section 34 credit note (lib/credit-notes.ts), the s.52 TCS base change
 *      for a GST-registered provider, the provider payout (reduced pro rata before release, recovered from the next payout
 *      after release: lib/provider-payout-queue.ts) and the messages to the customer and the provider.
 * Every step is idempotent, audited, and refused in a closed month.
 */
import{capturedGatewayPayments,ensureBookingRefundCaseTargets,POST_COMPLETION_ESCALATION_REFUND_PURPOSE,runAutomaticBookingRefundSweep}from"./automatic-booking-refund";
import{collectedForBooking}from"./collected-funds";
import{enqueueCommunication}from"./communication-engine";
import{correctionDate,ensureCreditNoteTables,istDate,issueEscalationCreditNote,listCreditNotes,noGstTreatmentForSupply,originalInvoiceFor,payoutRecordForCreditNote,periodLocked,recordEscalationTcsAdjustment,valueFromPayoutRecord}from"./credit-notes";
import{ensurePaymentReconciliationTables}from"./grooming-payment-reconciliation";
import{governedJsonError}from"./governed-http-error";
import{providerPayoutRefundImpact,refreshProviderPayoutForBooking}from"./provider-payout-queue";

type Db=D1Database;type Row=Record<string,unknown>;type Env=Record<string,unknown>;
export type EscalationActor={email:string;roleCode?:string|null};
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0;};
const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const money=(v:unknown)=>round2(Math.max(0,num(v)));
const rs=(v:unknown)=>`Rs ${money(v).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const changes=(result:unknown)=>Number((result as {meta?:{changes?:number}}|undefined)?.meta?.changes||0);
const sameActor=(a:unknown,b:unknown)=>text(a).toLowerCase()===text(b).toLowerCase();
const refuse=(error:string,status:number,code?:string)=>governedJsonError(code?{error,code}:{error},status);
export const ESCALATION_REFUND_PURPOSE=POST_COMPLETION_ESCALATION_REFUND_PURPOSE;
export const ESCALATION_REASON_MIN=10;

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

const ready=new WeakSet<Db>();
export async function ensureEscalationRefundTables(db:Db){
 if(ready.has(db))return;
 await ensurePaymentReconciliationTables(db);
 await ensureCreditNoteTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escalation_refund_requests (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,payment_id TEXT NOT NULL,customer_id TEXT,provider_id TEXT,service_code TEXT NOT NULL DEFAULT '',percent REAL NOT NULL CHECK(percent>=1 AND percent<=100),amount REAL NOT NULL CHECK(amount>0),amount_paid REAL NOT NULL,refunded_before REAL NOT NULL DEFAULT 0,refundable_before REAL NOT NULL,capped INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL,customer_note TEXT,status TEXT NOT NULL CHECK(status IN ('requested','approved','rejected','processed')),requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,decided_by TEXT,decided_at INTEGER,decision_reason TEXT,claim_token TEXT,refund_case_id TEXT UNIQUE,preview_json TEXT NOT NULL DEFAULT '{}',processed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  // One request waits per booking: two staff members cannot each queue a refund of the same money.
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_escalation_refund_one_waiting ON escalation_refund_requests(booking_id) WHERE status='requested'"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_escalation_refund_status ON escalation_refund_requests(status,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escalation_refund_settlements (refund_case_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,booking_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','settled')),processed_at INTEGER,issue_date TEXT NOT NULL,period_code TEXT NOT NULL,moved_from_period TEXT,credit_note_id TEXT,credit_note_error TEXT,tcs_outcome TEXT,tcs_adjustment_id TEXT,payout_stage TEXT,provider_id TEXT,provider_share REAL NOT NULL DEFAULT 0,payout_detail_json TEXT NOT NULL DEFAULT '{}',customer_message TEXT,provider_notice_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,next_attempt_at INTEGER NOT NULL DEFAULT 0,settled_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_escalation_refund_settlements_request ON escalation_refund_settlements(request_id,status)"),
  // What the provider is told about their payout (shown on their payout statement).
  db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_notices (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,booking_id TEXT NOT NULL,kind TEXT NOT NULL,amount REAL NOT NULL,message TEXT NOT NULL,channel TEXT NOT NULL DEFAULT 'in_app',status TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_payout_notices_provider ON provider_payout_notices(provider_id,created_at)"),
 ]);
 // The refund case columns other modules add in place (approval, the stored policy, purpose and target payment).
 const columns=new Set((await db.prepare("PRAGMA table_info(booking_refund_cases)").all<Row>()).results.map(r=>text(r.name)));
 for(const[name,ddl]of[["approved_by","ALTER TABLE booking_refund_cases ADD COLUMN approved_by TEXT"],["policy_json","ALTER TABLE booking_refund_cases ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'"]] as const){
  if(columns.has(name))continue;
  await db.prepare(ddl).run().catch((error:unknown)=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
 }
 await ensureBookingRefundCaseTargets(db);
 ready.add(db);
}

const auditStatement=(db:Db,actor:EscalationActor,action:string,resourceId:string,outcome:string,detail:unknown)=>db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),text(actor.email),text(actor.roleCode)||"system",action,"escalation_refund",resourceId,outcome,JSON.stringify(detail??{}),Date.now());
const lifecycleStatement=(db:Db,id:string,bookingId:string,eventType:string,actorId:string,detail:unknown,at:number)=>db.prepare("INSERT OR IGNORE INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,'refund',?,?,?,?)").bind(id,bookingId,eventType,bookingId,actorId,JSON.stringify(detail??{}),at);

export function validPercent(value:unknown){const p=Number(value);return Number.isFinite(p)&&p>=1&&p<=100&&Math.abs(Math.round(p*100)-p*100)<1e-6?round2(p):null;}

const IMPACT_LABELS:Record<string,(share:number)=>string>={
 no_provider_payout:()=>"No provider payout on this booking (PawSpace's own supply), so nothing to adjust.",
 before_queue:share=>`${rs(share)} comes off the provider's payout when it is queued (the payout is not released yet).`,
 before_release:share=>`${rs(share)} comes off the provider's queued payout before it is released.`,
 after_release:share=>`The payout was already released: ${rs(share)} is recovered from the provider's next payout.`,
 payout_cancelled:()=>"The provider payout was cancelled after a full refund, so nothing more is adjusted.",
};
export const providerImpactLabel=(stage:string,share:number)=>(IMPACT_LABELS[stage]??IMPACT_LABELS.no_provider_payout)(share);

/**
 * Everything the request form and the approver see for one booking: the payment, the refunds so far, what is still
 * refundable, and - for a percentage - the amount, the credit note it will produce and what it does to the provider payout.
 * `refusal` names why no refund after completion is possible, in words.
 */
export async function escalationRefundPosition(db:Db,input:{bookingId:string;percent?:number|null;excludeRequestId?:string|null}){
 await ensureEscalationRefundTables(db);
 const bookingId=text(input.bookingId);
 const booking=await db.prepare("SELECT b.id,b.status,b.service_code,b.package_name,b.customer_id,b.provider_id,b.scheduled_start,b.total_amount,b.city_id FROM canonical_bookings b WHERE b.id=?").bind(bookingId).first<Row>();
 if(!booking)return{found:false as const,bookingId,refusal:"Booking not found",refusalStatus:404};
 const[customer,work,payment]=await Promise.all([
  (async()=>await tableExists(db,"canonical_customers")?db.prepare("SELECT name FROM canonical_customers WHERE id=?").bind(text(booking.customer_id)).first<Row>():null)(),
  (async()=>await tableExists(db,"provider_work_orders")?db.prepare("SELECT provider_name,provider_model FROM provider_work_orders WHERE booking_id=?").bind(bookingId).first<Row>():null)(),
  db.prepare("SELECT id,amount,status,method FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>(),
 ]);
 const paymentId=text(payment?.id);
 const record=paymentId?await db.prepare("SELECT captured_amount,refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first<Row>():null;
 const amountPaid=await collectedForBooking(db,bookingId),captured=record&&num(record.captured_amount)>0?money(record.captured_amount):amountPaid;
 const refunds=(await db.prepare("SELECT id,amount,status,purpose,reason,gateway_reference,created_at FROM booking_refund_cases WHERE booking_id=? ORDER BY created_at DESC").bind(bookingId).all<Row>()).results;
 const committed=round2(refunds.filter(r=>["requested","approved","processing","processed","completed"].includes(text(r.status))).reduce((s,r)=>s+num(r.amount),0));
 const refundedSoFar=round2(Math.max(committed,money(record?.refunded_amount)));
 const waiting=await db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM escalation_refund_requests WHERE booking_id=? AND status='requested' AND id<>?").bind(bookingId,text(input.excludeRequestId)).first<Row>();
 const pendingRequests=money(waiting?.amount),refundable=round2(Math.max(0,captured-refundedSoFar-pendingRequests));
 const gatewayPayments=paymentId?await capturedGatewayPayments(db,paymentId):[];
 const payout=await payoutRecordForCreditNote(db,bookingId),invoice=await originalInvoiceFor(db,bookingId),funeral=payout?await noGstTreatmentForSupply(db,invoice,istDate(num(payout.computed_at)||Date.now())):"schedule_iii";
 const status=text(booking.status);
 const refusal=status!=="completed"?{text:`Only a completed booking can get a refund after completion; this booking is ${status.replaceAll("_"," ")||"not completed"}.`,status:409}
  :!payment||amountPaid<=0?{text:"This booking has no captured payment, so there is nothing to refund.",status:409}
  :!gatewayPayments.length?{text:"The customer's payment was not captured online, so it cannot go back to their original payment method.",status:409}
  :!payout?{text:"This booking has no completion tax record under the 26 Sept 2026 model, so its credit note cannot be worked out. Finance must handle it by hand.",status:409}
  :refundable<=0.009?{text:`Nothing is left to refund: ${rs(captured)} was captured and ${rs(round2(refundedSoFar+pendingRequests))} is already refunded or waiting.`,status:409}
  :null;
 const base={found:true as const,bookingId,
  booking:{id:bookingId,status,serviceCode:text(booking.service_code),packageName:text(booking.package_name),customerId:text(booking.customer_id),customerName:text(customer?.name),providerId:text(booking.provider_id),providerName:text(work?.provider_name),providerModel:text(work?.provider_model),scheduledStart:text(booking.scheduled_start)},
  payment:{paymentId,status:text(payment?.status),amountPaid,captured,refundedSoFar,pendingRequests,refundable,gatewayPayments},
  refunds:refunds.map(r=>({id:text(r.id),amount:money(r.amount),status:text(r.status),purpose:text(r.purpose)||null,reason:text(r.reason),gatewayReference:text(r.gateway_reference)||null,createdAt:num(r.created_at)})),
  taxRecord:payout?{treatment:valueFromPayoutRecord(payout,100,funeral).treatment,commissionPercent:valueFromPayoutRecord(payout,100,funeral).commissionPercent,gstRatePercent:num(payout.gst_rate),gstMethod:text(payout.gst_method)}:null,
  invoice:invoice?{kind:invoice.kind,number:invoice.number,date:invoice.date}:null,
  refusal:refusal?.text??null,refusalStatus:refusal?.status??200};
 const percent=input.percent==null?null:validPercent(input.percent);
 if(percent==null||!payout)return{...base,preview:null};
 const asked=round2(amountPaid*percent/100),amount=round2(Math.min(asked,refundable));
 if(!(amount>0))return{...base,preview:null};
 const value=valueFromPayoutRecord(payout,amount,funeral),impact=await providerPayoutRefundImpact(db,{bookingId,refund:amount});
 return{...base,preview:{percent,asked,amount,capped:amount<asked-0.009,creditNote:{...value,invoice:base.invoice,pendingInvoice:!invoice},providerImpact:{...impact,label:providerImpactLabel(impact.stage,impact.providerShare)}}};
}

async function assertMonthOpen(db:Db,asOf:number){const period=istDate(asOf).slice(0,7);if(await periodLocked(db,period))throw refuse(`period_locked: ${period} is closed and locked; a refund after completion cannot be raised or approved in it`,409,"period_locked");}

/** Operations asks for a refund after completion. Idempotent on the idempotency key, and on an identical waiting request. */
export async function requestEscalationRefund(db:Db,input:{bookingId:string;percent:unknown;reason:string;customerNote?:string|null;idempotencyKey?:string|null;asOf?:number},actor:EscalationActor){
 await ensureEscalationRefundTables(db);
 const bookingId=text(input.bookingId),percent=validPercent(input.percent),reason=text(input.reason),note=text(input.customerNote),key=text(input.idempotencyKey),asOf=input.asOf??Date.now();
 if(!bookingId)throw refuse("A booking is required",400);
 if(percent==null)throw refuse("The refund percentage must be between 1 and 100, with at most two decimals",400);
 if(reason.length<ESCALATION_REASON_MIN)throw refuse(`A reason of at least ${ESCALATION_REASON_MIN} characters is required`,400);
 if(note.length>500)throw refuse("The note for the customer can be at most 500 characters",400);
 if(key.length>120)throw refuse("The idempotency key is too long",400);
 const same=(row:Row)=>text(row.booking_id)===bookingId&&Math.abs(num(row.percent)-percent)<0.001&&text(row.reason)===reason&&sameActor(row.requested_by,actor.email);
 if(key){const prior=await db.prepare("SELECT * FROM escalation_refund_requests WHERE idempotency_key=?").bind(key).first<Row>();if(prior){if(text(prior.booking_id)!==bookingId)throw refuse("This idempotency key belongs to a different booking's refund request",409);return{request:prior,duplicatePrevented:true};}}
 const waiting=await db.prepare("SELECT * FROM escalation_refund_requests WHERE booking_id=? AND status='requested'").bind(bookingId).first<Row>();
 if(waiting){if(same(waiting))return{request:waiting,duplicatePrevented:true};throw refuse(`A refund request of ${rs(waiting.amount)} for this booking is already waiting for Finance approval`,409,"escalation_refund_waiting");}
 await assertMonthOpen(db,asOf);
 const position=await escalationRefundPosition(db,{bookingId,percent});
 if(!position.found||position.refusal)throw refuse(position.refusal??"Booking not found",position.refusalStatus||409);
 const preview=position.preview;
 if(!preview)throw refuse("Nothing is left to refund on this booking",409);
 const id=`ESC-${crypto.randomUUID().replaceAll("-","").slice(0,16).toUpperCase()}`,now=Date.now(),idempotencyKey=key||`escalation:${id}`;
 const detail={bookingId,percent,amount:preview.amount,asked:preview.asked,capped:preview.capped,amountPaid:position.payment.amountPaid,refundedSoFar:position.payment.refundedSoFar,refundable:position.payment.refundable,reason,customerNote:note||null};
 try{
  await db.batch([
   db.prepare("INSERT INTO escalation_refund_requests (id,idempotency_key,booking_id,payment_id,customer_id,provider_id,service_code,percent,amount,amount_paid,refunded_before,refundable_before,capped,reason,customer_note,status,requested_by,requested_at,preview_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'requested',?,?,?,?,?)")
    .bind(id,idempotencyKey,bookingId,position.payment.paymentId,position.booking.customerId||null,position.booking.providerId||null,position.booking.serviceCode,percent,preview.amount,position.payment.amountPaid,position.payment.refundedSoFar,position.payment.refundable,preview.capped?1:0,reason,note||null,text(actor.email),now,JSON.stringify({creditNote:preview.creditNote,providerImpact:preview.providerImpact}),now,now),
   auditStatement(db,actor,"escalation_refund.request",id,"completed",detail),
   lifecycleStatement(db,`ESCREQ-${id}`,bookingId,"escalation_refund.requested",text(actor.email),detail,now),
  ]);
 }catch(error){
  // A concurrent identical request, or the same key retried: answer with the request that won.
  const winner=key?await db.prepare("SELECT * FROM escalation_refund_requests WHERE idempotency_key=?").bind(key).first<Row>():await db.prepare("SELECT * FROM escalation_refund_requests WHERE booking_id=? AND status='requested'").bind(bookingId).first<Row>();
  if(winner&&(key?text(winner.booking_id)===bookingId:same(winner)))return{request:winner,duplicatePrevented:true};
  if(winner)throw refuse(`A refund request of ${rs(winner.amount)} for this booking is already waiting for Finance approval`,409,"escalation_refund_waiting");
  throw error;
 }
 return{request:await db.prepare("SELECT * FROM escalation_refund_requests WHERE id=?").bind(id).first<Row>() as Row,duplicatePrevented:false,preview};
}

async function customerMessage(db:Db,input:{request:Row;key:string;templateKey:string;body:string;actorId:string}){
 const bookingId=text(input.request.booking_id),booking=await db.prepare("SELECT customer_id,city_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 try{
  const result=await enqueueCommunication(db,{customerId:text(booking?.customer_id),cityId:text(booking?.city_id)||"blr",channel:"whatsapp",purpose:"service_recovery",idempotencyKey:input.key,templateKey:input.templateKey,bookingId,createdBy:input.actorId,
   payload:{bookingId,requestId:text(input.request.id),amount:money(input.request.amount),body:input.body,customerNote:text(input.request.customer_note)||null}});
  return{status:(result as Row).duplicatePrevented?"already_queued":"queued"};
 }catch(error){
  // The refund stands whatever happens to the message; the reason is kept on the request's audit trail.
  const reason=error instanceof Error?error.message:String(error);
  await db.prepare("INSERT OR IGNORE INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,'escalation_refund.message_failed','refund',?,?,?,?)").bind(`ESCMSG-${input.key}`,bookingId,bookingId,input.actorId,JSON.stringify({templateKey:input.templateKey,reason}),Date.now()).run().catch(()=>null);
  return{status:"not_queued",reason};
 }
}
const noteSuffix=(request:Row)=>text(request.customer_note)?` Note from PawSpace: ${text(request.customer_note)}`:"";

/**
 * Finance approves or rejects a waiting request. Approval needs a second person; two decisions racing resolve to exactly one
 * (the loser gets 409 and writes nothing). An approval opens the refund case and runs it through the existing refund path.
 */
export async function decideEscalationRefund(db:Db,env:Env,input:{requestId:string;decision:"approve"|"reject";reason?:string|null;asOf?:number},actor:EscalationActor){
 await ensureEscalationRefundTables(db);
 const requestId=text(input.requestId),reason=text(input.reason),asOf=input.asOf??Date.now(),decision=input.decision;
 if(!requestId)throw refuse("A refund request is required",400);
 if(decision!=="approve"&&decision!=="reject")throw refuse("Choose approve or reject",400);
 if(decision==="reject"&&reason.length<ESCALATION_REASON_MIN)throw refuse(`A reason of at least ${ESCALATION_REASON_MIN} characters is required to reject a refund`,400);
 const request=await db.prepare("SELECT * FROM escalation_refund_requests WHERE id=?").bind(requestId).first<Row>();
 if(!request)throw refuse("Refund request not found",404);
 if(text(request.status)!=="requested")throw refuse(`This refund request was already ${text(request.status)}`,409,"escalation_refund_already_decided");
 const bookingId=text(request.booking_id),claim=crypto.randomUUID(),now=Date.now(),guard="EXISTS (SELECT 1 FROM escalation_refund_requests WHERE id=? AND claim_token=?)";
 if(decision==="reject"){
  if(sameActor(request.requested_by,actor.email))throw refuse("The person who asked for this refund cannot decide it; a different Finance person must approve or reject it",409,"escalation_refund_self_decision_forbidden");
  const detail={bookingId,amount:money(request.amount),percent:num(request.percent),requestedBy:text(request.requested_by),reason};
  const results=await db.batch([
   db.prepare("UPDATE escalation_refund_requests SET status='rejected',decided_by=?,decided_at=?,decision_reason=?,claim_token=?,updated_at=? WHERE id=? AND status='requested'").bind(text(actor.email),now,reason,claim,now,requestId),
   db.prepare(`INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) SELECT ?,?,?,'escalation_refund.reject','escalation_refund',?,'completed',?,? WHERE ${guard}`).bind(crypto.randomUUID(),text(actor.email),text(actor.roleCode)||"system",requestId,JSON.stringify(detail),now,requestId,claim),
   db.prepare(`INSERT OR IGNORE INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) SELECT ?,?,'escalation_refund.rejected','refund',?,?,?,? WHERE ${guard}`).bind(`ESCREJ-${requestId}`,bookingId,bookingId,text(actor.email),JSON.stringify(detail),now,requestId,claim),
  ]);
  if(changes(results[0])!==1)throw refuse("This refund request was just decided by someone else",409,"escalation_refund_already_decided");
  return{request:await db.prepare("SELECT * FROM escalation_refund_requests WHERE id=?").bind(requestId).first<Row>() as Row,status:"rejected" as const};
 }
 // Segregation of duties: whoever asked for the refund cannot also release it.
 if(sameActor(request.requested_by,actor.email))throw refuse("The person who asked for this refund cannot approve it; a different Finance approver must",409,"escalation_refund_self_approval_forbidden");
 await assertMonthOpen(db,asOf);
 const position=await escalationRefundPosition(db,{bookingId,excludeRequestId:requestId});
 if(!position.found)throw refuse("Booking not found",404);
 if(position.refusal&&!/Nothing is left to refund/.test(position.refusal))throw refuse(position.refusal,position.refusalStatus||409);
 if(money(request.amount)>position.payment.refundable+0.009)throw refuse(`Refunds since this request leave only ${rs(position.payment.refundable)} refundable, less than the ${rs(request.amount)} asked. Reject it and raise a new request.`,409,"escalation_refund_exceeds_refundable");
 const caseId=`${requestId}-RF`,amount=money(request.amount);
 const policy={automatic:true,requiresApproval:false,approvedByHuman:true,policyVersion:"escalation-refund-2026-09-27",escalationRequestId:requestId,percent:num(request.percent),requestedBy:text(request.requested_by),approvedBy:text(actor.email)};
 const detail={bookingId,refundCaseId:caseId,amount,percent:num(request.percent),requestedBy:text(request.requested_by),note:reason||null};
 const results=await db.batch([
  db.prepare("UPDATE escalation_refund_requests SET status='approved',decided_by=?,decided_at=?,decision_reason=?,claim_token=?,refund_case_id=?,updated_at=? WHERE id=? AND status='requested'").bind(text(actor.email),now,reason||null,claim,caseId,now,requestId),
  db.prepare(`INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,policy_json,purpose,created_at,updated_at) SELECT ?,?,?,?,?,'approved',?,?,?,?,?,? WHERE ${guard}`).bind(caseId,bookingId,text(request.payment_id),amount,`Refund after completion (${num(request.percent)}%): ${text(request.reason)}`,text(request.requested_by),text(actor.email),JSON.stringify(policy),ESCALATION_REFUND_PURPOSE,now,now,requestId,claim),
  db.prepare(`INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) SELECT ?,?,?,'escalation_refund.approve','escalation_refund',?,'completed',?,? WHERE ${guard}`).bind(crypto.randomUUID(),text(actor.email),text(actor.roleCode)||"system",requestId,JSON.stringify(detail),now,requestId,claim),
  db.prepare(`INSERT OR IGNORE INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) SELECT ?,?,'escalation_refund.approved','refund',?,?,?,? WHERE ${guard}`).bind(`ESCAPP-${requestId}`,bookingId,caseId,text(actor.email),JSON.stringify(detail),now,requestId,claim),
 ]);
 if(changes(results[0])!==1)throw refuse("This refund request was just decided by someone else",409,"escalation_refund_already_decided");
 const approved=await db.prepare("SELECT * FROM escalation_refund_requests WHERE id=?").bind(requestId).first<Row>() as Row;
 const message=await customerMessage(db,{request:approved,key:`ESCALATION-REFUND-APPROVED-${requestId}`,templateKey:"escalation_refund_approved",body:`Your PawSpace refund of ${rs(amount)} for booking ${bookingId} has been approved. It will go back to your original payment method.${noteSuffix(approved)}`,actorId:text(actor.email)});
 // The existing refund path: the sweep refunds the original payment (sandbox) and records the gateway refund; if the gateway
 // is not reachable now, the case stays approved and the scheduled sweep retries it.
 let execution:Row;
 try{execution=await runAutomaticBookingRefundSweep(db,env,{asOf,refundCaseIds:[caseId]}) as unknown as Row;}
 catch(error){execution={failed:1,errors:[error instanceof Error?error.message:String(error)]};}
 const refundCase=await db.prepare("SELECT id,status,gateway_reference,gateway_payment_id,amount FROM booking_refund_cases WHERE id=?").bind(caseId).first<Row>();
 return{request:approved,status:"approved" as const,refundCaseId:caseId,refundCase,execution,message};
}

/** When the gateway reported this refund case processed (its refund_processed lifecycle event), else when the case last moved. */
async function processedTime(db:Db,bookingId:string,gatewayReference:string,fallback:number){
 if(gatewayReference){const row=await db.prepare("SELECT MIN(occurred_at) at FROM booking_lifecycle_events WHERE booking_id=? AND event_type='refund_processed' AND json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.gatewayRefundId')=?").bind(bookingId,gatewayReference).first<Row>();if(num(row?.at)>0)return num(row?.at);}
 return fallback;
}
const PROVIDER_NOTICE:Record<string,(share:number,refund:number,bookingId:string)=>string>={
 after_release:(share,refund,bookingId)=>`Payout adjusted by ${rs(share)} for booking ${bookingId}: the customer was refunded ${rs(refund)} after the service and your payout was already released, so ${rs(share)} is taken off your next payout.`,
 default:(share,refund,bookingId)=>`Payout adjusted by ${rs(share)} for booking ${bookingId}: the customer was refunded ${rs(refund)} after the service, so your payout for it is ${rs(share)} less.`,
};

async function settleCase(db:Db,row:Row,asOf:number,actorId:string){
 const caseId=text(row.case_id),bookingId=text(row.booking_id),requestId=text(row.id),amount=money(row.case_amount),gatewayReference=text(row.gateway_reference);
 const processedAt=await processedTime(db,bookingId,gatewayReference,num(row.case_updated_at)||asOf);
 let settlement=await db.prepare("SELECT * FROM escalation_refund_settlements WHERE refund_case_id=?").bind(caseId).first<Row>();
 if(!settlement){
  // The note's date and month are fixed the first time, so a retry never moves them.
  const when=await correctionDate(db,processedAt,asOf),now=Date.now();
  await db.prepare("INSERT OR IGNORE INTO escalation_refund_settlements (refund_case_id,request_id,booking_id,amount,status,processed_at,issue_date,period_code,moved_from_period,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?,?,?,?)").bind(caseId,requestId,bookingId,amount,processedAt,when.issueDate,when.periodCode,when.movedFromLockedPeriod,now,now).run();
  settlement=await db.prepare("SELECT * FROM escalation_refund_settlements WHERE refund_case_id=?").bind(caseId).first<Row>() as Row;
 }
 let issueDate=text(settlement.issue_date),periodCode=text(settlement.period_code);const errors:string[]=[];
 // A note still waiting (for its invoice) when its month closes moves to the next open month, as any correction does; the TCS
 // adjustment already recorded keeps its month. Once the note exists its date never moves.
 if(!text(settlement.credit_note_id)&&await periodLocked(db,periodCode)){
  const when=await correctionDate(db,processedAt,asOf);
  if(when.periodCode!==periodCode){await db.prepare("UPDATE escalation_refund_settlements SET issue_date=?,period_code=?,moved_from_period=COALESCE(moved_from_period,?),updated_at=? WHERE refund_case_id=? AND credit_note_id IS NULL").bind(when.issueDate,when.periodCode,periodCode,Date.now(),caseId).run();issueDate=when.issueDate;periodCode=when.periodCode;}
 }
 const reasonOf=(error:unknown)=>error instanceof Response?"governed refusal":error instanceof Error?error.message:String(error);
 const governedText=async(error:unknown)=>error instanceof Response?text(((await error.clone().json().catch(()=>({}))) as Row).error)||`HTTP ${error.status}`:reasonOf(error);
 // 1. The Section 34 credit note. Past the s.34(2) time limit it can no longer be issued: that is recorded and final.
 let creditNoteId=text(settlement.credit_note_id)||null,creditNoteError:string|null=text(settlement.credit_note_error)||null;
 const timeBarred=()=>/^time_barred:/.test(text(creditNoteError));
 if(!creditNoteId&&!timeBarred()){creditNoteError=null;try{const issued=await issueEscalationCreditNote(db,{refundCaseId:caseId,requestId,bookingId,refundAmount:amount,issueDate,periodCode,reason:`Refund after completion: ${text(row.reason)}`,gatewayReference,processedAt,actorId,asOf});creditNoteId=text(issued.note.id);}catch(error){creditNoteError=await governedText(error);if(!timeBarred())errors.push(`credit note: ${creditNoteError}`);}}
 // 2. The s.52 TCS base (GST-registered commission providers only).
 let tcsOutcome=text(settlement.tcs_outcome)||null,tcsId=text(settlement.tcs_adjustment_id)||null;
 if(!tcsOutcome){try{const tcs=await recordEscalationTcsAdjustment(db,{refundCaseId:caseId,bookingId,refundAmount:amount,issueDate,periodCode,creditNoteId,actorId});tcsOutcome=tcs.applicable?"tcs_base_reduced":tcs.reason;tcsId=tcs.applicable?text(tcs.adjustment.id):null;}catch(error){errors.push(`TCS: ${await governedText(error)}`);}}
 // 3. The provider payout: reduced before release, recovered from the next payout after release.
 let payoutStage=text(settlement.payout_stage)||null,providerId=text(settlement.provider_id)||null,share=num(settlement.provider_share),payoutDetail=text(settlement.payout_detail_json)||"{}";
 if(!payoutStage){try{const impact=await providerPayoutRefundImpact(db,{bookingId,refund:amount,alreadyCounted:true});const refreshed=await refreshProviderPayoutForBooking(db,{bookingId,asOf,actorId});payoutStage=impact.stage;providerId=impact.providerId;share=impact.providerShare;payoutDetail=JSON.stringify({impact,refreshed:{stage:refreshed.stage,outcome:refreshed.outcome??null,recovery:refreshed.recovery??null}});}catch(error){errors.push(`payout: ${await governedText(error)}`);}}
 // 4. The messages: the customer through the communication engine; the provider on their payout statement.
 const request=await db.prepare("SELECT * FROM escalation_refund_requests WHERE id=?").bind(requestId).first<Row>() as Row;
 const note=creditNoteId?await db.prepare("SELECT credit_note_number FROM finance_credit_notes WHERE id=?").bind(creditNoteId).first<Row>():null;
 const customer=text(settlement.customer_message)?{status:text(settlement.customer_message)}:await customerMessage(db,{request:{...request,amount},key:`ESCALATION-REFUND-PROCESSED-${caseId}`,templateKey:"escalation_refund_processed",body:`Your PawSpace refund of ${rs(amount)} for booking ${bookingId} has been processed to your original payment method. Banks can take 5 to 7 working days to show it.${note?` Credit note ${text(note.credit_note_number)} has been issued for it.`:""}${noteSuffix(request)}`,actorId});
 let noticeId=text(settlement.provider_notice_id)||null;
 if(!noticeId&&payoutStage&&providerId&&share>0.004){
  noticeId=`PPN-${caseId}`;
  const message=(PROVIDER_NOTICE[payoutStage]??PROVIDER_NOTICE.default)(share,amount,bookingId);
  await db.prepare("INSERT OR IGNORE INTO provider_payout_notices (id,idempotency_key,provider_id,booking_id,kind,amount,message,channel,status,created_at) VALUES (?,?,?,?,?,?,?,'in_app','queued',?)").bind(noticeId,`payout-adjusted:${caseId}`,providerId,bookingId,payoutStage==="after_release"?"recovery_from_next_payout":"payout_reduced",share,message,Date.now()).run();
 }
 const settled=Boolean((creditNoteId||timeBarred())&&tcsOutcome&&payoutStage),now=Date.now();
 await db.prepare("UPDATE escalation_refund_settlements SET status=?,credit_note_id=?,credit_note_error=?,tcs_outcome=?,tcs_adjustment_id=?,payout_stage=?,provider_id=?,provider_share=?,payout_detail_json=?,customer_message=?,provider_notice_id=?,attempts=attempts+1,last_error=?,next_attempt_at=?,settled_at=CASE WHEN ?='settled' THEN COALESCE(settled_at,?) ELSE settled_at END,updated_at=? WHERE refund_case_id=?")
  .bind(settled?"settled":"pending",creditNoteId,creditNoteError,tcsOutcome,tcsId,payoutStage,providerId,share,payoutDetail,customer.status==="not_queued"?null:customer.status,noticeId,errors.length?errors.join(" | "):null,settled?0:asOf+60*60_000,settled?"settled":"pending",now,now,caseId).run();
 if(settled){
  await db.batch([
   lifecycleStatement(db,`ESCSET-${caseId}`,bookingId,"escalation_refund.settled","system:escalation-refund",{refundCaseId:caseId,amount,creditNoteId,creditNoteNumber:text(note?.credit_note_number)||null,periodCode,tcsOutcome,payoutStage,providerShare:share},now),
   db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) SELECT ?,?,'system','escalation_refund.settle','escalation_refund',?,'completed',?,? WHERE NOT EXISTS (SELECT 1 FROM security_audit_events WHERE action='escalation_refund.settle' AND resource_id=? AND json_extract(detail_json,'$.refundCaseId')=?)").bind(crypto.randomUUID(),actorId,requestId,JSON.stringify({refundCaseId:caseId,amount,creditNoteId,periodCode,tcsOutcome,payoutStage,providerShare:share}),now,requestId,caseId),
   // The request is processed once every refund case it produced is processed and settled.
   db.prepare("UPDATE escalation_refund_requests SET status='processed',processed_at=?,updated_at=? WHERE id=? AND status='approved' AND NOT EXISTS (SELECT 1 FROM booking_refund_cases c WHERE (c.id=escalation_refund_requests.refund_case_id OR substr(c.id,1,length(escalation_refund_requests.refund_case_id)+2)=escalation_refund_requests.refund_case_id||'-P') AND NOT EXISTS (SELECT 1 FROM escalation_refund_settlements s WHERE s.refund_case_id=c.id AND s.status='settled'))").bind(now,now,requestId),
  ]);
 }
 return{refundCaseId:caseId,requestId,bookingId,amount,settled,creditNoteId,creditNoteNumber:text(note?.credit_note_number)||null,periodCode,tcsOutcome,payoutStage,providerShare:share,customerMessage:customer.status,errors};
}

/**
 * Settles every processed escalation refund case not settled yet: the webhook calls it for its refund, the refund sweep for
 * anything left. Each step inside is idempotent, so a replay or a race issues nothing twice; a step that cannot run yet (no
 * invoice to credit, a closed month) keeps the case pending and is retried hourly.
 */
export async function settleEscalationRefunds(db:Db,input:{asOf?:number;limit?:number;refundCaseIds?:string[];gatewayRefundId?:string|null;actorId?:string}={}){
 const report={examined:0,settled:0,pending:0,results:[] as Array<Record<string,unknown>>,errors:[] as string[]};
 if(!await tableExists(db,"escalation_refund_requests"))return report;
 await ensureEscalationRefundTables(db);
 const asOf=input.asOf??Date.now(),limit=Math.max(1,Math.min(100,Math.floor(input.limit??25))),actorId=text(input.actorId)||"system:escalation-refund";
 const ids=(input.refundCaseIds??[]).map(text).filter(Boolean),gatewayRefundId=text(input.gatewayRefundId);
 const targeted=ids.length>0||Boolean(gatewayRefundId);
 const filter=ids.length?" AND c.id IN (SELECT value FROM json_each(?))":gatewayRefundId?" AND c.gateway_reference=?":"";
 const rows=(await db.prepare(`SELECT r.*,c.id case_id,c.amount case_amount,c.status case_status,c.gateway_reference,c.updated_at case_updated_at FROM escalation_refund_requests r JOIN booking_refund_cases c ON (c.id=r.refund_case_id OR substr(c.id,1,length(r.refund_case_id)+2)=r.refund_case_id||'-P') WHERE r.status IN ('approved','processed') AND c.status IN ('processed','completed') AND c.purpose=? AND NOT EXISTS (SELECT 1 FROM escalation_refund_settlements s WHERE s.refund_case_id=c.id AND (s.status='settled'${targeted?"":" OR s.next_attempt_at>?"}))${filter} ORDER BY c.updated_at,c.id LIMIT ?`)
  .bind(ESCALATION_REFUND_PURPOSE,...(targeted?[]:[asOf]),...(ids.length?[JSON.stringify(ids)]:gatewayRefundId?[gatewayRefundId]:[]),limit).all<Row>()).results;
 for(const row of rows){
  report.examined++;
  try{const result=await settleCase(db,row,asOf,actorId);report.results.push(result);if(result.settled)report.settled++;else{report.pending++;report.errors.push(...result.errors.map(e=>`${result.refundCaseId}: ${e}`));}}
  catch(error){report.pending++;report.errors.push(`${text(row.case_id)}: ${error instanceof Response?text(((await error.clone().json().catch(()=>({}))) as Row).error)||`HTTP ${error.status}`:error instanceof Error?error.message:String(error)}`);}
 }
 return report;
}
/** For the refund.processed webhook: settle this gateway refund now. Never throws; the sweep retries whatever is left. */
export async function settleEscalationRefundAfterWebhook(db:Db,gatewayRefundId:string|null|undefined){
 if(!text(gatewayRefundId))return null;
 try{return await settleEscalationRefunds(db,{gatewayRefundId:text(gatewayRefundId),actorId:"razorpay_webhook"});}
 catch(error){console.warn("[escalation-refund] settlement after webhook deferred to the sweep",error instanceof Error?error.message:String(error));return{examined:0,settled:0,pending:0,results:[],errors:[error instanceof Error?error.message:String(error)]};}
}

const view=(row:Row)=>{const preview=(()=>{try{return JSON.parse(text(row.preview_json)||"{}") as Row;}catch{return{} as Row;}})();const{preview_json:omitPreview,claim_token:omitClaim,...rest}=row;void omitPreview;void omitClaim;return{...rest,preview};};
/** The Finance queue: requests waiting for a decision (with everything the approver needs), recent decisions, and credit notes. */
export async function escalationRefundQueue(db:Db,input:{limit?:number}={}){
 await ensureEscalationRefundTables(db);
 const limit=Math.max(1,Math.min(200,Math.floor(num(input.limit)||50)));
 const waiting=(await db.prepare("SELECT * FROM escalation_refund_requests WHERE status='requested' ORDER BY created_at LIMIT ?").bind(limit).all<Row>()).results;
 const pending=[];
 for(const row of waiting){const position=await escalationRefundPosition(db,{bookingId:text(row.booking_id),percent:num(row.percent),excludeRequestId:text(row.id)});pending.push({...view(row),position});}
 const recent=(await db.prepare("SELECT r.*,c.status case_status,c.gateway_reference,s.status settlement_status,s.credit_note_id,s.period_code settlement_period,s.payout_stage,s.provider_share,s.tcs_outcome,s.last_error settlement_error,n.credit_note_number,n.taxable_value note_taxable,n.tax_total note_tax FROM escalation_refund_requests r LEFT JOIN booking_refund_cases c ON c.id=r.refund_case_id LEFT JOIN escalation_refund_settlements s ON s.refund_case_id=r.refund_case_id LEFT JOIN finance_credit_notes n ON n.id=s.credit_note_id WHERE r.status<>'requested' ORDER BY r.updated_at DESC LIMIT ?").bind(limit).all<Row>()).results;
 return{pending,recent:recent.map(row=>({...view(row),providerImpactLabel:text(row.payout_stage)?providerImpactLabel(text(row.payout_stage),num(row.provider_share)):null})),creditNotes:await listCreditNotes(db,{limit:100}),rules:{percent:"1 to 100, up to two decimals",reasonMinimum:ESCALATION_REASON_MIN,approver:"a different person with finance.manage",liveMoney:false}};
}
/** The requests for one booking (Booking Command Center). */
export async function escalationRefundsForBooking(db:Db,bookingId:string){
 await ensureEscalationRefundTables(db);
 return(await db.prepare("SELECT r.*,c.status case_status,s.status settlement_status,s.payout_stage,s.provider_share,n.credit_note_number FROM escalation_refund_requests r LEFT JOIN booking_refund_cases c ON c.id=r.refund_case_id LEFT JOIN escalation_refund_settlements s ON s.refund_case_id=r.refund_case_id LEFT JOIN finance_credit_notes n ON n.id=s.credit_note_id WHERE r.booking_id=? ORDER BY r.created_at DESC").bind(text(bookingId)).all<Row>()).results.map(view);
}
/** The payout adjustments a provider is told about, newest first (their payout statement). Read-only and cold-DB safe. */
export async function providerPayoutNotices(db:Db,providerId:string){
 if(!await tableExists(db,"provider_payout_notices"))return[] as Array<{id:string;bookingId:string;kind:string;amount:number;message:string;createdAt:number}>;
 return(await db.prepare("SELECT id,booking_id,kind,amount,message,created_at FROM provider_payout_notices WHERE provider_id=? ORDER BY created_at DESC LIMIT 100").bind(text(providerId)).all<Row>()).results.map(r=>({id:text(r.id),bookingId:text(r.booking_id),kind:text(r.kind),amount:money(r.amount),message:text(r.message),createdAt:num(r.created_at)}));
}
