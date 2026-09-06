import{prepareAiToolExecution,confirmAiToolExecution,type AiToolChannel,type AiToolCode,type AiToolIntent}from"./ai-tool-registry";
import{buildCustomer360}from"./customer-360";
import{requestAiHumanHandoff,type AiHandoffReason}from"./ai-human-handoff";
import{recordVoiceConsent,requestOutboundVoiceCall,VOICE_USE_CASES,type VoiceUseCaseDefinition}from"./voice-outbound-canonical";
import{requireCustomerOwnership,type AuthenticatedActor}from"./server-auth";

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
export function isCustomerCallbackRequest(message:string){const value=text(message).toLowerCase();return CALLBACK_PHRASES.some(phrase=>value.includes(phrase));}

export async function requestGovernedCustomerCallback(db:D1Database,env:Env,input:{actor:AuthenticatedActor;customerId:string;message:string;idempotencyKey:string;cityId?:string}){
 await requireCustomerOwnership(db,input.actor,input.customerId);
 if(!isCustomerCallbackRequest(input.message))return{matched:false as const};
 // This is not sales outreach. Register a dedicated transactional voice use case before the canonical
 // voice engine seeds scripts/evaluates policy so the existing PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED
 // switch continues to govern real outbound marketing while an explicit customer callback request is
 // governed only by identity, consent, opt-out, quiet hours, frequency and provider readiness.
 ensureCustomerRequestedCallbackUseCase();
 const customer=await db.prepare("SELECT id,primary_phone FROM canonical_customers WHERE id=?").bind(input.customerId).first<Row>();
 const phone=digits(customer?.primary_phone);if(phone.length<10)throw new Response("A verified customer phone is required before an AI callback can be requested",{status:409});
 const now=Date.now(),actorId="ai-callback-orchestrator@system.pawspace";
 // The customer's explicit request to be called is the consent event. It is persisted before the
 // existing voice engine evaluates opt-out, quiet-hours, frequency, provider and environment gates.
 await recordVoiceConsent(db,{phone,subjectType:"customer",subjectId:input.customerId,granted:true,source:"authenticated_customer_call_me_request",actorId,asOf:now});
 const context=await buildCustomer360(db,input.customerId);
 const result=await requestOutboundVoiceCall(db,env,{idempotencyKey:`ai-callback:${input.idempotencyKey}`,useCase:CUSTOMER_REQUESTED_CALLBACK_USE_CASE,phone,cityId:text(input.cityId)||"blr",customerId:input.customerId,actorId,actorPermissions:["customers.manage","communications.call"],asOf:now});
 return{matched:true as const,callback:result,customerContextAttached:context.length>0,contextCustomerId:input.customerId,consentSource:"authenticated_customer_call_me_request",voiceUseCase:CUSTOMER_REQUESTED_CALLBACK_USE_CASE,policyEngine:"voice-outbound-canonical"};
}

export const LOW_RISK_AUTO_TOOLS=new Set<AiToolCode>([
 "service_catalogue.read","customer_bookings.read","booking_status.read","provider_status.read","subscription_wallet.read","case_status.read","approved_knowledge.read","quote.request"
]);
export const CONFIRMABLE_SAFE_MUTATIONS=new Set<AiToolCode>(["booking.request"]);
export const NEVER_AUTONOMOUS_TOOLS=new Set<AiToolCode>(["refund.issue","payment.capture","payout.release","price.override","provider.assign","campaign.activate","communication.send","customer.merge","booking_reschedule.request","booking_cancel.request"]);

export async function executeGovernedLowRiskTool(db:D1Database,input:{actor:AuthenticatedActor;toolCode:AiToolCode;threadId:string;customerId:string;intent:AiToolIntent;channel:AiToolChannel;arguments?:Record<string,unknown>;idempotencyKey?:string;customerConfirmed?:boolean}){
 if(NEVER_AUTONOMOUS_TOOLS.has(input.toolCode))throw new Response("This tool requires deterministic approval or human review",{status:403});
 if(!LOW_RISK_AUTO_TOOLS.has(input.toolCode)&&!CONFIRMABLE_SAFE_MUTATIONS.has(input.toolCode))throw new Response("Tool is not on the AI-first allow-list",{status:403});
 if(CONFIRMABLE_SAFE_MUTATIONS.has(input.toolCode)&&!input.customerConfirmed)throw new Response("Explicit customer confirmation is required",{status:409});
 const prepared=await prepareAiToolExecution(db,{actor:input.actor,toolCode:input.toolCode,threadId:input.threadId,customerId:input.customerId,intent:input.intent,channel:input.channel,arguments:input.arguments,idempotencyKey:input.idempotencyKey});
 if(LOW_RISK_AUTO_TOOLS.has(input.toolCode))return{...prepared,autonomyClass:"low_risk_read",humanReviewRequired:false};
 const requestId="requestId"in prepared&&typeof prepared.requestId==="string"?prepared.requestId:"";
 if(!requestId)throw new Error("Governed mutation did not create a confirmation request");
 const confirmed=await confirmAiToolExecution(db,{actor:input.actor,requestId});
 return{...confirmed,autonomyClass:"customer_confirmed_safe_mutation",humanReviewRequired:false};
}

export type WhatsAppAutoSendInput={intent:string;outcome:string;humanOwned:boolean;customerConsented:boolean;optedOut:boolean;grounded:boolean;containsHighImpactClaim:boolean;messageType?:string|null};
const LOW_RISK_WHATSAPP_INTENTS=new Set(["service_info","booking_status","subscription_wallet"]);
const LOW_RISK_MESSAGE_TYPES=new Set(["booking_confirmation","eta_update","payment_link_reminder","schedule_details","standard_faq"]);
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
