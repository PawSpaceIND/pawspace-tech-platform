type Db=D1Database;
type Row=Record<string,unknown>;

export type GroomingPolicy={
  id:string;policyCode:string;cityId:string;zoneId:string|null;version:number;enforcementMode:"observe"|"enforce";
  cancellationCutoffMinutes:number;refundPercentBeforeCutoff:number;refundPercentAfterCutoff:number;
  rescheduleCutoffMinutes:number;rescheduleAllowedAfterCutoff:boolean;maxReschedules:number;rescheduleFeeType:"none"|"flat"|"percent";rescheduleFeeValue:number;
  noShowRefundPercent:number;multiPetMax:number;multiPetPricingMode:"catalogue"|"per_pet"|"custom";changeLockStatuses:string[];
  effectiveFrom:string;effectiveTo:string|null;
};

export type BookingChangeEvaluation={
  policyVersion:string;enforcementMode:"observe"|"enforce";allowed:boolean;minutesUntilStart:number;refundPercent:number;feeAmount:number;reasons:string[];
};

// Per-isolate memoization: DDL and the single default policy row are idempotent. resolveGroomingPolicy
// runs on every grooming booking; the WeakSet keeps this to one round-trip per D1 binding.
const groomingPolicyTablesEnsured=new WeakSet<Db>();
export async function ensureGroomingPolicyTables(db:Db){if(groomingPolicyTablesEnsured.has(db))return;await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_commercial_policies (id TEXT PRIMARY KEY,policy_code TEXT NOT NULL DEFAULT 'grooming-default',city_id TEXT NOT NULL,zone_id TEXT,enforcement_mode TEXT NOT NULL DEFAULT 'observe',cancellation_cutoff_minutes INTEGER NOT NULL DEFAULT 0,refund_percent_before_cutoff REAL NOT NULL DEFAULT 100,refund_percent_after_cutoff REAL NOT NULL DEFAULT 100,reschedule_cutoff_minutes INTEGER NOT NULL DEFAULT 0,reschedule_allowed_after_cutoff INTEGER NOT NULL DEFAULT 1,max_reschedules INTEGER NOT NULL DEFAULT 0,reschedule_fee_type TEXT NOT NULL DEFAULT 'none',reschedule_fee_value REAL NOT NULL DEFAULT 0,no_show_refund_percent REAL NOT NULL DEFAULT 0,multi_pet_max INTEGER NOT NULL DEFAULT 4,multi_pet_pricing_mode TEXT NOT NULL DEFAULT 'catalogue',change_lock_statuses_json TEXT NOT NULL DEFAULT '[\"completed\",\"cancelled\"]',active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_policy_lookup ON grooming_commercial_policies(city_id,zone_id,active,effective_from,effective_to)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_commercial_policy_audit (id TEXT PRIMARY KEY,policy_id TEXT NOT NULL,policy_code TEXT NOT NULL,city_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);groomingPolicyTablesEnsured.add(db);}

const groomingPolicySeeded=new WeakSet<Db>();
export async function seedDefaultGroomingPolicy(db:Db){if(groomingPolicySeeded.has(db))return;await ensureGroomingPolicyTables(db);const now=Date.now();groomingPolicySeeded.add(db);await db.prepare("INSERT OR IGNORE INTO grooming_commercial_policies (id,policy_code,city_id,zone_id,enforcement_mode,cancellation_cutoff_minutes,refund_percent_before_cutoff,refund_percent_after_cutoff,reschedule_cutoff_minutes,reschedule_allowed_after_cutoff,max_reschedules,reschedule_fee_type,reschedule_fee_value,no_show_refund_percent,multi_pet_max,multi_pet_pricing_mode,change_lock_statuses_json,active,version,effective_from,effective_to,updated_by,updated_at) VALUES ('gpolicy_blr_default','grooming-default','blr',NULL,'observe',0,100,100,0,1,0,'none',0,0,4,'catalogue','[\"completed\",\"cancelled\"]',1,1,'2026-08-01',NULL,'founder_seed',?)").bind(now).run();}

function parse<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}}
function rowToPolicy(row:Row):GroomingPolicy{return{
  id:String(row.id),policyCode:String(row.policy_code),cityId:String(row.city_id),zoneId:row.zone_id?String(row.zone_id):null,version:Number(row.version||1),enforcementMode:String(row.enforcement_mode)==="enforce"?"enforce":"observe",
  cancellationCutoffMinutes:Number(row.cancellation_cutoff_minutes||0),refundPercentBeforeCutoff:Number(row.refund_percent_before_cutoff??100),refundPercentAfterCutoff:Number(row.refund_percent_after_cutoff??100),
  rescheduleCutoffMinutes:Number(row.reschedule_cutoff_minutes||0),rescheduleAllowedAfterCutoff:Boolean(row.reschedule_allowed_after_cutoff),maxReschedules:Number(row.max_reschedules||0),rescheduleFeeType:["flat","percent"].includes(String(row.reschedule_fee_type))?String(row.reschedule_fee_type) as "flat"|"percent":"none",rescheduleFeeValue:Number(row.reschedule_fee_value||0),
  noShowRefundPercent:Number(row.no_show_refund_percent||0),multiPetMax:Number(row.multi_pet_max||4),multiPetPricingMode:["per_pet","custom"].includes(String(row.multi_pet_pricing_mode))?String(row.multi_pet_pricing_mode) as "per_pet"|"custom":"catalogue",changeLockStatuses:parse<string[]>(row.change_lock_statuses_json,["completed","cancelled"]),effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to?String(row.effective_to):null,
};}

export async function resolveGroomingPolicy(db:Db,cityId:string,zoneId?:string,at=new Date()):Promise<GroomingPolicy>{await seedDefaultGroomingPolicy(db);const date=at.toISOString().slice(0,10);const row=await db.prepare("SELECT * FROM grooming_commercial_policies WHERE city_id=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) AND (zone_id IS NULL OR zone_id=?) ORDER BY CASE WHEN zone_id=? THEN 0 ELSE 1 END,version DESC LIMIT 1").bind(cityId,date,date,zoneId??"",zoneId??"").first<Row>();if(!row)throw Response.json({error:"Grooming is not commercially configured for this city/zone",code:"grooming_policy_configuration_required",cityId,zoneId:zoneId??null},{status:409});return rowToPolicy(row);}

export function policyVersion(policy:GroomingPolicy){return `${policy.cityId}:${policy.zoneId??"all"}:${policy.policyCode}:v${policy.version}`;}
export function policySnapshot(policy:GroomingPolicy){return{...policy,policyVersion:policyVersion(policy)};}
export function parsePolicySnapshot(value:unknown):GroomingPolicy|null{if(!value||typeof value!=="object")return null;const row=value as Partial<GroomingPolicy>;if(!row.id||!row.cityId||!row.policyCode)return null;return{...row,zoneId:row.zoneId??null,version:Number(row.version||1),enforcementMode:row.enforcementMode==="enforce"?"enforce":"observe",cancellationCutoffMinutes:Number(row.cancellationCutoffMinutes||0),refundPercentBeforeCutoff:Number(row.refundPercentBeforeCutoff??100),refundPercentAfterCutoff:Number(row.refundPercentAfterCutoff??100),rescheduleCutoffMinutes:Number(row.rescheduleCutoffMinutes||0),rescheduleAllowedAfterCutoff:Boolean(row.rescheduleAllowedAfterCutoff),maxReschedules:Number(row.maxReschedules||0),rescheduleFeeType:row.rescheduleFeeType??"none",rescheduleFeeValue:Number(row.rescheduleFeeValue||0),noShowRefundPercent:Number(row.noShowRefundPercent||0),multiPetMax:Number(row.multiPetMax||4),multiPetPricingMode:row.multiPetPricingMode??"catalogue",changeLockStatuses:Array.isArray(row.changeLockStatuses)?row.changeLockStatuses:["completed","cancelled"],effectiveFrom:String(row.effectiveFrom||""),effectiveTo:row.effectiveTo??null} as GroomingPolicy;}

export function evaluateBookingChange(policy:GroomingPolicy,input:{action:"cancel"|"reschedule";scheduledStart:string;status:string;bookingAmount:number;rescheduleCount?:number;now?:number}):BookingChangeEvaluation{
  const now=input.now??Date.now(),start=new Date(input.scheduledStart).getTime(),minutesUntilStart=Math.floor((start-now)/60_000),reasons:string[]=[];
  let allowed=!policy.changeLockStatuses.includes(input.status),refundPercent=100,feeAmount=0;
  if(!allowed)reasons.push(`Booking status ${input.status} is locked by policy`);
  if(input.action==="cancel"){
    const before=minutesUntilStart>=policy.cancellationCutoffMinutes;refundPercent=before?policy.refundPercentBeforeCutoff:policy.refundPercentAfterCutoff;reasons.push(before?"Cancellation is before the configured cutoff":"Cancellation is inside the configured cutoff");
  }else{
    const before=minutesUntilStart>=policy.rescheduleCutoffMinutes;
    if(!before&&!policy.rescheduleAllowedAfterCutoff){allowed=false;reasons.push("Reschedule is inside the cutoff and late reschedule is disabled");}
    const count=input.rescheduleCount??0;if(policy.maxReschedules>0&&count>=policy.maxReschedules){allowed=false;reasons.push("Maximum reschedule count reached");}
    if(policy.rescheduleFeeType==="flat")feeAmount=policy.rescheduleFeeValue;else if(policy.rescheduleFeeType==="percent")feeAmount=Math.round(input.bookingAmount*policy.rescheduleFeeValue)/100;
    reasons.push(before?"Reschedule is before the configured cutoff":"Reschedule is inside the configured cutoff");
  }
  if(policy.enforcementMode==="observe"&&policy.changeLockStatuses.includes(input.status)===false){if(!allowed)reasons.push("Observe mode: policy would block this change but UAT behavior is preserved");allowed=true;refundPercent=100;feeAmount=0;}
  return{policyVersion:policyVersion(policy),enforcementMode:policy.enforcementMode,allowed,minutesUntilStart,refundPercent:Math.max(0,Math.min(100,refundPercent)),feeAmount:Math.max(0,feeAmount),reasons};
}
