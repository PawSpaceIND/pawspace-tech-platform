import { resolveLivePrice } from "./live-pricing-resolver";
import { addCalendarMonthsClamped } from "./subscription-calendar";

export type GroomingPetType="dog"|"cat"|"other";
export type GroomingOfferType="regular"|"young"|"subscription";
export type GroomingCatalogueItem={
  code:string;name:string;offerType:GroomingOfferType;eligiblePetTypes:GroomingPetType[];singlePrice:number;multiPetPrice?:number;
  sessions?:number;validityValue?:number;validityUnit?:"days"|"months";servicePackageCode?:string;version:string;active:boolean;
  cityId?:string;zoneId?:string|null;maxPetsPerBooking?:number;creditsPerPet?:number;familyWallet?:boolean;pauseDays?:number;graceDays?:number;renewalWindowDays?:number;benefits?:unknown[];terms?:Record<string,unknown>;
};

type Db=D1Database;
type Row=Record<string,unknown>;
export const GROOMING_CATALOGUE_VERSION="2026-08-07.v2";

export const groomingCatalogue:GroomingCatalogueItem[]=[
  {code:"dog-bath",name:"Essential Bath",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:1349,multiPetPrice:1149,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"dog-basic",name:"Bath & Basic",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:1899,multiPetPrice:1649,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"dog-makeover",name:"Complete Makeover",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:2399,multiPetPrice:2149,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"dog-trim",name:"Just Trim",offerType:"regular",eligiblePetTypes:["dog"],singlePrice:1599,multiPetPrice:1399,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-routine",name:"Routine Grooming",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:1149,multiPetPrice:999,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-basic",name:"Bath & Basic",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:1899,multiPetPrice:1649,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-makeover",name:"Complete Makeover",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:2399,multiPetPrice:2149,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"cat-trim",name:"Just Trim",offerType:"regular",eligiblePetTypes:["cat"],singlePrice:1599,multiPetPrice:1399,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"young-basic",name:"Bath & Basic",offerType:"young",eligiblePetTypes:["dog","cat"],singlePrice:999,multiPetPrice:899,version:GROOMING_CATALOGUE_VERSION,active:true},
  {code:"young-makeover",name:"Complete Makeover",offerType:"young",eligiblePetTypes:["dog","cat"],singlePrice:1399,multiPetPrice:1299,version:GROOMING_CATALOGUE_VERSION,active:true},
];

const defaultSubscriptionPlans=[
  {id:"gsubplan_blr_sub_3_dog",planCode:"sub-3-dog",name:"3 sessions · Dog",price:3597,sessions:3,validityValue:4,validityUnit:"months",pets:["dog"],servicePackageCode:"dog-basic"},
  {id:"gsubplan_blr_sub_3_cat",planCode:"sub-3-cat",name:"3 sessions · Cat Routine",price:2999,sessions:3,validityValue:4,validityUnit:"months",pets:["cat"],servicePackageCode:"cat-routine"},
  {id:"gsubplan_blr_sub_6",planCode:"sub-6",name:"6 sessions · Semiannual",price:6594,sessions:6,validityValue:6,validityUnit:"months",pets:["dog","cat"],servicePackageCode:"dog-basic"},
  {id:"gsubplan_blr_sub_12",planCode:"sub-12",name:"12 sessions · Annual",price:11988,sessions:12,validityValue:12,validityUnit:"months",pets:["dog","cat"],servicePackageCode:"dog-basic"},
  {id:"gsubplan_blr_sub_trim",planCode:"sub-trim",name:"3 Just Trim sessions",price:4197,sessions:3,validityValue:4,validityUnit:"months",pets:["dog","cat"],servicePackageCode:"dog-trim"},
] as const;

export async function ensureGroomingSubscriptionPlans(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_subscription_plans (id TEXT PRIMARY KEY,service_code TEXT NOT NULL DEFAULT 'grooming',plan_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT,name TEXT NOT NULL,price REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',session_count INTEGER NOT NULL,validity_value INTEGER NOT NULL,validity_unit TEXT NOT NULL DEFAULT 'months',eligible_pet_types_json TEXT NOT NULL DEFAULT '[\"dog\",\"cat\"]',service_package_code TEXT NOT NULL,max_pets_per_booking INTEGER NOT NULL DEFAULT 4,credits_per_pet INTEGER NOT NULL DEFAULT 1,family_wallet INTEGER NOT NULL DEFAULT 1,pause_days INTEGER NOT NULL DEFAULT 0,grace_days INTEGER NOT NULL DEFAULT 0,renewal_window_days INTEGER NOT NULL DEFAULT 30,benefits_json TEXT NOT NULL DEFAULT '[]',terms_json TEXT NOT NULL DEFAULT '{}',active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_subscription_plan_lookup ON grooming_subscription_plans(plan_code,city_id,zone_id,active,effective_from,effective_to)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_subscription_plan_audit (id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,plan_code TEXT NOT NULL,city_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);}

const subscriptionPlansSeeded=new WeakSet<Db>();
export async function seedDefaultGroomingSubscriptionPlans(db:Db){if(subscriptionPlansSeeded.has(db))return;await ensureGroomingSubscriptionPlans(db);const now=Date.now();await db.batch(defaultSubscriptionPlans.map(plan=>db.prepare("INSERT OR IGNORE INTO grooming_subscription_plans (id,service_code,plan_code,city_id,zone_id,name,price,currency,session_count,validity_value,validity_unit,eligible_pet_types_json,service_package_code,max_pets_per_booking,credits_per_pet,family_wallet,pause_days,grace_days,renewal_window_days,benefits_json,terms_json,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,'grooming',?,'blr',NULL,? ,?,'INR',?,?,?,?,?,4,1,1,0,0,30,'[]','{}',1,1,'2026-08-01',NULL,'founder_seed',?)")
  .bind(plan.id,plan.planCode,plan.name,plan.price,plan.sessions,plan.validityValue,plan.validityUnit,JSON.stringify(plan.pets),plan.servicePackageCode,now)));subscriptionPlansSeeded.add(db);}

function parseJson<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}}

export async function resolveGroomingSubscriptionPlan(db:Db,planCode:string,cityId:string,zoneId?:string,at=new Date()):Promise<GroomingCatalogueItem|null>{await seedDefaultGroomingSubscriptionPlans(db);const date=at.toISOString().slice(0,10);const row=await db.prepare("SELECT * FROM grooming_subscription_plans WHERE plan_code=? AND city_id=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) AND (zone_id IS NULL OR zone_id=?) ORDER BY CASE WHEN zone_id=? THEN 0 ELSE 1 END,version DESC LIMIT 1").bind(planCode,cityId,date,date,zoneId??"",zoneId??"").first<Row>();if(!row)return null;return{
  code:String(row.plan_code),name:String(row.name),offerType:"subscription",eligiblePetTypes:parseJson<GroomingPetType[]>(row.eligible_pet_types_json,["dog","cat"]),singlePrice:Number(row.price),sessions:Number(row.session_count),validityValue:Number(row.validity_value),validityUnit:String(row.validity_unit)==="days"?"days":"months",servicePackageCode:String(row.service_package_code),version:`${row.city_id}:${row.plan_code}:v${row.version}`,active:Boolean(row.active),cityId:String(row.city_id),zoneId:row.zone_id?String(row.zone_id):null,maxPetsPerBooking:Number(row.max_pets_per_booking||4),creditsPerPet:Number(row.credits_per_pet||1),familyWallet:Boolean(row.family_wallet),pauseDays:Number(row.pause_days||0),graceDays:Number(row.grace_days||0),renewalWindowDays:Number(row.renewal_window_days||30),benefits:parseJson<unknown[]>(row.benefits_json,[]),terms:parseJson<Record<string,unknown>>(row.terms_json,{}),
};}

export type GroomingGovernanceInput={
  packageCode:string;packageName?:string;pets:Array<{species?:GroomingPetType}>;submittedTotal:number;submittedAmountDueNow:number;
  paymentMode:string;existingSubscriptionId?:string;cityId:string;zoneId?:string;scheduledStart?:string;
};
export type GroomingGovernanceResult={
  packageCode:string;packageName:string;catalogueVersion:string;offerType:GroomingOfferType;petCount:number;totalAmount:number;amountDueNow:number;
  subscriptionPlan?:{planCode:string;sessions:number;validityValue:number;validityUnit:"days"|"months";reserveSessions:number;servicePackageCode:string;cityId:string;zoneId?:string|null;familyWallet:boolean;pauseDays:number;graceDays:number;renewalWindowDays:number;benefits:unknown[];terms:Record<string,unknown>};
};

export async function governGroomingBooking(db:Db,input:GroomingGovernanceInput):Promise<GroomingGovernanceResult>{
  let item=groomingCatalogue.find(row=>row.active&&row.code===input.packageCode)??null;
  if(!item)item=await resolveGroomingSubscriptionPlan(db,input.packageCode,input.cityId,input.zoneId);
  if(!item)throw new Error("Grooming package is not active for this city/zone");
  const petCount=input.pets.length,maxPets=item.maxPetsPerBooking??4;
  if(petCount<1||petCount>maxPets)throw new Error(`Grooming supports between 1 and ${maxPets} pets for this plan`);
  for(const pet of input.pets){const species=pet.species??"other";if(!item.eligiblePetTypes.includes(species))throw new Error(`${item.name} is not eligible for ${species}`);}
  let totalAmount=item.offerType==="subscription"?item.singlePrice:(petCount===1?item.singlePrice:(item.multiPetPrice??item.singlePrice)*petCount);
  // Live pricing only applies to the single-pet, non-subscription case for now. Multi-pet pricing
  // has no equivalent live package_code to check against yet (it would need its own dedicated entry,
  // not a multiplier on the single-pet live price) - staying on the existing hardcoded catalogue for
  // multi-pet bookings is a real, deliberate, documented limitation of this pass, not a silent gap.
  if(item.offerType!=="subscription"&&petCount===1&&input.scheduledStart){
    const live=await resolveLivePrice(db,{packageCode:input.packageCode,fallbackPrice:totalAmount,scheduledStart:input.scheduledStart,cityId:input.cityId,zoneId:input.zoneId});
    totalAmount=live.price;
  }
  if(Math.round(input.submittedTotal)!==Math.round(totalAmount))throw new Error(`Submitted Grooming total does not match governed catalogue ${item.version}`);
  const amountDueNow=input.paymentMode==="prepaid"?totalAmount:0;
  if(Math.round(input.submittedAmountDueNow)!==Math.round(amountDueNow))throw new Error("Submitted amount due now does not match the governed payment mode");
  if(item.offerType==="subscription"&&input.existingSubscriptionId)throw new Error("A subscription-plan purchase cannot also consume an existing subscription");
  const reserveSessions=petCount*(item.creditsPerPet??1);
  if(item.offerType==="subscription"&&reserveSessions>Number(item.sessions||0))throw new Error("The selected subscription does not contain enough credits for all selected pets");
  return {
    packageCode:item.code,packageName:item.name,catalogueVersion:item.version,offerType:item.offerType,petCount,totalAmount,amountDueNow,
    subscriptionPlan:item.offerType==="subscription"?{planCode:item.code,sessions:Number(item.sessions),validityValue:Number(item.validityValue),validityUnit:item.validityUnit??"months",reserveSessions,servicePackageCode:String(item.servicePackageCode),cityId:input.cityId,zoneId:item.zoneId,familyWallet:item.familyWallet??true,pauseDays:item.pauseDays??0,graceDays:item.graceDays??0,renewalWindowDays:item.renewalWindowDays??30,benefits:item.benefits??[],terms:item.terms??{}}:undefined,
  };
}

export function subscriptionExpiry(startedAt:number,validityValue:number,validityUnit:"days"|"months"){if(validityUnit==="months")return addCalendarMonthsClamped(startedAt,validityValue);const date=new Date(startedAt);date.setUTCDate(date.getUTCDate()+validityValue);return date.getTime();}
