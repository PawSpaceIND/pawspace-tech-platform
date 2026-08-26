import{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{evaluateBookingChange,parsePolicySnapshot,resolveGroomingPolicy}from"../../../lib/grooming-policy-governance";
import{handleReferralBookingCancellation}from"../../../lib/referral-booking-governance";
import{evaluateCancellationRefund,resolveRefundPolicy}from"../../../lib/refund-policy-governance";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;
type Input={bookingId:string;customerId:string;action:"cancel"|"reschedule";reason?:string;scheduledStart?:string;scheduledEnd?:string};

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
async function ensureTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);
  // Additive: the approved refund evaluation that produced the case, so a finance reviewer can see which
  // policy version, which notice band and which basis were applied - and the gateway deduction recorded
  // BESIDE the customer's amount rather than taken out of it. [PTJA-W1-F24]
  await db.prepare("ALTER TABLE booking_refund_cases ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'").run().catch((error:unknown)=>{if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});
}
async function event(db:Db,bookingId:string,eventType:string,actorId:string,detail:unknown,now:number){await db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,"booking",bookingId,actorId,JSON.stringify(detail),now).run();}

export async function POST(request:Request){
  try{
    const input=await request.json() as Input;
    if(!input.bookingId||!input.customerId||!input.action)return json({error:"Booking, customer and action are required"},400);
    const db=await database();await ensureTables(db);
    const actor=await resolveActor(request);requirePermission(actor,"scheduling.book");
    const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(input.bookingId).first<Row>();
    if(!booking)return json({error:"Grooming booking not found"},404);
    if(String(booking.customer_id)!==input.customerId)return json({error:"This customer does not own the booking"},403);
    await requireCustomerOwnership(db,actor,input.customerId);
    const status=String(booking.status);
    let pricing:Record<string,unknown>={};try{pricing=JSON.parse(String(booking.pricing_json||"{}")) as Record<string,unknown>;}catch{}
    const frozenPolicy=parsePolicySnapshot(pricing.commercialPolicy)??await resolveGroomingPolicy(db,String(booking.city_id),String(booking.zone_id),new Date(Number(booking.created_at||Date.now())));
    const rescheduleHistory=await db.prepare("SELECT COUNT(*) count FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_rescheduled'").bind(input.bookingId).first<{count:number}>();
    const policyEvaluation=evaluateBookingChange(frozenPolicy,{action:input.action,scheduledStart:String(booking.scheduled_start),status,bookingAmount:Number(booking.total_amount||0),rescheduleCount:Number(rescheduleHistory?.count||0)});
    if(!policyEvaluation.allowed)return json({error:`Booking change is blocked by policy ${policyEvaluation.policyVersion}`,policy:policyEvaluation},409);
    const work=await db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(input.bookingId).first<Row>();
    const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
    if(!work||!payment)return json({error:"Booking work order or payment record is missing"},409);
    const now=Date.now(),auditActor=actor.email;

    if(input.action==="cancel"){
      const reason=(input.reason||"Customer cancelled from PawSpace").trim();
      const captured=["captured","paid"].includes(String(payment.status));
      /*
       * The approved PawSpace cancellation policy decides the refund. [PTJA-W1-F24]
       *
       * MEASURED before this: a customer self-cancelled a booking whose status was `in_service` - the
       * groomer physically at the house, mid-appointment - and got HTTP 200, a 100% refund case for the
       * full Rs 2,000, the provider's work order flipped to 'cancelled' out from under them, and the
       * payment moved to refund_pending. The only change-locked statuses were 'completed' and
       * 'cancelled', so every in-flight state was self-serve cancellable at full refund.
       *
       * The refund percentage now comes from ONE place. lib/grooming-policy-governance.ts still decides
       * whether a change is ALLOWED at all - its change-locks, reschedule rules and fees are untouched -
       * but two surfaces answering "what refund is owed" is the same defect this audit closed in F14, so
       * the approved ladder is the single authority for the amount and for whether it may be paid
       * without a human.
       */
      const refundPolicy=await resolveRefundPolicy(db,{serviceCode:String(booking.service_code||"grooming"),cityId:String(booking.city_id||"")});
      const refundEvaluation=evaluateCancellationRefund(refundPolicy,{
        scheduledStart:String(booking.scheduled_start),bookingStatus:status,cancelledBy:"customer",
        amountPaid:captured?Number(payment.amount||0):0,
        couponValue:Number((pricing.discount as number|undefined)??0),
        now,
      });
      /*
       * "Once status is EN_ROUTE, ARRIVED, IN_SERVICE or COMPLETED the customer must not receive an
       * automatic refund. Customer may still raise a dispute. Only a manager/finance role may approve an
       * exception, with reason and audit history."
       *
       * So the request becomes a reviewable case instead of a self-serve cancellation: the booking, the
       * work order and the payment are left exactly as they are - a job under way is not cancelled out
       * from under the provider serving it - and the customer is told who can approve an exception and
       * that the dispute route is open. Nothing is silently refused; the request is recorded.
       */
      if(!refundEvaluation.automatic&&refundEvaluation.requiresApproval){
        const caseId=crypto.randomUUID();
        await db.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,'pending_approval',?,?,?,?)")
          .bind(caseId,input.bookingId,payment.id,refundEvaluation.customerRefundAmount,reason,auditActor,JSON.stringify(refundEvaluation),now,now).run();
        await event(db,input.bookingId,"booking_cancellation_review_requested",auditActor,{refundEvaluation,status},now);
        await securityAudit(db,actor,"grooming.booking.cancel","booking",input.bookingId,"blocked",{reason,status,policyVersion:refundEvaluation.policyVersion,refundCaseId:caseId});
        return json({error:"This cancellation needs an authorised review; the booking has not been changed",code:"cancellation_requires_approval",
          refundCaseId:caseId,refundPolicy:refundEvaluation,approvalPermissions:refundEvaluation.approvalPermissions,disputeAllowed:refundEvaluation.disputeAllowed},409);
      }
      const refundAmount=refundEvaluation.customerRefundAmount;
      const refundId=refundAmount>0?crypto.randomUUID():null;
      const usage=await db.prepare("SELECT * FROM booking_subscription_usage WHERE booking_id=?").bind(input.bookingId).first<Row>();
      const reservedSessions=usage?Number(usage.sessions_reserved||0):0;
      const subscriptionId=usage?String(usage.plan_code):"";
      const subscription=subscriptionId?await db.prepare("SELECT * FROM customer_grooming_subscriptions WHERE id=?").bind(subscriptionId).first<Row>():null;
      const statements=[
        db.prepare("UPDATE canonical_bookings SET status='cancelled',updated_at=? WHERE id=?").bind(now,input.bookingId),
        db.prepare("UPDATE provider_work_orders SET status='cancelled',updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
        db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?").bind(booking.schedule_group_id),
        db.prepare("UPDATE scheduling_assignment_decisions SET status='cancelled',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(auditActor,reason,now,booking.schedule_group_id),
        db.prepare("UPDATE booking_payments SET status=?,detail_json=json_set(json_set(detail_json,'$.cancelReason',?),'$.commercialPolicyEvaluation',json(?)),updated_at=? WHERE booking_id=?").bind(refundAmount>0?"refund_pending":"cancelled",reason,JSON.stringify(policyEvaluation),now,input.bookingId),
        db.prepare("UPDATE booking_subscription_usage SET sessions_reserved=0,status=CASE WHEN sessions_consumed=0 THEN 'reversed' ELSE status END,updated_at=? WHERE booking_id=?").bind(now,input.bookingId),
      ];
      if(subscriptionId&&reservedSessions>0)statements.push(db.prepare("UPDATE customer_grooming_subscriptions SET sessions_reserved=MAX(0,sessions_reserved-?),status=CASE WHEN source_booking_id=? THEN ? ELSE status END,updated_at=? WHERE id=?").bind(reservedSessions,input.bookingId,refundAmount>0?"refund_pending":"cancelled",now,subscriptionId));
      if(refundId)statements.push(db.prepare("INSERT OR IGNORE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,'requested',?,?,?,?)").bind(refundId,input.bookingId,payment.id,refundAmount,reason,auditActor,JSON.stringify(refundEvaluation),now,now));
      await db.batch(statements);
      let referral:unknown;try{referral=await handleReferralBookingCancellation(db,{bookingId:input.bookingId,actorId:auditActor,reason});}catch(error){referral={applicable:true,status:"review_required",reason:error instanceof Error?error.message:"Referral cancellation consequence requires review"};}
      await event(db,input.bookingId,"booking_cancelled",auditActor,{customerId:input.customerId,reason,capacityReleased:true,paymentStatus:refundAmount>0?"refund_pending":"cancelled",refundCaseId:refundId,refundAmount,policy:policyEvaluation,subscriptionId:subscription?.id??null,subscriptionSessionsReleased:reservedSessions,subscriptionStatus:subscription?refundAmount>0?"refund_pending":"cancelled":null,referral},now);
      await securityAudit(db,actor,"grooming.cancel","booking",input.bookingId,"completed",{customerId:input.customerId,refundCaseId:refundId,refundAmount,policy:policyEvaluation,subscriptionId:subscription?.id??null,reservedSessions,referral});
      return json({data:{bookingId:input.bookingId,status:"cancelled",paymentStatus:refundAmount>0?"refund_pending":"cancelled",refundCaseId:refundId,refundAmount,policy:policyEvaluation,capacityReleased:true,subscriptionSessionsReleased:reservedSessions,referral}});
    }

    if(!input.scheduledStart||!input.scheduledEnd)return json({error:"New start and end times are required"},400);
    const start=new Date(input.scheduledStart),end=new Date(input.scheduledEnd);
    if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start||start.getTime()<=now)return json({error:"A valid future time range is required"},400);
    const providerId=String(work.provider_id);
    // Fast pre-check for a friendly error; the authoritative check is the atomic guarded UPDATE below.
    const conflicts=await db.prepare("SELECT id,group_id FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status!='cancelled' AND scheduled_start<? AND scheduled_end>? LIMIT 1").bind(providerId,booking.schedule_group_id,end.toISOString(),start.toISOString()).first<Row>();
    if(conflicts)return json({error:"The assigned provider is no longer available for that slot"},409);
    const oldStart=String(booking.scheduled_start),oldEnd=String(booking.scheduled_end);
    // TOCTOU-safe move (same invariant as the scheduling engine's atomic double-booking guard):
    // the reservation moves only if NO overlapping non-cancelled reservation exists for this
    // provider at write time, so a reservation landing between the pre-check and this write
    // cannot be double-booked.
    const groupRows=await db.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").bind(booking.schedule_group_id).first<Row>();
    if(Number(groupRows?.count||0)>0){
      const moved=await db.prepare("UPDATE scheduling_reservations SET scheduled_start=?,scheduled_end=?,status='assigned' WHERE group_id=? AND status!='cancelled' AND NOT EXISTS (SELECT 1 FROM scheduling_reservations other WHERE other.provider_id=scheduling_reservations.provider_id AND other.group_id!=? AND other.status!='cancelled' AND other.scheduled_start<? AND other.scheduled_end>?)").bind(start.toISOString(),end.toISOString(),booking.schedule_group_id,booking.schedule_group_id,end.toISOString(),start.toISOString()).run();
      if(!Number(moved.meta?.changes||0))return json({error:"The assigned provider is no longer available for that slot"},409);
    }
    await db.batch([
      db.prepare("UPDATE canonical_bookings SET scheduled_start=?,scheduled_end=?,status='assigned',updated_at=? WHERE id=?").bind(start.toISOString(),end.toISOString(),now,input.bookingId),
      db.prepare("UPDATE provider_work_orders SET scheduled_start=?,scheduled_end=?,status='assigned',updated_at=? WHERE booking_id=?").bind(start.toISOString(),end.toISOString(),now,input.bookingId),
      db.prepare("UPDATE scheduling_assignment_decisions SET status='assigned',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(auditActor,input.reason||"Customer rescheduled",now,booking.schedule_group_id),
    ]);
    await event(db,input.bookingId,"booking_rescheduled",auditActor,{customerId:input.customerId,from:{scheduledStart:oldStart,scheduledEnd:oldEnd},to:{scheduledStart:start.toISOString(),scheduledEnd:end.toISOString()},providerId,capacityRevalidated:true,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount},now);
    await securityAudit(db,actor,"grooming.reschedule","booking",input.bookingId,"completed",{customerId:input.customerId,providerId,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount});
    return json({data:{bookingId:input.bookingId,status:"assigned",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),providerId,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount}});
  }catch(error){return authError(error,"Unable to change Grooming booking");}
}