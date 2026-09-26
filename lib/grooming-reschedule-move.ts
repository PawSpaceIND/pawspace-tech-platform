import{getProviderAcceptanceTimeout}from"./provider-capacity-governance";
import{securityAuditStatement,type AuthenticatedActor}from"./server-auth";
import{cityOffsetMinutes,scheduleRules}from"../backend/src/scheduling";
import{listAuthoritativeAvailability}from"./scheduling-roster-authority";
import{automaticReassignmentAllowed,quoteGroomingReschedule,rankReschedulingGroomers,reassignedReservationMove,ReschedulePricingUnavailable,type GroomingReschedulePricing}from"./grooming-reschedule-governance";
import{captureProviderAssignmentAuthority}from"./provider-assignment-authority";
import{providerAssignmentBlock}from"./provider-assignment-eligibility";
import{groomingRecoveryLifecycle}from"./grooming-recovery-lifecycle";
import type{Provider}from"../backend/src/domain";

/*
 * Moving a Grooming booking to a new time, shared by the customer reschedule route and by the move that
 * follows a paid reschedule difference (lib/grooming-reschedule-payment.ts), so both run the same checks
 * and the same guarded write. [QA M4]
 *
 *   planGroomingRescheduleMove  - can the booking move, which groomer takes the new slot, what it costs.
 *   groomingRescheduleMoveStatements - the one atomic batch that moves it (the caller runs the batch).
 */

type Db=D1Database;
type Row=Record<string,unknown>;
export type RescheduleRefusal={status:number;body:Record<string,unknown>};
export const MOVABLE_GROOMING_STATUSES=["confirmed","assigned","awaiting_acceptance"];
export const GROOMING_CHANGE_ASSERTION=/CHECK constraint failed.*grooming_change_assertion/i;

const shiftIso=(value:string,ms:number)=>new Date(new Date(value).getTime()+ms).toISOString();
const minutesOfLocalDay=(value:string,offsetMinutes:number)=>{const local=new Date(new Date(value).getTime()+offsetMinutes*60_000);return{date:local.toISOString().slice(0,10),minutes:local.getUTCHours()*60+local.getUTCMinutes()};};
const rosterWindowCovers=(window:string,startMinutes:number,endMinutes:number)=>{const match=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);if(!match)return false;const from=Number(match[1])*60+Number(match[2]),to=Number(match[3])*60+Number(match[4]);return startMinutes>=from&&endMinutes<=to;};

export type GroomingRescheduleSlot={profile:Row;travelBufferMinutes:number;maxDailyJobs:number;bufferedStart:string;bufferedEnd:string};
export type GroomingReschedulePlan={
 start:Date;end:Date;assignedProviderId:string;providerId:string;cityId:string;zoneId:string;offsetMinutes:number;
 localStart:{date:string;minutes:number};localEnd:{date:string;minutes:number};localDayStartUtc:string;localDayEndUtc:string;offsetModifier:string;
 slot:GroomingRescheduleSlot;replacement:Provider|null;replacementAuthority:Awaited<ReturnType<typeof captureProviderAssignmentAuthority>>|null;
 pricing:GroomingReschedulePricing|null;
};
type Planned={ok:true;plan:GroomingReschedulePlan}|{ok:false;refusal:RescheduleRefusal};

/**
 * Can this booking move to the new time, and with which groomer? The status, time and duration checks,
 * the assigned groomer's slot (profile, capacity, effective dates, authored roster for this city and
 * zone, leave that local day, travel-buffered conflicts, daily-job cap) and, when that groomer cannot
 * take it, the other groomers in the zone ranked by the governed scheduler. `excludeGroupIds` are
 * reservations the move itself releases (a paid reschedule's own slot hold); `preferProviderId` is the
 * groomer that hold was placed on. With `price`, the new slot is priced with the governed quote.
 */
export async function planGroomingRescheduleMove(db:Db,input:{booking:Row;work:Row;payment:Row;scheduledStart?:string;scheduledEnd?:string;now:number;price:boolean;excludeGroupIds?:string[];preferProviderId?:string|null}):Promise<Planned>{
 const{booking,work,payment,now}=input,status=String(booking.status);
 const refuse=(code:number,body:Record<string,unknown>):Planned=>({ok:false,refusal:{status:code,body}});
 if(!MOVABLE_GROOMING_STATUSES.includes(status)||!MOVABLE_GROOMING_STATUSES.includes(String(work.status)))return refuse(409,{error:"This Grooming service has progressed and cannot be rescheduled directly"});
 if(!input.scheduledStart||!input.scheduledEnd)return refuse(400,{error:"New start and end times are required"});
 const start=new Date(input.scheduledStart),end=new Date(input.scheduledEnd);
 if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start||start.getTime()<=now)return refuse(400,{error:"A valid future time range is required"});
 const bookedDuration=Date.parse(String(booking.scheduled_end))-Date.parse(String(booking.scheduled_start));
 if(!Number.isFinite(bookedDuration)||bookedDuration<=0||String(work.scheduled_start)!==String(booking.scheduled_start)||String(work.scheduled_end)!==String(booking.scheduled_end))return refuse(409,{error:"The existing booking schedule requires review before it can be moved"});
 if(end.getTime()-start.getTime()!==bookedDuration)return refuse(400,{error:"Rescheduling must preserve the booked service duration"});
 const assignedProviderId=String(work.provider_id),cityId=String(booking.city_id),zoneId=String(booking.zone_id),offsetMinutes=cityOffsetMinutes(cityId);
 const localStart=minutesOfLocalDay(start.toISOString(),offsetMinutes),localEnd=minutesOfLocalDay(end.toISOString(),offsetMinutes);
 if(localStart.date!==localEnd.date)return refuse(409,{error:"Choose a time that lets the service finish on the same day. Your booking has not been changed.",code:"reschedule_slot_unavailable",bookingUnchanged:true});
 const localDayStartUtc=shiftIso(`${localStart.date}T00:00:00.000Z`,-offsetMinutes*60_000),localDayEndUtc=shiftIso(localDayStartUtc,86_400_000),offsetModifier=`${offsetMinutes>=0?"+":""}${offsetMinutes} minutes`;
 const excludedGroups=JSON.stringify([String(booking.schedule_group_id),...(input.excludeGroupIds??[])]);
 /*
  * Can this groomer take the new slot? Profile, capacity configuration, effective dates, authored
  * roster for this city and zone, leave that local day, travel-buffered conflicts and the daily-job
  * cap - the same predicates the guarded write repeats atomically. [QA M4] This used to run for the
  * assigned groomer only and answer "The assigned provider is no longer available for that slot" when
  * it failed; the other groomers in the zone were never asked.
  */
 const slotFor=async(providerId:string):Promise<GroomingRescheduleSlot|null>=>{
  const profile=await db.prepare("SELECT travel_buffer_minutes,max_daily_jobs,live,status,effective_from,effective_to FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
  if(!profile||Number(profile.live)!==1||String(profile.status)!=="active")return null;
  const travelBufferMinutes=profile.travel_buffer_minutes===null||profile.travel_buffer_minutes===undefined?scheduleRules.grooming.bufferMinutes:Number(profile.travel_buffer_minutes);
  const maxDailyJobs=profile.max_daily_jobs===null||profile.max_daily_jobs===undefined?6:Number(profile.max_daily_jobs);
  if(!Number.isFinite(travelBufferMinutes)||travelBufferMinutes<0||!Number.isInteger(maxDailyJobs)||maxDailyJobs<0)return null;
  const effectiveFrom=String(profile.effective_from||""),effectiveTo=profile.effective_to?String(profile.effective_to):null;
  if((effectiveFrom&&localStart.date<effectiveFrom)||(effectiveTo&&localStart.date>effectiveTo))return null;
  const roster=await listAuthoritativeAvailability(db,providerId,localStart.date);
  const rosterCovered=roster.some(row=>String(row.city_id)===cityId&&String(row.zone_id)===zoneId&&(()=>{try{return (JSON.parse(String(row.windows_json||"[]")) as string[]).some(window=>rosterWindowCovers(window,localStart.minutes,localEnd.minutes));}catch{return false;}})());
  if(!rosterCovered)return null;
  const unavailable=await db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1").bind(providerId,localDayEndUtc,localDayStartUtc).first<Row>();
  if(unavailable)return null;
  const bufferMs=travelBufferMinutes*60_000,bufferedStart=shiftIso(start.toISOString(),-bufferMs),bufferedEnd=shiftIso(end.toISOString(),bufferMs);
  // Fast pre-check for a friendly error; the authoritative write repeats the same predicates.
  const conflicts=await db.prepare("SELECT id,group_id FROM scheduling_reservations WHERE provider_id=? AND group_id NOT IN (SELECT value FROM json_each(?)) AND status!='cancelled' AND scheduled_start<? AND scheduled_end>? LIMIT 1").bind(providerId,excludedGroups,bufferedEnd,bufferedStart).first<Row>();
  if(conflicts)return null;
  const daily=await db.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE provider_id=? AND group_id NOT IN (SELECT value FROM json_each(?)) AND status!='cancelled' AND substr(datetime(scheduled_start,?),1,10)=?").bind(providerId,excludedGroups,offsetModifier,localStart.date).first<Row>();
  if(Number(daily?.count||0)>=maxDailyJobs)return null;
  return{profile,travelBufferMinutes,maxDailyJobs,bufferedStart,bufferedEnd};
 };
 const preferred=input.preferProviderId&&input.preferProviderId!==assignedProviderId?input.preferProviderId:null;
 let slot=preferred?null:await slotFor(assignedProviderId),replacement:Provider|null=null,replacementAuthority:GroomingReschedulePlan["replacementAuthority"]=null;
 const reassignmentAllowed=slot?true:await automaticReassignmentAllowed(db,cityId,start);
 if(!slot&&reassignmentAllowed){
  // Another groomer in the same zone, chosen by the governed scheduler and held to the same checks. The
  // groomer a paid reschedule's hold was placed on is asked first.
  const ranked=await rankReschedulingGroomers(db,{booking,scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),excludeProviderIds:[assignedProviderId],offsetMinutes,excludeGroupIds:input.excludeGroupIds});
  const candidates=preferred?[...ranked.providers.filter(item=>item.id===preferred),...ranked.providers.filter(item=>item.id!==preferred)]:ranked.providers;
  for(const candidate of candidates){
   const candidateSlot=await slotFor(candidate.id);if(!candidateSlot)continue;
   if((await providerAssignmentBlock(db,candidate.id,start.getTime())).blocked)continue;
   // Snapshot the verification authority, then re-evaluate it: the write asserts it is unchanged.
   const authority=await captureProviderAssignmentAuthority(db,candidate.id);
   if((await providerAssignmentBlock(db,candidate.id,start.getTime())).blocked)continue;
   slot=candidateSlot;replacement=candidate;replacementAuthority=authority;break;
  }
  if(!slot&&preferred)slot=await slotFor(assignedProviderId);
 }else if(!slot&&preferred)slot=await slotFor(assignedProviderId);
 if(!slot){
  if(!reassignmentAllowed)return refuse(409,{error:"Your groomer is not available at that time, and a change of groomer in your city is arranged by PawSpace Operations. Your booking has not been changed - choose another time or contact PawSpace support.",code:"reschedule_reassignment_requires_operations",bookingUnchanged:true});
  return refuse(409,{error:"No groomer in your area is available at that time. Your booking has not been changed - please choose another time.",code:"reschedule_no_provider_available",bookingUnchanged:true});
 }
 const providerId=replacement?.id??assignedProviderId;
 let pricing:GroomingReschedulePricing|null=null;
 if(input.price){
  try{pricing=await quoteGroomingReschedule(db,{booking,payment,scheduledStart:start.toISOString()});}
  catch(error){if(error instanceof ReschedulePricingUnavailable)return refuse(409,{error:"The new time could not be priced, so your booking has not been moved. Please choose another time or contact PawSpace support.",code:"reschedule_price_unavailable",bookingUnchanged:true});throw error;}
 }
 return{ok:true,plan:{start,end,assignedProviderId,providerId,cityId,zoneId,offsetMinutes,localStart,localEnd,localDayStartUtc,localDayEndUtc,offsetModifier,slot,replacement,replacementAuthority,pricing}};
}

export type GroomingRescheduleMoveResult={bookingId:string;status:string;workOrderStatus:string;scheduledStart:string;scheduledEnd:string;providerId:string;providerChanged:boolean;previousProviderId:string;provider:{id:string;name:string;model:string};offer?:{timeoutMinutes:number;expiresAt:number}};

/**
 * The one batch that moves the booking. TOCTOU-safe: travel buffer, authored roster authority, daily-job
 * cap, active provider status and provider unavailability are all rechecked by the same guarded UPDATE
 * that moves the reservation, and the booking, work order and profile read by the plan are asserted
 * unchanged. `beforeMove` runs just before the reservation moves (a paid reschedule cancels its own slot
 * hold there, or the hold would block its own booking); `afterMove` runs after the booking is updated.
 * A failed assertion surfaces as GROOMING_CHANGE_ASSERTION from db.batch.
 */
export async function groomingRescheduleMoveStatements(db:Db,input:{booking:Row;work:Row;plan:GroomingReschedulePlan;actor:AuthenticatedActor;customerId:string;reason:string;now:number;policy:unknown;rescheduleFeeAmount:number;pricingEvidence:Record<string,unknown>;beforeMove?:D1PreparedStatement[];afterMove?:D1PreparedStatement[]}):Promise<{ok:true;statements:D1PreparedStatement[];result:GroomingRescheduleMoveResult}|{ok:false;refusal:RescheduleRefusal}>{
 const{booking,work,plan,actor,now,pricingEvidence}=input,bookingId=String(booking.id),status=String(booking.status),auditActor=actor.email;
 const{start,end,assignedProviderId,providerId,replacement,replacementAuthority,localStart,localEnd,cityId,zoneId,offsetModifier,localDayStartUtc,localDayEndUtc}=plan;
 const{profile,travelBufferMinutes,maxDailyJobs,bufferedStart,bufferedEnd}=plan.slot;
 const oldStart=String(booking.scheduled_start),oldEnd=String(booking.scheduled_end);
 const groupRows=await db.prepare("SELECT COUNT(*) count FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").bind(booking.schedule_group_id).first<Row>(),expectedRows=Number(groupRows?.count||0);
 if(expectedRows<1)return{ok:false,refusal:{status:409,body:{error:"The booking has no active scheduling reservation to move"}}};
 const moveStatement=replacement?reassignedReservationMove(db,{providerId,groupId:String(booking.schedule_group_id),start:start.toISOString(),end:end.toISOString(),bufferedStart,bufferedEnd,offsetModifier,localDate:localStart.date,maxDailyJobs,cityId,zoneId,startMinutes:localStart.minutes,endMinutes:localEnd.minutes,localDayStartUtc,localDayEndUtc}):db.prepare(`UPDATE scheduling_reservations SET scheduled_start=?,scheduled_end=?,status='assigned'
    WHERE group_id=? AND status!='cancelled'
      AND NOT EXISTS (SELECT 1 FROM scheduling_reservations other WHERE other.provider_id=scheduling_reservations.provider_id AND other.group_id!=? AND other.status!='cancelled' AND other.scheduled_start<? AND other.scheduled_end>?)
      AND (SELECT COUNT(*) FROM scheduling_reservations other WHERE other.provider_id=scheduling_reservations.provider_id AND other.group_id!=? AND other.status!='cancelled' AND substr(datetime(other.scheduled_start,?),1,10)=?)<?
      AND EXISTS (SELECT 1 FROM provider_capacity_profiles p WHERE p.id=scheduling_reservations.provider_id AND p.live=1 AND p.status='active' AND (p.effective_from IS NULL OR p.effective_from<=?) AND (p.effective_to IS NULL OR p.effective_to>=?))
      AND EXISTS (SELECT 1 FROM scheduling_availability a,json_each(a.windows_json) w WHERE a.provider_id=scheduling_reservations.provider_id AND a.city_id=? AND a.zone_id=? AND a.date=? AND (a.source IN ('partner_app','operations','roster') OR NOT EXISTS (SELECT 1 FROM scheduling_availability authored WHERE authored.provider_id=a.provider_id AND authored.date=a.date AND authored.source IN ('partner_app','operations','roster'))) AND (CAST(substr(w.value,1,2) AS INTEGER)*60+CAST(substr(w.value,4,2) AS INTEGER))<=? AND (CAST(substr(w.value,7,2) AS INTEGER)*60+CAST(substr(w.value,10,2) AS INTEGER))>=?)
      AND NOT EXISTS (SELECT 1 FROM provider_unavailability u WHERE u.provider_id=scheduling_reservations.provider_id AND u.status='active' AND u.starts_at<? AND u.ends_at>?)`)
    .bind(start.toISOString(),end.toISOString(),booking.schedule_group_id,booking.schedule_group_id,bufferedEnd,bufferedStart,booking.schedule_group_id,offsetModifier,localStart.date,maxDailyJobs,localStart.date,localStart.date,cityId,zoneId,localStart.date,localStart.minutes,localEnd.minutes,localDayEndUtc,localDayStartUtc);
 const awaitingAcceptance=replacement?replacement.model==="commission":String(work.status)==="awaiting_acceptance";
 const nextBookingStatus=replacement?(awaitingAcceptance?"confirmed":"assigned"):awaitingAcceptance?status:"assigned",nextWorkStatus=awaitingAcceptance?"awaiting_acceptance":"assigned";
 const assertionId=crypto.randomUUID();
 /*
  * A different groomer takes the booking over exactly as provider recovery hands a job over: the
  * canonical service lifecycle moves to the new groomer, a commission groomer gets a pending offer
  * to accept (a full-time groomer's stale pending offer is withdrawn), the doorstep location follows
  * the booking, and the offer, lifecycle and verification authority read above are asserted
  * unchanged in the same transaction.
  */
 const handoverGuards:D1PreparedStatement[]=[],handover:D1PreparedStatement[]=[];let nextOffer:{timeoutMinutes:number;expiresAt:number}|null=null;
 if(replacement&&replacementAuthority){
  const offer=await db.prepare("SELECT * FROM provider_assignment_offers WHERE group_id=?").bind(booking.schedule_group_id).first<Row>();
  let lifecycle:Awaited<ReturnType<typeof groomingRecoveryLifecycle>>;
  try{lifecycle=await groomingRecoveryLifecycle(db,booking,"replace",replacement.id,auditActor);}
  catch(error){if(error instanceof Response&&error.status===409)return{ok:false,refusal:{status:409,body:{error:"Your booking is being updated right now. Refresh your booking before choosing another time.",code:"reschedule_lifecycle_busy",bookingUnchanged:true}}};throw error;}
  const offerPredicate=offer?"EXISTS (SELECT 1 FROM provider_assignment_offers WHERE group_id=? AND provider_id IS ? AND status IS ? AND expires_at IS ? AND updated_at IS ?)":"NOT EXISTS (SELECT 1 FROM provider_assignment_offers WHERE group_id=?)";
  const offerValues=[booking.schedule_group_id,...(offer?[offer.provider_id,offer.status,offer.expires_at,offer.updated_at]:[])].map(value=>value??null);
  handoverGuards.push(db.prepare(`INSERT INTO grooming_change_assertions (id,ok) SELECT ?,CASE WHEN (${offerPredicate}) AND (${lifecycle.guard.sql}) AND (${replacementAuthority.sql}) THEN 1 ELSE 0 END`).bind(`${assertionId}-handover`,...offerValues,...lifecycle.guard.values,...replacementAuthority.values));
  const timeoutMinutes=replacement.model==="commission"?await getProviderAcceptanceTimeout(db,replacement.id):null;
  nextOffer=timeoutMinutes===null?null:{timeoutMinutes,expiresAt:now+timeoutMinutes*60_000};
  const locations=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_service_locations'").first<Row>();
  handover.push(
   ...lifecycle.statements,
   db.prepare("UPDATE canonical_bookings SET provider_id=?,updated_at=? WHERE id=?").bind(replacement.id,now,bookingId),
   db.prepare("UPDATE provider_work_orders SET provider_id=?,provider_name=?,provider_model=?,updated_at=? WHERE booking_id=?").bind(replacement.id,replacement.name,replacement.model,now,bookingId),
   db.prepare("UPDATE scheduling_assignment_decisions SET selected_provider_id=?,updated_at=? WHERE group_id=?").bind(replacement.id,now,booking.schedule_group_id),
   nextOffer
    ?db.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,responded_at,response_reason,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,NULL,NULL,?,?) ON CONFLICT(group_id) DO UPDATE SET booking_id=excluded.booking_id,provider_id=excluded.provider_id,status='pending',offered_at=excluded.offered_at,expires_at=excluded.expires_at,responded_at=NULL,response_reason=NULL,attempt_no=excluded.attempt_no,updated_at=excluded.updated_at").bind(booking.schedule_group_id,bookingId,replacement.id,now,nextOffer.expiresAt,Number(offer?.attempt_no||0)+1,now)
    :db.prepare("UPDATE provider_assignment_offers SET status='cancelled',responded_at=?,response_reason=?,updated_at=? WHERE group_id=? AND status='pending'").bind(now,"Customer rescheduled to a time another groomer took",now,booking.schedule_group_id),
   ...(locations?[db.prepare("UPDATE booking_service_locations SET provider_id=?,updated_at=? WHERE booking_id=? AND status='active'").bind(replacement.id,now,bookingId)]:[]),
  );
 }
 const providerChange={providerChanged:Boolean(replacement),previousProviderId:assignedProviderId,provider:replacement?{id:replacement.id,name:replacement.name,model:replacement.model}:{id:assignedProviderId,name:String(work.provider_name||""),model:String(work.provider_model||"")},...(nextOffer?{offer:nextOffer}:{})};
 const auditPricing={basis:pricingEvidence.basis,bookedAmount:pricingEvidence.bookedAmount,newSlotAmount:pricingEvidence.newSlotAmount,priceDifference:pricingEvidence.priceDifference,storedPriceKept:pricingEvidence.storedPriceKept,...(pricingEvidence.differencePaid!==undefined?{differencePaid:pricingEvidence.differencePaid,rescheduleRequestId:pricingEvidence.rescheduleRequestId}:{})};
 const statements=[
  db.prepare(`INSERT INTO grooming_change_assertions (id,ok) SELECT ?,CASE WHEN
    EXISTS (SELECT 1 FROM canonical_bookings WHERE id=? AND status=? AND scheduled_start=? AND scheduled_end=? AND provider_id=? AND updated_at=?)
    AND EXISTS (SELECT 1 FROM provider_work_orders WHERE booking_id=? AND status=? AND scheduled_start=? AND scheduled_end=? AND provider_id=? AND updated_at=?)
    AND EXISTS (SELECT 1 FROM provider_capacity_profiles WHERE id=? AND travel_buffer_minutes IS ? AND max_daily_jobs IS ?)
    AND (SELECT COUNT(*) FROM scheduling_reservations WHERE group_id=? AND status!='cancelled')=?
    THEN 1 ELSE 0 END`).bind(assertionId,bookingId,status,oldStart,oldEnd,assignedProviderId,booking.updated_at,bookingId,work.status,work.scheduled_start,work.scheduled_end,assignedProviderId,work.updated_at,providerId,profile.travel_buffer_minutes??null,profile.max_daily_jobs??null,booking.schedule_group_id,expectedRows),
  ...handoverGuards,
  ...(input.beforeMove??[]),
  moveStatement,
  db.prepare("INSERT INTO grooming_change_assertions (id,ok) VALUES (?,CASE WHEN changes()=? THEN 1 ELSE 0 END)").bind(`${assertionId}-move`,expectedRows),
  ...handover,
  db.prepare("UPDATE canonical_bookings SET scheduled_start=?,scheduled_end=?,status=?,updated_at=? WHERE id=?").bind(start.toISOString(),end.toISOString(),nextBookingStatus,now,bookingId),
  db.prepare("UPDATE provider_work_orders SET scheduled_start=?,scheduled_end=?,status=?,updated_at=? WHERE booking_id=?").bind(start.toISOString(),end.toISOString(),nextWorkStatus,now,bookingId),
  db.prepare("UPDATE scheduling_assignment_decisions SET status='assigned',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(auditActor,input.reason||"Customer rescheduled",now,booking.schedule_group_id),
  db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,"booking_rescheduled","booking",bookingId,auditActor,JSON.stringify({customerId:input.customerId,from:{scheduledStart:oldStart,scheduledEnd:oldEnd},to:{scheduledStart:start.toISOString(),scheduledEnd:end.toISOString()},providerId,...providerChange,capacityRevalidated:true,travelBufferMinutes,maxDailyJobs,rosterDate:localStart.date,policy:input.policy,rescheduleFeeAmount:input.rescheduleFeeAmount,pricing:pricingEvidence}),now),
  securityAuditStatement(db,actor,"grooming.reschedule","booking",bookingId,"completed",{customerId:input.customerId,providerId,providerChanged:providerChange.providerChanged,previousProviderId:assignedProviderId,policy:input.policy,rescheduleFeeAmount:input.rescheduleFeeAmount,travelBufferMinutes,maxDailyJobs,rosterDate:localStart.date,pricing:auditPricing}),
  ...(input.afterMove??[]),
  db.prepare("DELETE FROM grooming_change_assertions WHERE id IN (?,?,?)").bind(assertionId,`${assertionId}-move`,`${assertionId}-handover`),
 ];
 return{ok:true,statements,result:{bookingId,status:nextBookingStatus,workOrderStatus:nextWorkStatus,scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),providerId,...providerChange}};
}
