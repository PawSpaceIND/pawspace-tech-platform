import type{Booking,PlatformRepository,Provider,ProviderAvailability}from"../backend/src/domain";
import{schedule,type CustomScheduleRule,type ProviderEvaluation}from"../backend/src/scheduling";
import{quoteGroomingBookingWithLiveMultiPet}from"./live-grooming-governance";
import{loadGovernedProviders}from"./provider-capacity-governance";
import{resolveAssignmentPolicy}from"./provider-assignment-policy";
import{schedulingCalendarReads}from"./scheduling-calendar-reads";

/*
 * Customer reschedule of a Grooming booking: the price of the NEW slot and the groomers who may take it.
 * [QA M4]
 *
 * Pricing. The reschedule route used to move a booking without asking what the new slot costs, so a
 * weekday -8% booking moved into a +15% weekend slot kept the lower price. The new slot is now priced
 * with the same governed quote a booking uses (quoteGroomingBookingWithLiveMultiPet: the booking's
 * package, its pets' species, its city/zone and the NEW start). Owner decision:
 *   - same or lower: the booking moves and the booked price is kept; the difference is not refunded.
 *   - higher: the booking does not move and nothing is charged until the customer approves and pays
 *     the difference (owner decision M4). The difference is collected on its own payment intent and
 *     Razorpay order, confirmed only by a signed webhook or an authenticated provider read, and the
 *     booking moves after that capture (lib/grooming-reschedule-payment.ts). Where that is not
 *     available the route refuses with the difference, as before.
 * A booking whose price is covered by a subscription entitlement is not re-priced per slot.
 *
 * Groomers. When the assigned groomer cannot take the new slot, the governed scheduler (the same
 * backend/src/scheduling.ts rule pack the reserve path runs) ranks every other eligible groomer in the
 * booking's city and zone. The route then re-checks each candidate against the same roster, leave,
 * travel-buffer and daily-cap predicates its guarded write enforces.
 */

type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
function parse<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}}

/** The new slot could not be priced; the booking must not move on an unverified price. */
export class ReschedulePricingUnavailable extends Error{constructor(message:string){super(message);this.name="ReschedulePricingUnavailable";}}

export type GroomingReschedulePricing={
 basis:"governed_quote"|"subscription_entitlement";
 currency:string;
 /** The package price the booking was confirmed at (before its coupon/referral discount and add-ons). */
 bookedAmount:number;
 /** The governed package price for the new slot. Equals bookedAmount for a subscription entitlement. */
 newSlotAmount:number;
 /** newSlotAmount - bookedAmount. Positive means the customer would have to pay more. */
 priceDifference:number;
 quote:null|{packageCode:string;packageName:string;catalogueVersion:string;offerType:string;petCount:number;totalAmount:number;scheduledStart:string;cityId:string;zoneId:string;pricingBreakdown?:unknown};
};

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

/**
 * The booked package price: what the customer agreed to pay for the package itself. total_amount is
 * the package plus add-ons less the one governed coupon or referral discount (canonical-bookings writes
 * pricing_json.discount and pricing_json.addOnTotal beside it), so both are backed out here. Comparing
 * package to package keeps the add-ons and the discount exactly as they were booked.
 */
function bookedPackageAmount(booking:Row,pricing:Record<string,unknown>){
 const total=Number(booking.total_amount),discount=Number(pricing.discount??0),addOns=Number(pricing.addOnTotal??0);
 if(!Number.isFinite(total)||!Number.isFinite(discount)||!Number.isFinite(addOns))throw new ReschedulePricingUnavailable("The booked price could not be read");
 return round2(total+discount-addOns);
}

export async function quoteGroomingReschedule(db:Db,input:{booking:Row;payment:Row;scheduledStart:string}):Promise<GroomingReschedulePricing>{
 const{booking,payment,scheduledStart}=input;
 const pricing=parse<Record<string,unknown>>(booking.pricing_json,{}),currency=String(booking.currency||"INR"),packageCode=String(booking.package_code||"");
 const bookedAmount=bookedPackageAmount(booking,pricing);
 // Server-written signals only (the credit reservation row, the governed package/offer type and plan
 // code). pricing_json.subscription is copied from the client's payload, so it can never switch the
 // re-pricing off.
 const usage=await tableExists(db,"booking_subscription_usage")?await db.prepare("SELECT id FROM booking_subscription_usage WHERE booking_id=?").bind(booking.id).first<Row>():null;
 if(usage||packageCode.startsWith("sub-")||pricing.offerType==="subscription"||pricing.subscriptionPlanCode)
  return{basis:"subscription_entitlement",currency,bookedAmount,newSlotAmount:bookedAmount,priceDifference:0,quote:null};
 const petIds=parse<unknown[]>(booking.pet_ids_json,[]).map(String);
 if(!petIds.length||!await tableExists(db,"canonical_pets"))throw new ReschedulePricingUnavailable("The booking's pets could not be read");
 const pets:Array<{species:"dog"|"cat"|"other"}>=[];
 for(const petId of petIds){
  const pet=await db.prepare("SELECT species FROM canonical_pets WHERE id=?").bind(petId).first<Row>();
  if(!pet)throw new ReschedulePricingUnavailable("The booking's pets could not be read");
  const species=String(pet.species||"other");pets.push({species:species==="dog"||species==="cat"?species:"other"});
 }
 const cityId=String(booking.city_id),zoneId=String(booking.zone_id);
 let quote:Awaited<ReturnType<typeof quoteGroomingBookingWithLiveMultiPet>>;
 try{quote=await quoteGroomingBookingWithLiveMultiPet(db,{packageCode,packageName:String(booking.package_name||""),pets,paymentMode:String(payment.mode||"prepaid"),cityId,zoneId,scheduledStart});}
 catch(error){throw new ReschedulePricingUnavailable(error instanceof Error?error.message:"The new slot could not be priced");}
 const newSlotAmount=round2(Number(quote.totalAmount));
 if(!Number.isFinite(newSlotAmount))throw new ReschedulePricingUnavailable("The new slot could not be priced");
 return{basis:"governed_quote",currency,bookedAmount,newSlotAmount,priceDifference:round2(newSlotAmount-bookedAmount),quote:{packageCode:quote.packageCode,packageName:quote.packageName,catalogueVersion:quote.catalogueVersion,offerType:quote.offerType,petCount:quote.petCount,totalAmount:newSlotAmount,scheduledStart,cityId,zoneId,...(quote.pricingBreakdown?{pricingBreakdown:quote.pricingBreakdown}:{})}};
}

/** Customer-facing money, the same "₹1,234" shape the booking pages use. */
export function formatRupees(amount:number){return`₹${amount.toLocaleString("en-IN",{maximumFractionDigits:2})}`;}

/** Ops scheduling rules for this service/city/zone, exactly as the reserve path reads them. */
async function activeSchedulingRules(db:Db,cityId:string,zoneId:string):Promise<CustomScheduleRule[]>{
 if(!await tableExists(db,"scheduling_rules"))return[];
 const rows=await db.prepare("SELECT condition_json FROM scheduling_rules WHERE active=1 AND (service_code IS NULL OR service_code=?) AND (city_id IS NULL OR city_id=?) AND (zone_id IS NULL OR zone_id=?) ORDER BY priority ASC").bind("grooming",cityId,zoneId).all<{condition_json:string}>();
 return rows.results.flatMap(row=>parse<CustomScheduleRule[]>(row.condition_json,[]));
}

function rescheduleRepository(db:Db,input:{cityId:string;groupIds:string[];start:string;end:string;offsetMinutes:number;loaded:(providers:Provider[])=>void}):PlatformRepository{
 const appointmentAt=new Date(input.start),calendar=schedulingCalendarReads(db,input.cityId,[{start:input.start,end:input.end}],input.offsetMinutes);
 let reservations:Promise<Row[]>|undefined;
 // The booking's own reservation is the one being moved, so it never blocks its replacement; nor does a
 // paid reschedule's own slot hold, which the move releases.
 const rows=()=>reservations??=db.prepare("SELECT * FROM scheduling_reservations WHERE city_id=? AND status!='cancelled' AND group_id NOT IN (SELECT value FROM json_each(?))").bind(input.cityId,JSON.stringify(input.groupIds)).all<Row>().then(result=>result.results);
 return{
  async listEligibleProviders(cityId:string,zoneId:string,serviceCode:string){const providers=await loadGovernedProviders(db,cityId,zoneId,serviceCode,appointmentAt);input.loaded(providers);return providers;},
  async listBookings(_cityId:string,providerId?:string){return (await rows()).filter(row=>!providerId||String(row.provider_id)===providerId).map(row=>({id:String(row.id),legacyIds:[],idempotencyKey:String(row.id),cityId:String(row.city_id),zoneId:String(row.zone_id),customerId:String(row.customer_id),petIds:parse<string[]>(row.pet_ids_json,[]),serviceCode:String(row.service_code),packageCode:"reschedule",addonCodes:[],scheduledStart:String(row.scheduled_start),scheduledEnd:String(row.scheduled_end),status:String(row.status) as Booking["status"],channel:"customer_app",totalAmount:0,providerId:String(row.provider_id),assignmentMode:"automatic",scheduleGroupId:String(row.group_id),occurrenceNumber:Number(row.occurrence_number),capacityUnits:Number(row.capacity_units),careMode:row.care_mode as Booking["careMode"],createdBy:String(row.customer_id),createdAt:new Date(Number(row.created_at)).toISOString(),updatedAt:new Date(Number(row.created_at)).toISOString()}));},
  async listAvailability(providerId:string,date:string){return (await calendar.availability(providerId,date)).map(row=>({id:String(row.id),providerId:String(row.provider_id),cityId:String(row.city_id),zoneId:String(row.zone_id),date:String(row.date),windows:parse<string[]>(row.windows_json,[]),source:String(row.source) as ProviderAvailability["source"],updatedAt:new Date(Number(row.updated_at)).toISOString()}));},
  async providerUnavailableForWindow(providerId:string,scheduledStart:string,scheduledEnd:string){return calendar.unavailable(providerId,scheduledStart,scheduledEnd);},
  async getPet(){return null;},
  async close(){},
 } as unknown as PlatformRepository;
}

/**
 * Every other groomer the governed scheduler finds eligible for the new slot, best first. Same city
 * and zone, same geofence as the original request, the Ops scheduling rules and the assignment
 * policy's ranking weights. The currently assigned groomer is excluded: the route only asks when that
 * groomer has already failed the slot check.
 */
export async function rankReschedulingGroomers(db:Db,input:{booking:Row;scheduledStart:string;scheduledEnd:string;excludeProviderIds:string[];offsetMinutes:number;excludeGroupIds?:string[]}):Promise<{providers:Provider[];evaluations:ProviderEvaluation[]}>{
 const{booking}=input,cityId=String(booking.city_id),zoneId=String(booking.zone_id),groupId=String(booking.schedule_group_id);
 const stored=await tableExists(db,"scheduling_assignment_decisions")?await db.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").bind(groupId).first<Row>():null;
 const original=parse<{request?:Record<string,unknown>}>(stored?.shortlist_json,{}).request??{};
 const geofence=original.serviceRadiusKm!==undefined&&original.serviceRadiusKm!==null?{latitude:Number(original.latitude),longitude:Number(original.longitude),serviceRadiusKm:Number(original.serviceRadiusKm)}:{};
 const policy=(await resolveAssignmentPolicy(db,"grooming",cityId,new Date(input.scheduledStart))).config;
 let governed:Provider[]=[];
 const decision=await schedule(rescheduleRepository(db,{cityId,groupIds:[groupId,...(input.excludeGroupIds??[])],start:input.scheduledStart,end:input.scheduledEnd,offsetMinutes:input.offsetMinutes,loaded:providers=>{governed=providers;}}),{
  cityId,zoneId,serviceCode:"grooming",petIds:parse<unknown[]>(booking.pet_ids_json,[]).map(String),scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,...geofence,
  excludeProviderIds:input.excludeProviderIds,preferredProviderMode:"disabled",
  rankingWeights:{qualityWeight:policy.qualityWeight,fullTimeBonus:policy.fullTimeBonus,preferredProviderBonus:policy.preferredProviderBonus,repeatProviderBonus:policy.repeatProviderBonus,distanceWeight:policy.distanceWeight,residualCapacityWeight:policy.residualCapacityWeight,workloadPenalty:policy.workloadPenalty},
  customRules:await activeSchedulingRules(db,cityId,zoneId),
 });
 // The scheduler's own ordering, over every eligible provider rather than only its top three.
 const ranked=decision.evaluations.filter(item=>item.eligible).sort((a,b)=>{const delta=b.score-a.score;if(Math.abs(delta)>1e-9)return delta;return a.workload-b.workload||a.distanceKm-b.distanceKm||a.providerId.localeCompare(b.providerId);});
 const providers=ranked.map(item=>governed.find(provider=>provider.id===item.providerId)).filter((provider):provider is Provider=>Boolean(provider));
 return{providers,evaluations:decision.evaluations};
}

/** Whether the city's assignment policy lets the system choose a replacement groomer on its own. */
export async function automaticReassignmentAllowed(db:Db,cityId:string,at:Date){return (await resolveAssignmentPolicy(db,"grooming",cityId,at)).config.assignmentMode==="auto";}

/**
 * Moves the booking's reservations to a DIFFERENT groomer at the new time. The same predicates as the
 * same-groomer move - buffered overlap, local-day cap, live/active/effective profile, authored roster
 * window for this city and zone, and no leave that local day - evaluated for the NEW groomer inside
 * the writing statement, plus the service and zone the profile must cover.
 */
export function reassignedReservationMove(db:Db,input:{providerId:string;groupId:string;start:string;end:string;bufferedStart:string;bufferedEnd:string;offsetModifier:string;localDate:string;maxDailyJobs:number;cityId:string;zoneId:string;startMinutes:number;endMinutes:number;localDayStartUtc:string;localDayEndUtc:string}){
 return db.prepare(`UPDATE scheduling_reservations SET provider_id=?,scheduled_start=?,scheduled_end=?,status='assigned'
  WHERE group_id=? AND status!='cancelled'
   AND NOT EXISTS (SELECT 1 FROM scheduling_reservations busy WHERE busy.provider_id=? AND busy.group_id!=? AND busy.status!='cancelled' AND busy.scheduled_start<? AND busy.scheduled_end>?)
   AND (SELECT COUNT(*) FROM scheduling_reservations busy WHERE busy.provider_id=? AND busy.group_id!=? AND busy.status!='cancelled' AND substr(datetime(busy.scheduled_start,?),1,10)=?)<?
   AND EXISTS (SELECT 1 FROM provider_capacity_profiles p WHERE p.id=? AND p.city_id=? AND p.live=1 AND p.status='active' AND (p.effective_from IS NULL OR p.effective_from<=?) AND (p.effective_to IS NULL OR p.effective_to>=?) AND EXISTS (SELECT 1 FROM json_each(p.services_json) s WHERE s.value='grooming') AND EXISTS (SELECT 1 FROM json_each(p.zones_json) z WHERE z.value=?))
   AND EXISTS (SELECT 1 FROM scheduling_availability a,json_each(a.windows_json) w WHERE a.provider_id=? AND a.city_id=? AND a.zone_id=? AND a.date=? AND (a.source IN ('partner_app','operations','roster') OR NOT EXISTS (SELECT 1 FROM scheduling_availability authored WHERE authored.provider_id=a.provider_id AND authored.date=a.date AND authored.source IN ('partner_app','operations','roster'))) AND (CAST(substr(w.value,1,2) AS INTEGER)*60+CAST(substr(w.value,4,2) AS INTEGER))<=? AND (CAST(substr(w.value,7,2) AS INTEGER)*60+CAST(substr(w.value,10,2) AS INTEGER))>=?)
   AND NOT EXISTS (SELECT 1 FROM provider_unavailability away WHERE away.provider_id=? AND away.status='active' AND away.starts_at<? AND away.ends_at>?)`)
  .bind(input.providerId,input.start,input.end,input.groupId,
   input.providerId,input.groupId,input.bufferedEnd,input.bufferedStart,
   input.providerId,input.groupId,input.offsetModifier,input.localDate,input.maxDailyJobs,
   input.providerId,input.cityId,input.localDate,input.localDate,input.zoneId,
   input.providerId,input.cityId,input.zoneId,input.localDate,input.startMinutes,input.endMinutes,
   input.providerId,input.localDayEndUtc,input.localDayStartUtc);
}
