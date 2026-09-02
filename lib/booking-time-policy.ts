/**
 * When a booking may be placed, and how long a stay may run. [PTJA-W3-BT]
 *
 * THE APPROVED RULE, in the business's own words:
 *   - Reject any booking whose start time is in the past.
 *   - Minimum lead time: Grooming, Dog Walking and Pet Taxi 2 hours; Training, Pet Sitting and
 *     Boarding 24 hours.
 *   - Maximum advance-booking horizon: 180 days for all schedulable services.
 *   - Maximum stay: Boarding 90 consecutive days, Pet Sitting 30 consecutive days. A longer INITIAL
 *     booking is rejected; an extension must be an explicit audited modification or a new booking, and
 *     must not silently extend active work.
 *   - One central configurable policy, not values hardcoded across routes.
 *   - Validation server-side using SERVER time. The client timestamp is never authoritative.
 *   - Fresh Food follows fulfilment/delivery-slot rules and Relocation stays a request/case workflow.
 *
 * WHAT WAS MEASURED BEFORE. backend/src/scheduling.ts buildOccurrences validates that the end is after
 * the start and that a minimum duration is met - nothing else. There was no lead time anywhere in the
 * repository, no upper horizon, and no maximum stay length in the code, the tests or the seeded
 * catalogue, so a Boarding stay could be opened for a decade and a booking could be placed for a slot
 * seventy-three years out. The reserve route carried a single inline `reserveStart <= Date.now()`
 * refusal: the past-start half only, written where nobody who owns the decision could see or change it.
 *
 * WHERE IT IS ENFORCED. app/api/uat-scheduling's reserve branch, which is the chokepoint every
 * schedulable booking passes through - no canonical_bookings row exists without a scheduling
 * reservation behind it. One gate rather than six copies, which is what "one central policy" means.
 *
 * WHY SERVER TIME IS NOT A PARAMETER. `now` is read from the server clock inside this module and is
 * deliberately NOT accepted from the caller. A test may pin the clock by replacing Date.now, which is
 * the whole process moving, not a value a request can carry.
 */
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
type Row=Record<string,unknown>;

/** The services that are booked as scheduled occurrences. Food and Relocation are deliberately absent. */
export const SCHEDULABLE_SERVICES=["grooming","dog_walking","pet_taxi","dog_training","pet_sitting","boarding"] as const;
export type SchedulableService=typeof SCHEDULABLE_SERVICES[number];

/**
 * Services that exist but are NOT occurrence-booked, so this gate does not apply to them.
 *
 * Named explicitly rather than inferred from "not in SCHEDULABLE_SERVICES", because those two are not
 * the same set: a service nobody has classified must be refused, not waved through as "probably food".
 */
export const NON_OCCURRENCE_SERVICES=["pet_food","relocation"] as const;

export function isSchedulableService(serviceCode:string):serviceCode is SchedulableService{
  return (SCHEDULABLE_SERVICES as readonly string[]).includes(String(serviceCode||"").trim().toLowerCase());
}
export function isNonOccurrenceService(serviceCode:string){
  return (NON_OCCURRENCE_SERVICES as readonly string[]).includes(String(serviceCode||"").trim().toLowerCase());
}

export const BOOKING_TIME_POLICY_DOMAIN="booking_time_policy";

export type BookingTimePolicy={
  /** How far ahead of the start a booking must be placed. */
  minimumLeadMinutes:number;
  /** How far into the future a booking may be placed at all. */
  maximumHorizonDays:number;
  /** Longest single booking span, in days. 1 for appointment services. */
  maximumStayDays:number;
  rejectPastStart:boolean;
  /** Present so the Control Center SHOWS the rule. The validator refuses `true`. */
  trustClientTimestamp:boolean;
};

/**
 * The platform default, which is also what a stored row inherits for any field it does not carry - so
 * every value here is the STRICT answer: the longest lead time of any service, and the shortest stay.
 * A service that forgets to seed its own row gets 24 hours' notice and a one-day cap, never 2 hours and
 * ninety days.
 */
export const APPROVED_BOOKING_TIME_DEFAULT:BookingTimePolicy={
  minimumLeadMinutes:24*60,
  maximumHorizonDays:180,
  maximumStayDays:1,
  rejectPastStart:true,
  trustClientTimestamp:false,
};

/** The approved per-service values. Seeded as (domain, serviceCode, *) rows the Control Center can edit. */
export const APPROVED_BOOKING_TIME_BY_SERVICE:Record<SchedulableService,Partial<BookingTimePolicy>>={
  grooming:{minimumLeadMinutes:120,maximumStayDays:1},
  dog_walking:{minimumLeadMinutes:120,maximumStayDays:1},
  pet_taxi:{minimumLeadMinutes:120,maximumStayDays:1},
  dog_training:{minimumLeadMinutes:24*60,maximumStayDays:1},
  pet_sitting:{minimumLeadMinutes:24*60,maximumStayDays:30},
  boarding:{minimumLeadMinutes:24*60,maximumStayDays:90},
};

registerServicePolicyDomain<BookingTimePolicy&Record<string,unknown>>({
  domain:BOOKING_TIME_POLICY_DOMAIN,
  label:"Booking time rules",
  managePermission:"settings.manage",
  defaults:APPROVED_BOOKING_TIME_DEFAULT as BookingTimePolicy&Record<string,unknown>,
  problem(config){
    const lead=Number(config.minimumLeadMinutes);
    if(!Number.isFinite(lead)||lead<0)return"The minimum lead time must be zero minutes or more";
    if(lead>30*24*60)return"A minimum lead time longer than thirty days is not a booking rule, it is a closure";
    const horizon=Number(config.maximumHorizonDays);
    if(!Number.isFinite(horizon)||horizon<1)return"The advance-booking horizon must be at least one day";
    if(horizon>APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays)return`The advance-booking horizon cannot exceed ${APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays} days`;
    const stay=Number(config.maximumStayDays);
    if(!Number.isFinite(stay)||stay<1)return"The maximum stay must be at least one day";
    if(stay>90)return"The maximum stay cannot exceed the approved ninety-day Boarding ceiling";
    if(stay>horizon)return"A stay cannot be longer than the advance-booking horizon";
    // Both of these are the approved rule itself, not a setting. They stay visible so the Control
    // Center shows what is in force; they are not editable, because "reject past starts" and "server
    // time is authoritative" are the two statements the whole gate rests on.
    if(config.rejectPastStart!==true)return"A booking in the past is always refused; this cannot be switched off";
    if(config.trustClientTimestamp!==false)return"Booking times are validated against server time; the client timestamp is never authoritative";
    return null;
  },
});

/**
 * Seeds the platform default plus one row per schedulable service. INSERT OR IGNORE through the kernel,
 * so an operator's own edit is never overwritten.
 */
export async function seedBookingTimePolicies(db:Db){
  const{seedServicePolicyDefault,seedServicePolicyScope}=await import("./service-policy-governance");
  await seedServicePolicyDefault(db,BOOKING_TIME_POLICY_DOMAIN);
  for(const service of SCHEDULABLE_SERVICES){
    await seedServicePolicyScope(db,BOOKING_TIME_POLICY_DOMAIN,service,"*",
      {...APPROVED_BOOKING_TIME_DEFAULT,...APPROVED_BOOKING_TIME_BY_SERVICE[service]},
      `Booking time rules - ${service}`);
  }
}

function parsePolicyConfig(value:unknown):BookingTimePolicy{
  let stored:Record<string,unknown>={};
  try{stored=JSON.parse(String(value??"{}")) as Record<string,unknown>;}catch{}
  return {...APPROVED_BOOKING_TIME_DEFAULT,...stored} as BookingTimePolicy;
}

/**
 * Fast read path for already-bootstrapped databases.
 *
 * Scheduling is a high-concurrency request path. The generic policy resolver intentionally self-seeds,
 * which is useful for a cold database but means every request otherwise performs INSERT OR IGNORE writes
 * (and may enter table-creation batches) before it can merely read the policy. Under concurrent hosted
 * scheduling this creates avoidable D1 transaction contention. Established staging/production databases
 * already have these governed rows, so resolve them read-only first; fall back to the existing bootstrap
 * path only when the table/row genuinely does not exist.
 */
export async function resolveBookingTimePolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}){
  const serviceCode=String(scope.serviceCode??"*").trim().toLowerCase()||"*";
  const cityId=String(scope.cityId??"*").trim().toLowerCase()||"*";
  const date=new Date().toISOString().slice(0,10);
  try{
    const row=await db.prepare(
      `SELECT *, CASE WHEN service_code=? AND city_id=? THEN 0 WHEN service_code=? AND city_id='*' THEN 1 WHEN service_code='*' AND city_id=? THEN 2 ELSE 3 END rank
       FROM service_policy_configs
       WHERE policy_domain=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
         AND (service_code=? OR service_code='*') AND (city_id=? OR city_id='*')
       ORDER BY rank ASC, version DESC, updated_at DESC LIMIT 1`)
      .bind(serviceCode,cityId,serviceCode,cityId,BOOKING_TIME_POLICY_DOMAIN,date,date,serviceCode,cityId).first<Row>();
    if(row){
      const config=parsePolicyConfig(row.config_json);
      const problem=(()=>{
        const lead=Number(config.minimumLeadMinutes);
        if(!Number.isFinite(lead)||lead<0)return"The minimum lead time must be zero minutes or more";
        if(lead>30*24*60)return"A minimum lead time longer than thirty days is not a booking rule, it is a closure";
        const horizon=Number(config.maximumHorizonDays);
        if(!Number.isFinite(horizon)||horizon<1)return"The advance-booking horizon must be at least one day";
        if(horizon>APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays)return`The advance-booking horizon cannot exceed ${APPROVED_BOOKING_TIME_DEFAULT.maximumHorizonDays} days`;
        const stay=Number(config.maximumStayDays);
        if(!Number.isFinite(stay)||stay<1)return"The maximum stay must be at least one day";
        if(stay>90)return"The maximum stay cannot exceed the approved ninety-day Boarding ceiling";
        if(stay>horizon)return"A stay cannot be longer than the advance-booking horizon";
        if(config.rejectPastStart!==true)return"A booking in the past is always refused; this cannot be switched off";
        if(config.trustClientTimestamp!==false)return"Booking times are validated against server time; the client timestamp is never authoritative";
        return null;
      })();
      if(problem)throw Response.json({error:`Booking time rules configuration is invalid: ${problem}`,code:"service_policy_configuration_invalid",domain:BOOKING_TIME_POLICY_DOMAIN,policyId:String(row.id)},{status:409});
      const matchedBy=["service_and_city","service_any_city","any_service_and_city","platform_default"][Number(row.rank??3)]??"platform_default";
      return{
        id:String(row.id),domain:String(row.policy_domain),serviceCode:String(row.service_code),cityId:String(row.city_id),
        config,notes:String(row.notes||""),active:Number(row.active)===1,version:Number(row.version||1),
        effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to?String(row.effective_to):null,
        updatedBy:String(row.updated_by||""),updatedAt:Number(row.updated_at||0),matchedBy,
        policyVersion:`${BOOKING_TIME_POLICY_DOMAIN}:${String(row.service_code)}:${String(row.city_id)}:v${Number(row.version||1)}`,
      };
    }
  }catch(error){
    if(error instanceof Response)throw error;
    // Missing table/legacy database: preserve the original cold-start bootstrap contract below.
  }
  await seedBookingTimePolicies(db);
  return resolveServicePolicy<BookingTimePolicy&Record<string,unknown>>(db,BOOKING_TIME_POLICY_DOMAIN,scope);
}

const refuse=(message:string,extra:Record<string,unknown>={}):never=>{throw Response.json({error:message,...extra},{status:400});};
const MINUTE=60_000,DAY=24*3_600_000;

export type BookingWindowInput={
  serviceCode:string;cityId?:string|null;scheduledStart:string;scheduledEnd:string;
  /** Every occurrence, when the caller has generated them. The LAST one must also sit inside the horizon. */
  occurrences?:Array<{start:string;end:string}>|null;
};

export type BookingWindowVerdict={
  applied:boolean;serviceCode:string;policyVersion:string|null;
  minimumLeadMinutes:number|null;maximumHorizonDays:number|null;maximumStayDays:number|null;
  leadMinutes:number|null;spanDays:number|null;reason?:string;
};

/**
 * The gate. Throws a 400 naming what is wrong, or returns the verdict.
 *
 * `now` comes from the server clock HERE. Note the input type carries no clock field: a caller cannot
 * pass one, so no request can move the boundary it is being measured against.
 */
export async function assertBookingWindow(db:Db,input:BookingWindowInput):Promise<BookingWindowVerdict>{
  const serviceCode=String(input.serviceCode||"").trim().toLowerCase();
  if(isNonOccurrenceService(serviceCode)){
    // Fresh Food follows fulfilment/delivery-slot rules and Relocation is a case workflow. Saying so
    // out loud beats silently returning "fine", which reads identically to "no rule was found".
    return{applied:false,serviceCode,policyVersion:null,minimumLeadMinutes:null,maximumHorizonDays:null,
      maximumStayDays:null,leadMinutes:null,spanDays:null,
      reason:serviceCode==="pet_food"?"Fresh Food follows delivery-slot rules":"Relocation is a request/case workflow"};
  }
  if(!isSchedulableService(serviceCode))
    refuse(`${serviceCode||"That service"} is not a bookable PawSpace service`,{code:"unknown_service_code"});

  const startMs=new Date(String(input.scheduledStart)).getTime();
  const endMs=new Date(String(input.scheduledEnd)).getTime();
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)
    refuse("A valid scheduling window is required",{code:"invalid_window"});

  const policy=await resolveBookingTimePolicy(db,{serviceCode,cityId:input.cityId});
  const config=policy.config;
  const now=Date.now();

  if(config.rejectPastStart&&startMs<=now)
    refuse("A scheduling window must start in the future; this slot has already passed",{code:"start_in_past",policyVersion:policy.policyVersion});

  const leadMinutes=Math.floor((startMs-now)/MINUTE);
  if(leadMinutes<config.minimumLeadMinutes)
    refuse(`This service needs at least ${config.minimumLeadMinutes} minutes' notice`,
      {code:"below_minimum_lead_time",minimumLeadMinutes:config.minimumLeadMinutes,leadMinutes,policyVersion:policy.policyVersion});

  const horizonMs=now+config.maximumHorizonDays*DAY;
  const latestStart=Math.max(startMs,...(input.occurrences??[]).map(item=>new Date(String(item.start)).getTime()).filter(Number.isFinite));
  if(latestStart>horizonMs)
    refuse(`Bookings can be made up to ${config.maximumHorizonDays} days ahead`,
      {code:"beyond_booking_horizon",maximumHorizonDays:config.maximumHorizonDays,policyVersion:policy.policyVersion});

  // The stay cap measures ONE booking's span. A recurring calendar is many short occurrences, not one
  // long stay, so it is measured per occurrence rather than end-to-end.
  const spans=[endMs-startMs,...(input.occurrences??[]).map(item=>new Date(String(item.end)).getTime()-new Date(String(item.start)).getTime()).filter(Number.isFinite)];
  const longestSpanDays=Math.max(...spans)/DAY;
  if(longestSpanDays>config.maximumStayDays)
    refuse(`A single booking cannot run longer than ${config.maximumStayDays} day${config.maximumStayDays===1?"":"s"}; a longer stay needs an audited extension or a new booking`,
      {code:"beyond_maximum_stay",maximumStayDays:config.maximumStayDays,requestedDays:Math.ceil(longestSpanDays),policyVersion:policy.policyVersion});

  return{applied:true,serviceCode,policyVersion:policy.policyVersion,
    minimumLeadMinutes:config.minimumLeadMinutes,maximumHorizonDays:config.maximumHorizonDays,
    maximumStayDays:config.maximumStayDays,leadMinutes,spanDays:Math.max(...spans)/DAY};
}
