/**
 * What a Boarding host can actually take. [PTJA-W3-BH]
 *
 * THE APPROVED RULE, in the business's own words: the five fields must be ANSWERED before a Boarding
 * host profile becomes active - service area, species accepted, guest capacity, one-family-at-a-time,
 * medication handling. They are MATCHING CONSTRAINTS, not universal rejection rules: the service area
 * must cover the booking location, the species must match the pet, available capacity must cover the
 * booking, one-family-at-a-time becomes a hard constraint when enabled, and medication capability
 * becomes a hard constraint only when the pet requires medication.
 *
 * And explicitly: do not add universal police or government-ID requirements through this work. The
 * police floor stays Dog Walking and Pet Taxi, in lib/provider-verification-policy.ts. Nothing here
 * touches it, and a test asserts this file never mentions one.
 *
 * WHAT WAS MEASURED BEFORE. boarding_host_profiles carried all five columns and nothing collected them:
 * the only writers in the repository were a hardcoded seed and a demo SQL file, so a real host could
 * never be boarded. Activation checked that a profile ROW EXISTS, not that it said anything - a row
 * with no area, an empty species list and zero capacity passed. And medication_support was read by
 * nothing at all, so a host who cannot give medication was matched to a pet that needs it every time.
 *
 * ANSWERED IS NOT THE SAME AS TRUE. "This host does not give medication" is information a matcher can
 * use; "nobody asked" is not, and both would otherwise be stored as 0. The write path takes booleans
 * and refuses null/undefined, which is what keeps those two apart.
 */
import{ensureBoardingGovernanceTables}from"./boarding-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

/** The five, named once so the gate, the report and the error message cannot drift apart. */
export const BOARDING_HOST_CAPABILITY_FIELDS=["service_area","species_accepted","guest_capacity","one_family_at_a_time","medication_handling"] as const;
export type BoardingHostCapabilityField=typeof BOARDING_HOST_CAPABILITY_FIELDS[number];

export async function ensureBoardingHostCapabilityTables(db:Db){
  await ensureBoardingGovernanceTables(db);
}

export type BoardingHostCapabilityInput={
  providerId:string;cityId:string;zoneId:string;
  area:string;species:string[];maxGuestPets:number;
  oneFamilyOnly:boolean|null;medicationSupport:boolean|null;
  residentPets?:string;
};

const refuse=(message:string,status=400,extra:Record<string,unknown>={}):never=>{throw Response.json({error:message,...extra},{status});};

/** Which of the five this profile has not answered. Empty means the host may go live. */
export function capabilityGapsFrom(row:Row|null|undefined):BoardingHostCapabilityField[]{
  if(!row)return[...BOARDING_HOST_CAPABILITY_FIELDS];
  const missing:BoardingHostCapabilityField[]=[];
  if(!text(row.area))missing.push("service_area");
  let species:string[]=[];
  try{species=JSON.parse(String(row.species_json||"[]"))as string[];}catch{species=[];}
  if(!Array.isArray(species)||!species.filter(entry=>text(entry)).length)missing.push("species_accepted");
  if(!Number.isFinite(Number(row.max_guest_pets))||Number(row.max_guest_pets)<1)missing.push("guest_capacity");
  // A NULL column is "nobody asked". 0 is "the host said no", which is an answer.
  if(row.one_family_only===null||row.one_family_only===undefined)missing.push("one_family_at_a_time");
  if(row.medication_support===null||row.medication_support===undefined)missing.push("medication_handling");
  return missing;
}

export async function boardingHostCapabilityGaps(db:Db,providerId:string){
  await ensureBoardingHostCapabilityTables(db);
  const row=await db.prepare("SELECT * FROM boarding_host_profiles WHERE provider_id=?").bind(text(providerId)).first<Row>().catch(()=>null);
  return{providerId:text(providerId),exists:Boolean(row),missing:capabilityGapsFrom(row),
    complete:Boolean(row)&&capabilityGapsFrom(row).length===0};
}

/**
 * The onboarding writer. Refuses an incomplete answer set outright rather than storing a half-profile
 * and marking it inactive - a row that exists but says nothing is what let the activation gate pass a
 * host who had never been asked anything.
 */
export async function saveBoardingHostCapability(db:Db,input:BoardingHostCapabilityInput,actorId:string){
  await ensureBoardingHostCapabilityTables(db);
  const providerId=text(input.providerId);
  if(!providerId||!text(input.cityId)||!text(input.zoneId))refuse("A provider, city and zone are required");
  if(!text(actorId))refuse("An actor is required");
  if(!text(input.area))refuse("The host's service area must be answered",400,{code:"missing_service_area"});
  const species=(Array.isArray(input.species)?input.species:[]).map(entry=>text(entry).toLowerCase()).filter(Boolean);
  if(!species.length)refuse("The species this host accepts must be answered",400,{code:"missing_species_accepted"});
  const capacity=Number(input.maxGuestPets);
  if(!Number.isFinite(capacity)||capacity<1)refuse("The host's guest-pet capacity must be answered and at least one",400,{code:"missing_guest_capacity"});
  if(typeof input.oneFamilyOnly!=="boolean")refuse("Whether this host takes one family at a time must be answered yes or no",400,{code:"missing_one_family_at_a_time"});
  if(typeof input.medicationSupport!=="boolean")refuse("Whether this host can handle medication must be answered yes or no",400,{code:"missing_medication_handling"});

  const now=Date.now();
  await db.prepare("INSERT INTO boarding_host_profiles (provider_id,city_id,zone_id,area,species_json,max_guest_pets,one_family_only,medication_support,resident_pets,active,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?) ON CONFLICT(provider_id) DO UPDATE SET city_id=excluded.city_id,zone_id=excluded.zone_id,area=excluded.area,species_json=excluded.species_json,max_guest_pets=excluded.max_guest_pets,one_family_only=excluded.one_family_only,medication_support=excluded.medication_support,resident_pets=excluded.resident_pets,active=1,version=boarding_host_profiles.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(providerId,text(input.cityId).toLowerCase(),text(input.zoneId).toLowerCase(),text(input.area),JSON.stringify(species),Math.floor(capacity),
      input.oneFamilyOnly?1:0,input.medicationSupport?1:0,text(input.residentPets)||"none",actorId,now).run();
  return{providerId,active:true,missing:[] as BoardingHostCapabilityField[],
    capability:{area:text(input.area),species,maxGuestPets:Math.floor(capacity),oneFamilyOnly:input.oneFamilyOnly,medicationSupport:input.medicationSupport}};
}

/** Blocks activation when any of the five is unanswered, naming which. */
export async function assertBoardingHostCapabilityComplete(db:Db,providerId:string){
  const gaps=await boardingHostCapabilityGaps(db,providerId);
  if(!gaps.exists)throw new Error("This provider offers boarding but has no boarding host profile; capture the host's service area, species accepted, guest-pet capacity, one-family setting and medication handling before putting them live");
  if(gaps.missing.length)throw new Error(`This provider's boarding host profile is incomplete: ${gaps.missing.join(", ")} still unanswered. Capture every answer before putting them live`);
  return gaps;
}

export type BoardingMatchInput={
  providerId:string;cityId:string;zoneId:string;species:string[];petCount:number;
  medicationRequired:boolean;customerId?:string|null;at?:number;
};

/**
 * The five as MATCHING constraints.
 *
 * Each one bites only where the rule says it should. A host who cannot give medication is not a worse
 * host - they are simply not the host for a pet that needs it, and are perfectly eligible for one that
 * does not. Treating those declarations as blanket rejections would shrink supply for no safety gain,
 * which is what "matching constraints, not universal rejection rules" is guarding against.
 */
export async function assertBoardingHostMatches(db:Db,input:BoardingMatchInput){
  await ensureBoardingHostCapabilityTables(db);
  const providerId=text(input.providerId);
  const row=await db.prepare("SELECT * FROM boarding_host_profiles WHERE provider_id=?").bind(providerId).first<Row>().catch(()=>null);
  if(!row)refuse("This Boarding host has no capability profile",409,{code:"boarding_host_profile_missing"});
  const missing=capabilityGapsFrom(row);
  if(missing.length)refuse(`This Boarding host has not answered: ${missing.join(", ")}`,409,{code:"boarding_host_capability_incomplete",missing});
  if(Number(row!.active)!==1)refuse("This Boarding host is not active",409,{code:"boarding_host_inactive"});

  // 1. Service area must COVER the booking location. The zone is the covering unit this platform
  //    matches on; `area` is the human label an operator reads, and is required as an ANSWER above.
  if(text(row!.city_id).toLowerCase()!==text(input.cityId).toLowerCase()||text(row!.zone_id).toLowerCase()!==text(input.zoneId).toLowerCase())
    refuse("This Boarding host's service area does not cover the booking location",409,{code:"boarding_host_area_mismatch"});

  // 2. Species must match the pet.
  let accepted:string[]=[];
  try{accepted=(JSON.parse(String(row!.species_json||"[]"))as string[]).map(entry=>text(entry).toLowerCase());}catch{accepted=[];}
  const wanted=(Array.isArray(input.species)?input.species:[]).map(entry=>text(entry).toLowerCase()).filter(Boolean);
  const unsupported=wanted.filter(species=>!accepted.includes(species));
  if(unsupported.length)refuse(`This Boarding host does not accept ${unsupported.join(", ")}`,409,{code:"boarding_host_species_mismatch"});

  // 3. AVAILABLE capacity, not declared capacity: what is already staying counts against it.
  const at=input.at??Date.now();
  const occupied=await db.prepare("SELECT customer_id,pet_count FROM boarding_stays WHERE host_provider_id=? AND status NOT IN ('cancelled','completed','refunded','declined')").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]}));
  void at;
  const used=occupied.results.reduce((sum,stay)=>sum+Number(stay.pet_count||0),0);
  const capacity=Number(row!.max_guest_pets||0);
  if(used+Number(input.petCount||0)>capacity)
    refuse(`This Boarding host has ${Math.max(0,capacity-used)} guest place${capacity-used===1?"":"s"} available`,409,{code:"boarding_host_capacity_exceeded"});

  // 4. One family at a time, ONLY where the host enabled it.
  if(Number(row!.one_family_only)===1){
    const others=occupied.results.filter(stay=>text(stay.customer_id)&&text(stay.customer_id)!==text(input.customerId));
    if(others.length)refuse("This Boarding host takes one family at a time and already has a family in residence",409,{code:"boarding_host_one_family_only"});
  }

  // 5. Medication handling, ONLY where the pet needs it.
  if(input.medicationRequired&&Number(row!.medication_support)!==1)
    refuse("This Boarding host cannot handle medication, and this booking requires it",409,{code:"boarding_host_medication_unsupported"});

  return{providerId,area:text(row!.area),acceptedSpecies:accepted,
    maxGuestPets:capacity,usedGuestPets:used,availableGuestPets:capacity-used,
    oneFamilyOnly:Number(row!.one_family_only)===1,medicationSupport:Number(row!.medication_support)===1};
}
