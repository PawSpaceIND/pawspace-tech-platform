import{authError,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{evaluateBookingChange,parsePolicySnapshot,resolveGroomingPolicy}from"../../../lib/grooming-policy-governance";
import{handleReferralBookingCancellation}from"../../../lib/referral-booking-governance";
import{evaluateCancellationRefund,resolveRefundPolicy}from"../../../lib/refund-policy-governance";
import{openCancellationCase}from"../../../lib/cancellation-case-governance";
import{cityOffsetMinutes,scheduleRules}from"../../../backend/src/scheduling";
import{listAuthoritativeAvailability}from"../../../lib/scheduling-roster-authority";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;
type Input={bookingId:string;customerId:string;action:"cancel"|"reschedule";reason?:string;reasonCategory?:string;scheduledStart?:string;scheduledEnd?:string};

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
const shiftIso=(value:string,ms:number)=>new Date(new Date(value).getTime()+ms).toISOString();
const minutesOfLocalDay=(value:string,offsetMinutes:number)=>{const local=new Date(new Date(value).getTime()+offsetMinutes*60_000);return{date:local.toISOString().slice(0,10),minutes:local.getUTCHours()*60+local.getUTCMinutes()};};
const rosterWindowCovers=(window:string,startMinutes:number,endMinutes:number)=>{const match=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);if(!match)return false;const from=Number(match[1])*60+Number(match[2]),to=Number(match[3])*60+Number(match[4]);return startMinutes>=from&&endMinutes<=to;};

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
    const work=await db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(input.bookingId).first<Row>();
    const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
    if(!work||!payment)return json({error:"Booking work order or payment record is missing"},409);
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
      const captured=["captured","paid"].includes(String(payment.status));
      const refundPolicy=await resolveRefundPolicy(db,{serviceCode:String(booking.service_code||"grooming"),cityId:String(booking.city_id||"")});
      refundEvaluation=evaluateCancellationRefund(refundPolicy,{
        scheduledStart:String(booking.scheduled_start),bookingStatus:status,cancelledBy:"customer",
        amountPaid:captured?Number(payment.amount||0):0,
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
      const reason=(input.reason||"Customer cancelled from PawSpace").trim();
      if(!refundEvaluation)return json({error:"The cancellation refund policy could not be evaluated"},409);
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
    const providerId=String(work.provider_id),cityId=String(booking.city_id),zoneId=String(booking.zone_id),offsetMinutes=cityOffsetMinutes(cityId);
    const profile=await db.prepare("SELECT travel_buffer_minutes,max_daily_jobs,live,status,effective_from,effective_to FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
    if(!profile||Number(profile.live)!==1||String(profile.status)!=="active")return json({error:"The assigned provider is no longer available for that slot"},409);
    const travelBufferMinutes=profile.travel_buffer_minutes===null||profile.travel_buffer_minutes===undefined?scheduleRules.grooming.bufferMinutes:Number(profile.travel_buffer_minutes);
    const maxDailyJobs=profile.max_daily_jobs===null||profile.max_daily_jobs===undefined?6:Number(profile.max_daily_jobs);
    if(!Number.isFinite(travelBufferMinutes)||travelBufferMinutes<0||!Number.isInteger(maxDailyJobs)||maxDailyJobs<0)return json({error:"The assigned provider capacity configuration is invalid"},409);
    const localStart=minutesOfLocalDay(start.toISOString(),offsetMinutes),localEnd=minutesOfLocalDay(end.toISOString(),offsetMinutes);
    if(localStart.date!==localEnd.date)return json({error:"The assigned provider is no longer available for that slot"},409);
    const effectiveFrom=String(profile.effective_from||""),effectiveTo=profile.effective_to?String(profile.effective_to):null;
    if((effectiveFrom&&localStart.date<effectiveFrom)||(effectiveTo&&localStart.date>effectiveTo))return json({error:"The assigned provider is no longer available for that slot"},409);
    const roster=await listAuthoritativeAvailability(db,providerId,localStart.date);
    const rosterCovered=roster.some(row=>String(row.city_id)===cityId&&String(row.zone_id)===zoneId&&(()=>{try{return (JSON.parse(String(row.windows_json||"[]")) as string[]).some(window=>rosterWindowCovers(window,localStart.minutes,localEnd.minutes));}catch{return false;}})());
    if(!rosterCovered)return json({error:"The assigned provider is no longer available for that slot"},409);
    const localDayStartUtc=shiftIso(`${localStart.date}T00:00:00.000Z`,-offsetMinutes*60_000),localDayEndUtc=shiftIso(localDayStartUtc,86_400_000);
    const unavailable=await db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1").bind(providerId,localDayEndUtc,localDayStartUtc).first<Row>();
    if(unavailable)return json({error:"The assigned provider is no longer available for that slot"},409);
    const bufferMs=travelBufferMinutes*60_000,bufferedStart=shiftIso(start.toISOString(),-bufferMs),bufferedEnd=shiftIso(end.toISOString(),bufferMs),offsetModifier=`${offsetMinutes>=0?"+":""}${offsetMinutes} minutes`;
    // Fast pre-check for a friendly error; the authoritative write below repeats the same predicates.
    const conflicts=await db.prepare("SELECT id,group_id FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status!='cancelled' AND scheduled_start<? AND scheduled_end>? LIMIT 1").bind(providerId,booking.schedule_group_id,bufferedEnd,bufferedStart).first<Row>();
    if(conflicts)return json({error:"The assigned provider is no longer available for that slot"},409);
    const daily=await db.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status!='cancelled' AND substr(datetime(scheduled_start,?),1,10)=?").bind(providerId,booking.schedule_group_id,offsetModifier,localStart.date).first<Row>();
    if(Number(daily?.count||0)>=maxDailyJobs)return json({error:"The assigned provider is no longer available for that slot"},409);
    const oldStart=String(booking.scheduled_start),oldEnd=String(booking.scheduled_end);
    // TOCTOU-safe move: travel buffer, authored roster authority, daily-job cap, active provider status
    // and provider unavailability are all rechecked by the same guarded UPDATE that moves the reservation.
    const groupRows=await db.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").bind(booking.schedule_group_id).first<Row>(),expectedRows=Number(groupRows?.count||0);
    if(expectedRows<1)return json({error:"The booking has no active scheduling reservation to move"},409);
    const moved=await db.prepare(`UPDATE scheduling_reservations SET scheduled_start=?,scheduled_end=?,status='assigned'
      WHERE group_id=? AND status!='cancelled'
        AND NOT EXISTS (SELECT 1 FROM scheduling_reservations other WHERE other.provider_id=scheduling_reservations.provider_id AND other.group_id!=? AND other.status!='cancelled' AND other.scheduled_start<? AND other.scheduled_end>?)
        AND (SELECT COUNT(*) FROM scheduling_reservations other WHERE other.provider_id=scheduling_reservations.provider_id AND other.group_id!=? AND other.status!='cancelled' AND substr(datetime(other.scheduled_start,?),1,10)=?)<?
        AND EXISTS (SELECT 1 FROM provider_capacity_profiles p WHERE p.id=scheduling_reservations.provider_id AND p.live=1 AND p.status='active' AND (p.effective_from IS NULL OR p.effective_from<=?) AND (p.effective_to IS NULL OR p.effective_to>=?))
        AND EXISTS (SELECT 1 FROM scheduling_availability a,json_each(a.windows_json) w WHERE a.provider_id=scheduling_reservations.provider_id AND a.city_id=? AND a.zone_id=? AND a.date=? AND (a.source IN ('partner_app','operations','roster') OR NOT EXISTS (SELECT 1 FROM scheduling_availability authored WHERE authored.provider_id=a.provider_id AND authored.date=a.date AND authored.source IN ('partner_app','operations','roster'))) AND (CAST(substr(w.value,1,2) AS INTEGER)*60+CAST(substr(w.value,4,2) AS INTEGER))<=? AND (CAST(substr(w.value,7,2) AS INTEGER)*60+CAST(substr(w.value,10,2) AS INTEGER))>=?)
        AND NOT EXISTS (SELECT 1 FROM provider_unavailability u WHERE u.provider_id=scheduling_reservations.provider_id AND u.status='active' AND u.starts_at<? AND u.ends_at>?)`)
      .bind(start.toISOString(),end.toISOString(),booking.schedule_group_id,booking.schedule_group_id,bufferedEnd,bufferedStart,booking.schedule_group_id,offsetModifier,localStart.date,maxDailyJobs,localStart.date,localStart.date,cityId,zoneId,localStart.date,localStart.minutes,localEnd.minutes,localDayEndUtc,localDayStartUtc).run();
    if(Number(moved.meta?.changes||0)!==expectedRows)return json({error:"The assigned provider is no longer available for that slot"},409);
    await db.batch([
      db.prepare("UPDATE canonical_bookings SET scheduled_start=?,scheduled_end=?,status='assigned',updated_at=? WHERE id=?").bind(start.toISOString(),end.toISOString(),now,input.bookingId),
      db.prepare("UPDATE provider_work_orders SET scheduled_start=?,scheduled_end=?,status='assigned',updated_at=? WHERE booking_id=?").bind(start.toISOString(),end.toISOString(),now,input.bookingId),
      db.prepare("UPDATE scheduling_assignment_decisions SET status='assigned',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(auditActor,input.reason||"Customer rescheduled",now,booking.schedule_group_id),
    ]);
    await event(db,input.bookingId,"booking_rescheduled",auditActor,{customerId:input.customerId,from:{scheduledStart:oldStart,scheduledEnd:oldEnd},to:{scheduledStart:start.toISOString(),scheduledEnd:end.toISOString()},providerId,capacityRevalidated:true,travelBufferMinutes,maxDailyJobs,rosterDate:localStart.date,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount},now);
    await securityAudit(db,actor,"grooming.reschedule","booking",input.bookingId,"completed",{customerId:input.customerId,providerId,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount,travelBufferMinutes,maxDailyJobs,rosterDate:localStart.date});
    return json({data:{bookingId:input.bookingId,status:"assigned",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),providerId,policy:policyEvaluation,rescheduleFeeAmount:policyEvaluation.feeAmount}});
  }catch(error){return authError(error,"Unable to change Grooming booking");}
}
