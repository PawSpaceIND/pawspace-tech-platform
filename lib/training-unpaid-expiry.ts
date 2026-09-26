/**
 * Unpaid Dog Training bookings expire (owner decision, Dog Training follow-up 6, 26 Sep 2026).
 *
 * A Training booking is created in payment_pending before the payment page opens, and nothing ever ended
 * it: its trainer sessions and scheduling reservations stayed held for good, although an unpaid session
 * can never be accepted, travelled to or started (lib/training-session-lifecycle.ts assertTrainingPayment).
 * Every conflict check counts any reservation that is not 'cancelled', so those slots blocked other
 * customers indefinitely.
 *
 * POLICY. An unpaid booking (a programme or a trainer Meet & Greet) expires at the EARLIER of
 *   - 7 days after it was created: the length of the existing recovery play for exactly this population
 *     (60-minute abandonment, the ₹300 entitlement's 7-day lifetime, "Complete abandoned payment"), and
 *   - the scheduled start of its earliest reserved session: from then on the held calendar only blocks
 *     other customers. With Training's 24-hour minimum notice the customer has 24 hours to 7 days to pay.
 * A booking with a checkout in flight (a payment intent created or updated in the last 15 minutes) waits.
 *
 * "Unpaid" is decided INSIDE the expiry transaction, by the marker insert that opens it: the booking is
 * payment_pending, its payment is in the funnel's "payment not done" allow-list, no reconciliation has
 * captured money, no intent is CAPTURED or SETTLED, the Training funding predicate the lifecycle uses is
 * not satisfied (sandbox attestations and credits count as paid there, so they count here), and every
 * session is locked, scheduled, reschedule_requested or cancelled. Anything else - an unknown payment or
 * session status included - is left alone.
 *
 * RESULT. One money-free governed cancellation, mirroring the owner-approved unpaid cancellations of
 * Boarding and Grooming: the booking ends 'cancelled' (the approved terminal state every reader already
 * understands, not a new 'expired' status), and so do its work order, payment, programme, sessions,
 * reservations, offers, decision and split schedule. The coupon redemption is released, the booking's
 * recovery entitlement is cancelled, open session recovery cases are resolved, and the customer is told on
 * WhatsApp. No refund, credit note, invoice, consumption, earning or payout is written, and payment
 * intents and gateway links are untouched so a late capture can still be recorded. After the commit the
 * wallet principal and PawPoints spent on the booking are restored with the same idempotency keys the
 * Training cancellation approval uses, so neither path can credit twice.
 *
 * LATE MONEY never revives the booking (a cancelled booking cannot be reassigned). The sweep opens one
 * booking_refund_cases row per late capture, evaluated by the governed refund policy as a platform
 * cancellation, and runAutomaticBookingRefundSweep pays it back.
 *
 * Runs every 5 minutes from lib/background-scheduler.ts. Overlapping runs are routine (the 5- and
 * 15-minute crons coincide), so the marker insert is ON CONFLICT DO NOTHING, every later statement is
 * scoped to that insert's attempt id, and every id is deterministic.
 */
import{collectedForBooking}from"./collected-funds";
import{trainingPaymentPredicate}from"./training-payment-eligibility";
import{ensureTrainingSessionLifecycleTables}from"./training-session-lifecycle";
import{ensureTrainingCommercialTables}from"./training-commercial-governance";
import{withLifecycleMutationLock}from"./lifecycle-mutation-lock";
import{chunkedIn}from"./d1-chunked-in";
import{reconcileRazorpayCaptureIntent}from"./razorpay-capture-reconciliation";
import{evaluateCancellationRefund,resolveRefundPolicy,type RefundEvaluation}from"./refund-policy-governance";
import{creditWallet}from"./pawspace-wallet-governance";
import{restoreRedeemedPointsForCancelledBooking}from"./paw-points-governance";
import{withdrawTrainingGroomingBonus}from"./training-grooming-bonus";
import{handleReferralBookingCancellation}from"./referral-booking-governance";
import{bridgeLifecycleCommunications}from"./lifecycle-communications";

type Db=D1Database;
type Row=Record<string,unknown>;
type Env=Record<string,unknown>;

export const TRAINING_UNPAID_EXPIRY_MS=7*86_400_000;
export const CHECKOUT_GRACE_MS=15*60_000;
export const POLICY_VERSION="training-unpaid-expiry-v1";
export const ACTOR="system:training-unpaid-expiry";
/** Razorpay order reads per sweep run, shared by every booking the run examines. */
export const MAX_PROVIDER_READS_PER_RUN=20;
/** booking_payments statuses that mean "payment not done" (the funnel's set, lib/app-to-revenue-funnel.ts). */
export const EXPIRABLE_PAYMENT_STATUSES=["created","failed","awaiting_payment","pending"] as const;
/** Session statuses an expiry may cancel. 'cancelled' sessions (e.g. staff cancel_session) never block it. */
export const EXPIRABLE_SESSION_STATUSES=["locked","scheduled","reschedule_requested","cancelled"] as const;
export const TRAINING_UNPAID_EXPIRY_NOTICE_TEMPLATE="training_booking_expired_unpaid";
/*
 * The booking_lifecycle_events types. lib/order-notification-governance.ts messages the customer about
 * any event type matching /...|paid/ and words it "Payment for your ... order was received successfully",
 * so a type containing "unpaid" would tell a customer whose booking just expired UNPAID that their payment
 * arrived. Neither name below matches that pattern; the customer's notice is the WhatsApp written here.
 */
export const TRAINING_UNPAID_EXPIRY_EVENT="booking_payment_window_expired";
export const TRAINING_LATE_CAPTURE_EVENT="late_capture_after_payment_window_expiry";
export const TRAINING_LATE_CAPTURE_REFUND_REASON="late_capture_after_unpaid_expiry";
const CANCEL_REASON="training_payment_window_expired";
/** A marker whose post-commit steps are still outstanding this long after expiry is repaired. */
const REPAIR_GRACE_MS=2*60_000;
const OPEN_SESSION_STATUSES=["locked","scheduled","reschedule_requested"] as const;
const sqlList=(values:readonly string[])=>values.map(value=>`'${value}'`).join(",");
const PAYMENT_IN=sqlList(EXPIRABLE_PAYMENT_STATUSES),SESSION_IN=sqlList(EXPIRABLE_SESSION_STATUSES),OPEN_SESSION_IN=sqlList(OPEN_SESSION_STATUSES);
const TERMINAL_PROGRAMME_IN="'completed','completed_with_exceptions','cancelled'";

const text=(value:unknown)=>String(value??"").trim();
const round2=(value:number)=>Math.round(value*100)/100;
const money=(value:unknown)=>round2(Math.max(0,Number(value||0)));
const iso=(value:number)=>new Date(value).toISOString();
async function errorText(error:unknown){if(error instanceof Response){try{return`${error.status}: ${(await error.clone().text()).slice(0,300)}`;}catch{return String(error.status);}}return error instanceof Error?error.message:String(error);}
async function tableSet(db:Db,names:readonly string[]){const rows=await chunkedIn(names,async(chunk,placeholders)=>(await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).bind(...chunk).all<Row>()).results);return new Set(rows.map(row=>String(row.name)));}

/** The customer's WhatsApp notice. Plain words: what happened, that nothing was charged, what came back. */
export function trainingUnpaidExpiryNotice(packageName?:string|null){const name=text(packageName);return`Your PawSpace Dog Training booking${name?` (${name})`:""} was not paid, so the trainer's sessions have been released. No money was taken, and any wallet credit or PawPoints you used on it have been returned. You can book again whenever you are ready.`;}

const tablesEnsured=new WeakSet<Db>();
/**
 * The marker, the rotation ledger and the shared booking tables the expiry writes. Called only once a
 * Training candidate or marker exists: ensureTrainingCommercialTables seeds the Training packages, which an
 * unrelated database must never receive from a background sweep. The three shared tables use DDL identical
 * to their other declarations (tests/schema-declaration-consistency.test.mjs).
 */
export async function ensureTrainingUnpaidExpiryTables(db:Db){
 if(tablesEnsured.has(db))return true;
 if(!(await tableSet(db,["canonical_bookings"])).size)return false;
 await ensureTrainingSessionLifecycleTables(db);
 await ensureTrainingCommercialTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS training_unpaid_expiries (booking_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,programme_id TEXT,customer_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,trigger TEXT NOT NULL,policy_version TEXT NOT NULL,window_ms INTEGER NOT NULL,booking_created_at INTEGER NOT NULL,first_session_start TEXT,expired_at INTEGER NOT NULL,credits_json TEXT NOT NULL DEFAULT '{}',credits_restored_at INTEGER,late_capture_refund_case_id TEXT,late_capture_detected_at INTEGER,created_at INTEGER NOT NULL)"),
  // Per-booking rotation: a candidate skipped this run (funded, lock busy, provider unreadable) moves behind
  // the ones not yet looked at, so skipped bookings can never pin the head of the queue for good.
  db.prepare("CREATE TABLE IF NOT EXISTS training_unpaid_expiry_checks (booking_id TEXT PRIMARY KEY,last_checked_at INTEGER NOT NULL,last_outcome TEXT NOT NULL,checks INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 ]);
 // The governed refund evaluation travels with a refund case (app/api/grooming-booking-change/route.ts).
 await db.prepare("ALTER TABLE booking_refund_cases ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'").run().catch((error:unknown)=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
 tablesEnsured.add(db);return true;
}

export type TrainingUnpaidExpiryOutcome={bookingId:string;status:"expired"|"skipped";reason:string;detail?:Row};
const skipped=(bookingId:string,reason:string,detail?:Row):TrainingUnpaidExpiryOutcome=>({bookingId,status:"skipped",reason,...(detail?{detail}:{})});
const OPTIONAL_TABLES=["provider_work_orders","provider_assignment_offers","scheduling_assignment_decisions","provider_job_offers","stay_payment_schedules","coupon_redemptions","payment_recovery_entitlements","payment_reconciliation_records","payment_intents"] as const;

/**
 * Expires one unpaid Training booking, or reports why it did not. Holds the booking's lifecycle mutation
 * lock (the lock staff session actions hold), so a staff mutation cannot recalculate the programme over the
 * expiry. Throws only for an unexpected failure; the sweep records that and carries on.
 */
export async function expireUnpaidTrainingBooking(db:Db,env:Env,input:{bookingId:string;asOf?:number;actorId?:string;budget?:{providerReads:number}}):Promise<TrainingUnpaidExpiryOutcome>{
 const bookingId=text(input.bookingId),asOf=input.asOf??Date.now(),actorId=text(input.actorId)||ACTOR,budget=input.budget??{providerReads:MAX_PROVIDER_READS_PER_RUN};
 if(!bookingId)throw new Error("A booking is required");
 if((await tableSet(db,["canonical_bookings","booking_payments","scheduling_reservations"])).size<3)return skipped(bookingId,"schema_missing");
 await ensureTrainingUnpaidExpiryTables(db);
 const funding=await trainingPaymentPredicate(db,bookingId,false);
 if(await db.prepare(`SELECT 1 ok WHERE ${funding.sql}`).bind(...funding.binds).first())return skipped(bookingId,"funded");
 let entered=false,outcome:TrainingUnpaidExpiryOutcome;
 try{outcome=await withLifecycleMutationLock(db,{bookingId,actorId:ACTOR,action:"expire_unpaid"},async()=>{entered=true;return expireLocked(db,env,{bookingId,asOf,actorId,budget});});}
 catch(error){if(!entered&&error instanceof Response&&error.status===409)return skipped(bookingId,"lock_busy");throw error;}
 /* Outside the lock: nothing below touches a session. The expiry has committed, so a failure here is not a
  * failed expiry - the marker keeps credits_restored_at empty and the repair pass finishes the job. */
 if(outcome.status==="expired"){try{outcome.detail={...outcome.detail,postCommit:await completeTrainingUnpaidExpiry(db,{bookingId,actorId,asOf})};}catch(error){outcome.detail={...outcome.detail,postCommitError:await errorText(error)};}}
 return outcome;
}

async function expireLocked(db:Db,env:Env,input:{bookingId:string;asOf:number;actorId:string;budget:{providerReads:number}}):Promise<TrainingUnpaidExpiryOutcome>{
 const{bookingId,asOf,actorId,budget}=input;
 const booking=await db.prepare("SELECT b.id,b.customer_id,b.city_id,b.schedule_group_id,b.package_name,b.scheduled_start,b.status,b.created_at,p.status payment_status FROM canonical_bookings b LEFT JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=? AND b.service_code='dog_training'").bind(bookingId).first<Row>();
 if(!booking)return skipped(bookingId,"not_found");
 if(text(booking.status)!=="payment_pending")return skipped(bookingId,"not_payment_pending",{bookingStatus:text(booking.status)});
 if(!(EXPIRABLE_PAYMENT_STATUSES as readonly string[]).includes(text(booking.payment_status)))return skipped(bookingId,"payment_not_expirable",{paymentStatus:text(booking.payment_status)||null});
 const tables=await tableSet(db,OPTIONAL_TABLES),group=text(booking.schedule_group_id),customerId=text(booking.customer_id);
 if(tables.has("payment_reconciliation_records")&&await db.prepare("SELECT 1 ok FROM payment_reconciliation_records WHERE booking_id=? AND captured_amount>0 LIMIT 1").bind(bookingId).first())return skipped(bookingId,"captured");
 const progressed=await db.prepare(`SELECT id,status FROM training_sessions WHERE booking_id=? AND status NOT IN (${SESSION_IN}) LIMIT 1`).bind(bookingId).first<Row>();
 if(progressed)return skipped(bookingId,"session_progressed",{sessionId:text(progressed.id),sessionStatus:text(progressed.status)});

 // The deadline: the earlier of created_at + 7 days and the first reserved session. Starts are compared as
 // instants (julianday), never as strings - a staff reschedule stores its new start verbatim.
 const createdAt=Number(booking.created_at),first=await db.prepare("SELECT scheduled_start,CAST(ROUND((julianday(scheduled_start)-2440587.5)*86400000) AS INTEGER) start_ms FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' AND julianday(scheduled_start) IS NOT NULL ORDER BY julianday(scheduled_start) ASC LIMIT 1").bind(group).first<Row>();
 const windowEnd=createdAt+TRAINING_UNPAID_EXPIRY_MS,firstStart=first?text(first.scheduled_start):null,firstStartMs=first?Number(first.start_ms):Number.NaN;
 const trigger=Number.isFinite(firstStartMs)&&firstStartMs<windowEnd?"first_session_start":"payment_window_elapsed",deadline=trigger==="first_session_start"?firstStartMs:windowEnd;
 if(!Number.isFinite(deadline)||deadline>asOf)return skipped(bookingId,"not_due",{deadline:Number.isFinite(deadline)?iso(deadline):null});

 if(tables.has("payment_intents")){
  if(await db.prepare("SELECT 1 ok FROM payment_intents WHERE booking_id=? AND state IN ('CAPTURED','SETTLED') LIMIT 1").bind(bookingId).first())return skipped(bookingId,"captured");
  if(await db.prepare("SELECT 1 ok FROM payment_intents WHERE booking_id=? AND (created_at>? OR updated_at>?) LIMIT 1").bind(bookingId,asOf-CHECKOUT_GRACE_MS,asOf-CHECKOUT_GRACE_MS).first())return skipped(bookingId,"checkout_in_progress");
  /* An open Razorpay order may already be paid with the webhook still in flight. Ask the provider first:
   * a capture it reports is committed through the normal path (which confirms the booking), and a read that
   * fails leaves the booking alone this run - expiring it on an unverified read would cancel a paid booking. */
  const open=await db.prepare("SELECT id,booking_id,payment_id,state,environment,amount_paise,currency,gateway_order_id,updated_at FROM payment_intents WHERE booking_id=? AND state IN ('CREATED','AUTHORIZED') AND gateway_order_id IS NOT NULL ORDER BY created_at,id").bind(bookingId).all<Row>();
  for(const intent of open.results){
   if(budget.providerReads<=0)return skipped(bookingId,"provider_check_deferred");
   budget.providerReads--;
   let checked;
   try{checked=await reconcileRazorpayCaptureIntent(db,env,intent,{asOf});}catch(error){return skipped(bookingId,"provider_unverifiable",{orderId:text(intent.gateway_order_id),error:await errorText(error)});}
   if(checked.status!=="provider_not_captured")return skipped(bookingId,"captured_at_provider",{orderId:checked.orderId,status:checked.status});
  }
 }

 const[sessionCount,reservationCount,coupon]=await Promise.all([
  db.prepare(`SELECT COUNT(*) n FROM training_sessions WHERE booking_id=? AND status IN (${OPEN_SESSION_IN})`).bind(bookingId).first<Row>(),
  db.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND status NOT IN ('completed','cancelled')").bind(group).first<Row>(),
  tables.has("coupon_redemptions")?db.prepare("SELECT code FROM coupon_redemptions WHERE booking_id=? AND status='consumed'").bind(bookingId).first<Row>():Promise.resolve(null),
 ]);
 // Recorded as Grooming records its policy. Nothing was paid, so it can only say "no refund owed"; a policy
 // that cannot be resolved is written down rather than allowed to keep the slots held.
 let refundEvaluation:RefundEvaluation|null=null,refundPolicyError:string|null=null;
 try{refundEvaluation=evaluateCancellationRefund(await resolveRefundPolicy(db,{serviceCode:"dog_training",cityId:text(booking.city_id)},new Date(asOf)),{scheduledStart:text(booking.scheduled_start),bookingStatus:"payment_pending",cancelledBy:"platform",amountPaid:0,now:asOf});}
 catch(error){refundPolicyError=await errorText(error);}

 const funding=await trainingPaymentPredicate(db,bookingId,false);
 const attemptId=crypto.randomUUID(),eventId=`training-unpaid-expiry:${bookingId}`,noticeId=`${eventId}:whatsapp`,now=asOf;
 const marker="EXISTS(SELECT 1 FROM training_unpaid_expiries x WHERE x.booking_id=? AND x.attempt_id=?)",mine=[bookingId,attemptId];
 const intentsClause=tables.has("payment_intents")?" AND NOT EXISTS(SELECT 1 FROM payment_intents i WHERE i.booking_id=b.id AND (i.state IN ('CAPTURED','SETTLED') OR i.created_at>? OR i.updated_at>?))":"";
 const reconClause=tables.has("payment_reconciliation_records")?" AND NOT EXISTS(SELECT 1 FROM payment_reconciliation_records r WHERE r.booking_id=b.id AND r.captured_amount>0)":"";
 const detail={trigger,windowMs:TRAINING_UNPAID_EXPIRY_MS,createdAt:Number.isFinite(createdAt)?iso(createdAt):null,firstSessionStart:firstStart,deadline:iso(deadline),sessionsReleased:Number(sessionCount?.n||0),reservationsReleased:Number(reservationCount?.n||0),collected:0,couponReleased:coupon?text(coupon.code):null,refundEvaluation,refundPolicyError,policyVersion:POLICY_VERSION};
 const statements:Array<[string,D1PreparedStatement]>=[
  /* 1. The marker. Its SELECT re-evaluates "unpaid" inside the transaction, so a capture, an attestation
   *    or a started session that commits after the checks above makes this whole batch a no-op. */
  ["marker",db.prepare(`INSERT INTO training_unpaid_expiries (booking_id,attempt_id,programme_id,customer_id,schedule_group_id,trigger,policy_version,window_ms,booking_created_at,first_session_start,expired_at,credits_json,credits_restored_at,late_capture_refund_case_id,late_capture_detected_at,created_at) SELECT b.id,?,(SELECT p.id FROM training_programmes p WHERE p.booking_id=b.id),b.customer_id,b.schedule_group_id,?,?,?,b.created_at,?,?,'{}',NULL,NULL,NULL,? FROM canonical_bookings b WHERE b.id=? AND b.service_code='dog_training' AND b.status='payment_pending' AND EXISTS(SELECT 1 FROM booking_payments pay WHERE pay.booking_id=b.id AND pay.status IN (${PAYMENT_IN}))${reconClause}${intentsClause} AND NOT (${funding.sql}) AND NOT EXISTS(SELECT 1 FROM training_sessions s WHERE s.booking_id=b.id AND s.status NOT IN (${SESSION_IN})) AND (b.created_at<=? OR EXISTS(SELECT 1 FROM scheduling_reservations r WHERE r.group_id=b.schedule_group_id AND r.status!='cancelled' AND julianday(r.scheduled_start)<=julianday(?))) ON CONFLICT(booking_id) DO NOTHING`)
   .bind(attemptId,trigger,POLICY_VERSION,TRAINING_UNPAID_EXPIRY_MS,firstStart,now,now,bookingId,...(intentsClause?[asOf-CHECKOUT_GRACE_MS,asOf-CHECKOUT_GRACE_MS]:[]),...funding.binds,asOf-TRAINING_UNPAID_EXPIRY_MS,iso(asOf))],
  // 2. One event per released session, BEFORE the update, so it can read the session's previous status.
  ["sessionEvents",db.prepare(`INSERT OR IGNORE INTO training_session_events (id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) SELECT ?||s.id,s.id,s.programme_id,s.booking_id,'expired_unpaid',?,?||s.id,json_object('from',s.status,'to','cancelled','consumption','not_consumed','reason',?,'trigger',?),? FROM training_sessions s WHERE s.booking_id=? AND s.status IN (${OPEN_SESSION_IN}) AND ${marker}`).bind(`${eventId}:`,actorId,`${eventId}:`,CANCEL_REASON,trigger,now,bookingId,...mine)],
  // 3. Sessions. Deliberately not cancel_session: no per-session recovery case, no unlockNextSession, no recalcProgramme.
  ["sessions",db.prepare(`UPDATE training_sessions SET status='cancelled',updated_at=? WHERE booking_id=? AND status IN (${OPEN_SESSION_IN}) AND ${marker}`).bind(now,bookingId,...mine)],
  // 4. Recovery cases the expiry makes moot (a customer's reschedule request, a staff cancel), or the Ops console counts them open for ever.
  ["recoveryCases",db.prepare(`UPDATE training_session_recovery_cases SET status='resolved',detail_json=json_set(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.resolution','booking_expired_unpaid','$.resolvedBy',?),updated_at=? WHERE booking_id=? AND status='open' AND ${marker}`).bind(actorId,now,bookingId,...mine)],
  // 5. The programme, counted after step 3 so cancelled_sessions includes what was just released.
  ["programme",db.prepare(`UPDATE training_programmes SET status='cancelled',cancelled_sessions=(SELECT COUNT(*) FROM training_sessions s WHERE s.programme_id=training_programmes.id AND s.status='cancelled'),updated_at=? WHERE booking_id=? AND status NOT IN (${TERMINAL_PROGRAMME_IN}) AND ${marker}`).bind(now,bookingId,...mine)],
  ["booking",db.prepare(`UPDATE canonical_bookings SET status='cancelled',updated_at=? WHERE id=? AND status='payment_pending' AND ${marker}`).bind(now,bookingId,...mine)],
 ];
 if(tables.has("provider_work_orders"))statements.push(["workOrder",db.prepare(`UPDATE provider_work_orders SET status='cancelled',updated_at=? WHERE booking_id=? AND status='payment_pending' AND ${marker}`).bind(now,bookingId,...mine)]);
 // 8. The payment reads 'cancelled' (Grooming's unpaid cancellation), so checkout and the order guard refuse it.
 statements.push(["payment",db.prepare(`UPDATE booking_payments SET status='cancelled',detail_json=json_set(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.cancelReason',?),updated_at=? WHERE booking_id=? AND status IN (${PAYMENT_IN}) AND ${marker}`).bind(CANCEL_REASON,now,bookingId,...mine)]);
 // 9. 'cancelled' is the only status that frees the active-slot unique index and the conflict checks.
 statements.push(["reservations",db.prepare(`UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=? AND status NOT IN ('completed','cancelled') AND ${marker}`).bind(group,...mine)]);
 if(tables.has("provider_assignment_offers"))statements.push(["offers",db.prepare(`UPDATE provider_assignment_offers SET status='cancelled',responded_at=?,response_reason=?,updated_at=? WHERE group_id=? AND status='pending' AND ${marker}`).bind(now,CANCEL_REASON,now,group,...mine)]);
 if(tables.has("scheduling_assignment_decisions"))statements.push(["decision",db.prepare(`UPDATE scheduling_assignment_decisions SET status='cancelled',actor_id=?,reason=?,updated_at=? WHERE group_id=? AND status!='cancelled' AND ${marker}`).bind(actorId,CANCEL_REASON,now,group,...mine)]);
 if(tables.has("provider_job_offers"))statements.push(["jobOffers",db.prepare(`UPDATE provider_job_offers SET status='expired',responded_at=? WHERE booking_id=? AND status='offered' AND ${marker}`).bind(now,bookingId,...mine)]);
 // 11. A Training split's balance schedule, so sweepOverdueStayBalances never chases a balance on it.
 if(tables.has("stay_payment_schedules"))statements.push(["splitSchedule",db.prepare(`UPDATE stay_payment_schedules SET status='cancelled',updated_at=? WHERE booking_id=? AND service_code='dog_training' AND status IN ('pending_balance','overdue') AND ${marker}`).bind(now,bookingId,...mine)]);
 /* 12. Every coupon limit counts only 'consumed' redemptions, so releasing this one gives the customer and
  *     the campaign their use back. The coupon QUOTE stays consumed: re-applying the code prices a new one. */
 if(tables.has("coupon_redemptions"))statements.push(["coupon",db.prepare(`UPDATE coupon_redemptions SET status='released',updated_at=? WHERE booking_id=? AND status='consumed' AND ${marker}`).bind(now,bookingId,...mine)]);
 // 13. Only THIS booking's ₹300 entitlement (cancelRecoveryEntitlements ignores bookingId), which stops "Complete abandoned payment" outreach.
 if(tables.has("payment_recovery_entitlements"))statements.push(["entitlement",db.prepare(`UPDATE payment_recovery_entitlements SET status='cancelled',cancelled_at=?,cancel_reason='booking_expired_unpaid',updated_at=? WHERE booking_id=? AND status='active' AND ${marker}`).bind(now,now,bookingId,...mine)]);
 statements.push(
  ["programmeEvent",db.prepare(`INSERT OR IGNORE INTO training_programme_events (id,programme_id,booking_id,event_type,actor_id,detail_json,created_at) SELECT ?,p.id,p.booking_id,'programme_expired_unpaid',?,?,? FROM training_programmes p WHERE p.booking_id=? AND ${marker}`).bind(eventId,actorId,JSON.stringify(detail),now,bookingId,...mine)],
  ["event",db.prepare(`INSERT OR IGNORE INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) SELECT ?,?,?,'booking',?,?,?,? WHERE ${marker}`).bind(eventId,bookingId,TRAINING_UNPAID_EXPIRY_EVENT,bookingId,actorId,JSON.stringify(detail),now,...mine)],
  /* 16. The customer's notice commits with the expiry (the FIN-D4 pattern): either the booking is expired
   *     and the customer is told, or neither. booking_customer_notifications rather than the Training table,
   *     whose programme_id is NOT NULL - a Meet & Greet is often expired before any programme exists. */
  ["notice",db.prepare(`INSERT OR IGNORE INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) SELECT ?,?,?,'whatsapp',?,?,'queued',?,? WHERE ${marker}`).bind(noticeId,bookingId,customerId,TRAINING_UNPAID_EXPIRY_NOTICE_TEMPLATE,trainingUnpaidExpiryNotice(text(booking.package_name)),eventId,now,...mine)],
 );
 const results=await db.batch(statements.map(([,statement])=>statement));
 const changes=(name:string)=>{const index=statements.findIndex(([label])=>label===name);return index<0?0:Number(results[index]?.meta?.changes||0);};
 const winner=await db.prepare("SELECT attempt_id FROM training_unpaid_expiries WHERE booking_id=?").bind(bookingId).first<Row>();
 if(text(winner?.attempt_id)!==attemptId)return skipped(bookingId,winner?"already_expired":"no_longer_expirable");
 return{bookingId,status:"expired",reason:trigger,detail:{trigger,deadline:iso(deadline),firstSessionStart:firstStart,noticeId,sessionsCancelled:changes("sessions"),reservationsReleased:changes("reservations"),recoveryCasesResolved:changes("recoveryCases"),couponReleased:changes("coupon")>0,entitlementCancelled:changes("entitlement")>0}};
}

/* The money-free cancellation restores what the booking consumed, with the idempotency keys and the exact
 * wallet payload of approveTrainingCancellation (lib/training-cancellation.ts): a stale cancellation case
 * approved later re-reads the same ledger rows and credits nothing a second time. A ledger that does not
 * exist was never used, so nothing is created for it. */
async function restoreExpiredBookingCredits(db:Db,input:{bookingId:string;customerId:string;actorId:string}){
 const{bookingId,customerId,actorId}=input,tables=await tableSet(db,["pawspace_wallet_ledger","paw_points_ledger"]);
 let wallet:Row={bookingId,amountRestored:0,alreadyRestored:false,notRequired:true};
 const redeemed=tables.has("pawspace_wallet_ledger")?await db.prepare("SELECT customer_id,amount FROM pawspace_wallet_ledger WHERE idempotency_key=?").bind(`wallet-redeem:${bookingId}`).first<Row>():null;
 if(redeemed){if(text(redeemed.customer_id)!==customerId)throw new Error("Redeemed wallet credit belongs to another customer");const principal=Math.max(0,-Number(redeemed.amount||0));if(principal>0){const result=await creditWallet(db,{customerId,amount:principal,source:"cancellation",sourceId:bookingId,idempotencyKey:`wallet-cancellation-restore:${bookingId}`,note:`Restored wallet principal after cancelled booking ${bookingId}`,actorId});wallet={bookingId,amountRestored:result.alreadyCredited?0:principal,alreadyRestored:Boolean(result.alreadyCredited),notRequired:false};}}
 const pawPoints=tables.has("paw_points_ledger")?await restoreRedeemedPointsForCancelledBooking(db,{customerId,bookingId,actorId}):{bookingId,pointsRestored:0,alreadyRestored:false,notRequired:true};
 return{wallet,pawPoints};
}

/** Audit only: a customer's pending Training cancellation request is overtaken by the expiry. */
async function supersedeOpenCancellationCases(db:Db,input:{bookingId:string;actorId:string;asOf:number}){
 if((await tableSet(db,["training_cancellation_cases","training_cancellation_events"])).size<2)return[] as string[];
 const open=await db.prepare("SELECT id,status FROM training_cancellation_cases WHERE booking_id=? AND status NOT IN ('rejected','refund_completed_sandbox','approved_no_refund')").bind(input.bookingId).all<Row>();
 for(const row of open.results)await db.prepare("INSERT OR IGNORE INTO training_cancellation_events (id,case_id,booking_id,event_type,actor_id,reason,detail_json,created_at) VALUES (?,?,?,'superseded_by_unpaid_expiry',?,?,?,?)").bind(`training-unpaid-expiry:${input.bookingId}:${text(row.id)}`,row.id,input.bookingId,input.actorId,"The unpaid booking expired and was cancelled without moving money before this request was decided",JSON.stringify({caseStatus:text(row.status),policyVersion:POLICY_VERSION}),input.asOf).run();
 return open.results.map(row=>text(row.id));
}

/**
 * The steps that run after a winning expiry commits: restore credits, withdraw a Training grooming bonus,
 * move a referral claim to review, hand the notice to the communication outbox, note a superseded
 * cancellation request, then stamp the marker. Every step is idempotent, so the repair pass re-runs the
 * whole sequence for a marker whose stamp is missing.
 */
export async function completeTrainingUnpaidExpiry(db:Db,input:{bookingId:string;actorId?:string;asOf?:number}){
 const bookingId=text(input.bookingId),actorId=text(input.actorId)||ACTOR,asOf=input.asOf??Date.now();
 const marker=await db.prepare("SELECT customer_id FROM training_unpaid_expiries WHERE booking_id=?").bind(bookingId).first<Row>();
 if(!marker)return null;
 const credits=await restoreExpiredBookingCredits(db,{bookingId,customerId:text(marker.customer_id),actorId});
 await withdrawTrainingGroomingBonus(db,bookingId);
 let referral:unknown;
 try{referral=await handleReferralBookingCancellation(db,{bookingId,actorId,reason:"The Dog Training booking was not paid in time and expired"});}
 catch(error){referral={applicable:true,status:"review_required",reason:await errorText(error)};}
 const notice=await bridgeLifecycleCommunications(db,{bookingId,source:"booking_customer_notifications",actorId,notificationId:`training-unpaid-expiry:${bookingId}:whatsapp`});
 const cancellationCases=await supersedeOpenCancellationCases(db,{bookingId,actorId,asOf});
 const summary={...credits,groomingBonusWithdrawn:true,referral,notice:{enqueued:notice.enqueued,duplicates:notice.duplicates,suppressed:notice.suppressed,skipped:notice.skipped,failed:notice.failed},cancellationCases};
 await db.prepare("UPDATE training_unpaid_expiries SET credits_json=?,credits_restored_at=? WHERE booking_id=? AND credits_restored_at IS NULL").bind(JSON.stringify(summary),asOf,bookingId).run();
 return summary;
}

/**
 * Money that lands after expiry is recorded by the capture paths and never revives the booking. This opens
 * one refund case per late capture for what is still unreturned, evaluated by the governed refund policy
 * as a platform cancellation (100%, automatic), and moves the payment to refund_pending - so a stale Training
 * cancellation approval computes nothing captured and no invoice can be numbered. runAutomaticBookingRefundSweep
 * pays it; a policy that needs a human leaves it with Finance as a refund_requested task.
 */
async function refundLateCapture(db:Db,row:Row,asOf:number){
 const bookingId=text(row.booking_id),paymentId=text(row.payment_id);
 const[captured,recon,committed,link]=await Promise.all([
  collectedForBooking(db,bookingId),
  db.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE payment_id=?").bind(paymentId).first<Row>().catch(()=>null),
  db.prepare("SELECT COALESCE(SUM(amount),0) total FROM booking_refund_cases WHERE booking_id=? AND status IN ('requested','approved','processing','processed','completed')").bind(bookingId).first<Row>(),
  db.prepare("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null),
 ]);
 const alreadyReturned=Math.max(money(recon?.refunded_amount),money(committed?.total)),outstanding=round2(captured-alreadyReturned);
 if(outstanding<=0.009)return false;
 let evaluation:RefundEvaluation|null=null,policyError:string|null=null;
 try{evaluation=evaluateCancellationRefund(await resolveRefundPolicy(db,{serviceCode:"dog_training",cityId:text(row.city_id)},new Date(asOf)),{scheduledStart:text(row.scheduled_start),bookingStatus:"cancelled",cancelledBy:"platform",amountPaid:outstanding,now:asOf});}
 catch(error){policyError=await errorText(error);}
 // A policy that cannot be evaluated, or that returns nothing for money we hold, goes to a person, not to zero.
 const governed=evaluation&&evaluation.customerRefundAmount>0;
 const amount=governed?round2(Math.min(evaluation!.customerRefundAmount,outstanding)):outstanding;
 const policy=governed?evaluation:{automatic:false,requiresApproval:true,approvalPermissions:["finance.manage"],reasons:[policyError?`The refund policy could not be evaluated: ${policyError}`:"The refund policy returned no refund for money captured after expiry"],evaluation};
 const caseId=`TUX-REFUND-${text(link?.gateway_payment_id)||paymentId}`;
 await db.batch([
  db.prepare("INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,created_at,updated_at) SELECT ?,?,?,?,?,'requested',?,?,?,? WHERE EXISTS(SELECT 1 FROM training_unpaid_expiries WHERE booking_id=?)").bind(caseId,bookingId,paymentId,amount,TRAINING_LATE_CAPTURE_REFUND_REASON,ACTOR,JSON.stringify(policy),asOf,asOf,bookingId),
  db.prepare("UPDATE booking_payments SET status='refund_pending',updated_at=? WHERE booking_id=? AND status='captured' AND EXISTS(SELECT 1 FROM booking_refund_cases WHERE id=?)").bind(asOf,bookingId,caseId),
  db.prepare("UPDATE training_unpaid_expiries SET late_capture_refund_case_id=?,late_capture_detected_at=COALESCE(late_capture_detected_at,?) WHERE booking_id=? AND EXISTS(SELECT 1 FROM booking_refund_cases WHERE id=?)").bind(caseId,asOf,bookingId,caseId),
  db.prepare("INSERT OR IGNORE INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) SELECT ?,?,?,'refund_case',?,?,?,? WHERE EXISTS(SELECT 1 FROM booking_refund_cases WHERE id=?)").bind(`training-unpaid-expiry:${bookingId}:late-capture:${caseId}`,bookingId,TRAINING_LATE_CAPTURE_EVENT,caseId,ACTOR,JSON.stringify({refundCaseId:caseId,capturedAmount:captured,alreadyReturned,refundAmount:amount,automatic:Boolean(governed&&evaluation!.automatic&&!evaluation!.requiresApproval),policyVersion:evaluation?.policyVersion??null}),asOf,caseId),
 ]);
 return true;
}

/*
 * Repairs, both idempotent: post-commit steps a crash left undone (after a grace period, so an overlapping
 * run never races the winner's own post-commit), and sessions or a programme materialised after expiry -
 * lib/training-programme.ts reads the booking status outside its insert batch, so a materialisation that
 * started before the expiry committed can still write 'scheduled' rows for a cancelled booking.
 */
async function repairExpiries(db:Db,asOf:number,report:TrainingUnpaidExpirySweepReport){
 const pending=await db.prepare("SELECT booking_id FROM training_unpaid_expiries WHERE credits_restored_at IS NULL AND expired_at<=? ORDER BY expired_at LIMIT 50").bind(asOf-REPAIR_GRACE_MS).all<Row>();
 for(const row of pending.results){try{await completeTrainingUnpaidExpiry(db,{bookingId:text(row.booking_id),asOf});report.repairs++;}catch(error){report.errors.push(`${text(row.booking_id)}:post-commit:${await errorText(error)}`);}}
 const stray=await db.prepare(`SELECT x.booking_id,b.schedule_group_id,x.trigger FROM training_unpaid_expiries x JOIN canonical_bookings b ON b.id=x.booking_id WHERE b.status='cancelled' AND (EXISTS(SELECT 1 FROM training_sessions s WHERE s.booking_id=x.booking_id AND s.status IN (${OPEN_SESSION_IN})) OR EXISTS(SELECT 1 FROM training_programmes p WHERE p.booking_id=x.booking_id AND p.status NOT IN (${TERMINAL_PROGRAMME_IN}))) ORDER BY x.expired_at LIMIT 50`).all<Row>();
 for(const row of stray.results){
  const bookingId=text(row.booking_id),eventId=`training-unpaid-expiry:${bookingId}`,guard="EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND status='cancelled') AND EXISTS(SELECT 1 FROM training_unpaid_expiries WHERE booking_id=?)",g=[bookingId,bookingId];
  try{
   await db.batch([
    db.prepare(`INSERT OR IGNORE INTO training_session_events (id,session_id,programme_id,booking_id,event_type,actor_id,idempotency_key,detail_json,created_at) SELECT ?||s.id,s.id,s.programme_id,s.booking_id,'expired_unpaid',?,?||s.id,json_object('from',s.status,'to','cancelled','consumption','not_consumed','reason',?,'trigger',?,'repair','materialised_after_expiry'),? FROM training_sessions s WHERE s.booking_id=? AND s.status IN (${OPEN_SESSION_IN}) AND ${guard}`).bind(`${eventId}:`,ACTOR,`${eventId}:`,CANCEL_REASON,text(row.trigger),asOf,bookingId,...g),
    db.prepare(`UPDATE training_sessions SET status='cancelled',updated_at=? WHERE booking_id=? AND status IN (${OPEN_SESSION_IN}) AND ${guard}`).bind(asOf,bookingId,...g),
    db.prepare(`UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=? AND status NOT IN ('completed','cancelled') AND ${guard}`).bind(text(row.schedule_group_id),...g),
    db.prepare(`UPDATE training_programmes SET status='cancelled',cancelled_sessions=(SELECT COUNT(*) FROM training_sessions s WHERE s.programme_id=training_programmes.id AND s.status='cancelled'),updated_at=? WHERE booking_id=? AND status NOT IN (${TERMINAL_PROGRAMME_IN}) AND ${guard}`).bind(asOf,bookingId,...g),
    db.prepare(`INSERT OR IGNORE INTO training_programme_events (id,programme_id,booking_id,event_type,actor_id,detail_json,created_at) SELECT ?,p.id,p.booking_id,'programme_expired_unpaid',?,?,? FROM training_programmes p WHERE p.booking_id=? AND ${guard}`).bind(eventId,ACTOR,JSON.stringify({repair:"materialised_after_expiry",policyVersion:POLICY_VERSION}),asOf,bookingId,...g),
   ]);
   report.repairs++;
  }catch(error){report.errors.push(`${bookingId}:repair:${await errorText(error)}`);}
 }
}

export type TrainingUnpaidExpirySweepReport={skipped:boolean;reason?:string;processed:number;expired:number;expiredBookingIds:string[];skippedByReason:Record<string,number>;providerReads:number;lateCaptureRefunds:number;repairs:number;errors:string[]};

/*
 * Candidates carry every cheap predicate in SQL - trigger due, payment allow-list, nothing captured, no
 * progressed session, no checkout in grace - so bookings that can never expire rarely reach the loop.
 * The Training funding predicate is per booking and is checked in the loop, where a funded booking costs
 * one read and does not count against the run's limit; the scan window and the last_checked_at rotation
 * keep a large set of funded payment_pending bookings from starving newer eligible ones.
 */
async function selectCandidates(db:Db,tables:Set<string>,asOf:number,scanLimit:number){
 const binds:unknown[]=[],checks=tables.has("training_unpaid_expiry_checks");
 let sql=`SELECT b.id FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id${checks?" LEFT JOIN training_unpaid_expiry_checks c ON c.booking_id=b.id":""} WHERE b.service_code='dog_training' AND b.status='payment_pending' AND p.status IN (${PAYMENT_IN})`;
 if(tables.has("training_unpaid_expiries"))sql+=" AND NOT EXISTS(SELECT 1 FROM training_unpaid_expiries x WHERE x.booking_id=b.id)";
 if(tables.has("payment_reconciliation_records"))sql+=" AND NOT EXISTS(SELECT 1 FROM payment_reconciliation_records r WHERE r.booking_id=b.id AND r.captured_amount>0)";
 if(tables.has("payment_intents")){sql+=" AND NOT EXISTS(SELECT 1 FROM payment_intents i WHERE i.booking_id=b.id AND (i.state IN ('CAPTURED','SETTLED') OR i.created_at>? OR i.updated_at>?))";binds.push(asOf-CHECKOUT_GRACE_MS,asOf-CHECKOUT_GRACE_MS);}
 if(tables.has("training_sessions"))sql+=` AND NOT EXISTS(SELECT 1 FROM training_sessions s WHERE s.booking_id=b.id AND s.status NOT IN (${SESSION_IN}))`;
 sql+=" AND (b.created_at<=? OR EXISTS(SELECT 1 FROM scheduling_reservations r WHERE r.group_id=b.schedule_group_id AND r.status!='cancelled' AND julianday(r.scheduled_start)<=julianday(?)))";binds.push(asOf-TRAINING_UNPAID_EXPIRY_MS,iso(asOf));
 sql+=` ORDER BY ${checks?"COALESCE(c.last_checked_at,0) ASC,":""}b.created_at ASC,b.id ASC LIMIT ?`;binds.push(scanLimit);
 return(await db.prepare(sql).bind(...binds).all<Row>()).results.map(row=>text(row.id));
}

/**
 * The 5-minute sweep (lib/background-scheduler.ts, 'trainingUnpaidExpiry'): late-capture refunds, repairs,
 * then up to `limit` expiries, oldest and least recently checked first. Cold-database safe - it creates no
 * Training table until a Training candidate or marker exists - and it never throws for a single booking.
 */
export async function runTrainingUnpaidExpirySweep(db:Db,env:Env,input:{asOf?:number;limit?:number}={}):Promise<TrainingUnpaidExpirySweepReport>{
 const asOf=input.asOf??Date.now(),limit=Math.max(1,Math.min(100,Math.floor(input.limit??50))),scanLimit=limit*4;
 const report:TrainingUnpaidExpirySweepReport={skipped:false,processed:0,expired:0,expiredBookingIds:[],skippedByReason:{},providerReads:0,lateCaptureRefunds:0,repairs:0,errors:[]};
 try{
  const tables=await tableSet(db,["canonical_bookings","booking_payments","scheduling_reservations","training_unpaid_expiries","training_unpaid_expiry_checks","training_sessions","payment_reconciliation_records","payment_intents"]);
  if(!tables.has("canonical_bookings")||!tables.has("booking_payments")||!tables.has("scheduling_reservations"))return{...report,skipped:true,reason:"schema_missing"};
  if(tables.has("training_unpaid_expiries")){
   await ensureTrainingUnpaidExpiryTables(db);
   // 'captured' is always looked at: a later capture on another order sets the payment back to it. The other
   // collected statuses keep their value after a case is opened, so they are looked at until one exists.
   const late=await db.prepare("SELECT x.booking_id,p.id payment_id,b.city_id,b.scheduled_start FROM training_unpaid_expiries x JOIN canonical_bookings b ON b.id=x.booking_id JOIN booking_payments p ON p.booking_id=x.booking_id WHERE p.status='captured' OR (p.status IN ('paid','partially_refunded') AND x.late_capture_refund_case_id IS NULL) ORDER BY x.expired_at LIMIT ?").bind(limit).all<Row>();
   for(const row of late.results){try{if(await refundLateCapture(db,row,asOf))report.lateCaptureRefunds++;}catch(error){report.errors.push(`${text(row.booking_id)}:late-capture:${await errorText(error)}`);}}
   await repairExpiries(db,asOf,report);
  }
  const candidates=await selectCandidates(db,tables,asOf,scanLimit);
  if(!candidates.length)return report;
  await ensureTrainingUnpaidExpiryTables(db);
  const budget={providerReads:MAX_PROVIDER_READS_PER_RUN};let attempts=0;
  for(const bookingId of candidates){
   if(attempts>=limit)break;
   report.processed++;
   let outcome:TrainingUnpaidExpiryOutcome;
   try{outcome=await expireUnpaidTrainingBooking(db,env,{bookingId,asOf,budget});}
   catch(error){outcome=skipped(bookingId,"error");report.errors.push(`${bookingId}:${await errorText(error)}`);}
   // A funded booking is one cheap read; only bookings that went on to the locked path use up the limit.
   if(outcome.reason!=="funded")attempts++;
   if(outcome.status==="expired"){report.expired++;report.expiredBookingIds.push(bookingId);if(outcome.detail?.postCommitError)report.errors.push(`${bookingId}:post-commit:${text(outcome.detail.postCommitError)}`);continue;}
   report.skippedByReason[outcome.reason]=(report.skippedByReason[outcome.reason]||0)+1;
   await db.prepare("INSERT INTO training_unpaid_expiry_checks (booking_id,last_checked_at,last_outcome,checks,updated_at) VALUES (?,?,?,1,?) ON CONFLICT(booking_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,last_outcome=excluded.last_outcome,checks=training_unpaid_expiry_checks.checks+1,updated_at=excluded.updated_at").bind(bookingId,asOf,outcome.reason,asOf).run();
  }
  report.providerReads=MAX_PROVIDER_READS_PER_RUN-budget.providerReads;
 }catch(error){
  if(/no such table/i.test(error instanceof Error?error.message:String(error)))return{...report,skipped:true,reason:"schema_missing"};
  throw error;
 }
 return report;
}
