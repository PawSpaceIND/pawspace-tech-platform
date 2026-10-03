import{isNativeDemoThread}from"./native-attended-demo";
import{createUnifiedCase,ensureUnifiedCaseTables}from"./unified-case-center";
import{notifyUnifiedCaseOwner}from"./staff-alert-center";
type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim();
/** Reconcile a canonical handoff to the existing case/inbox engines; never external dispatch. */
export async function ensureConversationHandoffTicket(db:D1Database,input:{handoffId:string;threadId:string;customerId:string;actorId:string}){
 if(isNativeDemoThread(input.threadId))return{caseId:null,threadId:input.threadId,alert:null,blockedBy:"native_demo_business_actions_forbidden",externalDelivery:false,refundApproved:false,refundProcessed:false};
 await ensureUnifiedCaseTables(db);
 const thread=await db.prepare("SELECT customer_id,booking_id,lead_id,ticket_id FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
 const handoff=await db.prepare("SELECT customer_id,thread_id,reason FROM ai_handoffs WHERE id=?").bind(input.handoffId).first<Row>();
 if(!thread||!handoff||text(thread.customer_id)!==input.customerId||text(handoff.customer_id)!==input.customerId||text(handoff.thread_id)!==input.threadId)throw new Response("Handoff ticket ownership denied",{status:403});
 let bookingId=text(thread.booking_id)||null;const leadId=text(thread.lead_id)||null;
 if(bookingId&&!await db.prepare("SELECT id FROM canonical_bookings WHERE id=? AND customer_id=?").bind(bookingId,input.customerId).first())throw new Response("Handoff booking ownership denied",{status:403});
 if(leadId&&!await db.prepare("SELECT id FROM lead_work_items WHERE id=? AND customer_id=?").bind(leadId,input.customerId).first())throw new Response("Handoff lead ownership denied",{status:403});
 let linked:Row|null=null;
 if(thread.ticket_id){linked=await db.prepare("SELECT * FROM unified_cases WHERE id=? AND customer_id=? AND status NOT IN ('resolved','closed')").bind(thread.ticket_id,input.customerId).first<Row>();if(!linked)throw new Response("Handoff ticket binding conflicts",{status:409});}
 const finance=text(handoff.reason)==="refund_payment_dispute";
 // Audio's typed refund adapter owns this case. Reuse its active episode, never create another refund request.
 if(!linked&&finance){
  if(bookingId)linked=await db.prepare("SELECT * FROM unified_cases WHERE customer_id=? AND booking_id=? AND source_type='ai_customer_refund_request' AND status IN ('open','in_progress','waiting') ORDER BY created_at DESC,id DESC LIMIT 1").bind(input.customerId,bookingId).first<Row>();
  else{const requests=await db.prepare("SELECT DISTINCT c.* FROM unified_case_events e JOIN unified_cases c ON c.id=e.case_id WHERE c.customer_id=? AND c.source_type='ai_customer_refund_request' AND c.status IN ('open','in_progress','waiting') AND e.event_type='customer_refund_requested' AND json_extract(e.detail_json,'$.threadId')=? AND json_extract(e.detail_json,'$.customerId')=? ORDER BY c.created_at DESC,c.id DESC LIMIT 2").bind(input.customerId,input.threadId,input.customerId).all<Row>();if(requests.results.length>1)throw new Response("Multiple refund requests need explicit case selection",{status:409});linked=requests.results[0]||null;}
 }
 if(finance){
  const typed=linked&&text(linked.source_type)==="ai_customer_refund_request"&&text(linked.case_type)==="refund"&&text(linked.owner_team)==="finance"&&text(linked.customer_id)===input.customerId&&text(linked.booking_id);
  const event=typed?await db.prepare("SELECT id FROM unified_case_events WHERE case_id=? AND event_type='customer_refund_requested' AND json_extract(detail_json,'$.threadId')=? AND json_extract(detail_json,'$.customerId')=? AND json_extract(detail_json,'$.bookingId')=? LIMIT 1").bind(text(linked!.id),input.threadId,input.customerId,text(linked!.booking_id)).first():null;
  if(!event)return{caseId:null,threadId:input.threadId,alert:null,blockedBy:"typed_refund_request_required",externalDelivery:false,refundApproved:false,refundProcessed:false};
 }
 if(linked?.booking_id){if(bookingId&&text(linked.booking_id)!==bookingId)throw new Response("Case booking conflicts with handoff",{status:409});bookingId=text(linked.booking_id);if(!await db.prepare("SELECT id FROM canonical_bookings WHERE id=? AND customer_id=?").bind(bookingId,input.customerId).first())throw new Response("Case booking ownership denied",{status:403});}

 const created=linked?{case:linked}:await createUnifiedCase(db,{idempotencyKey:`conversation-handoff:${input.handoffId}`,caseType:finance?"refund":"lead_escalation",severity:finance?"high":"medium",title:"Conversation requires human followup",description:`Canonical conversation handoff: ${text(handoff.reason)}`,customerId:input.customerId,bookingId,leadId,sourceType:"ai_handoff",sourceId:input.handoffId,ownerTeam:finance?"finance":"operations",actorId:input.actorId});
 const caseId=text(created.case?.id);if(!caseId)throw new Error("Canonical handoff case receipt missing");
 await db.prepare("UPDATE communication_threads SET ticket_id=? WHERE id=? AND customer_id=? AND (ticket_id IS NULL OR ticket_id=?)").bind(caseId,input.threadId,input.customerId,caseId).run();
 const bound=await db.prepare("SELECT ticket_id FROM communication_threads WHERE id=? AND customer_id=?").bind(input.threadId,input.customerId).first<Row>();if(text(bound?.ticket_id)!==caseId)throw new Response("Handoff ticket changed concurrently",{status:409});
 const alert=await notifyUnifiedCaseOwner(db,{caseId,actorId:input.actorId});
 return{caseId,threadId:input.threadId,alert,externalDelivery:false,refundApproved:false,refundProcessed:false};
}
