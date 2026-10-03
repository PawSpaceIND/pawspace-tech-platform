import{prepareAiToolExecution,confirmAiToolExecution,type AiToolChannel,type AiToolCode,type AiToolIntent}from"./ai-tool-registry";
import{buildCustomer360}from"./customer-360";
import{requestAiHumanHandoff,type AiHandoffReason}from"./ai-human-handoff";
import{cancelVoiceCall,ensureVoiceCallTables,recordVoiceConsent,requestOutboundVoiceCall,VOICE_USE_CASES,type VoiceUseCaseDefinition}from"./voice-outbound-canonical";
import{resolveCanonicalRecipientOwnership}from"./canonical-recipient-ownership";
import{requireCustomerOwnership,type AuthenticatedActor}from"./server-auth";
import{canVoiceCallTransition,isVoiceCallState}from"./voice-call-state";
import{cityBookingVerdict}from"./city-status-authority";
import{ensureCallbackContextSchema,reserveCallbackContext}from"./customer-callback-context";

type Row=Record<string,unknown>;
type Env=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const digits=(value:unknown)=>text(value).replace(/\D/g,"");

export const CALLBACK_PHRASES=["call me","please call","give me a call","call back","callback","phone me"] as const;
export const CUSTOMER_REQUESTED_CALLBACK_USE_CASE="customer_requested_callback" as const;
const CUSTOMER_CALLBACK_DEFINITION:VoiceUseCaseDefinition={code:CUSTOMER_REQUESTED_CALLBACK_USE_CASE,label:"Customer explicitly requested an AI callback",purpose:"transactional",requiresBooking:false,requiresSalesApproval:false,maxAttempts:2};
export function ensureCustomerRequestedCallbackUseCase(){
 const existing=VOICE_USE_CASES.find(item=>item.code===CUSTOMER_REQUESTED_CALLBACK_USE_CASE);
 if(existing)return existing;
 VOICE_USE_CASES.push(CUSTOMER_CALLBACK_DEFINITION);
 return CUSTOMER_CALLBACK_DEFINITION;
}
export function isCustomerCallbackRequest(message:string){
 const value=text(message).toLowerCase().replace(/[’‘]/g,"'");
 // A refusal, cancellation or complaint about a missed call is not permission to call now.
 if(/\b(?:don't|dont|do not|never|stop|cancel|didn't|didnt|did not)\b.{0,40}\b(?:call|calling|phone|callback)\b/.test(value))return false;
 if(/\bno\s+(?:more\s+|need to\s+)?(?:calls?|calling|phone|callback)\b/.test(value))return false;
 return CALLBACK_PHRASES.some(phrase=>value.includes(phrase));
}

const CALLBACK_CONTEXT_LIMIT=120;
const IMMEDIATE_REQUEST_WINDOW_MS=60_000;
export const UNSUPPORTED_SCHEDULING_NOTICE="Scheduling is not available.";
function callbackContextValue(value:unknown){const raw=text(value);return raw?raw.slice(0,CALLBACK_CONTEXT_LIMIT):null;}
type RequestedStartDecision={ok:true;when:"immediate"}|{ok:true;when:"future";value:string}|{ok:false};
/** A full calendar date: DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY. Not a callback timestamp. */
function calendarBookingDate(raw:string):{day:number;month:number;year:number}|null{
 const match=raw.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);if(!match)return null;
 const day=Number(match[1]),month=Number(match[2]),year=Number(match[3]);
 const date=new Date(Date.UTC(year,month-1,day));
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
 return{day,month,year};
}
function canonicalServiceDate(value:unknown):string|null{
 const raw=text(value);if(!raw)return null;
 const parsed=calendarBookingDate(raw);if(!parsed)return null;
 return`${String(parsed.day).padStart(2,"0")}/${String(parsed.month).padStart(2,"0")}/${parsed.year}`;
}
/** Absent, blank, the word now, or a timestamp within one minute is an immediate callback. Later than that is a future request and is not a schedule. A past or unparseable value is invalid. */
function canonicalRequestedStart(value:unknown,asOf:number):RequestedStartDecision{
 if(value==null)return{ok:true,when:"immediate"};
 let parsed:number;
 if(typeof value==="number"){if(!Number.isFinite(value))return{ok:false};parsed=value;}
 else{
  const raw=text(value);if(!raw)return{ok:true,when:"immediate"};
  if(/^now$/i.test(raw))return{ok:true,when:"immediate"};
  const calendar=calendarBookingDate(raw);
  if(calendar){
   const start=Date.UTC(calendar.year,calendar.month-1,calendar.day);
   const today=new Date(asOf),todayStart=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());
   if(start<todayStart)return{ok:false};
   return{ok:true,when:"future",value:`${String(calendar.day).padStart(2,"0")}/${String(calendar.month).padStart(2,"0")}/${calendar.year}`};
  }

  if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw))return{ok:false};
  const [year,month,day]=raw.slice(0,10).split("-").map(Number),date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return{ok:false};
  parsed=Date.parse(raw);if(!Number.isFinite(parsed))return{ok:false};
 }
 if(parsed+1000<asOf)return{ok:false};
 if(parsed<=asOf+IMMEDIATE_REQUEST_WINDOW_MS)return{ok:true,when:"immediate"};
 return{ok:true,when:"future",value:new Date(parsed).toISOString()};
}
/**
 * Launch coverage is lib/city-governance.ts serviceAlias / CityLaunchService only:
 * grooming, training, boarding, sitting, pet_sitting, "pet sitting"
 * map to Grooming, Training, Boarding, Pet Sitting.
 * Unsupported on city_launch_configs (not in that alias): dog_training, dog_walking, pet_taxi, vet_consult, fresh_food, food, relocation.
 * Catalogue coverage is lib/catalogue-governance.ts SERVICES:
 * grooming, dog_training, boarding, pet_sitting, dog_walking, pet_taxi, vet_consult.
 * dog_walking is the walking code and is catalogue-supported when a row exists. It is not a launch service.
 * fresh_food, food and relocation are in neither list. No name is rejected before the lookup.
 */
const LAUNCH_SERVICE_ALIAS:Record<string,string>={grooming:"Grooming",training:"Training",boarding:"Boarding",sitting:"Pet Sitting",pet_sitting:"Pet Sitting","pet sitting":"Pet Sitting"};
// Catalogue training still needs catalogue eligibility, but cannot override its launch-service denial.
const LAUNCH_DENIAL_ALIAS:Record<string,string>={...LAUNCH_SERVICE_ALIAS,dog_training:"Training"};
/** Statuses written onto canonical_bookings other than cancelled and completed. refunded stays excluded. */
const CALLBACK_ACTIVE_BOOKING_STATUSES=["confirmed","assigned","in_progress","reassignment_needed"] as const;
function callbackSchemaMessage(error:unknown){return error instanceof Error?error.message:String(error??"");}
/** Pet ownership. Database errors propagate before dispatch. */
async function assertCallbackPet(db:D1Database,customerId:string,petId:string|null){
 if(!petId)return;
 const pet=await db.prepare("SELECT customer_id FROM canonical_pets WHERE id=?").bind(petId).first<{customer_id?:string}>();
 if(!pet)throw new Response("Pet was not found for this customer",{status:404});
 if(text(pet.customer_id)!==customerId)throw new Response("Pet ownership denied",{status:403});
}
/** enabled:false is a hard denial. Invalid services_json throws. A missing launch table is not an allowance and is not a denial by itself. */
async function launchServiceExplicitlyDisabled(db:D1Database,cityId:string,serviceCode:string|null){
 if(!serviceCode)return false;
 const alias=LAUNCH_DENIAL_ALIAS[serviceCode.toLowerCase()];
 if(!alias)return false;
 let row:{services_json?:string}|null=null;
 try{row=await db.prepare("SELECT services_json FROM city_launch_configs WHERE lower(city_code)=? LIMIT 1").bind(cityId).first<{services_json?:string}>();}
 catch(error){
  if(error instanceof Response)throw error;
  const message=callbackSchemaMessage(error);
  if(/no such table/i.test(message))return false;
  throw error;
 }
 if(!row)return false;
 const services=JSON.parse(text(row.services_json)||"{}") as Record<string,{enabled?:boolean}>;
 return Object.prototype.hasOwnProperty.call(services,alias)&&services[alias]?.enabled===false;
}
/** New work: Live+enabled launch service, otherwise an active catalogue row. Explicitly disabled never falls through. JSON and non-table database errors throw. */
async function assertCallbackServiceConfigured(db:D1Database,cityId:string,serviceCode:string){
 const city=text(cityId).toLowerCase();
 if(!city)throw new Response("Service is not configured for this customer",{status:409});
 if(await launchServiceExplicitlyDisabled(db,city,serviceCode))throw new Response("Service is not configured for this customer",{status:409});
 const alias=LAUNCH_SERVICE_ALIAS[serviceCode.toLowerCase()];
 if(alias){
  try{
   const row=await db.prepare("SELECT status,services_json FROM city_launch_configs WHERE lower(city_code)=? LIMIT 1").bind(city).first<{status?:string;services_json?:string}>();
   if(row&&["Live","Active"].includes(text(row.status))){
    const services=JSON.parse(text(row.services_json)||"{}") as Record<string,{enabled?:boolean}>;
    if(services[alias]?.enabled===true)return;
   }
  }catch(error){
   if(error instanceof Response||error instanceof SyntaxError)throw error;
   const message=callbackSchemaMessage(error);
   if(!/no such table/i.test(message))throw error;
  }
 }
 try{
  const configured=await db.prepare("SELECT id FROM catalogue_packages WHERE lower(service_code)=? AND active=1 AND (lower(city_id)=? OR upper(city_id)='ALL') LIMIT 1").bind(serviceCode.toLowerCase(),city).first<{id?:string}>();
  if(configured?.id)return;
 }catch(error){
  if(error instanceof Response)throw error;
  const message=callbackSchemaMessage(error);
  if(/no such table/i.test(message))throw new Response("Service is not configured for this customer",{status:409});
  throw error;
 }
 throw new Response("Service is not configured for this customer",{status:409});
}
async function loadActiveCallbackBooking(db:D1Database,customerId:string,bookingId:string){
 const row=await db.prepare("SELECT id,customer_id,city_id,service_code,status FROM canonical_bookings WHERE id=?").bind(bookingId).first<{id?:string;customer_id?:string;city_id?:string;service_code?:string;status?:string}>();
 if(!row)throw new Response("Booking was not found for this customer",{status:404});
 if(text(row.customer_id)!==customerId)throw new Response("Booking ownership denied",{status:403});
 const status=text(row.status).toLowerCase();
 if(!(CALLBACK_ACTIVE_BOOKING_STATUSES as readonly string[]).includes(status))throw new Response("Booking is not an active callback context",{status:409});
 return row;
}
async function resolveCallbackDestination(db:D1Database,customerId:string,canonicalCity:string,input:{cityId?:string|null;bookingId?:string|null;serviceCode:string|null}){
 let serviceCode=input.serviceCode;
 const suppliedCity=text(input.cityId).toLowerCase();
 let cityId=suppliedCity||canonicalCity;
 const bookingId=input.bookingId||null;
 if(bookingId){
  const booking=await loadActiveCallbackBooking(db,customerId,bookingId);
  const bookingCity=text(booking.city_id).toLowerCase();
  if(suppliedCity&&suppliedCity!==bookingCity)throw new Response("Destination city is not the active booking city",{status:409});
  if(serviceCode&&serviceCode.toLowerCase()!==text(booking.service_code).toLowerCase())throw new Response("Service is not the active booking service",{status:409});
  cityId=bookingCity;serviceCode=serviceCode||callbackContextValue(booking.service_code);
 }
 if(!cityId)throw new Response("A customer city is required before an AI callback can be requested",{status:409});
 const verdict=await cityBookingVerdict(db,{cityId,serviceCode,channel:"customer_app"});
 if(bookingId){
  if(verdict.existingWorkHandling!=="continue")throw new Response("Booking requires an audited city operation",{status:409});
  if(await launchServiceExplicitlyDisabled(db,cityId,serviceCode))throw new Response("Service is not configured for this customer",{status:409});
 }else{
  if(!verdict.allowed||suppliedCity&&suppliedCity!==canonicalCity&&!serviceCode)throw new Response("Service is not configured for this customer",{status:409});
  if(serviceCode)await assertCallbackServiceConfigured(db,cityId,serviceCode);
 }
 return{cityId,bookingId,serviceCode};
}
type CallbackOwner={customerId:string;idempotencyKey:string;phoneKey:string};
function assertCallbackCallOwner(call:Row|null,owner:CallbackOwner){
 if(!call||text(call.customer_id)!==owner.customerId||text(call.idempotency_key)!==owner.idempotencyKey||text(call.use_case)!==CUSTOMER_REQUESTED_CALLBACK_USE_CASE||text(call.phone_key)!==owner.phoneKey)throw new Response("Callback ownership denied",{status:403});
}
async function assertStoredCallbackOwner(db:D1Database,callId:string,owner:CallbackOwner){
 const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_callback_request_context'").first<Row>();
 if(!table)return;
 const stored=await db.prepare("SELECT customer_id,idempotency_key FROM ai_callback_request_context WHERE call_id=?").bind(callId).first<Row>();
 if(stored&&(text(stored.customer_id)!==owner.customerId||text(stored.idempotency_key)!==owner.idempotencyKey))throw new Response("Callback context ownership denied",{status:403});
}
async function callbackIdempotencyKey(db:D1Database,customerId:string,requestKey:string,phoneKey:string){
 // A JSON tuple keeps arbitrary customer/request strings unambiguous. Preserve an owned legacy replay.
 const scoped=`ai-callback:v2:${JSON.stringify([customerId,requestKey])}`;
 await ensureVoiceCallTables(db);
 const scopedCall=await db.prepare("SELECT id,customer_id,idempotency_key,use_case,phone_key FROM voice_call_orders WHERE idempotency_key=?").bind(scoped).first<Row>();
 const legacy=`ai-callback:${requestKey}`;
 const prior=scopedCall||await db.prepare("SELECT id,customer_id,idempotency_key,use_case,phone_key FROM voice_call_orders WHERE idempotency_key=?").bind(legacy).first<Row>();
 const key=scopedCall?scoped:prior&&text(prior.customer_id)===customerId?legacy:scoped;
 if(prior&&(scopedCall||text(prior.customer_id)===customerId)){
  const owner={customerId,idempotencyKey:key,phoneKey};
  assertCallbackCallOwner(prior,owner);
  await assertStoredCallbackOwner(db,text(prior.id),owner);
 }
 return key;
}
async function readCallbackContext(db:D1Database,callId:string,owner:CallbackOwner){
 const call=await db.prepare("SELECT id,customer_id,idempotency_key,use_case,phone_key,city_id,booking_id FROM voice_call_orders WHERE id=?").bind(callId).first<Row>();
 assertCallbackCallOwner(call,owner);
 const stored=await db.prepare("SELECT * FROM ai_callback_request_context WHERE call_id=?").bind(callId).first<Row>();
 if(!stored||text(stored.customer_id)!==owner.customerId||text(stored.idempotency_key)!==owner.idempotencyKey)throw new Response("Callback context ownership denied",{status:403});
 return{requestedStart:stored.requested_start as string|null,petId:stored.pet_id as string|null,serviceCode:stored.service_code as string|null,leadId:stored.lead_id as string|null,serviceDate:stored.service_date as string|null,cityId:text(stored.city_id)||text(call?.city_id),bookingId:(stored.booking_id??call?.booking_id??null) as string|null};
}

export async function requestGovernedCustomerCallback(db:D1Database,env:Env,input:{actor:AuthenticatedActor;customerId:string;message:string;idempotencyKey:string;cityId?:string;requestedStart?:string|number|null;serviceDate?:string|null;bookingId?:string|null;petId?:string|null;serviceCode?:string|null;leadId?:string|null}){
 await requireCustomerOwnership(db,input.actor,input.customerId);
 if(!isCustomerCallbackRequest(input.message))return{matched:false as const};
 // Invalid schedule stops before consent and before requestOutboundVoiceCall. A future requestedStart
 // is not scheduled: the canonical scheduler is not allocated, so it returns before consent and dial.
 const now=Date.now();
 let schedule=canonicalRequestedStart(input.requestedStart,now);
 if(!schedule.ok)throw new Response("requestedStart is not a valid schedule",{status:400});
 // These explicit timing requests cannot silently become immediate calls when the UI omitted a timestamp.
 const explicitTiming=/\b(?:call(?: me)?(?: back)?|phone me|callback)\s+(?:tomorrow|later|tonight|next\b|this\s+(?:morning|afternoon|evening)|on\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d)|(?:at|after|before)\s+(?:\d|noon|midnight|lunch|dinner|work)|in\s+(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a few)\s*(?:mins?|minutes?|hrs?|hours?|days?))/i;
 if(explicitTiming.test(input.message))schedule={ok:true,when:"future",value:text(input.message).slice(0,CALLBACK_CONTEXT_LIMIT)};
 const serviceDate=canonicalServiceDate(input.serviceDate);
 if(text(input.serviceDate)&&!serviceDate)throw new Response("serviceDate is not a valid booking date",{status:400});
 const petId=callbackContextValue(input.petId),leadId=callbackContextValue(input.leadId);
 let serviceCode=callbackContextValue(input.serviceCode);
 const customer=await db.prepare("SELECT id,primary_phone,city_id FROM canonical_customers WHERE id=?").bind(input.customerId).first<Row>();
 const phone=digits(customer?.primary_phone);
 // Prove unique canonical phone ownership before recording consent, including requests without a lead.
 if(phone.length<10)throw new Response("A verified customer phone is required before an AI callback can be requested",{status:409});
 const recipient=await resolveCanonicalRecipientOwnership(db,env,{phone,customerId:input.customerId,leadId,requireSuppliedPhone:true});
 await assertCallbackPet(db,input.customerId,petId);
 const canonicalCity=text(customer?.city_id).toLowerCase();
 const destination=await resolveCallbackDestination(db,input.customerId,canonicalCity,{cityId:input.cityId,bookingId:callbackContextValue(input.bookingId),serviceCode});
 const {cityId,bookingId}=destination;serviceCode=destination.serviceCode;
 if(schedule.when==="future")return{matched:false as const,scheduling:"unsupported" as const,reason:"unsupported_scheduling" as const,requestedStart:schedule.value,notice:UNSUPPORTED_SCHEDULING_NOTICE,petId,serviceCode,leadId,serviceDate,cityId,bookingId};
 const idempotencyKey=await callbackIdempotencyKey(db,input.customerId,input.idempotencyKey,recipient.phoneKey);
 const owner={customerId:input.customerId,idempotencyKey,phoneKey:recipient.phoneKey};
 // Schema, legacy backfill and immutable intent writes finish before consent or provider execution.
 await ensureCallbackContextSchema(db);
 const dispatch=await reserveCallbackContext(db,owner,{requestedStart:null,petId,serviceCode,leadId,serviceDate,cityId,bookingId},now);
 // A failed earlier dispatch can leave an intent. Revalidate its original destination and pet, not only the retry fields.
 await assertCallbackPet(db,input.customerId,dispatch.petId);
 await resolveCallbackDestination(db,input.customerId,canonicalCity,dispatch);
 await resolveCanonicalRecipientOwnership(db,env,{phone,customerId:input.customerId,leadId:dispatch.leadId,bookingId:dispatch.bookingId,requireSuppliedPhone:true});
 ensureCustomerRequestedCallbackUseCase();
 const actorId="ai-callback-orchestrator@system.pawspace";
 await recordVoiceConsent(db,{phone,subjectType:"customer",subjectId:input.customerId,granted:true,source:"authenticated_customer_call_me_request",actorId,asOf:now});
 const context=await buildCustomer360(db,input.customerId);
 // Immediate only. requestedStart is not forwarded and is not stored: there is no scheduler.
 const voiceRequest={idempotencyKey,useCase:CUSTOMER_REQUESTED_CALLBACK_USE_CASE,phone,cityId:dispatch.cityId,customerId:input.customerId,leadId:dispatch.leadId,bookingId:dispatch.bookingId,actorId,actorPermissions:["customers.manage","communications.call"],asOf:now};
 const result=await requestOutboundVoiceCall(db,env,voiceRequest as Parameters<typeof requestOutboundVoiceCall>[2]);
 if(!result.callId)throw new Error("Canonical callback did not return a call id");
 // The context was written atomically with the voice order, before any provider contact. No post-dispatch context writes.
 const bound=await readCallbackContext(db,result.callId,owner);
 return{matched:true as const,callback:result,customerContextAttached:context.length>0,contextCustomerId:input.customerId,consentSource:"authenticated_customer_call_me_request",voiceUseCase:CUSTOMER_REQUESTED_CALLBACK_USE_CASE,policyEngine:"voice-outbound-canonical",...bound};
}

/** Cancel one known call through cancelVoiceCall. A foreign customer or a call owned by someone else is refused. No new dialer. */
export async function cancelGovernedCustomerCallback(db:D1Database,input:{actor:AuthenticatedActor;customerId:string;callId:string;reason?:string|null;asOf?:number}){
 await requireCustomerOwnership(db,input.actor,input.customerId);
 const callId=text(input.callId);if(!callId)throw new Response("callId is required",{status:400});
 await ensureVoiceCallTables(db);
 const row=await db.prepare("SELECT id,customer_id,state FROM voice_call_orders WHERE id=?").bind(callId).first<{id?:string;customer_id?:string|null;state?:string}>();
 if(!row)throw new Response("Voice call not found",{status:404});
 if(text(row.customer_id)!==input.customerId)throw new Response("Customer ownership denied",{status:403});
 const state=text(row.state);
 if(state==="cancelled")return{from:"cancelled" as const,to:"cancelled" as const};
 if((!isVoiceCallState(state)||!canVoiceCallTransition(state,"cancelled")))throw new Response("Voice call cannot be cancelled in its current state",{status:409});
 return cancelVoiceCall(db,{callId,reason:text(input.reason)||"customer_cancelled_in_chat",actorId:input.actor.email,asOf:input.asOf});
}

export const LOW_RISK_AUTO_TOOLS=new Set<AiToolCode>([
 "service_catalogue.read","customer_bookings.read","booking_status.read","provider_status.read","subscription_wallet.read","case_status.read","approved_knowledge.read","quote.request"
]);
export const CONFIRMABLE_SAFE_MUTATIONS=new Set<AiToolCode>(["schedule.reserve","booking.create","checkout.payment_order.create","booking.reschedule","booking.cancel","provider.assignment.execute_policy"]);
export const NEVER_AUTONOMOUS_TOOLS=new Set<AiToolCode>(["refund.issue","payment.capture","payout.release","price.override","campaign.activate","communication.send","customer.merge"]);

export async function executeGovernedLowRiskTool(db:D1Database,input:{sourceRequest?:Request;actor:AuthenticatedActor;toolCode:AiToolCode;threadId:string;customerId:string;intent:AiToolIntent;channel:AiToolChannel;arguments?:Record<string,unknown>;idempotencyKey?:string;customerConfirmed?:boolean}){
 if(NEVER_AUTONOMOUS_TOOLS.has(input.toolCode))throw new Response("This tool requires deterministic approval or human review",{status:403});
 if(!LOW_RISK_AUTO_TOOLS.has(input.toolCode)&&!CONFIRMABLE_SAFE_MUTATIONS.has(input.toolCode))throw new Response("Tool is not on the AI-first allow-list",{status:403});
 if(CONFIRMABLE_SAFE_MUTATIONS.has(input.toolCode)&&!input.customerConfirmed)throw new Response("Explicit customer confirmation is required",{status:409});
 const prepared=await prepareAiToolExecution(db,{actor:input.actor,toolCode:input.toolCode,threadId:input.threadId,customerId:input.customerId,intent:input.intent,channel:input.channel,arguments:input.arguments,idempotencyKey:input.idempotencyKey});
 if(LOW_RISK_AUTO_TOOLS.has(input.toolCode))return{...prepared,autonomyClass:"low_risk_read",humanReviewRequired:false};
 const requestId="requestId"in prepared&&typeof prepared.requestId==="string"?prepared.requestId:"";
 if(!requestId)throw new Error("Governed mutation did not create a confirmation request");
 const confirmed=await confirmAiToolExecution(db,{actor:input.actor,requestId,sourceRequest:input.sourceRequest});
 return{...confirmed,autonomyClass:"customer_confirmed_safe_mutation",humanReviewRequired:false};
}

export async function executeGovernedConversationTool(db:D1Database,input:{actor:AuthenticatedActor;toolCode:AiToolCode;threadId:string;customerId:string;intent:AiToolIntent;channel:AiToolChannel;arguments?:Record<string,unknown>;idempotencyKey?:string;customerConfirmed?:boolean}){
 if(!input.actor.email.endsWith("@system.pawspace")||!input.actor.permissions.includes("communications.manage"))throw new Response("Conversation service actor is not authorized for delegated AI actions",{status:403});
 const thread=await db.prepare("SELECT customer_id,status,assigned_to FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
 if(!thread||text(thread.customer_id)!==input.customerId)throw new Response("Conversation tool customer/thread mismatch",{status:403});
 if(text(thread.status)!=="open"||text(thread.assigned_to)&&text(thread.assigned_to)!=="ai-orchestrator")throw new Response("Human-owned or closed conversation cannot execute AI mutations",{status:409});
 if(!CONFIRMABLE_SAFE_MUTATIONS.has(input.toolCode)&&!LOW_RISK_AUTO_TOOLS.has(input.toolCode))throw new Response("Tool is not delegated to conversation AI",{status:403});
 // The elevated permissions exist only in this call frame after the thread/customer binding above.
 // They are not persisted and never include Finance, payout, price override or campaign authority.
 const delegated:AuthenticatedActor={...input.actor,permissions:Array.from(new Set([...input.actor.permissions,"scheduling.book","bookings.manage"]))};
 return executeGovernedLowRiskTool(db,{actor:delegated,toolCode:input.toolCode,threadId:input.threadId,customerId:input.customerId,intent:input.intent,channel:input.channel,arguments:input.arguments,idempotencyKey:input.idempotencyKey,customerConfirmed:input.customerConfirmed});
}

export type WhatsAppAutoSendInput={intent:string;outcome:string;humanOwned:boolean;customerConsented:boolean;optedOut:boolean;grounded:boolean;containsHighImpactClaim:boolean;messageType?:string|null};
const LOW_RISK_WHATSAPP_INTENTS=new Set(["service_info","booking_status","subscription_wallet"]);
const LOW_RISK_MESSAGE_TYPES=new Set(["booking_confirmation","eta_update","payment_link_reminder","schedule_details","standard_faq","action_confirmation_request"]);
export function evaluateWhatsAppAutoSend(input:WhatsAppAutoSendInput){
 const reasons:string[]=[];
 if(input.humanOwned)reasons.push("human_owned");if(!input.customerConsented)reasons.push("consent_missing");if(input.optedOut)reasons.push("opted_out");if(!input.grounded)reasons.push("not_grounded");if(input.containsHighImpactClaim)reasons.push("high_impact_claim");if(input.outcome!=="reply_ready")reasons.push(`outcome_${input.outcome||"unknown"}`);
 const lowRiskIntent=LOW_RISK_WHATSAPP_INTENTS.has(input.intent),lowRiskType=input.messageType?LOW_RISK_MESSAGE_TYPES.has(input.messageType):false;
 if(!lowRiskIntent&&!lowRiskType)reasons.push("not_low_risk_allowlisted");
 return{allowed:reasons.length===0,reasons,policy:"ai_first_whatsapp_low_risk_v1",humanReviewRequired:reasons.length>0};
}

export type ExceptionKind="pet_safety"|"emergency"|"payment_dispute"|"complex_complaint"|"customer_requested_human"|"provider_failure";
const EXCEPTION_REASON:Record<ExceptionKind,AiHandoffReason>={pet_safety:"safety",emergency:"safety",payment_dispute:"refund_payment_dispute",complex_complaint:"complaint",customer_requested_human:"customer_requested_human",provider_failure:"provider_error"};
export async function routeHumanException(db:D1Database,input:{threadId:string;customerId:string;kind:ExceptionKind;actorEmail?:string;confidence?:number|null}){
 const reason=EXCEPTION_REASON[input.kind];return requestAiHumanHandoff(db,{threadId:input.threadId,customerId:input.customerId,reason,actorEmail:input.actorEmail||"ai-first-control-plane@system.pawspace",confidence:input.confidence??null});
}

export function controlledLiveProviderReadiness(env:Env){
 const required={haptik:["HAPTIK_API_KEY","HAPTIK_OUTBOUND_API_KEY","HAPTIK_OUTBOUND_URL"],interakt:["INTERAKT_WEBHOOK_SECRET","INTERAKT_API_KEY"],exotel:["EXOTEL_API_KEY","EXOTEL_API_TOKEN","EXOTEL_SID","EXOTEL_CALLER_ID","EXOTEL_VOICE_APP_ID","EXOTEL_WEBHOOK_SECRET","PAWSPACE_VOICE_STATUS_CALLBACK_URL"]}as const;
 const providers=Object.fromEntries(Object.entries(required).map(([provider,names])=>{const missing=names.filter(name=>!text(env[name]));return[provider,{configured:missing.length===0,missing}]}));
 return{providers,controlledLiveVerified:false,verificationRequired:["signed inbound callback","successful allowlisted transaction","carrier/provider failure","retry/idempotency","opt-out refusal","quiet-hours refusal"],claim:"configuration readiness only; controlled-live requires executed provider evidence"};
}
