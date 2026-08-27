/**
 * When a call may be placed inside quiet hours, and by whom. [PTJA-W2-B4-M06]
 *
 * WHAT WAS MEASURED. The clock at 03:00 IST, deep inside the 21:00-09:00 window, with two POSTs to
 * /api/haptik-outbound as an admin holding marketing.manage:
 *
 *   {campaign:"new_lead_followup", limit:5000}              -> refused at the gate
 *   {campaign:"new_lead_followup", limit:5000, force:true}  -> gate passed, execution continued
 *
 * A request-body boolean turned off the bar on a FIVE THOUSAND contact lead-follow-up campaign at three
 * in the morning, and the security audit row read outcome 'completed' with nothing saying an override had
 * been used. An earlier fix in this audit made the override auditable. It did not BOUND it: "an urgent
 * callback" stayed a phrase in an error message rather than a rule anybody could check.
 *
 * THE APPROVED RULE, and every clause of it is a regression case:
 *
 *   permitted   a customer-requested callback at that specific time; an active service safety incident;
 *               a provider or customer unable to access or complete an imminent booking; a payment or
 *               booking failure affecting service within the next 12 hours; an active relocation, travel
 *               or taxi movement; an emergency escalation from an existing conversation
 *   forbidden   promotions, lead follow-ups, subscription sales, payment chasing unrelated to an imminent
 *               service, routine operations
 *   requires    manager permission except for designated emergency roles; a reason code AND a booking or
 *               case reference; ONE call attempt; no bulk overrides; a complete audit log; and compliance
 *               review of repeated overrides
 *
 * TWO THINGS WORTH SAYING ABOUT THE SHAPE. An unknown reason code is REFUSED rather than allowed - the
 * absence of a rule is not permission, and an override nobody has classified is not an emergency. And a
 * REFUSED override is logged as carefully as a granted one: the refusal is the more interesting record,
 * because it is the one that shows somebody tried.
 */
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export const QUIET_HOURS_DOMAIN="quiet_hours_override_policy";
const IST_OFFSET_MS=330*60_000;

export type QuietHoursOverrideConfig={
  quietStartHour:number;
  quietEndHour:number;
  permittedReasonCodes:string[];
  /** Named so a refusal can say WHY, rather than only that the code was unknown. */
  forbiddenReasonCodes:string[];
  /** Reasons a designated emergency role may act on without manager permission. */
  emergencyReasonCodes:string[];
  overridePermissions:string[];
  emergencyRolePermissions:string[];
  maxContactsPerOverride:number;
  requireCaseReference:boolean;
  /** Overrides by one actor within the review window, above which compliance is asked to look. */
  reviewThreshold:number;
  reviewWindowHours:number;
};

export const APPROVED_QUIET_HOURS_OVERRIDE:QuietHoursOverrideConfig={
  quietStartHour:21,
  quietEndHour:9,
  permittedReasonCodes:[
    "customer_requested_callback","active_safety_incident","imminent_booking_access_failure",
    "payment_or_booking_failure_within_12h","active_relocation_or_transit","emergency_escalation_existing_conversation",
  ],
  forbiddenReasonCodes:["promotion","lead_followup","subscription_sales","payment_chasing","routine_operations"],
  emergencyReasonCodes:["active_safety_incident","emergency_escalation_existing_conversation"],
  overridePermissions:["communications.manage"],
  emergencyRolePermissions:["incidents.respond"],
  // ONE call attempt. Not a small batch, not a capped campaign - one.
  maxContactsPerOverride:1,
  requireCaseReference:true,
  reviewThreshold:3,
  reviewWindowHours:24,
};

registerServicePolicyDomain<QuietHoursOverrideConfig&Record<string,unknown>>({
  domain:QUIET_HOURS_DOMAIN,
  label:"Quiet-hours override",
  managePermission:"settings.manage",
  defaults:APPROVED_QUIET_HOURS_OVERRIDE as QuietHoursOverrideConfig&Record<string,unknown>,
  problem(config){
    for(const key of["permittedReasonCodes","forbiddenReasonCodes","emergencyReasonCodes","overridePermissions","emergencyRolePermissions"]){
      if(!Array.isArray(config[key]))return `${key} must be a list`;
    }
    const permitted=(config.permittedReasonCodes as string[]).map(String);
    if(!permitted.length)return "At least one reason code must be permitted, or the override is unusable";
    const forbidden=(config.forbiddenReasonCodes as string[]).map(String);
    const overlap=permitted.filter(code=>forbidden.includes(code));
    if(overlap.length)return `A reason code cannot be both permitted and forbidden: ${overlap.join(", ")}`;
    // The five the approved decision names explicitly. Quietly permitting one of these is how a
    // quiet-hours control becomes a marketing channel again.
    for(const required of["promotion","lead_followup","subscription_sales","payment_chasing","routine_operations"]){
      if(!forbidden.includes(required))return `forbiddenReasonCodes must include ${required}`;
      if(permitted.includes(required))return `${required} must never be a permitted override reason`;
    }
    const emergency=(config.emergencyReasonCodes as string[]).map(String);
    const stray=emergency.filter(code=>!permitted.includes(code));
    if(stray.length)return `An emergency reason must also be a permitted reason: ${stray.join(", ")}`;
    const maxContacts=Number(config.maxContactsPerOverride);
    if(!Number.isFinite(maxContacts)||maxContacts<1)return "maxContactsPerOverride must be at least 1";
    // "One call attempt initially" and "no bulk overrides" are the same rule read twice. A ceiling above
    // one is a bulk override with a smaller number on it.
    if(maxContacts>1)return "An override is a single call attempt - no bulk overrides";
    if(config.requireCaseReference===false)return "An override must be traceable to a booking or case";
    if(!Number.isFinite(Number(config.reviewThreshold))||Number(config.reviewThreshold)<1)return "A compliance review threshold is required";
    return null;
  },
});

export async function resolveQuietHoursOverridePolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}={},at=new Date()){
  return resolveServicePolicy<QuietHoursOverrideConfig&Record<string,unknown>>(db,QUIET_HOURS_DOMAIN,scope,at);
}

const overrideReady=new WeakSet<Db>();
export async function ensureQuietHoursOverrideTables(db:Db){
  if(overrideReady.has(db))return;
  await db.prepare("CREATE TABLE IF NOT EXISTS quiet_hours_overrides (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,actor_role TEXT NOT NULL,reason_code TEXT NOT NULL,case_reference TEXT,reason TEXT NOT NULL DEFAULT '',contact_count INTEGER NOT NULL DEFAULT 1,allowed INTEGER NOT NULL DEFAULT 0,refusal_reason TEXT,channel TEXT,created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_quiet_hours_overrides_actor ON quiet_hours_overrides(actor_id,created_at)").run();
  overrideReady.add(db);
}

export function inQuietHours(at:number,startHour:number,endHour:number){
  const hour=new Date(at+IST_OFFSET_MS).getUTCHours();
  return startHour<=endHour?hour>=startHour&&hour<endHour:hour>=startHour||hour<endHour;
}

export type OverrideActor={email:string;roleCode:string;permissions?:readonly string[]};
export type OverrideRequest={
  actor:OverrideActor;reasonCode:string;caseReference?:string|null;reason?:string|null;
  contactCount?:number;channel?:string|null;at?:number;
};
export type OverrideVerdict={
  allowed:boolean;overrideUsed:boolean;reason:string;maxContacts:number;policyVersion:string;
};

/**
 * May this call go out now?
 *
 * Outside quiet hours the answer is yes and no override is recorded - if the gate applied around the
 * clock, ordinary daytime calling would start requiring override paperwork and the control would be
 * worked around within a week.
 */
export async function requestQuietHoursOverride(db:Db,input:OverrideRequest):Promise<OverrideVerdict>{
  await ensureQuietHoursOverrideTables(db);
  const policy=await resolveQuietHoursOverridePolicy(db,{});
  const config=policy.config;
  const at=input.at??Date.now();
  const actor=input.actor;
  const reasonCode=text(input.reasonCode);
  const caseReference=text(input.caseReference);
  const reason=text(input.reason);
  const contactCount=Math.max(1,Number(input.contactCount??1));
  const base={maxContacts:config.maxContactsPerOverride,policyVersion:policy.policyVersion};

  if(!inQuietHours(at,config.quietStartHour,config.quietEndHour)){
    return{...base,allowed:true,overrideUsed:false,reason:"not_quiet_hours"};
  }

  const record=async(allowed:boolean,refusalReason:string|null)=>{
    await db.prepare("INSERT INTO quiet_hours_overrides (id,actor_id,actor_role,reason_code,case_reference,reason,contact_count,allowed,refusal_reason,channel,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(`QHO-${crypto.randomUUID().slice(0,10).toUpperCase()}`,actor.email,actor.roleCode,reasonCode||"(none)",caseReference||null,reason,contactCount,allowed?1:0,refusalReason,input.channel??null,at).run();
  };
  const refuse=async(why:string):Promise<OverrideVerdict>=>{await record(false,why);return{...base,allowed:false,overrideUsed:true,reason:why};};

  // An override the policy has never heard of is not an emergency. Absence of a rule is not permission.
  if(!config.permittedReasonCodes.map(String).includes(reasonCode))return refuse("reason_code_not_permitted");
  if(config.requireCaseReference&&!caseReference)return refuse("case_reference_required");
  if(!reason)return refuse("reason_required");
  if(contactCount>config.maxContactsPerOverride)return refuse("bulk_override_not_permitted");

  const permissions=actor.permissions??[];
  const holdsAll=permissions.includes("*");
  const manager=holdsAll||config.overridePermissions.some(permission=>permissions.includes(permission));
  // The emergency carve-out is for EMERGENCIES. Without that second condition, "designated emergency
  // role" would simply be a second manager permission handed to more people.
  const emergency=config.emergencyReasonCodes.map(String).includes(reasonCode)&&
    config.emergencyRolePermissions.some(permission=>permissions.includes(permission));
  if(!manager&&!emergency)return refuse("override_permission_required");

  await record(true,null);
  return{...base,allowed:true,overrideUsed:true,reason:"override_granted"};
}

export type OverrideReviewRow={actorId:string;actorRole:string;overrides:number;refusals:number;reviewRequired:boolean;windowHours:number};

/**
 * Who has been overriding quiet hours repeatedly, for compliance to look at.
 *
 * Threshold-based on purpose: a review queue that lists everybody who ever placed one urgent call is a
 * queue nobody reads, and the control it was meant to provide quietly stops existing.
 */
export async function quietHoursOverrideReview(db:Db,input:{at?:number}={}):Promise<OverrideReviewRow[]>{
  await ensureQuietHoursOverrideTables(db);
  const policy=await resolveQuietHoursOverridePolicy(db,{});
  const config=policy.config;
  const at=input.at??Date.now();
  const since=at-config.reviewWindowHours*3_600_000;
  const rows=await db.prepare("SELECT actor_id,actor_role,SUM(allowed) granted,SUM(CASE WHEN allowed=0 THEN 1 ELSE 0 END) refused FROM quiet_hours_overrides WHERE created_at>=? GROUP BY actor_id,actor_role ORDER BY granted DESC").bind(since).all<Row>();
  return rows.results.map(row=>{
    const overrides=Number(row.granted||0);
    return{actorId:text(row.actor_id),actorRole:text(row.actor_role),overrides,refusals:Number(row.refused||0),
      reviewRequired:overrides>=config.reviewThreshold,windowHours:config.reviewWindowHours};
  });
}
