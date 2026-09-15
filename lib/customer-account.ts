/*
 * Refusals in this module are caller-safe and MUST survive the route's catch block. [R3-C/F9]
 *
 * MEASURED: POST /api/customer-account {action:"upsert_pet",pet:{...,vaccinationStatus:"vaccinated"}}
 * answered 400 {"error":"Unable to update customer account"}. The real sentence - "Vaccination status
 * must be not_provided, verified or pending", which petProfileIssues() produces and this engine
 * raises - never reached the caller, so a customer was told only that something unspecified was wrong
 * with a form they could not correct.
 *
 * lib/server-auth.ts authError() returns a raised Response verbatim only when isGovernedHttpError()
 * says so: membership in a module-private WeakSet, tested by object identity. A bare Response
 * constructed here is NOT in that set, so authError kept the STATUS and replaced the BODY with the
 * route's generic fallback. Every refusal below had the same fate, not only the vaccination one -
 * ownership denials, the duplicate-phone refusal and "Address line 1 is required" included - so the
 * whole engine is branded rather than the one line that was reported.
 *
 * governedJsonError({error},status) both registers the response and writes the {"error":...} envelope
 * the clients already read (app/mobile-app/customer-account-view.tsx reads body.error). Statuses and
 * wording are unchanged; only the body survives. Same mechanism as lib/boarding-proof-governance.ts.
 */
import{governedJsonError}from"./governed-http-error";
import{validatePetProfile,type PetProfile,type PetSpecies}from"./pet-profile-options";
type Db=D1Database;
type Row=Record<string,unknown>;

export type CustomerAccountRecord={customerId:string;cityId:string;name:string;primaryPhone:string;secondaryPhone:string|null;email:string|null;memberSince:number;addresses:Array<{id:string;label:string;line1:string;line2:string|null;area:string|null;city:string;postalCode:string|null;isDefault:boolean}>;pets:Array<{id:string;sourceId:string|null;name:string;species:string;breed:string|null;vaccinationStatus:string;ageYears:number|null;weightKg:number|null;profile:PetProfile|null}>;bookings:Array<{id:string;serviceCode:string;packageName:string;status:string;scheduledStart:string;scheduledEnd:string;totalAmount:number;currency:string;providerId:string}>};
export const PET_SPECIES=["dog","cat","other"] as const;
export const PET_VACCINATION_STATUSES=["not_provided","verified","pending","recorded","vaccinated"] as const;
/**
 * What a CUSTOMER may assert about their own pet. "verified", "recorded" and "vaccinated" are
 * staff/vet outcomes - lib/pet-vaccination-governance.ts stamps "recorded", seeded rows carry
 * "vaccinated" - and a host deciding whether to accept a pet reads that column. Two paths used to
 * write "verified" straight from the owner's own tick-box: a top-level vaccinationStatus (MEASURED:
 * a hand-crafted upsert_pet stored "verified") and the rich-profile branch below. Neither did any
 * verifying. A claim is now "pending"; an existing staff verdict is preserved, never re-asserted.
 */
export const CUSTOMER_DECLARABLE_VACCINATION_STATUSES=["not_provided","pending"] as const;
const rows=<T=Row>(result:{results?:unknown[]})=>(result.results||[]) as T[];const safe=(value:unknown)=>String(value??"").trim();const token=(value:string)=>value.replace(/[^A-Za-z0-9]/g,"").toUpperCase();function stable(value:string){let hash=2166136261;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619);}return(hash>>>0).toString(36).toUpperCase();}export const canonicalPetId=(customerId:string,sourceId:string)=>`PET-${token(customerId)}-${token(sourceId)}`;
/**
 * Put back customer names that a masked display string was written over. [R3C-F10-MASK-REPAIR]
 *
 * /api/assisted-orders forwarded the CRM's MASKED customer object into canonical booking, and
 * /api/canonical-bookings upserts `name=excluded.name` - so converting a lead overwrote the real name
 * with its own mask. MEASURED on the audit database: canonical_customers held
 * `{"name":"R•• C• C•","primary_phone":"9811100144"}` - the real name simply gone, the phone intact
 * because the phone was already being resolved server-side.
 *
 * The write path is closed (assisted orders now resolve the name as well as the phone). This repairs
 * rows already damaged. It is deliberately conservative: a name is only replaced when crm_contacts
 * holds an UNMASKED name for the same customer. Where no source survives the row is left exactly as
 * it is - a wrong name invented from a phone number would be worse than a visibly masked one.
 * U+2022 cannot occur in a real name, so the predicate cannot match an undamaged row.
 */
async function repairMaskedCustomerNames(db:Db){
 await db.prepare(
  "UPDATE canonical_customers SET name=(SELECT c.name FROM crm_contacts c WHERE c.id=canonical_customers.id AND c.name NOT LIKE '%\u2022%' AND TRIM(COALESCE(c.name,''))<>'')"+
  " WHERE name LIKE '%\u2022%'"+
  " AND EXISTS (SELECT 1 FROM crm_contacts c WHERE c.id=canonical_customers.id AND c.name NOT LIKE '%\u2022%' AND TRIM(COALESCE(c.name,''))<>'')"
 ).run().catch(()=>undefined);
}

export async function ensureCustomerAccountTables(db:Db){await db.batch([db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),db.prepare("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),db.prepare("CREATE INDEX IF NOT EXISTS canonical_pets_customer_idx ON canonical_pets(customer_id,created_at)"),db.prepare("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),db.prepare("CREATE INDEX IF NOT EXISTS customer_addresses_customer_idx ON customer_addresses(customer_id,is_default DESC,created_at)"),db.prepare("CREATE TABLE IF NOT EXISTS customer_account_mutations (idempotency_key TEXT PRIMARY KEY,customer_id TEXT NOT NULL,action TEXT NOT NULL,entity_id TEXT,result_json TEXT NOT NULL,created_at INTEGER NOT NULL)")]);
// Additive pet-profile columns (canonical_pets is also created by older route DDL without them,
// so the owning lib migrates whichever copy exists - same PRAGMA/ALTER pattern as coupon-governance).
const petColumns=await db.prepare("PRAGMA table_info(canonical_pets)").all<Row>();
if(!petColumns.results.some(row=>String(row.name)==="age_years")){await addColumnIfMissing(db,"ALTER TABLE canonical_pets ADD COLUMN age_years REAL");await addColumnIfMissing(db,"ALTER TABLE canonical_pets ADD COLUMN weight_kg REAL");}
// Rich pet profile (gender, breed, age band, DOB, vaccination, temperament, weight band, photo) is
// stored as one JSON column so the capture form can grow without a migration per field; the typed
// age_years/weight_kg/vaccination_status columns above stay populated (derived) for existing readers.
if(!petColumns.results.some(row=>String(row.name)==="profile_json")){await addColumnIfMissing(db,"ALTER TABLE canonical_pets ADD COLUMN profile_json TEXT");}await repairMaskedCustomerNames(db);}
// Additive column migration that is safe under concurrent first-writes: the PRAGMA check avoids the ALTER
// in the common case, and if two requests race past it, the loser's "duplicate column" error is benign.
async function addColumnIfMissing(db:Db,ddl:string){try{await db.prepare(ddl).run();}catch(error){if(!/duplicate column/i.test(String((error as {message?:string})?.message??error)))throw error;}}
async function safeAll(db:Db,sql:string,bindings:unknown[]=[]){try{let statement=db.prepare(sql);if(bindings.length)statement=statement.bind(...bindings);return rows(await statement.all<Row>());}catch{return[] as Row[];}}
export async function readCustomerAccount(db:Db,customerId:string):Promise<CustomerAccountRecord|null>{await ensureCustomerAccountTables(db);const customer=await db.prepare("SELECT id,city_id,name,primary_phone,secondary_phone,email,created_at FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();if(!customer)return null;const[addressRows,petRows,bookingRows]=await Promise.all([safeAll(db,"SELECT id,label,line1,line2,area,city,postal_code,is_default FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,created_at",[customerId]),safeAll(db,"SELECT id,source_pet_id,name,species,breed,vaccination_status,age_years,weight_kg,profile_json FROM canonical_pets WHERE customer_id=? ORDER BY created_at",[customerId]),safeAll(db,"SELECT id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency,provider_id FROM canonical_bookings WHERE customer_id=? ORDER BY scheduled_start DESC LIMIT 50",[customerId])]);return{customerId:String(customer.id),cityId:String(customer.city_id||"blr"),name:String(customer.name||"Customer"),primaryPhone:String(customer.primary_phone||""),secondaryPhone:customer.secondary_phone?String(customer.secondary_phone):null,email:customer.email?String(customer.email):null,memberSince:Number(customer.created_at||Date.now()),addresses:addressRows.map(row=>({id:String(row.id),label:String(row.label||"Address"),line1:String(row.line1||""),line2:row.line2?String(row.line2):null,area:row.area?String(row.area):null,city:String(row.city||"Bengaluru"),postalCode:row.postal_code?String(row.postal_code):null,isDefault:Boolean(Number(row.is_default||0))})),pets:petRows.map(row=>({id:String(row.id),sourceId:row.source_pet_id?String(row.source_pet_id):null,name:String(row.name||"Pet"),species:String(row.species||"other"),breed:row.breed?String(row.breed):null,vaccinationStatus:String(row.vaccination_status||"not_provided"),ageYears:row.age_years==null?null:Number(row.age_years),weightKg:row.weight_kg==null?null:Number(row.weight_kg),profile:parsePetProfile(row.profile_json)})),bookings:bookingRows.map(row=>({id:String(row.id),serviceCode:String(row.service_code),packageName:String(row.package_name),status:String(row.status),scheduledStart:String(row.scheduled_start),scheduledEnd:String(row.scheduled_end),totalAmount:Number(row.total_amount||0),currency:String(row.currency||"INR"),providerId:String(row.provider_id||"")}))};}
/** Pure pet-profile validation shared by the server mutation and the pet-manager UI, so the
 *  inline form flags exactly what the server would reject. Returns human-readable issues. */
export function petProfileIssues(input:{name:string;species:string;vaccinationStatus:string;ageYears:number|null;weightKg:number|null}):string[]{
 const issues:string[]=[];
 if(!input.name.trim())issues.push("Pet name is required");
 if(input.name.trim().length>60)issues.push("Pet name must be 60 characters or fewer");
 if(!(PET_SPECIES as readonly string[]).includes(input.species))issues.push("Pet species must be dog, cat or other");
 if(!(PET_VACCINATION_STATUSES as readonly string[]).includes(input.vaccinationStatus))issues.push(`Vaccination status must be one of ${PET_VACCINATION_STATUSES.join(", ")}`);
 if(input.ageYears!==null&&(!Number.isFinite(input.ageYears)||input.ageYears<0||input.ageYears>40))issues.push("Pet age must be between 0 and 40 years");
 if(input.weightKg!==null&&(!Number.isFinite(input.weightKg)||input.weightKg<=0||input.weightKg>120))issues.push("Pet weight must be between 0 and 120 kg");
 return issues;
}
const optionalNumber=(value:unknown)=>value===undefined||value===null||safe(value)===""?null:Number(value);
// Parse the stored rich profile back into a typed object for reads (tolerant of legacy/null rows).
function parsePetProfile(value:unknown):PetProfile|null{if(!value)return null;try{const parsed=JSON.parse(String(value));return parsed&&typeof parsed==="object"?parsed as PetProfile:null;}catch{return null;}}
// Derive a representative numeric age (years) from DOB when given, else from the selected age band,
// so the typed age_years column stays meaningful for existing readers/analytics.
const AGE_BAND_YEARS:Record<string,number>={"< 6 months":0.25,"6–12 months":0.75,"20+ years":20};
function ageYearsFromProfile(p:PetProfile):number|null{if(p.dateOfBirth){const dob=new Date(`${p.dateOfBirth}T00:00:00Z`).getTime();if(Number.isFinite(dob)){const years=(Date.now()-dob)/(365.25*24*3600*1000);if(years>=0&&years<=40)return Math.round(years*10)/10;}}const band=String(p.ageBand||"");if(band in AGE_BAND_YEARS)return AGE_BAND_YEARS[band];const match=/^(\d+)\s*year/.exec(band);return match?Number(match[1]):null;}
// Weight bands map to a representative midpoint; "Not sure" (and anything unknown) stays null.
const WEIGHT_BAND_KG:Record<string,number>={"3–20 kg":11,"20–45 kg":32,"45–60 kg":52,"60+ kg":65};
function weightKgFromBand(band:string):number|null{return band in WEIGHT_BAND_KG?WEIGHT_BAND_KG[band]:null;}
type MutationInput={customerId:string;action:string;idempotencyKey:string;profile?:Record<string,unknown>;address?:Record<string,unknown>;pet?:Record<string,unknown>};
/**
 * A profile write may not CLAIM a phone number that already belongs to another customer.
 *
 * update_profile wrote an arbitrary caller-supplied number into primary_phone and secondary_phone with
 * no proof of possession and no uniqueness check at all. Combined with OTP login treating a secondary
 * number as an identity, that was a full account takeover: an attacker wrote a stranger's number onto
 * their own record (201), and when the person who genuinely held that number OTP-verified it they were
 * handed a verified session on the ATTACKER's customer id, with no new customer row created. Everything
 * they entered afterwards - address, pets, bookings, points - landed under the attacker's record.
 *
 * This closes the claiming half. The login half is closed in lib/customer-otp.ts, which no longer
 * resolves an identity from a self-asserted secondary number at all. Both were needed: uniqueness alone
 * does not stop a number NOBODY has registered yet from being planted.
 */
export async function mutateCustomerAccount(db:Db,input:MutationInput){await ensureCustomerAccountTables(db);const customerId=safe(input.customerId),action=safe(input.action),key=safe(input.idempotencyKey);if(!customerId||!action||!key)throw governedJsonError({error:"Customer, action and idempotency key are required"},400);const customer=await db.prepare("SELECT id,city_id,name,primary_phone,secondary_phone,email FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();if(!customer)throw governedJsonError({error:"Canonical customer not found"},404);const prior=await db.prepare("SELECT customer_id,action,result_json FROM customer_account_mutations WHERE idempotency_key=?").bind(key).first<Row>();if(prior){if(String(prior.customer_id)!==customerId||String(prior.action)!==action)throw governedJsonError({error:"Idempotency key was already used for a different customer mutation"},409);return{...(JSON.parse(String(prior.result_json||"{}")) as Row),duplicatePrevented:true};}const now=Date.now();let entityId=customerId,result:Row;if(action==="update_profile"){const p=input.profile||{},name=safe(p.name)||String(customer.name||""),primaryPhone=safe(p.primaryPhone)||String(customer.primary_phone||""),secondaryPhone=p.secondaryPhone===null?null:(safe(p.secondaryPhone)||customer.secondary_phone||null),email=p.email===null?null:(safe(p.email).toLowerCase()||customer.email||null),cityId=safe(p.cityId)||String(customer.city_id||"blr");if(!name||!primaryPhone)throw governedJsonError({error:"Name and primary phone are required"},400);for(const claimed of [primaryPhone,secondaryPhone]){if(!claimed)continue;const held=await db.prepare("SELECT id FROM canonical_customers WHERE id!=? AND (primary_phone=? OR secondary_phone=?) LIMIT 1").bind(customerId,claimed,claimed).first<Row>();if(held)throw governedJsonError({error:"That phone number is already recorded on another PawSpace account"},409);}await db.prepare("UPDATE canonical_customers SET city_id=?,name=?,primary_phone=?,secondary_phone=?,email=?,source='customer_app',updated_at=? WHERE id=?").bind(cityId,name,primaryPhone,secondaryPhone,email,now,customerId).run();result={customerId,action,entityId:customerId};}else if(action==="upsert_address"){const a=input.address||{},line1=safe(a.line1),city=safe(a.city)||"Bengaluru";if(!line1)throw governedJsonError({error:"Address line 1 is required"},400);const supplied=safe(a.id),label=safe(a.label)||"Home",line2=safe(a.line2)||null,area=safe(a.area)||null,postalCode=safe(a.postalCode)||null;let id=supplied;if(!id){const same=await db.prepare("SELECT id FROM customer_addresses WHERE customer_id=? AND lower(trim(label))=lower(trim(?)) AND lower(trim(line1))=lower(trim(?)) AND COALESCE(lower(trim(area)),'')=COALESCE(lower(trim(?)),'') AND lower(trim(city))=lower(trim(?)) AND COALESCE(trim(postal_code),'')=COALESCE(trim(?),'') ORDER BY is_default DESC,updated_at DESC LIMIT 1").bind(customerId,label,line1,area,city,postalCode).first<Row>();id=same?String(same.id):`ADDR-${token(customerId)}-${stable(key)}`;}if(supplied){const owned=await db.prepare("SELECT customer_id FROM customer_addresses WHERE id=?").bind(id).first<Row>();if(owned&&String(owned.customer_id)!==customerId)throw governedJsonError({error:"Address ownership denied"},403);}const isDefault=a.isDefault===false?0:1;if(isDefault)await db.prepare("UPDATE customer_addresses SET is_default=0,updated_at=? WHERE customer_id=?").bind(now,customerId).run();await db.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,line1=excluded.line1,line2=excluded.line2,area=excluded.area,city=excluded.city,postal_code=excluded.postal_code,is_default=excluded.is_default,updated_at=excluded.updated_at WHERE customer_addresses.customer_id=excluded.customer_id").bind(id,customerId,label,line1,line2,area,city,postalCode,isDefault,now,now).run();entityId=id;result={customerId,action,entityId:id};}else if(action==="upsert_pet"){const p=input.pet||{},name=safe(p.name),species=safe(p.species).toLowerCase()||"other";let breed=safe(p.breed)||null,vaccinationStatus=safe(p.vaccinationStatus)||"not_provided",ageYears=optionalNumber(p.ageYears),weightKg=optionalNumber(p.weightKg),profileJson:string|null=null;
 // Rich capture path: when the form sends a full `profile`, validate it against the shared catalogue,
 // store it verbatim, and derive the typed columns (breed / vaccination / age / weight) from it.
 const rawProfile=(p.profile&&typeof p.profile==="object")?p.profile as Partial<PetProfile>:null;
 if(rawProfile){if(species!=="dog"&&species!=="cat")throw governedJsonError({error:"Rich pet profiles are only supported for dogs and cats"},400);const petSpecies=species as PetSpecies;const problem=validatePetProfile(petSpecies,rawProfile);if(problem)throw governedJsonError({error:problem},400);const vaccinated=Boolean(rawProfile.vaccinated);const photo=typeof rawProfile.photo==="string"&&rawProfile.photo.startsWith("data:")?rawProfile.photo.slice(0,300000):undefined;const normalized:PetProfile={gender:safe(rawProfile.gender)||undefined,breed:safe(rawProfile.breed),ageBand:safe(rawProfile.ageBand),dateOfBirth:safe(rawProfile.dateOfBirth)||undefined,vaccinated,vaccinationDose:vaccinated?(safe(rawProfile.vaccinationDose)||undefined):undefined,aggression:safe(rawProfile.aggression),weightBand:safe(rawProfile.weightBand),photo};profileJson=JSON.stringify(normalized);
 // The validated profile is the single source of truth for the derived typed columns — no top-level
 // override, so the stored breed/vaccination/age/weight can never conflict with the profile.
 breed=normalized.breed;vaccinationStatus=vaccinated?"pending":"not_provided";ageYears=ageYearsFromProfile(normalized);weightKg=weightKgFromBand(normalized.weightBand);}
 const sourceId=safe(p.sourceId)||`account-${stable(key).toLowerCase()}`,supplied=safe(p.id),id=supplied||canonicalPetId(customerId,sourceId);const issues=petProfileIssues({name,species,vaccinationStatus,ageYears,weightKg});if(issues.length)throw governedJsonError({error:issues.join("; ")},400);const existing=await db.prepare("SELECT customer_id,vaccination_status FROM canonical_pets WHERE id=?").bind(id).first<Row>();if(supplied&&existing&&String(existing.customer_id)!==customerId)throw governedJsonError({error:"Pet ownership denied"},403);
 // This endpoint is customer-scoped, so every caller here is the pet OWNER. A status only staff
 // can establish is kept at whatever staff last stored - editing a pet's name must neither revoke
 // a verification nor mint one - and anything else the owner sends is clamped to what they may
 // assert. MEASURED before this: a hand-crafted upsert_pet stored "verified" with no staff step.
 const storedStatus=safe(existing?.vaccination_status);
 const staffEstablished=storedStatus&&!(CUSTOMER_DECLARABLE_VACCINATION_STATUSES as readonly string[]).includes(storedStatus);
 if(staffEstablished)vaccinationStatus=storedStatus;
 else if(!(CUSTOMER_DECLARABLE_VACCINATION_STATUSES as readonly string[]).includes(vaccinationStatus))vaccinationStatus="pending";await db.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,age_years,weight_kg,profile_json,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,species=excluded.species,breed=excluded.breed,vaccination_status=excluded.vaccination_status,age_years=excluded.age_years,weight_kg=excluded.weight_kg,profile_json=COALESCE(excluded.profile_json,canonical_pets.profile_json),source_pet_id=COALESCE(canonical_pets.source_pet_id,excluded.source_pet_id),updated_at=excluded.updated_at WHERE canonical_pets.customer_id=excluded.customer_id").bind(id,customerId,name,species,breed,vaccinationStatus,ageYears,weightKg,profileJson,sourceId,now,now).run();entityId=id;result={customerId,action,entityId:id};}else throw governedJsonError({error:"Unsupported customer account action"},400);await db.prepare("INSERT INTO customer_account_mutations (idempotency_key,customer_id,action,entity_id,result_json,created_at) VALUES (?,?,?,?,?,?)").bind(key,customerId,action,entityId,JSON.stringify(result),now).run();return{...result,duplicatePrevented:false};}
