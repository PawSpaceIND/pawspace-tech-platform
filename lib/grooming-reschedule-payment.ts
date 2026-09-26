import{customerCheckoutEnvironment}from"./customer-checkout-server";
import{resolvePaymentWebhookGate}from"./payment-webhook-gate";
import{openPaymentIntentOrder}from"./payment-order-intent";
import{publicKeyId}from"./razorpay-client";
import{rupeesToPaiseExact}from"./financial-lifecycle";
import{ensureSchedulingReservationLeaseGovernance}from"./scheduling-reservation-leases";
import{resolvePlatformSession}from"./platform-session";
import{ensureBookingRefundCaseTargets,RESCHEDULE_DIFFERENCE_REFUND_PURPOSE}from"./automatic-booking-refund";
import{GROOMING_CHANGE_ASSERTION,groomingRescheduleMoveStatements,planGroomingRescheduleMove,type GroomingReschedulePlan,type RescheduleRefusal}from"./grooming-reschedule-move";
import{formatRupees}from"./grooming-reschedule-governance";
import{bridgeLifecycleCommunications}from"./lifecycle-communications";
import{formatIndiaDateTime}from"./india-time";
import{groomingRescheduleRequestSchema}from"./grooming-reschedule-schema";
import type{AuthenticatedActor}from"./server-auth";

/*
 * Owner decision M4: a customer who moves a Grooming booking to a dearer slot approves and PAYS THE
 * DIFFERENCE, and only then does the booking move. [QA M4]
 *
 *   quoted -> awaiting_payment -> paid -> applying -> applied
 *   side exits: expired (the 10-minute hold lapsed with no capture), cancelled (the booking was
 *   cancelled while paying), refund_requested -> refunded (the booking could not move after the
 *   money arrived: the difference goes back), move_failed (no captured payment id to refund against).
 *
 * The money path is the verify-first one the Stay and Taxi balances already use: its own payment intent
 * and Razorpay order (lib/payment-order-intent.openPaymentIntentOrder), captured only on a signed webhook
 * or an authenticated provider read. That capture writes a GROOMING_RESCHEDULE_APPLY outbox row in the
 * same transaction (lib/razorpay-capture-atomic.ts), so whichever path records the capture - webhook,
 * the customer's confirm, the scheduled probe - the booking moves exactly once.
 *
 * While the customer pays, the new slot is held for 10 minutes as a scheduling reservation in its own
 * group RSH-<requestId> on the chosen groomer; the existing lease cleanup releases it if nobody pays.
 * The move cancels the hold in the same batch, just before the reservation moves, or the hold would
 * block its own booking. Once applied, total_amount and booking_payments.amount include the difference,
 * so the invoice and completion finance use the new total; there is no separate tax line.
 */

type Db=D1Database;
type Row=Record<string,unknown>;
type Env=Record<string,unknown>;
export const RESCHEDULE_HOLD_MS=10*60_000;
/** No order is opened for a hold with less than this left: UPI payments are slow. */
export const RESCHEDULE_MIN_HOLD_TO_PAY_MS=3*60_000;
/** Razorpay Checkout closes itself before the hold lapses. */
export const RESCHEDULE_CHECKOUT_TIMEOUT_SECONDS=480;
const TERMINAL=["applied","refund_requested","refunded","move_failed"];
const text=(value:unknown)=>String(value??"").trim();
const round2=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
const holdGroupFor=(requestId:string)=>`RSH-${requestId}`;
const SYSTEM_ACTOR={email:"system:grooming-reschedule",name:"PawSpace reschedule",roleCode:"system",permissions:[],developmentPreview:false,identitySource:"system",principalType:"system",principalKey:"system:grooming-reschedule"} as unknown as AuthenticatedActor;
function parse<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}}
async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");}

const tablesReady=new WeakSet<Db>();
export async function ensureGroomingRescheduleTables(db:Db){
 if(tablesReady.has(db))return;
 await db.batch([
  ...groomingRescheduleRequestSchema(db),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_change_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT grooming_change_assertion CHECK(ok=1))"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
 ]);
 await db.prepare("ALTER TABLE booking_refund_cases ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'").run().catch((error:unknown)=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
 await ensureBookingRefundCaseTargets(db);
 tablesReady.add(db);
}

export type GroomingRescheduleRequestView={requestId:string;bookingId:string;status:string;fromStart:string;fromEnd:string;toStart:string;toEnd:string;bookedAmount:number;newSlotAmount:number;difference:number;bookingTotalBefore:number;newTotalAmount:number;currency:string;consentRevision:string;providerChanges:boolean;targetProviderId:string|null;holdExpiresAt:number|null;orderId:string|null;refundCaseId:string|null;refundStatus:string|null;failureReason:string|null};
function requestView(row:Row,refundStatus:string|null=null):GroomingRescheduleRequestView{
 return{requestId:text(row.id),bookingId:text(row.booking_id),status:text(row.status),fromStart:text(row.from_start),fromEnd:text(row.from_end),toStart:text(row.to_start),toEnd:text(row.to_end),bookedAmount:Number(row.booked_amount),newSlotAmount:Number(row.new_slot_amount),difference:Number(row.difference_amount),bookingTotalBefore:Number(row.booking_total_before),newTotalAmount:Number(row.new_total_amount),currency:text(row.currency)||"INR",consentRevision:text(row.consent_revision),providerChanges:Number(row.provider_changes)===1,targetProviderId:row.target_provider_id?text(row.target_provider_id):null,holdExpiresAt:row.hold_expires_at===null||row.hold_expires_at===undefined?null:Number(row.hold_expires_at),orderId:row.gateway_order_id?text(row.gateway_order_id):null,refundCaseId:row.refund_case_id?text(row.refund_case_id):null,refundStatus,failureReason:row.failure_reason?text(row.failure_reason):null};
}
const readRequest=(db:Db,requestId:string)=>db.prepare("SELECT * FROM grooming_reschedule_requests WHERE id=?").bind(requestId).first<Row>();

/**
 * Whether this booking can pay a difference online right now: a captured prepaid payment and the same
 * sandbox checkout locks and verified receiver the customer checkout demands. Live money stays behind
 * the existing live-payment approvals; until then the dearer slot is refused as before.
 */
export function differencePaymentAvailable(env:Env,payment:Row){
 if(!["captured","paid"].includes(text(payment.status))||text(payment.mode)==="pay_after_service")return false;
 try{customerCheckoutEnvironment(env);}catch{return false;}
 const gate=resolvePaymentWebhookGate(env);
 return gate.ok&&gate.environment==="sandbox";
}

async function consentRevisionFor(input:Record<string,unknown>){return sha256(JSON.stringify({purpose:"grooming_reschedule_difference",...input}));}

/** Cancels a request's hold rows. Safe to repeat. */
const releaseHoldStatement=(db:Db,requestId:string)=>db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=? AND status!='cancelled'").bind(holdGroupFor(requestId));

/**
 * Awaiting-payment requests whose hold lapsed (or was released by the lease cleanup) with no capture on
 * their intent become `expired`. A late capture still reaches applyGroomingRescheduleRequest.
 */
export async function expireLapsedRescheduleHolds(db:Db,input:{now:number;bookingId?:string}){
 await ensureGroomingRescheduleTables(db);
 const scope=input.bookingId?" AND q.booking_id=?":"",binds=input.bookingId?[input.bookingId]:[];
 const lapsed=await db.prepare(`SELECT q.id FROM grooming_reschedule_requests q WHERE q.status='awaiting_payment'${scope}
   AND (q.hold_expires_at<=? OR NOT EXISTS (SELECT 1 FROM scheduling_reservations r WHERE r.group_id=q.hold_group_id AND r.status!='cancelled'))
   AND NOT EXISTS (SELECT 1 FROM payment_intents i WHERE i.id=q.intent_id AND i.state IN ('CAPTURED','SETTLED'))
   LIMIT 50`).bind(...binds,input.now).all<Row>().catch(()=>({results:[] as Row[]}));
 for(const row of lapsed.results){
  const requestId=text(row.id);
  await db.batch([releaseHoldStatement(db,requestId),db.prepare("UPDATE grooming_reschedule_requests SET status='expired',failure_reason=COALESCE(failure_reason,'hold_lapsed_before_payment'),updated_at=? WHERE id=? AND status='awaiting_payment'").bind(input.now,requestId)]);
 }
 return lapsed.results.length;
}

/**
 * The reschedule this booking is paying for right now, if any: awaiting payment on a live hold, or paid
 * and still moving. Any other move started meanwhile would leave that payment to be refunded, so the
 * route refuses it until the payment is finished or the hold lapses.
 */
export async function groomingReschedulePaymentInFlight(db:Db,input:{bookingId:string;now:number}){
 await expireLapsedRescheduleHolds(db,input);
 const row=await db.prepare("SELECT * FROM grooming_reschedule_requests WHERE booking_id=? AND status IN ('awaiting_payment','paid','applying') ORDER BY updated_at DESC LIMIT 1").bind(input.bookingId).first<Row>();
 return row?requestView(row):null;
}

/**
 * The dearer-slot refusal becomes an offer: a `quoted` request carrying the difference and a consent
 * revision the customer must echo back to pay. Nothing is held and no intent is created here.
 * A request already awaiting payment for the SAME time is returned as is; one for another time is
 * reported so the customer finishes or waits out that payment first.
 */
export async function quoteGroomingRescheduleDifference(db:Db,input:{booking:Row;work:Row;payment:Row;plan:GroomingReschedulePlan;actor:AuthenticatedActor;customerId:string;reason:string;now:number}):Promise<{request:GroomingRescheduleRequestView;paymentInProgress:boolean}>{
 await ensureGroomingRescheduleTables(db);
 const{booking,work,payment,plan,now}=input,bookingId=text(booking.id),pricing=plan.pricing!;
 await expireLapsedRescheduleHolds(db,{now,bookingId});
 const toStart=plan.start.toISOString(),toEnd=plan.end.toISOString();
 const open=await db.prepare("SELECT * FROM grooming_reschedule_requests WHERE booking_id=? AND status IN ('quoted','awaiting_payment')").bind(bookingId).first<Row>();
 if(open&&text(open.status)==="awaiting_payment")return{request:requestView(open),paymentInProgress:!(text(open.to_start)===toStart&&text(open.to_end)===toEnd)};
 const requestId=open?text(open.id):`GRR-${crypto.randomUUID()}`;
 const bookingTotalBefore=round2(Number(booking.total_amount||0)),difference=round2(pricing.priceDifference),newTotalAmount=round2(bookingTotalBefore+difference);
 const consentRevision=await consentRevisionFor({requestId,bookingId,from:[text(booking.scheduled_start),text(booking.scheduled_end)],to:[toStart,toEnd],bookedAmount:pricing.bookedAmount,newSlotAmount:pricing.newSlotAmount,difference,bookingTotalBefore,newTotalAmount,providerId:plan.providerId,bookingUpdatedAt:booking.updated_at,paymentUpdatedAt:payment.updated_at});
 const values=[text(booking.scheduled_start),text(booking.scheduled_end),toStart,toEnd,text(work.provider_id),plan.providerId,plan.replacement?1:0,pricing.bookedAmount,pricing.newSlotAmount,difference,bookingTotalBefore,newTotalAmount,pricing.currency,JSON.stringify(pricing),consentRevision,input.reason,input.actor.email,now];
 try{
  if(open)await db.prepare("UPDATE grooming_reschedule_requests SET from_start=?,from_end=?,to_start=?,to_end=?,current_provider_id=?,target_provider_id=?,provider_changes=?,booked_amount=?,new_slot_amount=?,difference_amount=?,booking_total_before=?,new_total_amount=?,currency=?,quote_json=?,consent_revision=?,reason=?,requested_by=?,updated_at=? WHERE id=? AND status='quoted'").bind(...values,requestId).run();
  else await db.prepare("INSERT INTO grooming_reschedule_requests (from_start,from_end,to_start,to_end,current_provider_id,target_provider_id,provider_changes,booked_amount,new_slot_amount,difference_amount,booking_total_before,new_total_amount,currency,quote_json,consent_revision,reason,requested_by,updated_at,id,booking_id,customer_id,payment_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'quoted',?)").bind(...values,requestId,bookingId,input.customerId,text(payment.id),now).run();
 }catch(error){if(!/UNIQUE/i.test(error instanceof Error?error.message:String(error)))throw error;}
 const stored=await readRequest(db,requestId)??await db.prepare("SELECT * FROM grooming_reschedule_requests WHERE booking_id=? AND status IN ('quoted','awaiting_payment')").bind(bookingId).first<Row>();
 if(!stored)throw new Error("The reschedule quote could not be recorded");
 return{request:requestView(stored),paymentInProgress:text(stored.status)==="awaiting_payment"&&!(text(stored.to_start)===toStart&&text(stored.to_end)===toEnd)};
}

type Outcome={status:number;body:Record<string,unknown>};
const refusal=(status:number,body:Record<string,unknown>):Outcome=>({status,body:{bookingUnchanged:true,charged:false,...body}});

/**
 * Pay the difference: re-price, hold the new slot for 10 minutes, claim the intent (key
 * grooming-reschedule:<requestId>:<paise>) and open its Razorpay order. A replay while the hold is live
 * returns the same order; a changed price is refused with the new figures for the customer to approve.
 */
export async function payGroomingRescheduleDifference(db:Db,env:Env,request:Request,input:{booking:Row;work:Row;payment:Row;customerId:string;requestId:string;expectedDifference:unknown;expectedConsentRevision:unknown;idempotencyKey:unknown;now:number}):Promise<Outcome>{
 await ensureGroomingRescheduleTables(db);
 const{booking,work,payment,now}=input,bookingId=text(booking.id);
 let row=await readRequest(db,input.requestId);
 if(!row||text(row.booking_id)!==bookingId||text(row.customer_id)!==input.customerId)return{status:404,body:{error:"This reschedule request was not found. Choose the new time again.",code:"reschedule_request_not_found"}};
 if(typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9:_-]{8,120}$/.test(input.idempotencyKey))return{status:400,body:{error:"A payment attempt key is required"}};
 if(text(row.status)==="awaiting_payment"){
  const left=Number(row.hold_expires_at||0)-now,held=await db.prepare("SELECT 1 FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' LIMIT 1").bind(holdGroupFor(input.requestId)).first<Row>();
  if(left<RESCHEDULE_MIN_HOLD_TO_PAY_MS||!held){
   await db.batch([releaseHoldStatement(db,input.requestId),db.prepare("UPDATE grooming_reschedule_requests SET status='expired',failure_reason='hold_too_short_to_pay',updated_at=? WHERE id=? AND status='awaiting_payment'").bind(now,input.requestId)]);
   return refusal(409,{error:"The time we held for you is about to be released, so no payment was started. Choose the new time again to hold it for another 10 minutes.",code:"reschedule_hold_expired",requestId:input.requestId});
  }
 }else if(text(row.status)!=="quoted")return refusal(409,{error:"This reschedule request is closed. Choose the new time again.",code:"reschedule_request_closed",requestId:input.requestId,requestStatus:text(row.status)});
 if(text(input.expectedConsentRevision)!==text(row.consent_revision)||Math.abs(Number(input.expectedDifference)-Number(row.difference_amount))>0.009)return refusal(409,{error:`The price for this time has changed. It now costs ${formatRupees(Number(row.difference_amount))} more. Review the new amount before paying.`,code:"reschedule_price_changed",request:requestView(row),priceDifference:Number(row.difference_amount),consentRevision:text(row.consent_revision),requestId:input.requestId});
 if(text(booking.scheduled_start)!==text(row.from_start)||text(booking.scheduled_end)!==text(row.from_end))return refusal(409,{error:"Your booking changed after this price was shown. Refresh your booking and choose the new time again.",code:"booking_change_terms_changed"});
 if(!differencePaymentAvailable(env,payment))return refusal(503,{error:"Paying the difference online is not available right now. Your booking has not been changed.",code:"reschedule_difference_payment_unavailable",differencePaymentAvailable:false});

 if(text(row.status)==="quoted"){
  // Re-price and re-check the slot at the moment of paying, never on the quote alone.
  const planned=await planGroomingRescheduleMove(db,{booking,work,payment,scheduledStart:text(row.to_start),scheduledEnd:text(row.to_end),now,price:true,excludeGroupIds:[holdGroupFor(input.requestId)]});
  if(!planned.ok)return{status:planned.refusal.status,body:{...planned.refusal.body,requestId:input.requestId}};
  const plan=planned.plan,pricing=plan.pricing!;
  if(Math.abs(round2(pricing.priceDifference)-Number(row.difference_amount))>0.009){
   if(pricing.priceDifference<=0)return refusal(409,{error:"This time no longer costs more than your booked price. Confirm the new time again to move without paying.",code:"reschedule_price_changed",priceDifference:round2(pricing.priceDifference),requestId:input.requestId});
   const refreshed=await quoteGroomingRescheduleDifference(db,{booking,work,payment,plan,actor:{...SYSTEM_ACTOR,email:text(row.requested_by)},customerId:input.customerId,reason:text(row.reason),now});
   return refusal(409,{error:`The price for this time has changed. It now costs ${formatRupees(refreshed.request.difference)} more. Review the new amount before paying.`,code:"reschedule_price_changed",request:refreshed.request,priceDifference:refreshed.request.difference,consentRevision:refreshed.request.consentRevision,requestId:refreshed.request.requestId});
  }
  if(!(await ensureSchedulingReservationLeaseGovernance(db)))return refusal(409,{error:"The new time could not be held. Your booking has not been changed.",code:"reschedule_slot_unavailable"});
  const session=await resolvePlatformSession(db,request);
  const owned=session?.subjectType==="customer"&&session.subjectId===input.customerId?session:null;
  const holdExpiresAt=Math.min(now+RESCHEDULE_HOLD_MS,owned?.expiresAt??Number.POSITIVE_INFINITY);
  if(holdExpiresAt-now<RESCHEDULE_MIN_HOLD_TO_PAY_MS)return refusal(409,{error:"Your sign-in is about to expire. Sign in again before paying for the new time.",code:"reschedule_session_expiring"});
  const own=await db.prepare("SELECT pet_ids_json,capacity_units,customer_id FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' ORDER BY occurrence_number LIMIT 1").bind(booking.schedule_group_id).first<Row>();
  if(!own)return refusal(409,{error:"The booking has no active scheduling reservation to move"});
  const{localStart,localEnd,cityId,zoneId,offsetModifier,localDayStartUtc,localDayEndUtc}=plan,{maxDailyJobs,bufferedStart,bufferedEnd}=plan.slot,providerId=plan.providerId;
  const excluded=JSON.stringify([text(booking.schedule_group_id),holdGroupFor(input.requestId)]),assertionId=`${input.requestId}-hold-${now}`;
  // The hold is written only if the same predicates the move enforces still hold for this groomer.
  const hold=db.prepare(`INSERT OR IGNORE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at,lease_expires_at,customer_session_id)
   SELECT ?,?,?,'grooming',?,?,?,?,?,?,?,1,NULL,'assigned',?,?,?,?
   WHERE NOT EXISTS (SELECT 1 FROM scheduling_reservations busy WHERE busy.provider_id=? AND busy.group_id NOT IN (SELECT value FROM json_each(?)) AND busy.status!='cancelled' AND busy.scheduled_start<? AND busy.scheduled_end>?)
    AND (SELECT COUNT(*) FROM scheduling_reservations busy WHERE busy.provider_id=? AND busy.group_id NOT IN (SELECT value FROM json_each(?)) AND busy.status!='cancelled' AND substr(datetime(busy.scheduled_start,?),1,10)=?)<?
    AND EXISTS (SELECT 1 FROM provider_capacity_profiles p WHERE p.id=? AND p.live=1 AND p.status='active' AND (p.effective_from IS NULL OR p.effective_from<=?) AND (p.effective_to IS NULL OR p.effective_to>=?))
    AND EXISTS (SELECT 1 FROM scheduling_availability a,json_each(a.windows_json) w WHERE a.provider_id=? AND a.city_id=? AND a.zone_id=? AND a.date=? AND (a.source IN ('partner_app','operations','roster') OR NOT EXISTS (SELECT 1 FROM scheduling_availability authored WHERE authored.provider_id=a.provider_id AND authored.date=a.date AND authored.source IN ('partner_app','operations','roster'))) AND (CAST(substr(w.value,1,2) AS INTEGER)*60+CAST(substr(w.value,4,2) AS INTEGER))<=? AND (CAST(substr(w.value,7,2) AS INTEGER)*60+CAST(substr(w.value,10,2) AS INTEGER))>=?)
    AND NOT EXISTS (SELECT 1 FROM provider_unavailability away WHERE away.provider_id=? AND away.status='active' AND away.starts_at<? AND away.ends_at>?)`)
   .bind(`${holdGroupFor(input.requestId)}_${providerId}_${now}`,holdGroupFor(input.requestId),providerId,cityId,zoneId,text(own.customer_id)||input.customerId,text(own.pet_ids_json)||"[]",plan.start.toISOString(),plan.end.toISOString(),Number(own.capacity_units||1),JSON.stringify({rescheduleHoldFor:bookingId,requestId:input.requestId}),now,holdExpiresAt,owned?.sessionId??null,
    providerId,excluded,bufferedEnd,bufferedStart,
    providerId,excluded,offsetModifier,localStart.date,maxDailyJobs,
    providerId,localStart.date,localStart.date,
    providerId,cityId,zoneId,localStart.date,localStart.minutes,localEnd.minutes,
    providerId,localDayEndUtc,localDayStartUtc);
  try{await db.batch([
   db.prepare("INSERT INTO grooming_change_assertions (id,ok) SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM grooming_reschedule_requests WHERE id=? AND status='quoted' AND updated_at=?) THEN 1 ELSE 0 END").bind(assertionId,input.requestId,row.updated_at),
   hold,
   db.prepare("INSERT INTO grooming_change_assertions (id,ok) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)").bind(`${assertionId}-held`),
   db.prepare("UPDATE grooming_reschedule_requests SET status='awaiting_payment',hold_group_id=?,hold_expires_at=?,target_provider_id=?,provider_changes=?,failure_reason=NULL,updated_at=? WHERE id=? AND status='quoted'").bind(holdGroupFor(input.requestId),holdExpiresAt,providerId,plan.replacement?1:0,now,input.requestId),
   db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,'reschedule_difference_payment_started','booking',?,?,?,?)").bind(crypto.randomUUID(),bookingId,bookingId,input.customerId,JSON.stringify({requestId:input.requestId,toStart:plan.start.toISOString(),difference:Number(row.difference_amount),holdExpiresAt,providerId,attemptKey:input.idempotencyKey}),now),
   db.prepare("DELETE FROM grooming_change_assertions WHERE id IN (?,?)").bind(assertionId,`${assertionId}-held`),
  ]);}catch(error){
   if(!GROOMING_CHANGE_ASSERTION.test(error instanceof Error?error.message:String(error)))throw error;
   const current=await readRequest(db,input.requestId);
   if(text(current?.status)!=="quoted"&&text(current?.status)!=="awaiting_payment")return refusal(409,{error:"This reschedule request is closed. Choose the new time again.",code:"reschedule_request_closed",requestId:input.requestId});
   if(text(current?.status)==="quoted")return refusal(409,{error:"That time was just taken. Your booking has not been changed - please choose another time.",code:"reschedule_slot_unavailable",requestId:input.requestId});
  }
  row=await readRequest(db,input.requestId);
  if(!row)throw new Error("The reschedule request disappeared");
 }

 const difference=Number(row.difference_amount),amountPaise=rupeesToPaiseExact(difference.toFixed(2));
 const opened=await openPaymentIntentOrder(db,env,{bookingId,customerId:input.customerId,paymentId:text(payment.id),idempotencyKey:`grooming-reschedule:${input.requestId}:${amountPaise}`,amountPaise,currency:text(row.currency)||"INR",commercialSnapshot:{paymentStage:"reschedule_difference",purpose:"grooming_reschedule_difference",rescheduleRequestId:input.requestId,bookingTotalBefore:Number(row.booking_total_before),newTotalAmount:Number(row.new_total_amount),difference,fromStart:text(row.from_start),toStart:text(row.to_start),holdExpiresAt:Number(row.hold_expires_at)}});
 if(!opened.connected){
  await db.batch([releaseHoldStatement(db,input.requestId),db.prepare("UPDATE grooming_reschedule_requests SET status='quoted',hold_group_id=NULL,hold_expires_at=NULL,intent_id=?,failure_reason=?,updated_at=? WHERE id=? AND status='awaiting_payment'").bind(opened.intentId,`checkout_unavailable: ${opened.reason}`.slice(0,500),Date.now(),input.requestId)]);
  return refusal(503,{error:"Secure checkout is unavailable right now. Your booking has not been changed and nothing has been charged.",code:"reschedule_checkout_unavailable",requestId:input.requestId});
 }
 await db.prepare("UPDATE grooming_reschedule_requests SET intent_id=?,gateway_order_id=?,updated_at=? WHERE id=?").bind(opened.intentId,opened.orderId,Date.now(),input.requestId).run();
 const locks=customerCheckoutEnvironment(env);
 // Checkout closes itself a minute before the hold lapses, also when a payment is reopened later in the hold.
 const checkoutTimeoutSeconds=Math.max(60,Math.min(RESCHEDULE_CHECKOUT_TIMEOUT_SECONDS,Math.floor((Number(row.hold_expires_at)-Date.now())/1000)-60));
 return{status:201,body:{data:{requestId:input.requestId,bookingId,status:"awaiting_payment",connected:true,environment:opened.environment,orderId:opened.orderId,amountPaise,amount:difference,currency:opened.currency,keyId:publicKeyId(env),holdExpiresAt:Number(row.hold_expires_at),checkoutTimeoutSeconds,newTotalAmount:Number(row.new_total_amount),toStart:text(row.to_start),toEnd:text(row.to_end),locks}}};
}

/** The difference goes back to the customer: one targeted refund case, the hold released. */
async function refundDifference(db:Db,input:{request:Row;booking:Row|null;gatewayPaymentId:string;reason:string;now:number}){
 const{request,now}=input,requestId=text(request.id),bookingId=text(request.booking_id),amount=Number(request.difference_amount);
 if(!input.gatewayPaymentId){
  await db.batch([releaseHoldStatement(db,requestId),db.prepare("UPDATE grooming_reschedule_requests SET status='move_failed',failure_reason=?,updated_at=? WHERE id=? AND status NOT IN ('applied','refund_requested','refunded','move_failed')").bind(`${input.reason}; no captured payment id to refund against`,now,requestId)]);
  return{outcome:"move_failed" as const};
 }
 const refundCaseId=`RRC-${requestId}`,eventId=crypto.randomUUID(),notificationId=crypto.randomUUID();
 const cancelled=input.reason==="booking_cancelled";
 const message=cancelled
  ?`Your PawSpace grooming booking was cancelled before your payment for the new time was confirmed. The ${formatRupees(amount)} you paid is being refunded to your original payment method.`
  :input.reason==="superseded_by_a_newer_reschedule"
  ?`You chose another time for your PawSpace grooming booking, so the ${formatRupees(amount)} you paid earlier for ${formatIndiaDateTime(text(request.to_start))} is being refunded to your original payment method.`
  :`We could not move your PawSpace grooming booking to ${formatIndiaDateTime(text(request.to_start))}, so it stays at ${formatIndiaDateTime(text(input.booking?.scheduled_start??request.from_start))}. The ${formatRupees(amount)} you paid for the new time is being refunded to your original payment method.`;
 await db.batch([
  releaseHoldStatement(db,requestId),
  db.prepare("INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,purpose,gateway_payment_id,created_at,updated_at) VALUES (?,?,?,?,?,'requested','system:grooming-reschedule',?,?,?,?,?)")
   .bind(refundCaseId,bookingId,text(request.payment_id),amount,cancelled?"Booking cancelled before the reschedule payment was confirmed":input.reason==="superseded_by_a_newer_reschedule"?"The customer chose a newer reschedule before this payment was confirmed":"The booking could not be moved to the paid time",JSON.stringify({automatic:true,requiresApproval:false,policyVersion:"grooming-reschedule-difference-v1",basis:input.reason,requestId}),RESCHEDULE_DIFFERENCE_REFUND_PURPOSE,input.gatewayPaymentId,now,now),
  db.prepare("UPDATE grooming_reschedule_requests SET status='refund_requested',failure_reason=?,refund_case_id=?,gateway_payment_id=COALESCE(gateway_payment_id,?),updated_at=? WHERE id=? AND status NOT IN ('applied','refund_requested','refunded','move_failed')").bind(input.reason,refundCaseId,input.gatewayPaymentId,now,requestId),
  db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,'reschedule_difference_refund_requested','booking',?,?,?,?)").bind(eventId,bookingId,bookingId,SYSTEM_ACTOR.email,JSON.stringify({requestId,reason:input.reason,refundCaseId,amount,gatewayPaymentId:input.gatewayPaymentId,toStart:text(request.to_start)}),now),
  db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,'whatsapp','reschedule_difference_refund',?,'queued',?,?)").bind(notificationId,bookingId,text(request.customer_id),message,eventId,now),
 ]);
 await bridgeLifecycleCommunications(db,{bookingId,source:"booking_customer_notifications",actorId:SYSTEM_ACTOR.email,notificationId}).catch(()=>null);
 return{outcome:"refund_requested" as const,refundCaseId};
}

/**
 * Moves the booking once its difference is captured. Idempotent: the claim `paid -> applying` lets one
 * runner move it; every other call returns the state it finds. A booking that can no longer move (it
 * was cancelled, has progressed, moved meanwhile, or nobody can take the slot) gets the difference
 * refunded instead.
 */
export async function applyGroomingRescheduleRequest(db:Db,input:{requestId:string;now?:number}){
 await ensureGroomingRescheduleTables(db);
 const request=await readRequest(db,input.requestId);
 if(!request)return{outcome:"missing" as const};
 const status=text(request.status);
 if(TERMINAL.includes(status))return{outcome:status};
 const intent=request.intent_id?await db.prepare("SELECT id,state,amount_paise,gateway_payment_id FROM payment_intents WHERE id=?").bind(request.intent_id).first<Row>().catch(()=>null):null;
 if(!intent||!["CAPTURED","SETTLED"].includes(text(intent.state)))return{outcome:"awaiting_payment" as const,pending:true};
 const now=input.now??Date.now(),gatewayPaymentId=text(intent.gateway_payment_id),requestId=input.requestId;
 if(Number(intent.amount_paise)!==Math.round(Number(request.difference_amount)*100)){
  await db.batch([releaseHoldStatement(db,requestId),db.prepare("UPDATE grooming_reschedule_requests SET status='move_failed',failure_reason='captured_amount_differs_from_difference',updated_at=? WHERE id=? AND status NOT IN ('applied','refund_requested','refunded','move_failed')").bind(now,requestId)]);
  return{outcome:"move_failed" as const};
 }
 if(status==="cancelled")return refundDifference(db,{request,booking:null,gatewayPaymentId,reason:"booking_cancelled",now});
 // A late payment for a lapsed request never overrides a newer reschedule the customer is paying for (or
 // has paid for): the booking follows the customer's latest choice and this payment goes back.
 if(status==="expired"){
  const newer=await db.prepare("SELECT id FROM grooming_reschedule_requests WHERE booking_id=? AND id<>? AND created_at>? AND status IN ('awaiting_payment','paid','applying','applied') LIMIT 1").bind(request.booking_id,requestId,Number(request.created_at||0)).first<Row>();
  if(newer)return refundDifference(db,{request,booking:await db.prepare("SELECT scheduled_start FROM canonical_bookings WHERE id=?").bind(request.booking_id).first<Row>(),gatewayPaymentId,reason:"superseded_by_a_newer_reschedule",now});
 }
 await db.prepare("UPDATE grooming_reschedule_requests SET status='paid',gateway_payment_id=?,paid_at=COALESCE(paid_at,?),updated_at=? WHERE id=? AND status IN ('quoted','awaiting_payment','expired')").bind(gatewayPaymentId,now,now,requestId).run();
 // A runner that stopped mid-way committed nothing (the move is one batch), so its claim is taken over.
 await db.prepare("UPDATE grooming_reschedule_requests SET status='paid',updated_at=? WHERE id=? AND status='applying' AND updated_at<?").bind(now,requestId,now-120_000).run();
 const claim=await db.prepare("UPDATE grooming_reschedule_requests SET status='applying',updated_at=? WHERE id=? AND status='paid'").bind(now,requestId).run();
 if(Number(claim.meta?.changes||0)!==1){const current=await readRequest(db,requestId);return{outcome:text(current?.status)||"missing"};}
 const difference=round2(Number(request.difference_amount)),holdGroup=holdGroupFor(requestId);
 for(let attempt=0;attempt<3;attempt++){
  const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(request.booking_id).first<Row>();
  const work=booking?await db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(request.booking_id).first<Row>():null;
  const payment=booking?await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(request.booking_id).first<Row>():null;
  if(!booking||!work||!payment)return refundDifference(db,{request,booking,gatewayPaymentId,reason:"booking_missing",now});
  if(text(booking.status)==="cancelled")return refundDifference(db,{request,booking,gatewayPaymentId,reason:"booking_cancelled",now});
  if(text(booking.scheduled_start)!==text(request.from_start)||text(booking.scheduled_end)!==text(request.from_end))return refundDifference(db,{request,booking,gatewayPaymentId,reason:"booking_changed_before_the_move",now});
  const planned=await planGroomingRescheduleMove(db,{booking,work,payment,scheduledStart:text(request.to_start),scheduledEnd:text(request.to_end),now:Date.now(),price:false,excludeGroupIds:[holdGroup],preferProviderId:text(request.target_provider_id)||null});
  if(!planned.ok)return refundDifference(db,{request,booking,gatewayPaymentId,reason:text(planned.refusal.body.code)||"booking_cannot_move",now});
  const quote=parse<Record<string,unknown>>(request.quote_json,{}),newTotalAmount=round2(Number(booking.total_amount||0)+difference);
  const pricingEvidence={basis:"paid_difference",bookedAmount:Number(request.booked_amount),newSlotAmount:Number(request.new_slot_amount),priceDifference:difference,storedPriceKept:false,differencePaid:difference,rescheduleRequestId:requestId,paymentIntentId:text(intent.id),gatewayPaymentId,bookingTotalBefore:round2(Number(booking.total_amount||0)),newTotalAmount,quote:quote.quote??null};
  const appliedAssertion=`${requestId}-applied-${attempt}`,eventId=crypto.randomUUID(),notificationId=crypto.randomUUID();
  const lastDifference=JSON.stringify({requestId,amount:difference,paymentIntentId:text(intent.id),gatewayPaymentId,paidAt:Number(request.paid_at||now),fromStart:text(request.from_start),toStart:text(request.to_start)});
  const built=await groomingRescheduleMoveStatements(db,{booking,work,plan:planned.plan,actor:SYSTEM_ACTOR,customerId:text(request.customer_id),reason:text(request.reason)||"Customer rescheduled and paid the difference",now:Date.now(),policy:{source:"paid_reschedule_request",requestId},rescheduleFeeAmount:0,pricingEvidence,
   beforeMove:[releaseHoldStatement(db,requestId)],
   afterMove:[
    db.prepare("UPDATE canonical_bookings SET total_amount=ROUND(total_amount+?,2),pricing_json=json_set(CASE WHEN json_valid(pricing_json) THEN pricing_json ELSE '{}' END,'$.rescheduleDifferencePaid',ROUND(COALESCE(json_extract(CASE WHEN json_valid(pricing_json) THEN pricing_json ELSE '{}' END,'$.rescheduleDifferencePaid'),0)+?,2),'$.lastRescheduleDifference',json(?)) WHERE id=?").bind(difference,difference,lastDifference,request.booking_id),
    db.prepare("UPDATE booking_payments SET amount=ROUND(amount+?,2),amount_due_now=CASE WHEN amount_due_now>=amount THEN ROUND(amount_due_now+?,2) ELSE amount_due_now END,detail_json=json_set(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.rescheduleDifferencePaid',ROUND(COALESCE(json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.rescheduleDifferencePaid'),0)+?,2)),updated_at=? WHERE id=? AND booking_id=?").bind(difference,difference,difference,Date.now(),payment.id,request.booking_id),
    db.prepare("UPDATE grooming_reschedule_requests SET status='applied',applied_at=?,target_provider_id=?,provider_changes=?,updated_at=? WHERE id=? AND status='applying'").bind(now,planned.plan.providerId,planned.plan.replacement?1:0,now,requestId),
    db.prepare("INSERT INTO grooming_change_assertions (id,ok) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)").bind(appliedAssertion),
    db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,'reschedule_difference_applied','booking',?,?,?,?)").bind(eventId,request.booking_id,request.booking_id,SYSTEM_ACTOR.email,JSON.stringify({requestId,difference,newTotalAmount,gatewayPaymentId,providerId:planned.plan.providerId,providerChanged:Boolean(planned.plan.replacement)}),now),
    db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,'whatsapp','reschedule_difference_applied',?,'queued',?,?)").bind(notificationId,request.booking_id,request.customer_id,`Your PawSpace grooming booking has moved to ${formatIndiaDateTime(text(request.to_start))}. We received ${formatRupees(difference)} for the new time, so your booking total is now ${formatRupees(newTotalAmount)}.`,eventId,now),
    db.prepare("DELETE FROM grooming_change_assertions WHERE id=?").bind(appliedAssertion),
   ]});
  if(!built.ok){if(attempt<2&&built.refusal.body.code==="reschedule_lifecycle_busy")continue;return refundDifference(db,{request,booking,gatewayPaymentId,reason:text(built.refusal.body.code)||"booking_cannot_move",now});}
  try{await db.batch(built.statements);}catch(error){
   if(!GROOMING_CHANGE_ASSERTION.test(error instanceof Error?error.message:String(error)))throw error;
   if(attempt<2)continue;
   return refundDifference(db,{request,booking,gatewayPaymentId,reason:"booking_changed_during_the_move",now});
  }
  await bridgeLifecycleCommunications(db,{bookingId:text(request.booking_id),source:"booking_customer_notifications",actorId:SYSTEM_ACTOR.email,notificationId}).catch(()=>null);
  return{outcome:"applied" as const,result:built.result,newTotalAmount};
 }
 return{outcome:"applying" as const};
}

/** Claims and runs one GROOMING_RESCHEDULE_APPLY outbox row (written in the capture transaction). */
export async function executeGroomingRescheduleApplyOutbox(db:Db,input:{outboxId:string;workerId:string;leaseMs?:number}){
 const now=Date.now(),leaseMs=Math.max(5_000,Math.min(input.leaseMs||60_000,120_000));
 await db.prepare("UPDATE financial_outbox SET status='RETRY',lease_owner=NULL,lease_expires_at=NULL,last_error=COALESCE(last_error,'stale_reschedule_apply_lease'),next_attempt_at=?,updated_at=? WHERE id=? AND event_type='GROOMING_RESCHEDULE_APPLY' AND status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<?").bind(now,now,input.outboxId,now).run();
 const claim=await db.prepare("UPDATE financial_outbox SET status='PROCESSING',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND event_type='GROOMING_RESCHEDULE_APPLY' AND status IN ('PENDING','RETRY') AND next_attempt_at<=?").bind(input.workerId,now+leaseMs,now,input.outboxId,now).run();
 if(Number(claim.meta?.changes||0)!==1)return{claimed:false as const};
 const work=await db.prepare("SELECT payload_json FROM financial_outbox WHERE id=? AND lease_owner=?").bind(input.outboxId,input.workerId).first<Row>();
 const requestId=text(parse<Row>(work?.payload_json,{}).requestId);
 try{
  const result=await applyGroomingRescheduleRequest(db,{requestId});
  const done=TERMINAL.includes(text(result.outcome))||result.outcome==="missing";
  await db.prepare(`UPDATE financial_outbox SET status=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,response_json=?,next_attempt_at=?,updated_at=? WHERE id=? AND lease_owner=?`).bind(done?"SUCCEEDED":"RETRY",done?null:`reschedule_${text(result.outcome)}`,JSON.stringify(result),done?now:Date.now()+60_000,Date.now(),input.outboxId,input.workerId).run();
  return{claimed:true as const,completed:done,outcome:text(result.outcome)};
 }catch(error){
  const message=error instanceof Error?error.message:String(error);
  await db.prepare("UPDATE financial_outbox SET status='RETRY',last_error=?,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND lease_owner=?").bind(message,Date.now()+60_000,Date.now(),input.outboxId,input.workerId).run().catch(()=>null);
  return{claimed:true as const,completed:false,outcome:"error",reason:message};
 }
}

/** Scheduled recovery: lapsed holds become `expired`, and every due apply row is run. */
export async function runGroomingRescheduleSweep(db:Db,input:{asOf?:number;limit?:number;workerId?:string}={}){
 const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='financial_outbox'").first<Row>();
 if(!table)return{expired:0,processed:0,applied:0,failed:0};
 const asOf=Math.min(input.asOf??Date.now(),Date.now()),limit=Math.max(1,Math.min(100,Math.trunc(input.limit??25)));
 const expired=await expireLapsedRescheduleHolds(db,{now:asOf});
 const rows=await db.prepare("SELECT id FROM financial_outbox WHERE event_type='GROOMING_RESCHEDULE_APPLY' AND ((status IN ('PENDING','RETRY') AND next_attempt_at<=?) OR (status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<?)) ORDER BY next_attempt_at ASC,created_at ASC LIMIT ?").bind(asOf,asOf,limit).all<Row>();
 let applied=0,failed=0;
 for(const row of rows.results){
  const result=await executeGroomingRescheduleApplyOutbox(db,{outboxId:text(row.id),workerId:`${text(input.workerId)||"scheduled-reschedule"}:${crypto.randomUUID()}`});
  if(result.claimed&&result.completed)applied++;else if(result.claimed)failed++;
 }
 return{expired,processed:rows.results.length,applied,failed};
}

/**
 * The customer's view of a request, advanced first: a due move is run, a lapsed hold expires and a
 * processed refund reads as refunded.
 */
export async function readGroomingRescheduleRequest(db:Db,input:{requestId:string;customerId?:string;now?:number}){
 await ensureGroomingRescheduleTables(db);
 const now=input.now??Date.now();
 const due=await db.prepare("SELECT id FROM financial_outbox WHERE event_type='GROOMING_RESCHEDULE_APPLY' AND aggregate_id=? AND status IN ('PENDING','RETRY') AND next_attempt_at<=?").bind(input.requestId,now).first<Row>().catch(()=>null);
 if(due)await executeGroomingRescheduleApplyOutbox(db,{outboxId:text(due.id),workerId:`reschedule-status:${crypto.randomUUID()}`});
 let row=await readRequest(db,input.requestId);
 if(!row||(input.customerId&&text(row.customer_id)!==input.customerId))return null;
 if(text(row.status)==="awaiting_payment"){await expireLapsedRescheduleHolds(db,{now,bookingId:text(row.booking_id)});row=await readRequest(db,input.requestId)??row;}
 let refundStatus:string|null=null;
 if(row.refund_case_id){
  const refund=await db.prepare("SELECT status FROM booking_refund_cases WHERE id=?").bind(row.refund_case_id).first<Row>();
  refundStatus=refund?text(refund.status):null;
  if(text(row.status)==="refund_requested"&&["processed","completed"].includes(refundStatus??"")){
   await db.prepare("UPDATE grooming_reschedule_requests SET status='refunded',updated_at=? WHERE id=? AND status='refund_requested'").bind(now,input.requestId).run();
   row=await readRequest(db,input.requestId)??row;
  }
 }
 return requestView(row,refundStatus);
}

/**
 * Cancelling the booking while a reschedule is open: its hold is released and the request closed, in
 * the cancellation's own batch. A difference captured later is refunded by applyGroomingRescheduleRequest.
 */
export function groomingRescheduleCancellationStatements(db:Db,input:{bookingId:string;now:number}):D1PreparedStatement[]{
 return[
  db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE status!='cancelled' AND group_id IN (SELECT hold_group_id FROM grooming_reschedule_requests WHERE booking_id=? AND status IN ('quoted','awaiting_payment','expired') AND hold_group_id IS NOT NULL)").bind(input.bookingId),
  db.prepare("UPDATE grooming_reschedule_requests SET status='cancelled',failure_reason='booking_cancelled',updated_at=? WHERE booking_id=? AND status IN ('quoted','awaiting_payment','expired')").bind(input.now,input.bookingId),
 ];
}

export type{RescheduleRefusal};
