/**
 * What a city's launch status means for taking work. [PTJA-W1-F38 follow-on]
 *
 * The earlier fix on this branch made PAUSED stop fulfilment, which was the measured defect: an operator
 * paused Bengaluru and removed a pincode, and the customer app kept resolving zones and saving doorstep
 * addresses into a closed market. This expresses the whole approved matrix:
 *
 *   status   new customer bookings                                        existing confirmed bookings
 *   DRAFT    blocked                                                      none expected
 *   PILOT    only for explicitly enabled pincodes, services and channels  continue
 *   ACTIVE   allowed normally                                             continue
 *   PAUSED   blocked                                                      continue unless individually cancelled
 *   CLOSED   blocked                                                      reassigned, rescheduled or cancelled
 *                                                                         through an audited operation
 *
 * A NOTE ON NAMES. The approved matrix says ACTIVE; this platform's launch console has always called that
 * status `Live`. Both are accepted, the way `on_the_way` and `en_route` are in the cancellation policy - a
 * rule that only knows the business's word for a state does not govern the state.
 *
 * A PAUSE IS NOT A CANCELLATION. It stops new bookings on every channel - the app, ops-assisted manual
 * bookings, wait-list conversion, automatic subscription renewal - and touches nothing that already
 * exists. Confirmed bookings continue unless somebody cancels them individually. Suspending existing work
 * is a SEPARATE emergency control below, and keeping the two apart is the sharpest line in the matrix:
 * confusing them is how a city pause becomes a mass cancellation.
 *
 * WHAT IS NOT ENFORCED HERE, AND WHY. The approved rules name wait-list conversion. This platform has no
 * wait-list - no table, no module, no route. Rather than invent one so a rule could be ticked off,
 * `waitlist_conversion` is a first-class channel in this verdict, so the day a wait-list is built it
 * cannot convert into a paused city without deliberately routing around a gate that already refuses it.
 */
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export const CITY_STATUS_DOMAIN="city_status_policy";

/** The channels a booking can arrive through. Every one is gated by the same verdict. */
export const BOOKING_CHANNELS=["customer_app","ops_assisted","waitlist_conversion","subscription_renewal","partner_app"] as const;
export type BookingChannel=(typeof BOOKING_CHANNELS)[number];

export type CityStatusPolicyConfig={
  /** Statuses that take new bookings without further conditions. `Live` is this platform's ACTIVE. */
  openStatuses:string[];
  /** Statuses that take no new bookings at all. */
  blockedStatuses:string[];
  /** The status whose existing work must be handled by a deliberate, audited operation. */
  closedStatus:string;
  pilotStatus:string;
  pilotAllowedPincodes:string[];
  pilotAllowedServices:string[];
  pilotAllowedChannels:string[];
  /** Zero means the pilot has no capacity ceiling; a positive number caps live bookings in the city. */
  pilotCapacityLimit:number;
  emergencySuspensionPermissions:string[];
  /** The status an emergency suspension writes onto existing bookings. Never ordinary `cancelled`. */
  emergencySuspendedBookingStatus:string;
  requireCustomerCommunicationOnSuspension:boolean;
};

export const APPROVED_CITY_STATUS_POLICY:CityStatusPolicyConfig={
  openStatuses:["Live","Active"],
  blockedStatuses:["Draft","Paused","Closed"],
  closedStatus:"Closed",
  pilotStatus:"Pilot",
  // Empty by default and deliberately so: a pilot whose allow-list nobody has filled in is a pilot with
  // no cohort. Absence is not permission.
  pilotAllowedPincodes:[],
  pilotAllowedServices:[],
  pilotAllowedChannels:[],
  pilotCapacityLimit:0,
  emergencySuspensionPermissions:["settings.manage"],
  emergencySuspendedBookingStatus:"suspended_city_emergency",
  requireCustomerCommunicationOnSuspension:true,
};

registerServicePolicyDomain<CityStatusPolicyConfig&Record<string,unknown>>({
  domain:CITY_STATUS_DOMAIN,
  label:"City status and market controls",
  managePermission:"settings.manage",
  defaults:APPROVED_CITY_STATUS_POLICY as CityStatusPolicyConfig&Record<string,unknown>,
  problem(config){
    for(const key of["openStatuses","blockedStatuses","pilotAllowedPincodes","pilotAllowedServices","pilotAllowedChannels","emergencySuspensionPermissions"]){
      if(!Array.isArray(config[key]))return `${key} must be a list`;
    }
    const open=(config.openStatuses as string[]).map(String),blocked=(config.blockedStatuses as string[]).map(String);
    const overlap=open.filter(status=>blocked.includes(status));
    if(overlap.length)return `A status cannot be both open and blocked: ${overlap.join(", ")}`;
    for(const required of["Draft","Paused","Closed"]){
      if(!blocked.includes(required))return `blockedStatuses must include ${required} - that is the approved matrix`;
    }
    if(open.includes(String(config.pilotStatus)))return "Pilot is not an open status - it is allowed only for an explicitly enabled scope";
    if(!(config.emergencySuspensionPermissions as string[]).length)return "At least one permission must be able to suspend a city's existing work";
    // Ordinary cancellation and an emergency city suspension are different events, and a customer whose
    // booking was suspended by a flood has not cancelled anything.
    const suspended=text(config.emergencySuspendedBookingStatus);
    if(!suspended)return "A distinct status for emergency-suspended bookings is required";
    if(suspended==="cancelled")return "An emergency suspension must not be recorded as an ordinary cancellation";
    if(config.requireCustomerCommunicationOnSuspension===false)return "Suspending a city's customers without telling them is not an option";
    return null;
  },
});

export async function resolveCityStatusPolicy(db:Db,cityId?:string|null,serviceCode?:string|null,at=new Date()){
  return resolveServicePolicy<CityStatusPolicyConfig&Record<string,unknown>>(db,CITY_STATUS_DOMAIN,{serviceCode,cityId},at);
}

export type CityBookingVerdict={
  allowed:boolean;cityId:string;status:string;reason:string;
  /** What the matrix says about work that already exists in this city. */
  existingWorkHandling:"continue"|"audited_operation_required"|"none_expected";
  policyVersion:string;
};

/**
 * May this city take THIS new booking, on this channel, for this service and pincode?
 *
 * Every channel goes through here on purpose - the app, an ops-assisted manual booking, a wait-list
 * conversion, an automatic subscription renewal. A gate that only the customer app passes through is a
 * gate an operator can walk around without meaning to.
 */
export async function cityBookingVerdict(db:Db,input:{cityId:string;serviceCode?:string|null;pincode?:string|null;channel?:string|null;at?:Date}):Promise<CityBookingVerdict>{
  const cityId=text(input.cityId).toLowerCase();
  const policy=await resolveCityStatusPolicy(db,cityId,input.serviceCode,input.at);
  const config=policy.config;
  const{seedDefaultCityLaunchConfigs}=await import("./city-governance");
  await seedDefaultCityLaunchConfigs(db);
  const row=await db.prepare("SELECT status FROM city_launch_configs WHERE city_code=?").bind(cityId).first<Row>();
  const status=text(row?.status);
  const base={cityId,status,policyVersion:policy.policyVersion};

  /*
   * A city with no launch config is governed by its reviewed service_zone_mappings rows alone. That is
   * this repository's deliberate second-city path - tests/service-zone-coverage.test.mjs pins it, and the
   * earlier half of this finding preserved it explicitly. A first draft of this gate blocked here and
   * took every second city offline; the suite said so immediately.
   *
   * So the matrix governs cities that HAVE been launched, and says nothing about cities that have not.
   * What stops an unverifiable city reaching customers is the launch-readiness gate, not this one.
   */
  if(!row)return{...base,allowed:true,reason:"no_launch_governance",existingWorkHandling:"continue"};

  if(status===config.closedStatus){
    return{...base,allowed:false,reason:"city_closed",existingWorkHandling:"audited_operation_required"};
  }
  if(config.blockedStatuses.map(String).includes(status)){
    return{...base,allowed:false,
      reason:status==="Draft"?"city_draft":status==="Paused"?"city_paused":"city_not_open",
      existingWorkHandling:status==="Draft"?"none_expected":"continue"};
  }
  if(status===config.pilotStatus){
    const pincode=text(input.pincode),serviceCode=text(input.serviceCode),channel=text(input.channel)||"customer_app";
    const inScope=
      config.pilotAllowedPincodes.map(String).includes(pincode)&&
      config.pilotAllowedServices.map(String).includes(serviceCode)&&
      config.pilotAllowedChannels.map(String).includes(channel);
    if(!inScope)return{...base,allowed:false,reason:"pilot_scope_not_enabled",existingWorkHandling:"continue"};
    if(config.pilotCapacityLimit>0){
      const live=await db.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE city_id=? AND status NOT IN ('cancelled','completed','refunded')").bind(cityId).first<Row>().catch(()=>null);
      if(Number(live?.n||0)>=config.pilotCapacityLimit)return{...base,allowed:false,reason:"pilot_capacity_reached",existingWorkHandling:"continue"};
    }
    return{...base,allowed:true,reason:"pilot_scope_enabled",existingWorkHandling:"continue"};
  }
  if(config.openStatuses.map(String).includes(status)){
    return{...base,allowed:true,reason:"city_open",existingWorkHandling:"continue"};
  }
  // An unrecognised status is not an open one.
  return{...base,allowed:false,reason:"city_status_not_open",existingWorkHandling:"continue"};
}

const emergencyReady=new WeakSet<Db>();
export async function ensureCityEmergencyTables(db:Db){
  if(emergencyReady.has(db))return;
  await db.prepare("CREATE TABLE IF NOT EXISTS city_emergency_suspensions (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,affected_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lifted_at INTEGER,lifted_by TEXT)").run();
  emergencyReady.add(db);
}

/**
 * The emergency control: stop new work AND suspend what already exists.
 *
 * Deliberately not reachable by pausing a city. A pause is an ordinary market control that any operator
 * running a city may use and that touches nothing already booked; this reaches into customers' confirmed
 * bookings, so it needs superuser approval, a real reason, a record of every booking it touched for
 * review, and the communication that went to those customers. Suspended bookings carry a DISTINCT status -
 * a customer whose booking was suspended by a flood has not cancelled anything, and payout, reporting and
 * refund policy all read that difference.
 */
export async function pauseNewAndSuspendExisting(db:Db,input:{cityId:string;actorId:string;actorPermissions:readonly string[];reason:string;customerCommunication?:unknown;now?:number}){
  await ensureCityEmergencyTables(db);
  const cityId=text(input.cityId).toLowerCase();
  const policy=await resolveCityStatusPolicy(db,cityId);
  const config=policy.config;
  const allowed=input.actorPermissions.includes("*")||config.emergencySuspensionPermissions.some(permission=>input.actorPermissions.includes(permission));
  if(!allowed)throw Response.json({error:"Suspending a city's existing bookings requires superuser approval",code:"city_suspension_not_permitted",required:config.emergencySuspensionPermissions},{status:403});
  const reason=text(input.reason);
  if(reason.length<5)throw Response.json({error:"A clear reason is required to suspend a city"},{status:400});
  if(config.requireCustomerCommunicationOnSuspension&&!input.customerCommunication){
    throw Response.json({error:"The customer communication must be recorded before a city's bookings are suspended",code:"customer_communication_required"},{status:400});
  }
  const now=input.now??Date.now();
  const affected=await db.prepare("SELECT id FROM canonical_bookings WHERE city_id=? AND status NOT IN ('cancelled','completed','refunded')").bind(cityId).all<Row>().catch(()=>({results:[] as Row[]}));
  const bookingIds=affected.results.map(row=>text(row.id));
  await db.batch([
    db.prepare("UPDATE city_launch_configs SET status='Paused',version=version+1,updated_by=?,updated_at=? WHERE city_code=?").bind(input.actorId,now,cityId),
    db.prepare("UPDATE canonical_bookings SET status=?,updated_at=? WHERE city_id=? AND status NOT IN ('cancelled','completed','refunded')").bind(config.emergencySuspendedBookingStatus,now,cityId),
    db.prepare("INSERT INTO city_emergency_suspensions (id,city_id,actor_id,reason,affected_json,created_at) VALUES (?,?,?,?,?,?)")
      .bind(`CEMG-${crypto.randomUUID().slice(0,10).toUpperCase()}`,cityId,input.actorId,reason,
        JSON.stringify({bookingIds,bookingCount:bookingIds.length,customerCommunication:input.customerCommunication??null,reviewRequired:true}),now),
  ]);
  return{cityId,status:"Paused",affectedBookings:bookingIds.length,bookingIds,suspendedStatus:config.emergencySuspendedBookingStatus,reviewRequired:true};
}
