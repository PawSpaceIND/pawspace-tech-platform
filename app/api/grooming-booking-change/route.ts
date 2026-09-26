import{ensureProviderCapacityTables}from"../../../lib/provider-capacity-governance";
import{CUSTOMER_CANCELLABLE_WORK_STATUSES,customerPaidTowardsBooking,groomingChangePreview}from"../../../lib/grooming-change-preview";
import{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit,securityAuditStatement,type AuthenticatedActor}from"../../../lib/server-auth";
import{evaluateBookingChange,parsePolicySnapshot,resolveGroomingPolicy}from"../../../lib/grooming-policy-governance";
import{bridgeLifecycleCommunications}from"../../../lib/lifecycle-communications";
import{handleReferralBookingCancellation}from"../../../lib/referral-booking-governance";
import{evaluateCancellationRefund,resolveRefundPolicy}from"../../../lib/refund-policy-governance";
import{openCancellationCase}from"../../../lib/cancellation-case-governance";
import{formatRupees}from"../../../lib/grooming-reschedule-governance";
import{GROOMING_CHANGE_ASSERTION,groomingRescheduleMoveStatements,planGroomingRescheduleMove}from"../../../lib/grooming-reschedule-move";
import{differencePaymentAvailable,ensureGroomingRescheduleTables,groomingRescheduleCancellationStatements,groomingReschedulePaymentInFlight,payGroomingRescheduleDifference,quoteGroomingRescheduleDifference,readGroomingRescheduleRequest,RESCHEDULE_HOLD_MS}from"../../../lib/grooming-reschedule-payment";
import{formatIndiaDateTime}from"../../../lib/india-time";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;
/**
 * reschedule        move now, or refuse a dearer slot with a quoted request to pay the difference against
 * reschedule_quote  the same checks and price without moving anything
 * reschedule_pay    hold the new slot and open the Razorpay order for the difference of a quoted request
 */
type Input={expectedConsentRevision?:string;bookingId:string;customerId:string;action:"cancel"|"reschedule"|"reschedule_quote"|"reschedule_pay";reason?:string;reasonCategory?:string;scheduledStart?:string;scheduledEnd?:string;requestId?:string;expectedDifference?:number;idempotencyKey?:string};

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
async function runtimeEnv(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
async function ensureTables(db:Db){await ensureProviderCapacityTables(db);await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_change_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT grooming_change_assertion CHECK(ok=1))"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  // FIN-D4. The cancellation batch now writes the customer's notification, so the table must exist here.
  db.prepare("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);
  // Additive: the approved refund evaluation that produced the case, so a finance reviewer can see which
  // policy version, which notice band and which basis were applied - and the gateway deduction recorded
  // BESIDE the customer's amount rather than taken out of it. [PTJA-W1-F24]
  await db.prepare("ALTER TABLE booking_refund_cases ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'").run().catch((error:unknown)=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
  // Reschedule requests (pay the difference) and the purpose/payment columns of refund cases.
  await ensureGroomingRescheduleTables(db);
}
async function event(db:Db,bookingId:string,eventType:string,actorId:string,detail:unknown,now:number){await db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,"booking",bookingId,actorId,JSON.stringify(detail),now).run();}

export async function GET(request:Request){try{
 const actor=await resolveActor(request);requirePermission(actor,"scheduling.book");
 const params=new URL(request.url).searchParams,requestId=params.get("requestId");
 if(requestId){
  // Status of a pay-the-difference reschedule: moved, refund raised, expired or still waiting.
  const db=await database();await ensureGroomingRescheduleTables(db);
  const owner=await db.prepare("SELECT customer_id,booking_id FROM grooming_reschedule_requests WHERE id=?").bind(requestId).first<Row>();if(!owner)return json({error:"Reschedule request not found"},404);
  await requireCustomerOwnership(db,actor,String(owner.customer_id));
  const view=await readGroomingRescheduleRequest(db,{requestId});
  const booking=await db.prepare("SELECT scheduled_start,scheduled_end,status,provider_id,total_amount FROM canonical_bookings WHERE id=?").bind(owner.booking_id).first<Row>();
  return json({data:{request:view,booking:booking?{scheduledStart:String(booking.scheduled_start),scheduledEnd:String(booking.scheduled_end),status:String(booking.status),providerId:booking.provider_id?String(booking.provider_id):null,totalAmount:Number(booking.total_amount||0)}:null}});
 }
 const bookingId=params.get("bookingId");if(!bookingId)return json({error:"Booking ID is required"},400);
 const db=await database();
 const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(bookingId).first<Row>();if(!booking)return json({error:"Grooming booking not found"},404);
 await requireCustomerOwnership(db,actor,String(booking.customer_id));
 const work=await db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(bookingId).first<Row>(),payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>();
 if(!work||!payment)return json({error:"Booking work order or payment record is missing"},409);
 return json({data:await groomingChangePreview(db,booking,work,payment)});
}catch(error){return authError(error,"Unable to preview Grooming booking changes");}}

export async function executeGroomingBookingChange(request:Request,actorOverride?:AuthenticatedActor){
  try{
    const input=await request.json() as Input;
    if(!input.bookingId||!input.customerId||!input.action)return json({error:"Booking, customer and action are required"},400);
    if(!["cancel","reschedule","reschedule_quote","reschedule_pay"].includes(input.action))return json({error:"Unknown booking change"},400);
    const db=await database();await ensureTables(db);
    const actor=actorOverride??await resolveActor(request);requirePermission(actor,"scheduling.book");
    const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(input.bookingId).first<Row>();
    if(!booking)return json({error:"Grooming booking not found"},404);
    if(String(booking.customer_id)!==input.customerId)return json({error:"This customer does not own the booking"},403);
    await requireCustomerOwnership(db,actor,input.customerId);
    const status=String(booking.status);
    let pricing:Record<string,unknown>={};try{pricing=JSON.parse(String(booking.pricing_json||"{}")) as Record<string,unknown>;}catch{}
    const frozenPolicy=parsePolicySnapshot(pricing.commercialPolicy)??await resolveGroomingPolicy(db,String(booking.city_id),String(booking.zone_id),new Date(Number(booking.created_at||Date.now())));
    const rescheduleHistory=await db.prepare("SELECT COUNT(*) count FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_rescheduled'").bind(input.bookingId).first<{count:number}>();
    const policyEvaluation=evaluateBookingChange(frozenPolicy,{action:input.action==="cancel"?"cancel":"reschedule",scheduledStart:String(booking.scheduled_start),status,bookingAmount:Number(booking.total_amount||0),rescheduleCount:Number(rescheduleHistory?.count||0)});
    const work=await db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(input.bookingId).first<Row>();
    const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
    if(!work||!payment)return json({error:"Booking work order or payment record is missing"},409);
    // reschedule_pay echoes its request's own consent revision; the payment step checks that one.
    if(input.expectedConsentRevision!==undefined&&input.action!=="reschedule_pay"){
      const current=await groomingChangePreview(db,booking,work,payment);
      if(input.expectedConsentRevision!==current.consentRevision)return json({error:"Booking change terms have changed. Review the latest preview before confirming.",code:"booking_change_terms_changed"},409);
    }
    const now=Date.now(),auditActor=actor.email;

    /*
     * A booking that has already started is not cancelled by the customer asking. It opens a REVIEWABLE
     * CASE and the operational state is preserved exactly as it is:
     *
     *   Cancellation requested -> Case opened -> Booking remains active -> Operations decision
     *   -> Finance decision if applicable -> Customer and provider notified -> Case closed
     *
     * on_the_way / arrived : the booking stays active; Operations decides proceed, stop or return.
     * in_service           : the booking stays in service; the customer cannot cancel it automatically.
     * completed            : cancellation is unavailable; the request becomes a service-quality dispute.
     *
     * This runs BEFORE the commercial policy's change-lock refusal on purpose. That lock answers
     * "completed bookings cannot be changed", which is true and stays true - but the approved rule says
     * the customer's request must still become a DISPUTE rather than a bare refusal, and a refusal with
     * nothing recorded is how a service-quality complaint disappears.
     *
     * Opening a case promises no refund and reverses nothing. The payment, the provider payout,
     * attendance, OTP, delivery evidence and every service record are untouched until an authorised
     * decision, and a stop uses a distinct terminal status, never ordinary 'cancelled'. A repeat tap
     * reuses the open case rather than opening a second one.
     */
    let refundEvaluation:Awaited<ReturnType<typeof evaluateCancellationRefund>>|null=null;
    if(input.action==="cancel"){
      const refundPolicy=await resolveRefundPolicy(db,{serviceCode:String(booking.service_code||"grooming"),cityId:String(booking.city_id||"")});
      refundEvaluation=evaluateCancellationRefund(refundPolicy,{
        scheduledStart:String(booking.scheduled_start),bookingStatus:status,cancelledBy:"customer",
        amountPaid:await customerPaidTowardsBooking(db,payment),
        couponValue:Number((pricing.discount as number|undefined)??0),
        now,
      });
      if(!refundEvaluation.automatic&&refundEvaluation.requiresApproval){
        const reasonText=(input.reason||"Customer cancelled from PawSpace").trim();
        const opened=await openCancellationCase(db,{
          bookingId:input.bookingId,customerId:input.customerId,serviceCode:String(booking.service_code||"grooming"),
          cityId:String(booking.city_id||""),bookingStatus:status,requestedBy:auditActor,
          reasonCategory:input.reasonCategory??null,reasonText,refundEvaluation,now,
        });
        await event(db,input.bookingId,opened.reused?"booking_cancellation_case_reopened_request":"booking_cancellation_case_opened",auditActor,{caseId:opened.case.id,caseType:opened.case.caseType,refundEvaluation,status},now);
        await securityAudit(db,actor,"grooming.booking.cancel","booking",input.bookingId,"blocked",{reason:reasonText,status,policyVersion:refundEvaluation.policyVersion,caseId:opened.case.id,reused:opened.reused});
        return json({
          error:opened.case.caseType==="service_dispute"
            ?"This booking is complete, so it cannot be cancelled; a service-quality dispute has been opened"
            :"This booking has already started, so it cannot be cancelled directly; a review case has been opened and the booking is unchanged",
          code:opened.case.caseType==="service_dispute"?"dispute_case_opened":"cancellation_requires_approval",
          caseId:opened.case.id,caseType:opened.case.caseType,caseStatus:opened.case.status,
          reasonCategory:opened.case.reasonCategory,duplicateOfOpenCase:opened.reused,
          bookingStatusUnchanged:status,refundPromised:false,
          refundPolicy:refundEvaluation,approvalPermissions:refundEvaluation.approvalPermissions,disputeAllowed:refundEvaluation.disputeAllowed,
        },409);
      }
    }
    if(!policyEvaluation.allowed)return json({error:`Booking change is blocked by policy ${policyEvaluation.policyVersion}`,policy:policyEvaluation},409);

    if(input.action==="cancel"){
      if(!(CUSTOMER_CANCELLABLE_WORK_STATUSES as readonly string[]).includes(String(work.status)))return json({error:"Provider work has progressed or changed. Refresh the booking and contact support for cancellation review."},409);
      const reason=(input.reason||"Customer cancelled from PawSpace").trim();
      if(!refundEvaluation)return json({error:"The cancellation refund policy could not be evaluated"},409);
      const refundAmount=refundEvaluation.customerRefundAmount;
      const refundId=refundAmount>0?crypto.randomUUID():null;
      const usage=await db.prepare("SELECT * FROM booking_subscription_usage WHERE booking_id=?").bind(input.bookingId).first<Row>();
      const reservedSessions=usage?Number(usage.sessions_reserved||0):0;
      const subscriptionId=usage?String(usage.plan_code):"";
      const subscription=subscriptionId?await db.prepare("SELECT * FROM customer_grooming_subscriptions WHERE id=?").bind(subscriptionId).first<Row>():null;
      if(usage&&(!subscription||String(usage.customer_id)!==input.customerId||String(subscription.customer_id)!==input.customerId||!Number.isInteger(reservedSessions)||reservedSessions<0||Number(subscription.sessions_reserved)<reservedSessions))return json({error:"Subscription credits require review before cancellation."},409);
      const assertionId=crypto.randomUUID(),cancellationEventId=crypto.randomUUID(),cancellationNotificationId=crypto.randomUUID();
      const usageGuard=usage?db.prepare(`INSERT INTO grooming_change_assertions (id,ok) SELECT ?,CASE WHEN
        EXISTS (SELECT 1 FROM booking_subscription_usage WHERE id=? AND booking_id=? AND customer_id=? AND plan_code=? AND sessions_reserved=? AND sessions_consumed=? AND status=? AND updated_at=?)
        AND EXISTS (SELECT 1 FROM customer_grooming_subscriptions WHERE id=? AND customer_id=? AND sessions_reserved=? AND sessions_consumed=? AND status=? AND source_booking_id=? AND updated_at=?)
        THEN 1 ELSE 0 END`).bind(`${assertionId}-credits`,usage.id,input.bookingId,input.customerId,usage.plan_code,usage.sessions_reserved,usage.sessions_consumed,usage.status,usage.updated_at,subscription!.id,input.customerId,subscription!.sessions_reserved,subscription!.sessions_consumed,subscription!.status,subscription!.source_booking_id,subscription!.updated_at)
        :db.prepare("INSERT INTO grooming_change_assertions (id,ok) SELECT ?,CASE WHEN NOT EXISTS (SELECT 1 FROM booking_subscription_usage WHERE booking_id=?) THEN 1 ELSE 0 END").bind(`${assertionId}-credits`,input.bookingId);
      const statements=[usageGuard,
        db.prepare(`INSERT INTO grooming_change_assertions (id,ok) SELECT ?,CASE WHEN
          EXISTS (SELECT 1 FROM canonical_bookings WHERE id=? AND status=? AND scheduled_start=? AND scheduled_end=? AND provider_id IS ? AND updated_at=?)
          AND EXISTS (SELECT 1 FROM provider_work_orders WHERE booking_id=? AND status=? AND scheduled_start=? AND scheduled_end=? AND provider_id IS ? AND updated_at=?)
          AND EXISTS (SELECT 1 FROM booking_payments WHERE id=? AND booking_id=? AND status=? AND amount=? AND updated_at=?)
          THEN 1 ELSE 0 END`).bind(assertionId,input.bookingId,status,booking.scheduled_start,booking.scheduled_end,booking.provider_id??null,booking.updated_at,input.bookingId,work.status,work.scheduled_start,work.scheduled_end,work.provider_id??null,work.updated_at,payment.id,input.bookingId,payment.status,payment.amount,payment.updated_at),
        db.prepare("UPDATE canonical_bookings SET status='cancelled',updated_at=? WHERE id=?").bind(now,input.bookingId),
        db.prepare("UPDATE provider_work_orders SET status='cancelled',updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
        db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?").bind(booking.schedule_group_id),
        db.prepare("UPDATE provider_assignment_offers SET status='cancelled',responded_at=?,response_reason=?,updated_at=? WHERE group_id=? AND status='pending'").bind(now,reason,now,booking.schedule_group_id),
        db.prepare("UPDATE scheduling_assignment_decisions SET status='cancelled',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(auditActor,reason,now,booking.schedule_group_id),
        db.prepare("UPDATE booking_payments SET status=?,detail_json=json_set(json_set(detail_json,'$.cancelReason',?),'$.commercialPolicyEvaluation',json(?)),updated_at=? WHERE booking_id=?").bind(refundAmount>0?"refund_pending":"cancelled",reason,JSON.stringify(policyEvaluation),now,input.bookingId),
        db.prepare("UPDATE booking_subscription_usage SET sessions_reserved=0,status=CASE WHEN sessions_consumed=0 THEN 'reversed' ELSE status END,updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
        // A reschedule being paid for is closed and its slot hold released with the booking.
        ...groomingRescheduleCancellationStatements(db,{bookingId:input.bookingId,now}),
      ];
      if(subscriptionId&&reservedSessions>0)statements.push(db.prepare("UPDATE customer_grooming_subscriptions SET sessions_reserved=MAX(0,sessions_reserved-?),status=CASE WHEN source_booking_id=? THEN ? ELSE status END,updated_at=? WHERE id=?").bind(reservedSessions,input.bookingId,refundAmount>0?"refund_pending":"cancelled",now,subscriptionId));
      if(refundId)statements.push(db.prepare("INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,'requested',?,?,?,?)").bind(refundId,input.bookingId,payment.id,refundAmount,reason,auditActor,JSON.stringify(refundEvaluation),now,now));
      statements.push(
        db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(cancellationEventId,input.bookingId,"booking_cancelled","booking",input.bookingId,auditActor,JSON.stringify({customerId:input.customerId,reason,capacityReleased:true,paymentStatus:refundAmount>0?"refund_pending":"cancelled",refundCaseId:refundId,refundAmount,policy:policyEvaluation,subscriptionId:subscription?.id??null,subscriptionSessionsReleased:reservedSessions,referral:{status:"pending_evaluation"}}),now),
        securityAuditStatement(db,actor,"grooming.cancel","booking",input.bookingId,"completed",{customerId:input.customerId,refundCaseId:refundId,refundAmount,policy:policyEvaluation,subscriptionId:subscription?.id??null,reservedSessions}),
        /* FIN-D4. The cancellation transaction moved the booking, the work order, the reservation, the
         * offer, the payment and the subscription credits - and told the customer nothing. Their booking
         * simply stopped existing. The notification is written INSIDE the same batch as the cancellation
         * so it cannot be lost: either the booking is cancelled and the customer is told, or neither. */
        db.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,'queued',?,?)")
          .bind(cancellationNotificationId,input.bookingId,input.customerId,"whatsapp","booking_cancelled",
            refundAmount>0
              ?`Your PawSpace grooming booking is cancelled. A refund of ₹${refundAmount} has been raised and will go back to your original payment method.`
              :"Your PawSpace grooming booking is cancelled. Open the order to review payment and refund details.",
            cancellationEventId,now),
        db.prepare("DELETE FROM grooming_change_assertions WHERE id IN (?,?)").bind(assertionId,`${assertionId}-credits`),
      );
      try{await db.batch(statements);}catch(error){
        if(/CHECK constraint failed.*grooming_change_assertion/i.test(error instanceof Error?error.message:String(error)))return json({error:"The booking, provider work, payment or subscription credits changed. Refresh before requesting cancellation."},409);
        throw error;
      }
      /* FIN-D4. Committed. The queued notification is now handed to the canonical bridge, the same one
       * booking-operations uses, so it becomes a real outbound message instead of a row nobody reads.
       * Deliberately AFTER the batch and unawaited-for-failure: the bridge never throws, and a messaging
       * problem must not undo a cancellation that has already released capacity and raised a refund. */
      await bridgeLifecycleCommunications(db,{bookingId:input.bookingId,source:"booking_customer_notifications",actorId:auditActor,notificationId:cancellationNotificationId});
      let referral:unknown;try{referral=await handleReferralBookingCancellation(db,{bookingId:input.bookingId,actorId:auditActor,reason});}catch(error){referral={applicable:true,status:"review_required",reason:error instanceof Error?error.message:"Referral cancellation consequence requires review"};}
      return json({data:{bookingId:input.bookingId,status:"cancelled",paymentStatus:refundAmount>0?"refund_pending":"cancelled",refundCaseId:refundId,refundAmount,policy:policyEvaluation,capacityReleased:true,subscriptionSessionsReleased:reservedSessions,referral}});
    }

    if(input.action==="reschedule_pay"){
      if(!input.requestId)return json({error:"The reschedule request is required"},400);
      const runtime=await runtimeEnv();
      const outcome=await payGroomingRescheduleDifference(db,runtime,request,{booking,work,payment,customerId:input.customerId,requestId:input.requestId,expectedDifference:input.expectedDifference,expectedConsentRevision:input.expectedConsentRevision,idempotencyKey:input.idempotencyKey,now});
      await securityAudit(db,actor,"grooming.reschedule.pay_difference","booking",input.bookingId,outcome.status<300?"completed":"blocked",{customerId:input.customerId,requestId:input.requestId,status:outcome.status,code:outcome.body.code??null});
      return json(outcome.body,outcome.status);
    }
    // A difference being paid for, or paid and moving, is finished first: another move now would only leave
    // that payment to be refunded. Cancelling stays available (it releases the hold and refunds).
    const inFlight=await groomingReschedulePaymentInFlight(db,{bookingId:input.bookingId,now});
    const inFlightRefusal=(error:string)=>json({error,code:"reschedule_payment_in_progress",bookingUnchanged:true,charged:false,differencePaymentAvailable:true,requestId:inFlight?.requestId,request:inFlight},409);
    if(inFlight&&inFlight.status!=="awaiting_payment")return inFlightRefusal(`We have received your payment to move this booking to ${formatIndiaDateTime(inFlight.toStart)} and are moving it now. Refresh your booking in a moment.`);
    const planned=await planGroomingRescheduleMove(db,{booking,work,payment,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,now,price:true});
    if(!planned.ok)return json(planned.refusal.body,planned.refusal.status);
    const plan=planned.plan,reschedulePricing=plan.pricing!;
    /*
     * The new slot is priced with the governed quote a booking uses. Same or lower: the booked price is
     * kept and the difference is not refunded. Higher: nothing moves and nothing is charged until the
     * customer approves and pays the difference (owner decision M4): the refusal carries a quoted
     * request to pay against. Where paying online is not available the refusal stands as before. [QA M4]
     */
    if(reschedulePricing.priceDifference>0){
      const increase={code:"reschedule_price_increase",priceDifference:reschedulePricing.priceDifference,bookedAmount:reschedulePricing.bookedAmount,newSlotAmount:reschedulePricing.newSlotAmount,currency:reschedulePricing.currency,bookingUnchanged:true,charged:false};
      if(!differencePaymentAvailable(await runtimeEnv(),payment))return json({
        error:`This time costs ${formatRupees(reschedulePricing.priceDifference)} more than your booked price. Your booking has not been moved and nothing has been charged. Paying the difference online is not available yet, so choose a time at the same or a lower price, or contact PawSpace support to move to this time.`,
        ...increase,differencePaymentAvailable:false,pricing:reschedulePricing,
      },409);
      const offer=await quoteGroomingRescheduleDifference(db,{booking,work,payment,plan,actor,customerId:input.customerId,reason:input.reason||"Customer rescheduled",now});
      if(offer.paymentInProgress)return json({error:`You are already paying to move this booking to ${formatIndiaDateTime(offer.request.toStart)}. Finish that payment, or wait until the held time is released, before choosing another time. Your booking has not been changed.`,code:"reschedule_payment_in_progress",bookingUnchanged:true,charged:false,differencePaymentAvailable:true,requestId:offer.request.requestId,request:offer.request},409);
      return json({
        error:`This time costs ${formatRupees(reschedulePricing.priceDifference)} more than your booked price. Your booking has not been moved and nothing has been charged. To move to this time, approve and pay the ${formatRupees(reschedulePricing.priceDifference)} difference; we hold the time for 10 minutes while you pay.`,
        ...increase,differencePaymentAvailable:true,requestId:offer.request.requestId,consentRevision:offer.request.consentRevision,newTotalAmount:offer.request.newTotalAmount,holdMinutes:RESCHEDULE_HOLD_MS/60_000,request:offer.request,pricing:reschedulePricing,
      },409);
    }
    if(inFlight&&input.action==="reschedule")return inFlightRefusal(`You are already paying to move this booking to ${formatIndiaDateTime(inFlight.toStart)}. Finish that payment, or wait until the held time is released, before choosing another time. Your booking has not been changed.`);
    const pricingEvidence={...reschedulePricing,storedPriceKept:true,differenceRefunded:false};
    if(input.action==="reschedule_quote")return json({data:{bookingId:input.bookingId,differencePaymentRequired:false,priceDifference:reschedulePricing.priceDifference,providerId:plan.providerId,providerChanged:Boolean(plan.replacement),scheduledStart:plan.start.toISOString(),scheduledEnd:plan.end.toISOString(),pricing:pricingEvidence}});
    const built=await groomingRescheduleMoveStatements(db,{booking,work,plan,actor,customerId:input.customerId,reason:input.reason||"Customer rescheduled",now,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount,pricingEvidence});
    if(!built.ok)return json(built.refusal.body,built.refusal.status);
    try{await db.batch(built.statements);}catch(error){
      if(GROOMING_CHANGE_ASSERTION.test(error instanceof Error?error.message:String(error)))return json({error:"The booking or provider availability changed. Refresh before requesting another time."},409);
      throw error;
    }
    return json({data:{...built.result,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount,pricing:pricingEvidence}});
  }catch(error){return authError(error,"Unable to change Grooming booking");}
}

export async function POST(request:Request){return executeGroomingBookingChange(request);}
