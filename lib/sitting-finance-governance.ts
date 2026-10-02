import{ensureSittingLifecycleTables}from"./sitting-lifecycle";
import{collectedForBooking}from"./collected-funds";
import{providerPayoutHoldDays}from"./provider-payout-hold";
import{approvedServiceRefundCase,ensureCanonicalRefundCaseTable,recordServiceLedgerRefund}from"./refund-collection-reversal";

type Row=Record<string,unknown>;
export type SittingFinanceAction="request_cancel"|"approve_cancel"|"request_date_change"|"apply_date_change"|"record_refund"|"prepare_settlement"|"approve_settlement"|"reconcile";
export type SittingFinanceInput={bookingId:string;action:SittingFinanceAction;actorId:string;idempotencyKey:string;cancellationRequestId?:string;refundId?:string;dateChangeRequestId?:string;reason?:string;requestedStart?:string;requestedEnd?:string;quoteId?:string;replacementGroupId?:string;approvedRefundAmount?:number;refundReference?:string;paymentAdjustmentReference?:string};
const parse=(value:unknown)=>{try{return JSON.parse(String(value??"{}")) as Record<string,unknown>}catch{return{}}};


/**
 * DATABASE-LEVEL refund uniqueness (PAWSPACE-QA-004 requirement 4).
 *
 * The atomic claim above is the correct fix; this is the floor under it, so one cancellation request
 * cannot own two refund obligations even if the application logic regresses later. The key is the
 * cancellation-request identity - not the human-supplied `reference`, which is NULL at insert and only
 * filled in later by record_refund.
 *
 * Created outside the schema batch and tolerant of failure ON PURPOSE. A database that already contains
 * duplicate refunds from before this fix cannot build the index, and throwing here would take every
 * request on this module down rather than the one write that is actually unsafe. When that happens the
 * duplicates must be reconciled by Finance and the index created afterwards; the claim still holds the
 * invariant in the meantime. tests assert the index EXISTS on any clean database.
 */
async function ensureRefundLedgerUniqueness(db:D1Database,table:string){
 await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_one_refund_per_request ON ${table}(cancellation_request_id)`).run().catch((error:unknown)=>{
  console.error(`${table}: could not create the one-refund-per-request index; existing duplicate refunds must be reconciled first.`,error instanceof Error?error.message:String(error));
 });
}
export async function ensureSittingFinanceTables(db:D1Database){await ensureSittingLifecycleTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_finance_action_keys (idempotency_key TEXT PRIMARY KEY,booking_id TEXT NOT NULL,action TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_cancellation_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,requested_by TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'policy_review_required',approved_refund_amount REAL,decision_by TEXT,decision_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_date_change_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,requested_start TEXT NOT NULL,requested_end TEXT NOT NULL,quote_id TEXT,replacement_group_id TEXT,status TEXT NOT NULL DEFAULT 'commercial_quote_required',old_total REAL NOT NULL,new_total REAL,amount_delta REAL,payment_adjustment_reference TEXT,requested_by TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_refund_ledger (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,cancellation_request_id TEXT,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL DEFAULT 'sandbox_pending',reference TEXT,policy_source TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sitting_refund_reference ON sitting_refund_ledger(reference) WHERE reference IS NOT NULL"),
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_sitter_settlement_ledger (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,gross_booking_value REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',base_payout REAL,travel_allowance REAL,incentives REAL,penalties REAL,cash_adjustment REAL,payout_amount REAL,payout_rule_status TEXT NOT NULL DEFAULT 'rule_pending',tax_status TEXT NOT NULL DEFAULT 'configuration_required',approval_status TEXT NOT NULL DEFAULT 'not_ready',payout_status TEXT NOT NULL DEFAULT 'not_instructed',eligible_at INTEGER,approved_by TEXT,payout_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_finance_reconciliation (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,booking_total REAL NOT NULL,captured_amount REAL NOT NULL,refund_total REAL NOT NULL,net_customer_amount REAL NOT NULL,settlement_amount REAL,refund_state TEXT NOT NULL,settlement_state TEXT NOT NULL,tax_state TEXT NOT NULL,status TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',checked_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sitting_date_change_quote_links (quote_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);await ensureRefundLedgerUniqueness(db,"sitting_refund_ledger");await ensureCanonicalRefundCaseTable(db);}
async function context(db:D1Database,bookingId:string){await ensureSittingFinanceTables(db);const row=await db.prepare("SELECT b.*,w.id work_order_id,w.status work_order_status,p.status payment_status FROM canonical_bookings b LEFT JOIN provider_work_orders w ON w.booking_id=b.id LEFT JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=? AND b.service_code='pet_sitting'").bind(bookingId).first<Row>();if(!row)throw new Response("Canonical Sitting booking not found",{status:404});
 // captured_amount is money actually collected — the one canonical definition, schedule-aware, never
 // the booking price. PAWSPACE-QA-A2: this SELECT used to alias p.amount, so an unpaid booking
 // reconciled at full price.
 row.captured_amount=await collectedForBooking(db,bookingId);return row;}
function selectedRow(input:SittingFinanceInput){
 const field=input.action==="approve_cancel"?"cancellationRequestId":input.action==="record_refund"?"refundId":input.action==="apply_date_change"?"dateChangeRequestId":null;
 if(!field)return null;
 const value=input[field];
 if(typeof value!=="string"||!value.trim())throw new Response(`${field} is required for this Sitting finance action`,{status:400});
 return{field,id:value.trim()};
}
async function prior(db:D1Database,input:SittingFinanceInput){
 const row=await db.prepare("SELECT booking_id,action,result_json FROM sitting_finance_action_keys WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
 if(!row)return null;
 const result=parse(row.result_json),target=selectedRow(input);
 if(String(row.booking_id)!==input.bookingId||String(row.action)!==input.action||target&&String(result[target.field]||"")!==target.id)throw new Response("Idempotency key does not match this Sitting action target",{status:409});
 return result;
}
async function remember(db:D1Database,input:SittingFinanceInput,result:Record<string,unknown>){
 const target=selectedRow(input),stored=target?{...result,[target.field]:target.id}:result;
 await db.prepare("INSERT INTO sitting_finance_action_keys (idempotency_key,booking_id,action,result_json,created_at) VALUES (?,?,?,?,?)")
 .bind(input.idempotencyKey,input.bookingId,input.action,JSON.stringify(stored),Date.now()).run();return stored;
}
function why(input:SittingFinanceInput){const value=String(input.reason||"").trim();if(value.length<3)throw new Response("A reason is required",{status:400});return value;}
function validFutureWindow(start:string,end:string){const a=new Date(start).getTime(),b=new Date(end).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||a<=Date.now())throw new Response("A valid future Sitting care window is required",{status:400});}
async function freshQuote(db:D1Database,booking:Row,quoteId:string,start:string,end:string){const quote=await db.prepare("SELECT * FROM sitting_commercial_quotes WHERE id=?").bind(quoteId).first<Row>();if(!quote||String(quote.status)!=="open"||Number(quote.expires_at)<Date.now())throw new Response("A fresh open Sitting server quote is required",{status:409});if(String(quote.package_code)!==String(booking.package_code)||String(quote.scheduled_start)!==start||String(quote.scheduled_end)!==end)throw new Response("Sitting change quote does not match the requested care window",{status:409});return quote;}
async function replacementSchedule(db:D1Database,booking:Row,groupId:string,start:string,end:string){const decision=await db.prepare("SELECT selected_provider_id,status FROM scheduling_assignment_decisions WHERE group_id=?").bind(groupId).first<Row>();if(!decision||String(decision.status)!=="assigned"||!decision.selected_provider_id)throw new Response("A canonical replacement Sitting schedule is required",{status:409});const reservations=await db.prepare("SELECT provider_id,scheduled_start,scheduled_end,status FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").bind(groupId).all<Row>();if(reservations.results.length!==1)throw new Response("Sitting date change requires exactly one replacement reservation",{status:409});const reservation=reservations.results[0];if(String(reservation.provider_id)!==String(decision.selected_provider_id)||String(reservation.scheduled_start)!==start||String(reservation.scheduled_end)!==end)throw new Response("Replacement Sitting reservation does not match the requested window",{status:409});if(groupId===String(booking.schedule_group_id))throw new Response("Date change must use a fresh scheduling group",{status:409});const provider=await db.prepare("SELECT name,provider_model FROM provider_capacity_profiles WHERE id=?").bind(decision.selected_provider_id).first<Row>();if(!provider)throw new Response("Replacement Sitting provider profile is missing",{status:409});return{providerId:String(decision.selected_provider_id),providerName:String(provider.name),providerModel:String(provider.provider_model)};}

export async function mutateSittingFinance(db:D1Database,input:SittingFinanceInput){if(!input.bookingId||!input.action||!input.actorId||!input.idempotencyKey)throw new Response("Booking, action, actor and idempotency key are required",{status:400});const target=selectedRow(input);await ensureSittingFinanceTables(db);const old=await prior(db,input);if(old)return{...old,duplicatePrevented:true};const booking=await context(db,input.bookingId),now=Date.now(),status=String(booking.status);
 if(input.action==="request_cancel"){
  if(["cancelled","completed"].includes(status))throw new Response("Closed Sitting bookings cannot accept a cancellation request",{status:409});if(status==="in_progress")throw new Response("In-progress Sitting cancellation requires an Operations incident workflow",{status:409});const reason=why(input),id=crypto.randomUUID();await db.prepare("INSERT INTO sitting_cancellation_requests (id,booking_id,requested_by,reason,status,created_at,updated_at) VALUES (?,?,?,?, 'policy_review_required',?,?)").bind(id,input.bookingId,input.actorId,reason,now,now).run();return remember(db,input,{requestId:id,bookingId:input.bookingId,status:"policy_review_required",refundPolicy:"configuration_required",bookingPreserved:true});
 }
 if(input.action==="approve_cancel"){
  try{
   // A delivered/in-progress stay cannot be cancelled. An already-cancelled booking may
   // still approve another legitimate split refund, within the shared captured ceiling.
   if(status==="completed")throw new Response("A delivered Sitting booking cannot be cancelled or refunded",{status:409});
   if(status==="in_progress")throw new Response("In-progress Sitting cancellation requires an Operations incident workflow",{status:409});
   const request=await db.prepare("SELECT * FROM sitting_cancellation_requests WHERE booking_id=? AND id=? AND status='policy_review_required'").bind(input.bookingId,target!.id).first<Row>();
   if(!request)throw new Response("No Sitting cancellation request is awaiting policy review",{status:409});
   if(String(request.requested_by)===String(input.actorId))throw new Response("Segregation of duties: the cancellation requester cannot approve their own refund",{status:409});
   const amount=Number(input.approvedRefundAmount),collectedTotal=await collectedForBooking(db,input.bookingId),alreadyApprovedRow=await db.prepare("SELECT COALESCE(SUM(amount),0) total FROM sitting_refund_ledger WHERE booking_id=? AND status NOT IN ('failed','cancelled')").bind(input.bookingId).first<Row>().catch(()=>null),alreadyApproved=Number(alreadyApprovedRow?.total||0),collected=Math.round(Math.max(0,collectedTotal-alreadyApproved)*100)/100;
   if(!Number.isFinite(amount)||amount<0||amount>collected)throw new Response(`Approved refund cannot exceed the amount actually collected for this booking (collected ₹${collected}). Sitting refunds are capped by captured funds, never by the booking total.`,{status:409});
   const reason=why(input),refundId=amount>0?crypto.randomUUID():null;
   const result={bookingId:input.bookingId,status:"cancelled",cancellationRequestId:target!.id,approvedRefundAmount:amount,refundId,refundStatus:refundId?"sandbox_pending":"not_required",capacityReleased:true};
   // Claim, replay result and dependent effects commit together. A zero-row claim makes
   // the existing NOT NULL cache constraint abort the batch. A failed obligation/cache
   // write cannot leave a stranded approval or cancellation. The claim reserves the
   // shared captured ceiling and also rejects a booking checked in since the read.
   const statements=[
    db.prepare(`UPDATE sitting_cancellation_requests SET status='approved',approved_refund_amount=?,decision_by=?,decision_reason=?,updated_at=?
   WHERE id=? AND booking_id=? AND status='policy_review_required'
   AND EXISTS(SELECT 1 FROM canonical_bookings WHERE id=sitting_cancellation_requests.booking_id AND status NOT IN ('completed','in_progress'))
   AND ?<=ROUND(MAX(0,?-
    (SELECT COALESCE(SUM(amount),0) FROM sitting_refund_ledger WHERE booking_id=? AND status NOT IN ('failed','cancelled'))-
    (SELECT COALESCE(SUM(r.approved_refund_amount),0) FROM sitting_cancellation_requests r WHERE r.booking_id=? AND r.status='approved'
     AND NOT EXISTS(SELECT 1 FROM sitting_refund_ledger l WHERE l.booking_id=r.booking_id AND l.cancellation_request_id=r.id))),2)`).bind(amount,input.actorId,reason,now,request.id,input.bookingId,amount,collectedTotal,input.bookingId,input.bookingId),
    db.prepare("INSERT INTO sitting_finance_action_keys (idempotency_key,booking_id,action,result_json,created_at) VALUES (?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?)").bind(input.idempotencyKey,input.bookingId,input.action,JSON.stringify(result),now),
    db.prepare("UPDATE canonical_bookings SET status='cancelled',updated_at=? WHERE id=? AND status NOT IN ('completed','in_progress')").bind(now,input.bookingId),
    db.prepare("UPDATE provider_work_orders SET status='cancelled',updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
    // Resolve the current group inside this transaction: a date change may have committed since context was read.
    db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=(SELECT schedule_group_id FROM canonical_bookings WHERE id=?) AND status!='cancelled'").bind(input.bookingId),
   ];
   if(refundId)statements.push(
    db.prepare("INSERT INTO sitting_refund_ledger (id,booking_id,cancellation_request_id,amount,currency,status,reference,policy_source,created_by,created_at,updated_at) VALUES (?,?,?,?,'INR','sandbox_pending',NULL,'explicit_staff_approval',?,?,?)").bind(refundId,input.bookingId,request.id,amount,input.actorId,now,now),
    approvedServiceRefundCase(db,{refundId,bookingId:input.bookingId,amount,reason,requestedBy:String(request.requested_by),approvedBy:input.actorId,service:"pet_sitting",cancellationRequestId:String(request.id),policySource:"explicit_staff_approval",now})
   );
   await db.batch(statements);return result;
  }catch(error){
   // A concurrent same-key request may have read before its winner committed. Replay
   // only the fully committed result; a different booking/action/row remains denied.
   const replay=await prior(db,input);if(replay)return{...replay,duplicatePrevented:true};
   const message=error instanceof Error?error.message:String(error);
   if(/NOT NULL constraint failed: sitting_finance_action_keys\.booking_id|UNIQUE constraint failed: sitting_finance_action_keys\.idempotency_key/.test(message))throw new Response("This Sitting cancellation or refundable balance changed; refresh before retrying",{status:409});
   throw error;
  }
 }
 if(input.action==="record_refund"){
  const reference=String(input.refundReference||"").trim();if(!reference)throw new Response("Sandbox refund reference is required",{status:400});const refund=await db.prepare("SELECT * FROM sitting_refund_ledger WHERE booking_id=? AND id=? AND status='sandbox_pending'").bind(input.bookingId,target!.id).first<Row>();if(!refund)throw new Response("No Sitting sandbox refund is pending",{status:409});const duplicate=await db.prepare("SELECT id FROM sitting_refund_ledger WHERE reference=?").bind(reference).first<Row>();if(duplicate&&String(duplicate.id)!==String(refund.id))throw new Response("Refund reference was already used",{status:409});
  // The same canonical chain as Boarding: the refund reaches the collection ledger, reconciliation, the booking payment and the timeline with the Sitting ledger row.
  const cancellation=refund.cancellation_request_id?await db.prepare("SELECT requested_by,decision_by,decision_reason FROM sitting_cancellation_requests WHERE id=?").bind(refund.cancellation_request_id).first<Row>():null;
  const canonical=await recordServiceLedgerRefund(db,{ledger:"sitting_refund_ledger",service:"pet_sitting",refund,cancellation,reference,actorId:input.actorId,policySource:"explicit_staff_approval",fallbackReason:"Pet Sitting cancellation refund",now});
  return remember(db,input,{bookingId:input.bookingId,status:"sandbox_recorded",refundId:refund.id,refundReference:reference,amount:Number(refund.amount),refundPosted:true,ledgerVerification:canonical.duplicate?null:canonical.ledger.verificationStatus});
 }
 if(input.action==="request_date_change"){
  if(!["confirmed","assigned"].includes(status))throw new Response("Sitting date changes are allowed only before check-in",{status:409});const start=String(input.requestedStart||""),end=String(input.requestedEnd||"");validFutureWindow(start,end);const reason=why(input),id=crypto.randomUUID();await db.prepare("INSERT INTO sitting_date_change_requests (id,booking_id,requested_start,requested_end,status,old_total,requested_by,reason,created_at,updated_at) VALUES (?,?,?,?, 'commercial_quote_required',?,?,?,?,?)").bind(id,input.bookingId,start,end,booking.total_amount,input.actorId,reason,now,now).run();return remember(db,input,{requestId:id,bookingId:input.bookingId,status:"commercial_quote_required",stayWindowUnchanged:true});
 }
 if(input.action==="apply_date_change"){
  try{
   if(!["confirmed","assigned"].includes(status))throw new Response("Sitting date changes are blocked after check-in",{status:409});
   const request=await db.prepare("SELECT * FROM sitting_date_change_requests WHERE booking_id=? AND id=? AND status='commercial_quote_required'").bind(input.bookingId,target!.id).first<Row>();
   if(!request)throw new Response("No Sitting date change is awaiting a commercial quote",{status:409});
   const start=String(request.requested_start),end=String(request.requested_end),quoteId=String(input.quoteId||"").trim(),groupId=String(input.replacementGroupId||"").trim();
   const quote=await freshQuote(db,booking,quoteId,start,end),schedule=await replacementSchedule(db,booking,groupId,start,end),oldTotal=Number(booking.total_amount),newTotal=Number(quote.total_amount),delta=newTotal-oldTotal;
   if(delta<0)throw new Response("A lower-priced date change requires an approved refund policy",{status:409});
   if(delta>0&&!String(input.paymentAdjustmentReference||"").trim())throw new Response("Additional sandbox payment reference is required",{status:409});
   const paymentRef=delta>0?String(input.paymentAdjustmentReference):null;
   const result={bookingId:input.bookingId,status:"date_changed",dateChangeRequestId:target!.id,quoteId,replacementGroupId:groupId,providerId:schedule.providerId,scheduledStart:start,scheduledEnd:end,totalAmount:newTotal,amountDelta:delta,sandboxOnly:true};
   // D1 executes this batch as one transaction. Each claim is immediately followed by a
   // changes() assertion using an existing NOT NULL booking_id constraint: a zero-row claim
   // aborts the batch before any dependent effect. Cache, claims and all canonical writes
   // roll back together on failure; no standalone applied request or success cache can remain.
   await db.batch([
    db.prepare(`UPDATE sitting_date_change_requests SET quote_id=?,replacement_group_id=?,status='applied',new_total=?,amount_delta=?,payment_adjustment_reference=?,updated_at=?
     WHERE id=? AND booking_id=? AND status='commercial_quote_required'
     AND EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND status IN ('confirmed','assigned') AND schedule_group_id=? AND total_amount=?)`)
     .bind(quoteId,groupId,newTotal,delta,paymentRef,now,request.id,input.bookingId,input.bookingId,booking.schedule_group_id,oldTotal),
    db.prepare("INSERT INTO sitting_finance_action_keys (idempotency_key,booking_id,action,result_json,created_at) VALUES (?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?)")
     .bind(input.idempotencyKey,input.bookingId,input.action,JSON.stringify(result),now),
    db.prepare("UPDATE sitting_commercial_quotes SET status='used',used_at=?,used_booking_id=? WHERE id=? AND status='open' AND expires_at>=?").bind(now,input.bookingId,quoteId,now),
    db.prepare("INSERT INTO sitting_date_change_quote_links (quote_id,booking_id,request_id,created_at) VALUES (?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)").bind(quoteId,input.bookingId,request.id,now),
    db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=? AND status!='cancelled'").bind(booking.schedule_group_id),
    db.prepare("UPDATE canonical_bookings SET schedule_group_id=?,provider_id=?,scheduled_start=?,scheduled_end=?,total_amount=?,updated_at=? WHERE id=?").bind(groupId,schedule.providerId,start,end,newTotal,now,input.bookingId),
    db.prepare("UPDATE provider_work_orders SET schedule_group_id=?,provider_id=?,provider_name=?,provider_model=?,scheduled_start=?,scheduled_end=?,status='assigned',updated_at=? WHERE booking_id=?").bind(groupId,schedule.providerId,schedule.providerName,schedule.providerModel,start,end,now,input.bookingId),
    db.prepare("UPDATE booking_payments SET amount=?,amount_due_now=?,detail_json=?,updated_at=? WHERE booking_id=?").bind(newTotal,newTotal,JSON.stringify({dateChange:true,previousTotal:oldTotal,amountDelta:delta,paymentAdjustmentReference:paymentRef,liveMoney:false}),now,input.bookingId),
   ]);
   return result;
  }catch(error){
   // An exact concurrent retry may have missed the initial cache read. Its winner's cache
   // is now committed with the complete transaction; another key/row never acquires it.
   const replay=await prior(db,input);if(replay)return{...replay,duplicatePrevented:true};
   const message=error instanceof Error?error.message:String(error);
   if(/NOT NULL constraint failed: (sitting_finance_action_keys|sitting_date_change_quote_links)\.booking_id|UNIQUE constraint failed: sitting_date_change_quote_links\.quote_id/.test(message))throw new Response("This Sitting date change or quote changed; refresh before retrying",{status:409});
   throw error;
  }
 }
 if(input.action==="prepare_settlement"){
  if(status!=="completed")throw new Response("Sitter settlement can be prepared only after canonical checkout",{status:409});
  // Sitting checkout already resolves the authoritative provider commercial split and posts the
  // balanced service-completion journal. This ledger is a projection of that truth, never a second
  // payout calculator. Finance approval and RazorpayX instruction remain separate guarded steps.
  const payout=await db.prepare("SELECT provider_net_payout,computed_at FROM provider_payout_computations WHERE booking_id=? AND provider_id=? AND service_code='pet_sitting'").bind(input.bookingId,booking.provider_id).first<Row>().catch(()=>null);
  const payable=await db.prepare("SELECT COALESCE(SUM(credit-debit),0) amount,MAX(created_at) resolved_at FROM finance_journal_entries WHERE source_type='service_completion' AND source_id=? AND account_code='2110-Provider Payable' AND posted=1").bind(input.bookingId).first<Row>().catch(()=>null);
  const payoutAmount=Math.round(Number(payable?.amount||0)*100)/100;
  if(!payout||!Number.isFinite(payoutAmount)||payoutAmount<0)throw new Response("Canonical Sitting completion finance must be resolved before sitter settlement",{status:409});
  const completedAt=Number(payable?.resolved_at||payout.computed_at||now),holdDays=await providerPayoutHoldDays(db,completedAt),eligibleAt=completedAt+holdDays*24*60*60*1000;
  await db.prepare("INSERT INTO sitting_sitter_settlement_ledger (booking_id,provider_id,gross_booking_value,currency,base_payout,travel_allowance,incentives,penalties,cash_adjustment,payout_amount,payout_rule_status,tax_status,approval_status,payout_status,eligible_at,approved_by,payout_reference,created_at,updated_at) VALUES (?,?,?,'INR',?,0,0,0,0,?,'rule_applied','resolved','awaiting_finance_approval','not_instructed',?,NULL,NULL,?,?) ON CONFLICT(booking_id) DO UPDATE SET provider_id=excluded.provider_id,gross_booking_value=excluded.gross_booking_value,base_payout=excluded.base_payout,travel_allowance=0,incentives=0,penalties=0,cash_adjustment=0,payout_amount=excluded.payout_amount,payout_rule_status='rule_applied',tax_status='resolved',approval_status=CASE WHEN sitting_sitter_settlement_ledger.approval_status IN ('approved','paid') THEN sitting_sitter_settlement_ledger.approval_status ELSE 'awaiting_finance_approval' END,payout_status=CASE WHEN sitting_sitter_settlement_ledger.payout_status!='not_instructed' THEN sitting_sitter_settlement_ledger.payout_status ELSE 'not_instructed' END,eligible_at=excluded.eligible_at,updated_at=excluded.updated_at").bind(input.bookingId,booking.provider_id,booking.total_amount,Number(payout.provider_net_payout),payoutAmount,eligibleAt,now,now).run();
  return remember(db,input,{bookingId:input.bookingId,status:"settlement_prepared",basePayout:Number(payout.provider_net_payout),payoutAmount,payoutRule:"rule_applied",tax:"resolved",approvalStatus:"awaiting_finance_approval",payoutStatus:"not_instructed",eligibleAt,payoutSlaDays:holdDays,source:"canonical_service_completion"});
 }
 if(input.action==="approve_settlement"){
  if(status!=="completed")throw new Response("Sitter settlement can be approved only after canonical checkout",{status:409});
  const reason=why(input),settlement=await db.prepare("SELECT * FROM sitting_sitter_settlement_ledger WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if(!settlement)throw new Response("Prepare the canonical Sitting settlement before approval",{status:409});
  if(String(settlement.payout_rule_status)!=="rule_applied"||String(settlement.tax_status)!=="resolved"||!Number.isFinite(Number(settlement.payout_amount)))throw new Response("Sitting settlement is not backed by resolved canonical completion finance",{status:409});
  if(Number(settlement.eligible_at)>now)throw new Response(`Sitting settlement is not yet eligible under the ${await providerPayoutHoldDays(db)}-day payout policy`,{status:409});
  if(String(settlement.approval_status)==="approved")return remember(db,input,{bookingId:input.bookingId,status:"approved",approvedBy:settlement.approved_by,payoutStatus:String(settlement.payout_status),duplicateApproval:true});
  const claim=await db.prepare("UPDATE sitting_sitter_settlement_ledger SET approval_status='approved',approved_by=?,updated_at=? WHERE booking_id=? AND approval_status='awaiting_finance_approval' AND payout_rule_status='rule_applied' AND tax_status='resolved' AND eligible_at<=?").bind(input.actorId,now,input.bookingId,now).run();
  if(Number(claim?.meta?.changes||0)!==1)throw new Response("Sitting settlement approval state changed; refresh before retrying",{status:409});
  return remember(db,input,{bookingId:input.bookingId,status:"approved",approvedBy:input.actorId,reason,payoutAmount:Number(settlement.payout_amount),payoutStatus:"not_instructed",liveMoney:false});
 }
 if(input.action==="reconcile"){
  const refunds=await db.prepare("SELECT COALESCE(SUM(amount),0) total,COUNT(*) count FROM sitting_refund_ledger WHERE booking_id=? AND status='sandbox_recorded'").bind(input.bookingId).first<Row>(),settlement=await db.prepare("SELECT * FROM sitting_sitter_settlement_ledger WHERE booking_id=?").bind(input.bookingId).first<Row>(),refundTotal=Number(refunds?.total||0),captured=Number(booking.captured_amount||0),net=Math.max(0,captured-refundTotal),refundState=refundTotal>0?"sandbox_recorded":String(booking.payment_status)==="captured"?"none":"attention_required",settlementState=settlement?String(settlement.approval_status):status==="completed"?"attention_required":"not_due",taxState=settlement?String(settlement.tax_status):"configuration_required",attention=refundState==="attention_required"||taxState==="configuration_required"||(status==="completed"&&settlementState!=="approved");const id=crypto.randomUUID();await db.prepare("INSERT INTO sitting_finance_reconciliation (id,booking_id,booking_total,captured_amount,refund_total,net_customer_amount,settlement_amount,refund_state,settlement_state,tax_state,status,detail_json,checked_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,input.bookingId,booking.total_amount,captured,refundTotal,net,settlement?.payout_amount??null,refundState,settlementState,taxState,attention?"attention_required":"balanced",JSON.stringify({sandboxOnly:true,paymentStatus:booking.payment_status}),input.actorId,now).run();return remember(db,input,{bookingId:input.bookingId,reconciliationId:id,status:attention?"attention_required":"balanced",refundState,settlementState,taxState,netCustomerAmount:net});
 }
 throw new Response("Unsupported Sitting finance action",{status:400});
}
