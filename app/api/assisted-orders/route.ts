import { CANONICAL_PET_UPSERT, resolveCanonicalPets } from "../../../lib/canonical-pet-upsert";
import { convertLeadOnAssistedOrder } from "../../../lib/lead-conversion-attribution";
import { groomingCatalogue } from "../../../lib/grooming-governance";
import { generateCanonicalSalesQuote } from "../../../lib/sales-core-tools";
import { authError, database, requirePermission, resolveActor, securityAudit } from "../../../lib/server-auth";
import { ensureCanonicalBookingCoreTables } from "../../../lib/canonical-booking-core-schema";

type PetInput={sourceId:string;canonicalId?:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string};
type Input={
  idempotencyKey:string;
  customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
  pets:PetInput[];
  cityId:string;
  zoneId:string;
  packageCode:string;
  scheduledStart:string;
  scheduledEnd:string;
  consent:{captured:boolean;method:"recorded_call"|"whatsapp"|"email"|"in_person";reference:string;note?:string};
};
type Row=Record<string,unknown>;

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const staffRoles=new Set(["founder","superuser","admin","manager","associate"]);
const fixtureCustomers=[
  {id:"UAT-CUST-ASSIST-001",name:"Meera Shah",primaryPhone:"+919800000101",email:"meera.uat@pawspace.test",pets:[{sourceId:"UAT-PET-BRUNO",name:"Bruno",species:"dog" as const,breed:"Golden Retriever",vaccinationStatus:"verified"}]},
  {id:"UAT-CUST-ASSIST-002",name:"Rohan Rao",primaryPhone:"+919800000102",email:"rohan.uat@pawspace.test",pets:[{sourceId:"UAT-PET-OREO",name:"Oreo",species:"dog" as const,breed:"Indie",vaccinationStatus:"verified"}]},
  {id:"UAT-CUST-ASSIST-003",name:"Ananya Iyer",primaryPhone:"+919800000103",email:"ananya.uat@pawspace.test",pets:[{sourceId:"UAT-PET-MISTY",name:"Misty",species:"cat" as const,breed:"Domestic Shorthair",vaccinationStatus:"verified"}]},
];

/* Two catalogue rows can share a NAME and differ only in offerType: "Bath & Basic" is dog-basic at
 * Rs1,899 and young-basic at Rs999, "Complete Makeover" is dog-makeover at Rs2,399 and young-makeover
 * at Rs1,399, and young-* is eligible for BOTH dog and cat so both render side by side. A staff member
 * on a call picks by name, and the two names are identical, so the Rs900 difference is a coin flip.
 * The catalogue already knows which tier a row belongs to - it just was not published to the browser.
 * The tier travels with the package from here, so the screen labels it instead of guessing. */
function tierFor(offerType:"regular"|"young"|"subscription"){return offerType==="young"?"Puppy / kitten":"Adult";}

/* A MASKED display value is not a phone number. /api/customer-360 serves "+91 ••••••5678" to a staff
 * screen by policy, /assisted-booking used to keep that string in the customer object it submitted,
 * and /api/canonical-bookings upserts primary_phone=excluded.primary_phone - so a successful assisted
 * order would have overwritten the customer's real number with bullets. The browser's copy of a phone
 * number is therefore never data here: the real number is resolved server-side from the customer id,
 * and a masked value is refused rather than stored. */
const maskedValue=(value:string)=>/[\u2022*]/.test(value);
const plausiblePhone=(value:string)=>/^\+?[0-9][0-9\s-]{7,17}$/.test(value.trim());
async function resolveGovernedCustomerPhone(db:Awaited<ReturnType<typeof database>>,customerId:string,submitted:string){
  const fixture=fixtureCustomers.find(row=>row.id===customerId);
  if(fixture)return{phone:fixture.primaryPhone,source:"uat_fixture"};
  for(const [table,source] of [["canonical_customers","canonical_customer"],["crm_contacts","crm_contact"]] as const){
    const present=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<Row>();
    if(!present)continue;
    const row=await db.prepare(`SELECT primary_phone FROM ${table} WHERE id=?`).bind(customerId).first<Row>();
    const stored=String(row?.primary_phone||"").trim();
    if(stored&&!maskedValue(stored))return{phone:stored,source};
  }
  const offered=String(submitted||"").trim();
  if(offered&&!maskedValue(offered)&&plausiblePhone(offered))return{phone:offered,source:"request"};
  return{phone:"",source:offered?(maskedValue(offered)?"masked_request":"unusable_request"):"absent"};
}
/* AND THE NAME IS DATA TOO. [R3-C/F10]
 *
 * The phone was resolved server-side because a masked display value would have been written over the
 * customer's real number. The NAME travels in the same object, is masked by the same policy
 * (maskName in /api/customer-360), and /api/canonical-bookings upserts name=excluded.name - so it had
 * exactly the same fate and nobody had noticed. MEASURED on the live UAT database after a staff
 * conversion: GET /api/customer-account for the signed-in customer's OWN record returned
 * {"name":"R•• C• C•","primaryPhone":"9811100144"} - their own phone number in full, beside a name
 * that had been REPLACED IN STORAGE by a screen's masking. That is not a masked read; it is a
 * destroyed record, and it is destroyed for every reader including the customer.
 *
 * Same rule as the phone: the server resolves the real name from the customer id, and a masked value
 * is refused rather than stored. */
async function resolveGovernedCustomerName(db:Awaited<ReturnType<typeof database>>,customerId:string,submitted:string){
  const fixture=fixtureCustomers.find(row=>row.id===customerId);
  if(fixture)return{name:fixture.name,source:"uat_fixture"};
  for(const [table,source] of [["canonical_customers","canonical_customer"],["crm_contacts","crm_contact"]] as const){
    const present=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<Row>();
    if(!present)continue;
    const row=await db.prepare(`SELECT name FROM ${table} WHERE id=?`).bind(customerId).first<Row>();
    const stored=String(row?.name||"").trim();
    if(stored&&!maskedValue(stored))return{name:stored,source};
  }
  const offered=String(submitted||"").trim();
  if(offered&&!maskedValue(offered))return{name:offered,source:"request"};
  return{name:"",source:offered?"masked_request":"absent"};
}
/* THE SCHEDULER LOOKS UP canonical_pets.id; THIS ROUTE WAS SENDING source_pet_id.
 * /api/uat-scheduling validates ownership with `SELECT customer_id,species FROM canonical_pets WHERE
 * id=?`, and this route mapped `p.sourceId` - the pet's SOURCE identity, "bruno" - into petIds. Every
 * CRM customer whose pets came from Customer 360 therefore failed ownership on a pet they own: the
 * scheduler answered 403 "Pet ownership denied" for a real pet with a real canonical row. The page
 * already carries the canonical id alongside the source id (and app/assisted-booking's Taxi panel
 * already prefers it, `p.canonicalId||p.sourceId`); this is that same preference, applied to the one
 * field the scheduler actually resolves. sourceId is still what travels to the canonical booking,
 * which stores both. */
const canonicalPetId=(pet:PetInput)=>String(pet.canonicalId||"").trim()||pet.sourceId;

/*
 * A CRM LEAD HAS NO canonical_pets ROW, AND THE SCHEDULER RESOLVES OWNERSHIP AGAINST THAT TABLE.
 *
 * MEASURED: /crm -> "Add lead" with a pet -> "Book this customer" -> the screen asks the operator to
 * "Confirm the missing pet species" (the lead's pet is only a NAME in crm_contacts.pet_names) ->
 * "Create" -> 403 "Pet ownership denied". The same 403 on /assisted-booking's OWN fixture customer
 * Meera Shah / Bruno, and on all three UAT fixtures, because none of them has a canonical_pets row
 * either. Conversion worked only for customers who already had one - app sign-up or CSV ingest - so
 * the entire CRM-to-booking path, and the demo path, were dead.
 *
 * Two things were wrong and both are fixed here:
 *
 *  1. THE RECORD DID NOT EXIST YET. The operator supplied exactly what the screen asked for, so the
 *     platform creates the pet it was told about: one canonical_pets row, owned by this customer,
 *     written through lib/canonical-pet-upsert - the SAME resolver /api/canonical-bookings uses, so a
 *     pet the customer already has is REUSED rather than duplicated, and the row this mints is the row
 *     the booking a moment later binds to.
 *
 *  2. THE REFUSAL BLAMED THE OPERATOR. "Pet ownership denied" means "this animal belongs to somebody
 *     else". A record that simply does not exist is a different fact and now reads as one - and a pet
 *     that really is another customer's is refused HERE, by name, before any provider is held.
 *
 * A canonicalId the screen already carries stays authoritative (that preference is what made the
 * scheduler resolve Customer 360 pets correctly in the first place); what is new is that the row it
 * names is guaranteed to exist and to belong to this customer before the scheduler is asked.
 */
const CANONICAL_PETS_DDL="CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
async function ensureCanonicalPetsOwned(db:Awaited<ReturnType<typeof database>>,customerId:string,pets:PetInput[]):Promise<PetInput[]>{
  await db.prepare(CANONICAL_PETS_DDL).run();
  const resolution=await resolveCanonicalPets(db,customerId,pets.map(pet=>({sourceId:pet.sourceId,name:pet.name,species:pet.species,breed:pet.breed,vaccinationStatus:pet.vaccinationStatus})));
  if(!resolution.ok)throw new Response(resolution.error,{status:resolution.status});
  const now=Date.now();const out:PetInput[]=[];
  for(let index=0;index<pets.length;index++){
    const pet=pets[index],resolved=resolution.pets[index];
    const id=String(pet.canonicalId||"").trim()||resolved.id;
    const owner=await db.prepare("SELECT customer_id FROM canonical_pets WHERE id=?").bind(id).first<Row>();
    if(owner&&String(owner.customer_id)!==customerId)throw new Response(`${resolved.name} (${id}) is registered to a different customer, so this booking cannot be created for ${customerId}. Pick the pet from this customer's own profile, or add it to their record first.`,{status:403});
    if(!owner)await db.prepare(CANONICAL_PET_UPSERT).bind(id,customerId,resolved.name,resolved.species,resolved.breed,resolved.vaccinationStatus,resolved.sourceId,now,now).run();
    out.push({...pet,canonicalId:id});
  }
  return out;
}
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin assisted order blocked",{status:403});}
function priceFor(packageCode:string,pets:PetInput[]){
  const item=groomingCatalogue.find(row=>row.active&&row.offerType!=="subscription"&&row.code===packageCode);
  if(!item)throw new Response("Only active single-service Grooming packages are supported in Assisted Orders UAT",{status:409});
  if(pets.length<1||pets.length>4)throw new Response("Assisted Orders UAT supports 1-4 pets",{status:400});
  for(const pet of pets)if(!item.eligiblePetTypes.includes(pet.species??"other"))throw new Response(`${item.name} is not eligible for ${pet.species??"other"}`,{status:409});
  const total=pets.length===1?item.singlePrice:(item.multiPetPrice??item.singlePrice)*pets.length;
  return {item,total};
}
async function ensureTable(db:Awaited<ReturnType<typeof database>>){await db.prepare("CREATE TABLE IF NOT EXISTS assisted_orders (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,booking_id TEXT UNIQUE,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,staff_email TEXT NOT NULL,staff_role TEXT NOT NULL,consent_method TEXT NOT NULL,consent_reference TEXT NOT NULL,consent_note TEXT,status TEXT NOT NULL,test_only INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();}
async function internalPost(request:Request,path:string,body:unknown){
  const target=new URL(path,request.url);
  const headers=new Headers();headers.set("content-type","application/json");
  for(const key of ["oai-authenticated-user-email","oai-authenticated-user-full-name","oai-authenticated-user-full-name-encoding","cookie","authorization"]) {const value=request.headers.get(key);if(value)headers.set(key,value);}
  const response=await fetch(target,{method:"POST",headers,body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok)throw new Response(`${path} refused this assisted order: ${String(payload.error||payload.message||`no reason was returned (HTTP ${response.status})`)}`,{status:response.status});
  return payload;
}

export async function GET(request:Request){try{
  const actor=requirePermission(await resolveActor(request),"scheduling.book");if(!staffRoles.has(actor.roleCode))return json({error:"Assisted Orders is staff-only"},403);
  const packages=groomingCatalogue.filter(row=>row.active&&row.offerType!=="subscription").map(row=>({code:row.code,name:row.name,offerType:row.offerType,tier:tierFor(row.offerType),eligiblePetTypes:row.eligiblePetTypes,singlePrice:row.singlePrice,multiPetPrice:row.multiPetPrice??row.singlePrice,version:row.version}));
  return json({data:{environment:"UAT",testOnly:true,liveMoney:false,serviceCode:"grooming",customers:fixtureCustomers,packages}});
}catch(error){if(error instanceof Response)return error;return authError(error,"Unable to load Assisted Orders UAT");}}

export async function POST(request:Request){let stage="request";try{
  sameOrigin(request);const actor=requirePermission(await resolveActor(request),"scheduling.book");if(!staffRoles.has(actor.roleCode))return json({error:"Assisted Orders is staff-only"},403);
  const input=await request.json() as Input;if(!input.idempotencyKey||!input.customer?.id||!input.customer?.name||!input.packageCode||!input.scheduledStart||!input.scheduledEnd||!input.pets?.length)return json({error:"Complete customer, pet, package, schedule and request identity are required"},400);
  if(!input.consent?.captured||!input.consent.reference?.trim()||input.consent.reference.trim().length<5)return json({error:"Customer consent evidence is required before an assisted order can be created"},400);
  const db=await database();await ensureTable(db);
/* THE REPLAY USED TO ANSWER WITH FOUR FIELDS, AND THE SCREEN RENDERED result.provider.name
 * UNCONDITIONALLY -> TypeError -> the React error boundary replaced /assisted-booking with "This page
 * didn't load", so the operator was never told the booking already existed. The screen is fixed too,
 * but a replay that cannot describe the order it is replaying is the reason it could be: the existing
 * booking's provider and governed total are read back here so the duplicate answer carries the SAME
 * shape as the original. */
const prior=await db.prepare("SELECT * FROM assisted_orders WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
if(prior){
  const priorBookingId=String(prior.booking_id||"");
  if(priorBookingId)await ensureCanonicalBookingCoreTables(db);
  const priorBooking=priorBookingId?await db.prepare("SELECT provider_id,total_amount,schedule_group_id FROM canonical_bookings WHERE id=?").bind(priorBookingId).first<Row>().catch(()=>null):null;
  // The work order stores the provider name and model as they were assigned to THIS booking, so the
  // replay describes the order that exists rather than the provider roster as it stands today.
  const priorProvider=priorBookingId?await db.prepare("SELECT provider_id,provider_name,provider_model FROM provider_work_orders WHERE booking_id=? ORDER BY created_at LIMIT 1").bind(priorBookingId).first<Row>().catch(()=>null):null;
  return json({data:{assistedOrderId:String(prior.id),bookingId:priorBookingId,customerId:String(prior.customer_id||""),scheduleGroupId:priorBooking?.schedule_group_id?String(priorBooking.schedule_group_id):null,
    provider:priorProvider?{id:String(priorProvider.provider_id),name:String(priorProvider.provider_name||priorProvider.provider_id),model:String(priorProvider.provider_model||"")}:priorBooking?.provider_id?{id:String(priorBooking.provider_id),name:String(priorBooking.provider_id),model:""}:null,
    totalAmount:priorBooking?Number(priorBooking.total_amount||0):null,amountDueNow:0,status:String(prior.status),duplicatePrevented:true,testOnly:true,liveMoney:false}});
}
  stage="customer_identity";
  const resolvedPhone=await resolveGovernedCustomerPhone(db,input.customer.id,input.customer.primaryPhone);
  if(!resolvedPhone.phone)throw new Response(resolvedPhone.source==="masked_request"
    ?`The phone number submitted for ${input.customer.id} is a masked display value, not a real number, and no real number is on file for that customer id. PawSpace refuses the order rather than writing the mask over the customer's phone number - reveal or correct the number on the customer record first.`
    :`No usable primary phone number could be resolved for ${input.customer.id}. Add the customer's phone number to the CRM record before converting this lead into a booking.`,{status:422});
  /* From here the request's customer identity carries the SERVER's phone number, never the browser's.
   * Everything downstream (including the canonical booking upsert) consumes this object unchanged. */
  const resolvedName=await resolveGovernedCustomerName(db,input.customer.id,input.customer.name);
  if(!resolvedName.name)throw new Response(`The customer name submitted for ${input.customer.id} is a masked display value, not a real name, and no real name is on file for that customer id. PawSpace refuses the order rather than writing the mask over the customer's name - reveal or correct the name on the customer record first.`,{status:422});
  input.customer={...input.customer,name:resolvedName.name,primaryPhone:resolvedPhone.phone};
  stage="pricing";
  const cityId=input.cityId||"blr",{item}=priceFor(input.packageCode,input.pets),groupId=`assist-${input.idempotencyKey}`;
  /* generateCanonicalSalesQuote fails CLOSED on a governed precondition - there is no published GST
   * policy for this city, the catalogue pricing is invalid, the pet count is out of range - and it
   * signals with a plain Error. authError treats a plain Error as an unexpected server fault, so every
   * one of those refusals reached the operator as `500 {"error":"Unable to create Assisted Order UAT"}`
   * with the actual reason only in the server log. Measured on the UAT database: grooming_tax_policies
   * did not exist at all, so EVERY assisted order - CRM conversion and fixture path alike - 500'd here
   * before the scheduler was ever called. Fail closed, but say what is missing and who fixes it. */
  let quote:Awaited<ReturnType<typeof generateCanonicalSalesQuote>>;
  try{quote=await generateCanonicalSalesQuote(db,{packageCode:input.packageCode,petCount:input.pets.length,cityId});}
  catch(error){throw new Response(`${error instanceof Error?error.message:"The governed price for this package could not be computed"} (city ${cityId}, package ${item.code}). An assisted order cannot be created until the governed Grooming price for this city can be computed - publish the city GST policy through Grooming finance (save_tax_policy) first.`,{status:409});}
  const total=quote.totalAmount;
  stage="pet_identity";
  /* Before any provider is held: the pets this order names exist as canonical rows owned by THIS
   * customer. A CRM lead's confirmed pet becomes a real pet here, which is what the scheduler, the
   * canonical booking and Customer 360 all read afterwards. */
  input.pets=await ensureCanonicalPetsOwned(db,input.customer.id,input.pets);
  stage="scheduling";
  const schedulePayload=await internalPost(request,"/api/uat-scheduling",{clientRequestId:groupId,customerId:input.customer.id,petIds:input.pets.map(p=>canonicalPetId(p)),serviceCode:"grooming",zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,occurrences:1});
  const schedule=(schedulePayload.data||{}) as Record<string,unknown>,provider=schedule.provider as {id?:string;name?:string;model?:"full_time"|"commission"}|undefined;if(!provider?.id||!provider.name||!provider.model)throw new Response("Canonical scheduler did not return an assigned Grooming provider",{status:409});
  stage="canonical_booking";
  const bookingPayload=await internalPost(request,"/api/canonical-bookings",{idempotencyKey:`assisted:${input.idempotencyKey}`,scheduleGroupId:groupId,customer:input.customer,pets:input.pets,cityId:input.cityId||"blr",zoneId:input.zoneId,serviceCode:"grooming",packageCode:item.code,packageName:item.name,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,provider,totalAmount:total,amountDueNow:0,payment:{method:"payment_link",mode:"pay_after_service",status:"created",detail:"Assisted Orders UAT: payment is not captured; no live money"},pricing:{discount:0,requirements:["staff_assisted_order","consent_evidence","test_only"]}});
  const booking=(bookingPayload.data||{}) as Record<string,unknown>,bookingId=String(booking.bookingId||"");if(!bookingId)throw new Response("Canonical booking ID was not returned",{status:500});
  stage="persist";
  const now=Date.now(),assistedOrderId=`ASST-UAT-${crypto.randomUUID().slice(0,10).toUpperCase()}`;
  await db.batch([
    db.prepare("INSERT INTO assisted_orders (id,idempotency_key,booking_id,customer_id,service_code,package_code,staff_email,staff_role,consent_method,consent_reference,consent_note,status,test_only,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)").bind(assistedOrderId,input.idempotencyKey,bookingId,input.customer.id,"grooming",item.code,actor.email,actor.roleCode,input.consent.method,input.consent.reference.trim(),input.consent.note?.trim()||null,"confirmed",now,now),
    db.prepare("UPDATE canonical_bookings SET channel='assisted_staff',updated_at=? WHERE id=?").bind(now,bookingId),
    db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(`EVT-ASST-${crypto.randomUUID().slice(0,10).toUpperCase()}`,bookingId,"assisted_order_created","booking",bookingId,actor.email,JSON.stringify({assistedOrderId,consentMethod:input.consent.method,consentReference:input.consent.reference.trim(),testOnly:true,liveMoney:false}),now),
  ]);
  /* THE LEAD IS THE OTHER HALF OF THE CONVERSION. Without this the customer showed the booking's
   * lifetime value while their lead card still read ACTIVE, and the sales team kept chasing somebody
   * who had already booked. Never fatal: the booking exists and is confirmed, so a failure to close the
   * lead is reported in the response and the audit rather than thrown over a completed order. */
  stage="lead_closure";
  const leadClosure=await convertLeadOnAssistedOrder(db,{customerId:input.customer.id,bookingId,actorId:actor.email}).catch(error=>({leadId:null,converted:false,reason:error instanceof Error?error.message:"lead_closure_failed"}));
  /* created_by was the CUSTOMER id on every booking, including one a staff member created on a call:
   * /api/canonical-bookings binds input.customer.id there for every caller. "Who created this booking"
   * is the whole point of channel='assisted_staff', and the two columns contradicted each other - the
   * ledger said the customer booked themselves. Corrected outside the batch and tolerantly, because a
   * confirmed booking must not be failed over an attribution column; whether it landed is recorded in
   * the audit rather than assumed. [R3-C/F10] */
  const attributed=await db.prepare("UPDATE canonical_bookings SET created_by=?,updated_at=? WHERE id=?").bind(actor.email,now,bookingId).run().then(result=>Number(result.meta?.changes||0)>0).catch(()=>false);
  await securityAudit(db,actor,"assisted_order.create","booking",bookingId,"completed",{assistedOrderId,createdBy:actor.email,createdByRecorded:attributed,customerId:input.customer.id,packageCode:item.code,totalAmount:total,channel:"assisted_staff",testOnly:true,liveMoney:false,leadId:leadClosure.leadId,leadConverted:leadClosure.converted,leadClosureReason:leadClosure.reason});
  return json({data:{assistedOrderId,bookingId,customerId:input.customer.id,scheduleGroupId:groupId,provider,totalAmount:total,amountDueNow:0,status:"confirmed",duplicatePrevented:false,lead:leadClosure,testOnly:true,liveMoney:false}},201);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,`Unable to create Assisted Order UAT - the request failed at the ${stage} step`);}}
