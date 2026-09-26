import { groomingCatalogue } from "../../../lib/grooming-governance";
import { generateCanonicalSalesQuote } from "../../../lib/sales-core-tools";
import { quoteGroomingBookingWithLiveMultiPet } from "../../../lib/live-grooming-governance";
import { quoteCoupon } from "../../../lib/coupon-governance";
import { couponsLiveApproved } from "../../../lib/ai-sales-offers";
import { ensureCustomerAccountTables, mutateCustomerAccount } from "../../../lib/customer-account";
import { authError, database, requireCustomerOwnership, requirePermission, resolveActor, securityAudit, type AuthenticatedActor } from "../../../lib/server-auth";

type PetInput={sourceId:string;canonicalId?:string;name:string;species?:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string};
type Input={
  idempotencyKey:string;
  customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
  pets:PetInput[];
  cityId:string;
  zoneId:string;
  /** Optional service address for a customer with none saved (a new CRM lead); the scheduler validates, geocodes and saves it. */
  serviceAddress?:string;
  servicePincode?:string;
  packageCode:string;
  scheduledStart:string;
  scheduledEnd:string;
  consent:{captured:boolean;method:"recorded_call"|"whatsapp"|"email"|"in_person";reference:string;note?:string};
  /** Optional governed coupon the customer asked for (e.g. GROOM200); the server quotes it on the assisted_staff channel. */
  couponCode?:string;
};
type Row=Record<string,unknown>;

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const staffRoles=new Set(["founder","superuser","admin","manager","associate"]);
const fixtureCustomers=[
  {id:"UAT-CUST-ASSIST-001",name:"Meera Shah",primaryPhone:"+919800000101",email:"meera.uat@pawspace.test",pets:[{sourceId:"UAT-PET-BRUNO",name:"Bruno",species:"dog" as const,breed:"Golden Retriever",vaccinationStatus:"verified"}]},
  {id:"UAT-CUST-ASSIST-002",name:"Rohan Rao",primaryPhone:"+919800000102",email:"rohan.uat@pawspace.test",pets:[{sourceId:"UAT-PET-OREO",name:"Oreo",species:"dog" as const,breed:"Indie",vaccinationStatus:"verified"}]},
  {id:"UAT-CUST-ASSIST-003",name:"Ananya Iyer",primaryPhone:"+919800000103",email:"ananya.uat@pawspace.test",pets:[{sourceId:"UAT-PET-MISTY",name:"Misty",species:"cat" as const,breed:"Domestic Shorthair",vaccinationStatus:"verified"}]},
];

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
  if(!response.ok)throw new Response(String(payload.error||`Internal ${path} request failed`),{status:response.status});
  return payload;
}
// Customer 360 serves the page masked contact details, so the order books the stored identity, never the browser's copy.
async function storedCustomer(db:Awaited<ReturnType<typeof database>>,submitted:Input["customer"]):Promise<Input["customer"]>{
  await db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
  const row=await db.prepare("SELECT name,primary_phone,secondary_phone,email FROM canonical_customers WHERE id=?").bind(submitted.id).first<Row>()??await db.prepare("SELECT name,primary_phone,secondary_phone,email FROM crm_contacts WHERE id=?").bind(submitted.id).first<Row>();
  return row?{id:submitted.id,name:String(row.name||submitted.name),primaryPhone:String(row.primary_phone??""),secondaryPhone:row.secondary_phone?String(row.secondary_phone):undefined,email:row.email?String(row.email):undefined}:submitted;
}
// Scheduling holds capacity only for saved pets owned by the customer, so each pet goes by its canonical_pets id. A canonical id
// passes through unchanged, so the scheduler still refuses another customer's pet. A pet with no saved record (a CRM lead's
// staff-confirmed pet) is saved to the customer's canonical profile first, through the customer-account pet upsert.
async function schedulingPetIds(db:Awaited<ReturnType<typeof database>>,actor:AuthenticatedActor,input:Input){
  const key=(value:unknown)=>String(value??"").trim().toLowerCase();
  const saved=(await db.prepare("SELECT id,source_pet_id FROM canonical_pets WHERE customer_id=?").bind(input.customer.id).all<Row>()).results;
  const ids=input.pets.map(pet=>pet.canonicalId?String(pet.canonicalId):saved.find(row=>key(row.source_pet_id)&&key(row.source_pet_id)===key(pet.sourceId))?.id);
  if(ids.every(Boolean))return ids.map(String);
  await requireCustomerOwnership(db,actor,input.customer.id);const now=Date.now();
  await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'assisted_staff','{}',?,?) ON CONFLICT(id) DO NOTHING").bind(input.customer.id,input.cityId||"blr",input.customer.name,input.customer.primaryPhone,input.customer.secondaryPhone??null,input.customer.email??null,now,now).run();
  for(const [index,pet] of input.pets.entries())if(!ids[index])ids[index]=String((await mutateCustomerAccount(db,{customerId:input.customer.id,action:"upsert_pet",idempotencyKey:`assisted:${input.idempotencyKey}:pet:${pet.sourceId}`,pet:{sourceId:pet.sourceId,name:pet.name,species:pet.species,breed:pet.breed,vaccinationStatus:pet.vaccinationStatus}}) as {entityId?:string}).entityId);
  return ids.map(String);
}
async function refusalText(response:Response){const text=await response.text();try{const body=JSON.parse(text) as {error?:unknown};if(typeof body?.error==="string")return body.error;}catch{/* plain-text refusal */}return text;}

export async function GET(request:Request){try{
  const actor=requirePermission(await resolveActor(request),"scheduling.book");if(!staffRoles.has(actor.roleCode))return json({error:"Assisted Orders is staff-only"},403);
  const packages=groomingCatalogue.filter(row=>row.active&&row.offerType!=="subscription").map(row=>({code:row.code,name:row.name,eligiblePetTypes:row.eligiblePetTypes,singlePrice:row.singlePrice,multiPetPrice:row.multiPetPrice??row.singlePrice,version:row.version}));
  return json({data:{environment:"UAT",testOnly:true,liveMoney:false,serviceCode:"grooming",customers:fixtureCustomers,packages}});
}catch(error){if(error instanceof Response)return error;return authError(error,"Unable to load Assisted Orders UAT");}}

export async function POST(request:Request){try{
  sameOrigin(request);const actor=requirePermission(await resolveActor(request),"scheduling.book");if(!staffRoles.has(actor.roleCode))return json({error:"Assisted Orders is staff-only"},403);
  const input=await request.json() as Input;if(!input.idempotencyKey||!input.customer?.id||!input.customer?.name||!input.customer?.primaryPhone||!input.packageCode||!input.scheduledStart||!input.scheduledEnd||!input.pets?.length)return json({error:"Complete customer, pet, package, schedule and request identity are required"},400);
  if(!input.consent?.captured||!input.consent.reference?.trim()||input.consent.reference.trim().length<5)return json({error:"Customer consent evidence is required before an assisted order can be created"},400);
  const db=await database();await ensureTable(db);const prior=await db.prepare("SELECT * FROM assisted_orders WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();if(prior)return json({data:{assistedOrderId:String(prior.id),bookingId:String(prior.booking_id||""),status:String(prior.status),duplicatePrevented:true,testOnly:true,liveMoney:false}});
  await ensureCustomerAccountTables(db);input.customer=await storedCustomer(db,input.customer);
  let quote:Awaited<ReturnType<typeof generateCanonicalSalesQuote>>;
  try{quote=await generateCanonicalSalesQuote(db,{packageCode:input.packageCode,petCount:input.pets.length,cityId:input.cityId||"blr"});}
  catch(error){if(error instanceof Error&&/GST policy/.test(error.message))return json({error:"Assisted booking needs a published GST setting for this city. Ask Finance to publish it in Team → Finance → GST setting.",code:"gst_policy_required"},409);throw error;}
  // The booking is governed at the live Pricing Control price (dynamic rules, multi-pet rows); the sales
  // quote above only proves a GST policy is published. Pricing from the list price made every booking 409.
  const governedQuote=await quoteGroomingBookingWithLiveMultiPet(db,{packageCode:input.packageCode,pets:input.pets.map(pet=>({species:pet.species})),paymentMode:"pay_after_service",cityId:input.cityId||"blr",zoneId:input.zoneId,scheduledStart:input.scheduledStart});
  const {item}=priceFor(input.packageCode,input.pets),total=governedQuote.totalAmount,groupId=`assist-${input.idempotencyKey}`;void quote;
  // A coupon is quoted before anything is reserved, so an ineligible code costs nothing and says why.
  const couponCode=String(input.couponCode||"").trim().toUpperCase();
  const coupon=couponCode?await quoteCoupon(db,{code:couponCode,customerId:input.customer.id,serviceCode:"grooming",cityId:input.cityId||"blr",channel:"assisted_staff",packageCode:item.code,orderValue:total,paymentMode:"after_service",isSubscription:false},{liveApproved:await couponsLiveApproved()}):null;
  if(coupon&&(!coupon.valid||!("quoteId"in coupon)||!coupon.quoteId))return json({error:`Coupon ${couponCode}: ${coupon.error||"not eligible for this order"}`},409);
  const discount=coupon&&"quoteId"in coupon?Number(coupon.discount):0,payable=total-discount;
  const petIds=await schedulingPetIds(db,actor,input);
  const schedulePayload=await internalPost(request,"/api/uat-scheduling",{clientRequestId:groupId,customerId:input.customer.id,petIds,serviceCode:"grooming",zoneId:input.zoneId,serviceAddress:input.serviceAddress,servicePincode:input.servicePincode,saveAddress:Boolean(input.serviceAddress?.trim()),scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,occurrences:1});
  const schedule=(schedulePayload.data||{}) as Record<string,unknown>,provider=schedule.provider as {id?:string;name?:string;model?:"full_time"|"commission"}|undefined;if(!provider?.id||!provider.name||!provider.model)throw new Response("Canonical scheduler did not return an assigned Grooming provider",{status:409});
  // The scheduler derives city and zone from the service address, and the booking must match what it reserved.
  const reserved=(schedule.addressAuthority||{}) as {cityId?:string;zoneId?:string};
  const bookingPayload=await internalPost(request,"/api/canonical-bookings",{idempotencyKey:`assisted:${input.idempotencyKey}`,scheduleGroupId:groupId,customer:input.customer,pets:input.pets,cityId:reserved.cityId||input.cityId||"blr",zoneId:reserved.zoneId||input.zoneId,serviceCode:"grooming",packageCode:item.code,packageName:item.name,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,provider,totalAmount:payable,amountDueNow:0,payment:{method:"payment_link",mode:"pay_after_service",status:"created",detail:"Assisted Orders UAT: payment is not captured; no live money"},pricing:{discount,...(coupon&&"quoteId"in coupon?{couponQuoteId:coupon.quoteId}:{}),requirements:["staff_assisted_order","consent_evidence","test_only"]}});
  const booking=(bookingPayload.data||{}) as Record<string,unknown>,bookingId=String(booking.bookingId||"");if(!bookingId)throw new Response("Canonical booking ID was not returned",{status:500});
  const now=Date.now(),assistedOrderId=`ASST-UAT-${crypto.randomUUID().slice(0,10).toUpperCase()}`;
  await db.batch([
    db.prepare("INSERT INTO assisted_orders (id,idempotency_key,booking_id,customer_id,service_code,package_code,staff_email,staff_role,consent_method,consent_reference,consent_note,status,test_only,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)").bind(assistedOrderId,input.idempotencyKey,bookingId,input.customer.id,"grooming",item.code,actor.email,actor.roleCode,input.consent.method,input.consent.reference.trim(),input.consent.note?.trim()||null,"confirmed",now,now),
    db.prepare("UPDATE canonical_bookings SET channel='assisted_staff',updated_at=? WHERE id=?").bind(now,bookingId),
    db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(`EVT-ASST-${crypto.randomUUID().slice(0,10).toUpperCase()}`,bookingId,"assisted_order_created","booking",bookingId,actor.email,JSON.stringify({assistedOrderId,consentMethod:input.consent.method,consentReference:input.consent.reference.trim(),testOnly:true,liveMoney:false}),now),
  ]);
  await securityAudit(db,actor,"assisted_order.create","booking",bookingId,"completed",{assistedOrderId,customerId:input.customer.id,packageCode:item.code,totalAmount:payable,couponCode:discount?couponCode:null,discount,channel:"assisted_staff",testOnly:true,liveMoney:false});
  return json({data:{assistedOrderId,bookingId,customerId:input.customer.id,scheduleGroupId:groupId,provider,totalAmount:payable,discount,couponCode:discount?couponCode:null,amountDueNow:0,status:"confirmed",duplicatePrevented:false,testOnly:true,liveMoney:false}},201);
}catch(error){if(error instanceof Response)return json({error:await refusalText(error)},error.status);return authError(error,"Unable to create Assisted Order UAT");}}
