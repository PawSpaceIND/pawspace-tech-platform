import {assertNativeDemoBusinessAllowed} from "./native-attended-demo";
import {createUnifiedCase,ensureUnifiedCaseTables} from './unified-case-center';
import {requireCustomerOwnership,type AuthenticatedActor} from './server-auth';
import {assertAiMayReply} from './ai-human-handoff';
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??'').trim();
const source='ai_customer_refund_request';
const hash=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
export function isCustomerRefundRequest(value:string){
 if(value.length>1200||/\b(?:just asking|only asking|no action|not yet|don't take action|don’t take action|do not take action)\b/i.test(value)||/\b(?:don't|don’t|do not)\b.{0,35}\b(?:create|record|submit|raise|open)\b/i.test(value)||/["“”]|\b(?:policy|terms|eligibility|eligible|hypothetical|example|if|know|understand|explain)\b/i.test(value)||/\b(?:don't|don’t|do not|not asking|not requesting)\b.{0,45}\b(?:refund|money back)\b/i.test(value))return false;
 return /^(?:(?:okay|ok|yes|sure),?\s+)?(?:i|we)\s+(?:want|need|would like|request)\b.{0,60}\b(?:refund|money back)\b/i.test(value)||/^(?:please\s+)?(?:request|raise|open|submit)\b.{0,40}\brefund\b/i.test(value)||/^(?:please\s+)?refund\s+(?:my|the|this)\s+booking\b/i.test(value);
}
/** A typed Finance-review intake, using the existing case engine. No amount, approval or payment mutation. */
export async function recordCustomerRefundRequest(db:D1Database,input:{actor:AuthenticatedActor;customerId:string;threadId:string;bookingId:string;reason:string;channel:'voice'|'chat';idempotencyKey:string}){
 if(!input.actor.permissions.includes('*')&&!input.actor.permissions.includes('customers.manage'))await requireCustomerOwnership(db,input.actor,input.customerId);
 if(!['voice','chat'].includes(input.channel)||!text(input.idempotencyKey)||!text(input.reason))throw new Response('Refund request input is incomplete',{status:400});
 const thread=await db.prepare('SELECT customer_id,status,lead_id FROM communication_threads WHERE id=?').bind(input.threadId).first<Row>();
 if(!thread||text(thread.customer_id)!==input.customerId||thread.status==='closed')throw new Response('Refund request thread ownership could not be verified',{status:403});
 const booking=await db.prepare('SELECT id,customer_id,service_code,provider_id FROM canonical_bookings WHERE id=? AND customer_id=?').bind(input.bookingId,input.customerId).first<Row>();
 if(!booking)throw new Response('Refund request booking ownership could not be verified',{status:403});
 await assertNativeDemoBusinessAllowed(db,input.threadId);
 await ensureUnifiedCaseTables(db);
 const eventKey=`customer-refund-turn:${await hash(input.idempotencyKey)}`;
 const binding={customerId:input.customerId,threadId:input.threadId,bookingId:input.bookingId,channel:input.channel,reason:input.reason.trim()};
 const bindingHash=await hash(binding);
 const prior=await db.prepare('SELECT c.*,e.detail_json request_binding FROM unified_case_events e JOIN unified_cases c ON c.id=e.case_id WHERE e.idempotency_key=?').bind(eventKey).first<Row>();
 if(prior){let detail:Row={};try{detail=JSON.parse(text(prior.request_binding));}catch{}
  if(detail.bindingHash!==bindingHash||text(prior.customer_id)!==input.customerId||text(prior.booking_id)!==input.bookingId||prior.source_type!==source)throw new Response('Refund request key belongs to another request',{status:409});
  return{requestId:text(prior.id),bookingId:input.bookingId,status:text(prior.status),ownerTeam:text(prior.owner_team),duplicatePrevented:true,refundApproved:false,refundProcessed:false};
 }
 await assertAiMayReply(db,input.threadId);
 const pending=await db.prepare("SELECT * FROM unified_cases WHERE customer_id=? AND booking_id=? AND source_type=? AND status IN ('open','in_progress','waiting') ORDER BY created_at DESC,id DESC LIMIT 1").bind(input.customerId,input.bookingId,source).first<Row>();
 const previous= pending?null:await db.prepare('SELECT id FROM unified_cases WHERE customer_id=? AND booking_id=? AND source_type=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(input.customerId,input.bookingId,source).first<Row>();
 const caseKey=pending?text(pending.idempotency_key):`customer-refund-review:${await hash([input.customerId,input.bookingId,previous?.id??null])}`;
 const eventId=`CRREQ-${await hash(eventKey)}`;
 const related=()=>[db.prepare("INSERT INTO unified_case_events (id,idempotency_key,case_id,event_type,actor_id,detail_json,created_at) SELECT ?,?,id,'customer_refund_requested',?,?,? FROM unified_cases WHERE idempotency_key=? AND customer_id=? AND booking_id=? AND source_type=?").bind(eventId,eventKey,input.actor.email,JSON.stringify({...binding,bindingHash,refundApproved:false,refundProcessed:false}),Date.now(),caseKey,input.customerId,input.bookingId,source)];
 const create=()=>createUnifiedCase(db,{idempotencyKey:caseKey,caseType:'refund',severity:'high',title:'Customer refund request — Finance review required',description:input.reason,customerId:input.customerId,bookingId:input.bookingId,leadId:text(thread.lead_id)||null,providerId:text(booking.provider_id)||null,sourceType:source,sourceId:input.bookingId,ownerTeam:'finance',actorId:input.actor.email},related());
 let result;try{result=await create();}catch(error){
  // The stable per-booking episode key admits one winner. Only a unique-key race is replayed.
  if(!/unique constraint/i.test(String(error)))throw error;
  const winner=await db.prepare('SELECT c.*,e.detail_json request_binding FROM unified_case_events e JOIN unified_cases c ON c.id=e.case_id WHERE e.idempotency_key=?').bind(eventKey).first<Row>();
  if(winner){let detail:Row={};try{detail=JSON.parse(text(winner.request_binding));}catch{}
   if(detail.bindingHash!==bindingHash||text(winner.customer_id)!==input.customerId||text(winner.booking_id)!==input.bookingId)throw new Response('Refund request key belongs to another request',{status:409});
   return{requestId:text(winner.id),bookingId:input.bookingId,status:text(winner.status),ownerTeam:text(winner.owner_team),duplicatePrevented:true,refundApproved:false,refundProcessed:false};
  }
  result=await create();
 }
 const receipt=await db.prepare('SELECT c.*,e.detail_json request_binding FROM unified_case_events e JOIN unified_cases c ON c.id=e.case_id WHERE e.idempotency_key=?').bind(eventKey).first<Row>();
 let receiptDetail:Row={};try{receiptDetail=JSON.parse(text(receipt?.request_binding));}catch{}
 if(receiptDetail.bindingHash!==bindingHash||!receipt||text(receipt.customer_id)!==input.customerId||text(receipt.booking_id)!==input.bookingId||receipt.source_type!==source)throw new Error('Refund request receipt could not be verified');
 return{requestId:text(receipt.id),bookingId:input.bookingId,status:text(receipt.status),ownerTeam:text(receipt.owner_team),duplicatePrevented:Boolean(pending||result.duplicatePrevented),refundApproved:false,refundProcessed:false};
}
export function customerRefundRequestReply(receipt:Awaited<ReturnType<typeof recordCustomerRefundRequest>>){
 if(['resolved','closed'].includes(receipt.status))return 'Your earlier refund-review request is already closed. That record is not proof that a refund was approved or processed. Finance can confirm its outcome.';
 return `${receipt.duplicatePrevented?'Your existing':'Your'} refund-review request has been recorded. Finance review is pending; no refund has been approved or processed by this conversation.`;
}
export const CUSTOMER_REFUND_REQUEST_FAILURE="I couldn't verify that a refund-review request was recorded. No refund has been approved or processed by this conversation. Our team needs to check before retrying.";
