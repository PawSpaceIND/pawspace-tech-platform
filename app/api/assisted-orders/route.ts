import { groomingCatalogue } from "../../../lib/grooming-governance";
import { generateCanonicalSalesQuote } from "../../../lib/sales-core-tools";
import { authError, database, requirePermission, resolveActor, securityAudit } from "../../../lib/server-auth";

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
const prior=await db.prepare("SELECT * FROM assisted_orders WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();if(prior)return json({data:{assistedOrderId:String(prior.id),bookingId:String(prior.booking_id||""),status:String(prior.status),duplicatePrevented:true,testOnly:true,liveMoney:false}});
  stage="customer_identity";
  const resolvedPhone=await resolveGovernedCustomerPhone(db,input.customer.id,input.customer.primaryPhone);
  if(!resolvedPhone.phone)throw new Response(resolvedPhone.source==="masked_request"
    ?`The phone number submitted for ${input.customer.id} is a masked display value, not a real number, and no real number is on file for that customer id. PawSpace refuses the order rather than writing the mask over the customer's phone number - reveal or correct the number on the customer record first.`
    :`No usable primary phone number could be resolved for ${input.customer.id}. Add the customer's phone number to the CRM record before converting this lead into a booking.`,{status:422});
  /* From here the request's customer identity carries the SERVER's phone number, never the browser's.
   * Everything downstream (including the canonical booking upsert) consumes this object unchanged. */
  input.customer={...input.customer,primaryPhone:resolvedPhone.phone};
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
  await securityAudit(db,actor,"assisted_order.create","booking",bookingId,"completed",{assistedOrderId,customerId:input.customer.id,packageCode:item.code,totalAmount:total,channel:"assisted_staff",testOnly:true,liveMoney:false});
  return json({data:{assistedOrderId,bookingId,customerId:input.customer.id,scheduleGroupId:groupId,provider,totalAmount:total,amountDueNow:0,status:"confirmed",duplicatePrevented:false,testOnly:true,liveMoney:false}},201);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,`Unable to create Assisted Order UAT - the request failed at the ${stage} step`);}}
