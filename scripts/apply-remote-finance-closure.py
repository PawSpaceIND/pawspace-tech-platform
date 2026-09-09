#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path):
    return (ROOT / path).read_text()

def write(path, text):
    (ROOT / path).write_text(text)

def one(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

def rx(path, pattern, replacement, flags=0):
    text = read(path)
    out, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one regex match, found {count}: {pattern[:120]!r}")
    write(path, out)

# 1. Finance refund retry state machine.
ops = "app/api/booking-operations/route.ts"
one(ops,
    'refundStatus?: "approved" | "processing" | "completed" | "rejected";',
    'refundStatus?: "requested" | "approved" | "processing" | "completed" | "rejected";')
one(ops,
    'const transitions:Record<string,string[]>={requested:["approved","rejected"],approved:["processing"],processing:["completed"],processed:["completed"]};',
    'const transitions:Record<string,string[]>={requested:["approved","rejected"],approved:["processing"],failed:["requested","processing"],processing:["completed"],processed:["completed"]};')
one(ops,
    'if (!(transitions[fromStatus]??[]).includes(toStatus)) return json({ error: `Refund cannot move from ${fromStatus} to ${toStatus}` },409);\n      if(toStatus==="approved"&&String(refund.requested_by)===actor.email)return json({error:"Segregation of duties: the refund requester cannot approve their own refund",code:"refund_self_approval_forbidden"},409);',
    'if (!(transitions[fromStatus]??[]).includes(toStatus)) return json({ error: `Refund cannot move from ${fromStatus} to ${toStatus}` },409);\n      if(fromStatus==="failed"&&toStatus==="processing"&&!String(refund.approved_by||"").trim())return json({error:"A failed refund cannot resume processing until it has an approved checker",code:"refund_retry_requires_approval"},409);\n      if(toStatus==="approved"&&String(refund.requested_by)===actor.email)return json({error:"Segregation of duties: the refund requester cannot approve their own refund",code:"refund_self_approval_forbidden"},409);')
one(ops,
    'const message=toStatus==="approved"?"Your refund is approved and will now be sent to the original payment method.":toStatus==="processing"?"Your refund has been sent to the payment gateway for processing.":toStatus==="completed"?"Your refund is complete. The gateway reference is available in this order.":"Your refund request was not approved. Open the order to see the reason or contact support.";',
    'const message=toStatus==="requested"?"Your refund has returned to Finance review after a failed gateway attempt.":toStatus==="approved"?"Your refund is approved and will now be sent to the original payment method.":toStatus==="processing"?"Your refund has been sent to the payment gateway for processing.":toStatus==="completed"?"Your refund is complete. The gateway reference is available in this order.":"Your refund request was not approved. Open the order to see the reason or contact support.";')

pattern = r'''      const guard="EXISTS \(SELECT 1 FROM booking_refund_transition_claims WHERE refund_case_id=\? AND from_status=\? AND to_status=\? AND claim_token=\?\)";\n      const applied=await db\.batch\(\[\n(?P<body>.*?)\n      \]\);\n      if\(Number\(applied\[0\]\?\.meta\?\.changes\|\|0\)!==1\|\|Number\(applied\[1\]\?\.meta\?\.changes\|\|0\)!==1\)return json\(\{error:"Refund status was already changed by another request",code:"refund_transition_already_claimed"\},409\);'''
text = read(ops)
m = re.search(pattern, text, flags=re.S)
if not m:
    raise SystemExit("booking-operations refund transition batch shape drifted")
body = m.group("body")
replacement = '''      const guard="EXISTS (SELECT 1 FROM booking_refund_transition_claims WHERE refund_case_id=? AND from_status=? AND to_status=? AND claim_token=?)";
      // Retry cycles may revisit a previously claimed state. Clear only retry-control claims inside
      // this transaction; immutable lifecycle/security audit records remain the financial history.
      const retryReset=fromStatus==="failed"
        ?db.prepare(toStatus==="requested"
          ?"DELETE FROM booking_refund_transition_claims WHERE refund_case_id=? AND from_status IN ('failed','requested','approved')"
          :"DELETE FROM booking_refund_transition_claims WHERE refund_case_id=? AND from_status='failed'").bind(input.refundCaseId)
        :null;
      const transitionStatements=[];
      if(retryReset)transitionStatements.push(retryReset);
      transitionStatements.push(
''' + body.replace('db.prepare(`UPDATE booking_refund_cases SET status=?,approved_by=CASE WHEN ?=\'approved\' THEN ? ELSE approved_by END,updated_at=? WHERE id=? AND status=? AND ${guard}`).bind(toStatus,toStatus,actor.email,now,input.refundCaseId,fromStatus,input.refundCaseId,fromStatus,toStatus,claim),', 'db.prepare(`UPDATE booking_refund_cases SET status=?,approved_by=CASE WHEN ?=\'approved\' THEN ? WHEN ?=\'requested\' THEN NULL ELSE approved_by END,updated_at=? WHERE id=? AND status=? AND ${guard}`).bind(toStatus,toStatus,actor.email,toStatus,now,input.refundCaseId,fromStatus,input.refundCaseId,fromStatus,toStatus,claim),') + '''
      );
      const applied=await db.batch(transitionStatements);
      const claimIndex=retryReset?1:0,updateIndex=claimIndex+1;
      if(Number(applied[claimIndex]?.meta?.changes||0)!==1||Number(applied[updateIndex]?.meta?.changes||0)!==1)return json({error:"Refund status was already changed by another request",code:"refund_transition_already_claimed"},409);'''
write(ops, text[:m.start()] + replacement + text[m.end():])

# Allow the sandbox adapter to continue only a governed failed->processing recovery.
sandbox = "app/api/grooming-payment-sandbox/route.ts"
one(sandbox,
    'if(String(refund.status)!=="approved")return json({error:"This refund case is not approved; approve it before a gateway refund",code:"refund_not_approved",refundCaseStatus:String(refund.status)},409);',
    '''const refundStatus=String(refund.status);\n    const retryTransition=refundStatus==="processing"\n      ?await db.prepare("SELECT id FROM booking_refund_transition_claims WHERE refund_case_id=? AND from_status='failed' AND to_status='processing' ORDER BY created_at DESC LIMIT 1").bind(refund.id).first<Record<string,unknown>>().catch(()=>null)\n      :null;\n    if(refundStatus!=="approved"&&!retryTransition)return json({error:"This refund case is not approved for gateway processing",code:"refund_not_approved",refundCaseStatus:refundStatus},409);''')
one(sandbox,
    'const claimTime=Date.now();const claim=await db.prepare("UPDATE booking_refund_cases SET status=\'processing\',updated_at=? WHERE id=? AND status=\'approved\'").bind(claimTime,refund.id).run();\n    if(Number(claim.meta?.changes||0)!==1)return json({error:"This refund case is already being processed",code:"refund_already_claimed",refundCaseId:String(refund.id)},409);',
    '''const claimTime=Date.now();\n    const claim=refundStatus==="approved"\n      ?await db.prepare("UPDATE booking_refund_cases SET status='processing',updated_at=? WHERE id=? AND status='approved'").bind(claimTime,refund.id).run()\n      :await db.prepare("UPDATE booking_refund_cases SET updated_at=? WHERE id=? AND status='processing'").bind(claimTime,refund.id).run();\n    if(Number(claim.meta?.changes||0)!==1)return json({error:"This refund case is already being processed",code:"refund_already_claimed",refundCaseId:String(refund.id)},409);''')
one(sandbox,
    'await db.prepare("UPDATE booking_refund_cases SET status=\'approved\',updated_at=? WHERE id=? AND status=\'processing\' AND gateway_reference IS NULL").bind(Date.now(),refund.id).run();',
    'await db.prepare("UPDATE booking_refund_cases SET status=\'approved\',updated_at=? WHERE id=? AND status=\'processing\'").bind(Date.now(),refund.id).run();')

# 2 + 6. Inner webhook event recovery and refund-completion ledger posting.
recon = "lib/grooming-payment-reconciliation.ts"
one(recon,
    'export async function processGatewayEvent(db:Db,event:GatewayEvent){',
    'export async function processGatewayEvent(db:Db,event:GatewayEvent,options:{allowRecovery?:boolean}={}){')

rx(recon,
   r'''  const existing=await db\.prepare\("SELECT id,processing_status,event_type,booking_id FROM payment_gateway_events WHERE provider=\? AND event_id=\?"\)\.bind\(event\.provider,event\.eventId\)\.first<Row>\(\);\n  if\(existing\)\{.*?\n  \}\n  const now=Date\.now\(\),rowId=`PAYEV-\$\{crypto\.randomUUID\(\)\.slice\(0,12\)\.toUpperCase\(\)\}`;await db\.prepare\("INSERT INTO payment_gateway_events .*?\n''',
   '''  const now=Date.now();\n  const existing=await db.prepare("SELECT id,processing_status,event_type,booking_id FROM payment_gateway_events WHERE provider=? AND event_id=?").bind(event.provider,event.eventId).first<Row>();\n  let rowId="";\n  if(existing){\n    const existingStatus=String(existing.processing_status);\n    // D1 has no SELECT FOR UPDATE. The safe equivalent is the outer inbox CAS plus this inner\n    // compare-and-set on the unique provider/event identity. Only an outer FAILED retry may re-enter.\n    if(options.allowRecovery&&["received","processing"].includes(existingStatus)){\n      const reclaimed=await db.prepare("UPDATE payment_gateway_events SET processing_status='processing',failure_reason=NULL,processed_at=NULL WHERE id=? AND processing_status IN ('received','processing')").bind(existing.id).run();\n      if(Number(reclaimed.meta?.changes||0)===1)rowId=String(existing.id);\n    }\n    if(!rowId){\n      const repairBookingId=existingStatus==="processed"?String(existing.booking_id||"").trim():"";\n      if(repairBookingId){\n        if(["payment.captured","order.paid","payment_link.paid"].includes(String(existing.event_type)))await activateSubscriptionOnCapture(db,{bookingId:repairBookingId,eventId:event.eventId}).catch(()=>null);\n        else if(String(existing.event_type)==="payment.failed")await failSubscriptionOnPaymentFailure(db,{bookingId:repairBookingId,eventId:event.eventId}).catch(()=>null);\n      }\n      return{duplicate:true,status:existingStatus};\n    }\n  }\n  if(!rowId){\n    const candidate=`PAYEV-${crypto.randomUUID().slice(0,12).toUpperCase()}`;\n    const inserted=await db.prepare("INSERT OR IGNORE INTO payment_gateway_events (id,provider,environment,event_id,event_type,booking_id,payment_id,gateway_order_id,gateway_payment_id,gateway_refund_id,amount_subunits,currency,signature_verified,payload_hash,processing_status,detail_json,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,'processing',?,?)").bind(candidate,event.provider,event.environment,event.eventId,event.eventType,event.bookingId??null,null,event.gatewayOrderId??null,event.gatewayPaymentId??null,event.gatewayRefundId??null,event.amountSubunits??null,event.currency??null,event.payloadHash,JSON.stringify(event.detail||{}),now).run();\n    if(Number(inserted.meta?.changes||0)!==1){const winner=await db.prepare("SELECT processing_status FROM payment_gateway_events WHERE provider=? AND event_id=?").bind(event.provider,event.eventId).first<Row>();return{duplicate:true,status:String(winner?.processing_status||"processing")};}\n    rowId=candidate;\n  }\n''',
   flags=re.S)

# The regex above deliberately replaces the old insert too. Ensure only one finish function remains.
if read(recon).count('const finish=async(status:"processed"|"exception"') != 1:
    raise SystemExit("grooming-payment-reconciliation finish function shape invalid after recovery patch")

capture_helper = '''async function postBookingCollectionOnCapture(db:Db,input:{bookingId:string;paymentId:string;eventId?:string|null}){\n  const payment=await db.prepare("SELECT id,customer_id,amount,method FROM booking_payments WHERE id=?").bind(input.paymentId).first<Row>();\n  if(!payment)return;\n  const booking=await db.prepare("SELECT city_id,service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);\n  const method=String(payment.method||"").toLowerCase();\n  await postCollectionEvent(db,{\n    event:method==="cash"?"cash_collected_confirmed":"online_payment_captured",\n    bookingId:input.bookingId,customerId:payment.customer_id?String(payment.customer_id):null,\n    cityId:booking?.city_id?String(booking.city_id):null,serviceCode:booking?.service_code?String(booking.service_code):null,\n    paymentId:String(payment.id),amount:Number(payment.amount||0),paymentMethod:method||null,\n    collectorId:method==="cash"?"gateway_reconciliation":null,\n    entryDate:new Date().toISOString().slice(0,10),transactionAt:Date.now(),actorId:"gateway_reconciliation",\n  });\n}'''
refund_helper = capture_helper + '''\n\nasync function postBookingRefundOnProcessed(db:Db,input:{bookingId:string;paymentId:string;refundReference:string;amount:number;eventAt:number}){\n  const payment=await db.prepare("SELECT id,customer_id,method FROM booking_payments WHERE id=?").bind(input.paymentId).first<Row>();\n  if(!payment)return;\n  const booking=await db.prepare("SELECT city_id,service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);\n  const method=String(payment.method||"").toLowerCase();\n  const refundInstrument=method==="cash"?"cash":(["bank","bank_transfer"].includes(method)?"bank":"gateway");\n  const at=Number.isFinite(input.eventAt)&&input.eventAt>0?input.eventAt:Date.now();\n  await postCollectionEvent(db,{event:"refund_completed",bookingId:input.bookingId,customerId:payment.customer_id?String(payment.customer_id):null,cityId:booking?.city_id?String(booking.city_id):null,serviceCode:booking?.service_code?String(booking.service_code):null,paymentId:String(payment.id),refundReference:input.refundReference,amount:input.amount,paymentMethod:method||null,refundInstrument,entryDate:new Date(at).toISOString().slice(0,10),transactionAt:at,actorId:"razorpay_webhook"});\n}'''
one(recon, capture_helper, refund_helper)
one(recon,
    'if(event.eventType==="refund.processed"&&alreadyProcessed){await finish("processed","Duplicate logical refund ignored");return{duplicate:false,status:"processed",ignored:true,reason:"refund_already_processed"};}',
    'if(event.eventType==="refund.processed"&&alreadyProcessed){if(event.gatewayRefundId)await postBookingRefundOnProcessed(db,{bookingId,paymentId,refundReference:event.gatewayRefundId,amount:expectedRefund,eventAt:event.createdAt??now});await finish("processed","Duplicate logical refund ignored");return{duplicate:false,status:"processed",ignored:true,reason:"refund_already_processed"};}')
one(recon,
    'await upsert(nextRefunded>=expected?"refunded":"partially_refunded",overage>0.009?"refund_overage":"matched",capturedCurrent,nextRefunded,overage>0?overage:0);if(overage>0.009)await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"refund_overage",detail:{expected,captured:capturedCurrent,refundCeiling,refunded:nextRefunded}});await lifecycle(db,bookingId,"refund_processed",{gateway:event.provider,eventId:event.eventId,gatewayRefundId:event.gatewayRefundId,amount});',
    'await upsert(nextRefunded>=expected?"refunded":"partially_refunded",overage>0.009?"refund_overage":"matched",capturedCurrent,nextRefunded,overage>0?overage:0);if(overage>0.009)await addException(db,{bookingId,paymentId,eventId:event.eventId,type:"refund_overage",detail:{expected,captured:capturedCurrent,refundCeiling,refunded:nextRefunded}});if(event.gatewayRefundId)await postBookingRefundOnProcessed(db,{bookingId,paymentId,refundReference:event.gatewayRefundId,amount,eventAt:event.createdAt??now});await lifecycle(db,bookingId,"refund_processed",{gateway:event.provider,eventId:event.eventId,gatewayRefundId:event.gatewayRefundId,amount});')

webhook = "app/api/razorpay-webhook/route.ts"
one(webhook,
    'if(!(await claimInbox(db,accepted.row,eventType))){',
    'const recoveringFailedInbox=String(accepted.row.processing_status||"").toUpperCase()==="FAILED";\n    if(!(await claimInbox(db,accepted.row,eventType))){')
one(webhook,
    'const governed=await processGatewayEvent(db,event);',
    'const governed=await processGatewayEvent(db,event,{allowRecovery:recoveringFailedInbox});')
one(webhook,
    'const result=await processGatewayEvent(db,event);',
    'const result=await processGatewayEvent(db,event,{allowRecovery:recoveringFailedInbox});')

# 3. Refund recognition is completed money only.
company = "lib/company-analytics.ts"
one(company,"status IN ('processing','processed','completed')","status IN ('processed','completed')")
one(company,'refundsStatus:"booking_refund_cases_processing_processed_completed"','refundsStatus:"booking_refund_cases_processed_completed"')
unit = "lib/unit-economics.ts"
one(unit,"status IN ('processing','processed','completed')","status IN ('processed','completed')")
one(unit,'refunds:"booking_refund_cases status=processing|processed|completed"','refunds:"booking_refund_cases status=processed|completed"')
pnl = "lib/pnl-reporting.ts"
one(pnl,"status IN ('processing','processed','completed')","status IN ('processed','completed')")

# 4. Direct cancellation durable notification + canonical communication handoff.
change = "app/api/grooming-booking-change/route.ts"
one(change,
    'import{listAuthoritativeAvailability}from"../../../lib/scheduling-roster-authority";',
    'import{listAuthoritativeAvailability}from"../../../lib/scheduling-roster-authority";\nimport{bridgeLifecycleCommunications}from"../../../lib/lifecycle-communications";')
one(change,
    '  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'requested\',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),',
    '  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'requested\',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),\n  db.prepare("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'queued\',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),')
one(change,
    'const refundId=refundAmount>0?crypto.randomUUID():null;\n      const usage=',
    'const refundId=refundAmount>0?crypto.randomUUID():null;\n      const cancellationEventId=crypto.randomUUID();\n      const cancellationMessage=refundAmount>0?`Your PawSpace Grooming booking is cancelled. A refund of ₹${refundAmount.toFixed(2)} is pending reconciliation.`:"Your PawSpace Grooming booking is cancelled.";\n      const usage=')
one(change,
    '        db.prepare("UPDATE booking_payments SET status=?,detail_json=json_set(json_set(detail_json,\'$.cancelReason\',?),\'$.commercialPolicyEvaluation\',json(?)),updated_at=? WHERE booking_id=?").bind(refundAmount>0?"refund_pending":"cancelled",reason,JSON.stringify(policyEvaluation),now,input.bookingId),',
    '        db.prepare("UPDATE booking_payments SET status=?,detail_json=json_set(json_set(detail_json,\'$.cancelReason\',?),\'$.commercialPolicyEvaluation\',json(?)),updated_at=? WHERE booking_id=?").bind(refundAmount>0?"refund_pending":"cancelled",reason,JSON.stringify(policyEvaluation),now,input.bookingId),\n        db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.bookingId,input.customerId,"whatsapp",refundAmount>0?"grooming_booking_cancelled_refund_pending":"grooming_booking_cancelled",cancellationMessage,"queued",cancellationEventId,now),')
one(change,
    '      await db.batch(statements);\n      let referral:',
    '      await db.batch(statements);\n      const customerCommunication=await bridgeLifecycleCommunications(db,{bookingId:input.bookingId,source:"booking_customer_notifications",actorId:auditActor});\n      let referral:')
one(change,
    'capacityReleased:true,subscriptionSessionsReleased:reservedSessions,referral}});',
    'capacityReleased:true,subscriptionSessionsReleased:reservedSessions,customerCommunication,referral}});')

# 5. Explicit critical Finance work item for refund failure.
queue = "lib/ops-work-queue.ts"
one(queue,
    '  for(const row of rows.results)await record({rule:"payment_exception",queue:"finance",priority:String(row.severity)==="critical"?"critical":"high",title:`Payment reconciliation exception: ${String(row.exception_type)}`,bookingId:row.booking_id?String(row.booking_id):null,entityType:"payment_exception",entityId:String(row.id),slaMinutes:120,detail:{exceptionType:row.exception_type,severity:row.severity,paymentId:row.payment_id}});',
    '  for(const row of rows.results){const refundFailed=String(row.exception_type)==="refund_failed";await record({rule:refundFailed?"refund_failed":"payment_exception",queue:"finance",priority:refundFailed||String(row.severity)==="critical"?"critical":"high",title:refundFailed?`Refund failed for booking ${String(row.booking_id||"unknown")} — Finance recovery required`:`Payment reconciliation exception: ${String(row.exception_type)}`,bookingId:row.booking_id?String(row.booking_id):null,entityType:"payment_exception",entityId:String(row.id),slaMinutes:refundFailed?60:120,detail:{exceptionType:row.exception_type,severity:row.severity,paymentId:row.payment_id}});}')
route = "app/api/ops-work-queue/route.ts"
one(route,
    '["provider_unassigned","refund_requested","payment_exception","low_rating_callback","relocation_enquiry","food_renewal_payment_overdue","lead_response_overdue"]',
    '["provider_unassigned","refund_requested","refund_failed","payment_exception","low_rating_callback","relocation_enquiry","food_renewal_payment_overdue","lead_response_overdue"]')

print("guarded remote finance closure patch applied")
