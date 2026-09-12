import type { AuthenticatedActor } from "./server-auth";
import type { AtlasToolDefinition } from "./atlas-tool-contract";
import { resolveVerticalRuntime } from "./agents/runtime/vertical-runtime";
import { requestOutboundVoiceCall } from "./voice-outbound-governance";
import { marketingAdsReadMetrics, marketingBudgetReallocate, marketingKeywordMutate, submitMarketingProposal } from "./marketing-agent-gateway";
import type { MarketingAdPlatform } from "./marketing-ad-connectors";
import { calculateSurgePricing } from "./policies/surge-pricing-engine";
import { ensureMarginPolicyTables } from "./finance-margin-validator";
import { ensureVetHealthcareTables, evaluateVetTriage, digitizeVetPrescriptionDraft, calculateVetPayout } from "./vet-healthcare";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const int=(v:unknown)=>Math.max(0,Math.trunc(Number(v)||0));
const enabled=(v:unknown)=>!["","0","false","off","disabled"].includes(text(v).toLowerCase());

export type Phase2ToolCode="ops.voice.dispatch"|"marketing.ads.read_metrics"|"marketing.proposal.submit"|"marketing.ads.budget.reallocate"|"marketing.ads.keyword.mutate"|"finance.yield.calculate_surge"|"vet.triage.evaluate"|"vet.prescription.digitize"|"finance.vet_payout.calculate";
const schema=(code:Phase2ToolCode,allowedAgents:AtlasToolDefinition["allowedAgents"],riskClass:AtlasToolDefinition["riskClass"],autonomy:AtlasToolDefinition["autonomy"],requiredPermissions:string[],properties:Record<string,unknown>,required:string[],networkPolicy:AtlasToolDefinition["networkPolicy"]="none"):AtlasToolDefinition<Phase2ToolCode>=>({code,version:"1",allowedAgents,riskClass,autonomy,idempotencyRequired:riskClass!=="read",requiredPermissions,inputSchema:{type:"object",additionalProperties:false,properties,required},executionTarget:networkPolicy==="none"?"canonical_service":"external_rpa",networkPolicy});

export const phase2ToolSchemas:Record<Phase2ToolCode,AtlasToolDefinition<Phase2ToolCode>>={
 "ops.voice.dispatch":schema("ops.voice.dispatch",["ops","atlas"],"high","within_envelope",["communications.call","customers.manage"],{bookingId:{type:"string"},useCase:{type:"string"}},["bookingId","useCase"],"allowlisted_https"),
 "marketing.ads.read_metrics":schema("marketing.ads.read_metrics",["marketing","atlas"],"read","autonomous",["marketing.view"],{from:{type:"string"},to:{type:"string"},platform:{type:"string"},campaignId:{type:"string"}},["from","to"]),
 "marketing.proposal.submit":schema("marketing.proposal.submit",["marketing","atlas"],"medium","autonomous",["marketing.manage"],{toolName:{type:"string"},platform:{type:"string"},why:{type:"string"},payload:{type:"object"}},["toolName","platform","why","payload"]),
 "marketing.ads.budget.reallocate":schema("marketing.ads.budget.reallocate",["marketing","atlas"],"high","within_envelope",["marketing.manage"],{approvalId:{type:"string"},platform:{type:"string"},accountId:{type:"string"},fromResourceId:{type:"string"},toResourceId:{type:"string"},fromDailyMinor:{type:"integer"},toDailyMinor:{type:"integer"},shiftMinor:{type:"integer"},reason:{type:"string"}},["approvalId","platform","accountId","fromResourceId","toResourceId","fromDailyMinor","toDailyMinor","shiftMinor","reason"],"allowlisted_https"),
 "marketing.ads.keyword.mutate":schema("marketing.ads.keyword.mutate",["marketing","atlas"],"high","within_envelope",["marketing.manage"],{approvalId:{type:"string"},platform:{type:"string"},accountId:{type:"string"},campaignId:{type:"string"},adGroupId:{type:"string"},criterionId:{type:"string"},keyword:{type:"string"},operation:{type:"string"},matchType:{type:"string"},currentDailyMinor:{type:"integer"},reason:{type:"string"}},["approvalId","platform","accountId","campaignId","adGroupId","keyword","operation","currentDailyMinor","reason"],"allowlisted_https"),
 "finance.yield.calculate_surge":schema("finance.yield.calculate_surge",["finance","atlas"],"read","autonomous",["finance.view"],{bookingId:{type:"string"},zone:{type:"object"},weather:{type:"object"},capacity:{type:"object"}},["bookingId","zone","weather","capacity"]),
 "vet.triage.evaluate":schema("vet.triage.evaluate",["healthcare","atlas"],"read","autonomous",[],{customerId:{type:"string"},petId:{type:"string"},symptoms:{type:"string"}},["customerId","petId","symptoms"]),
 "vet.prescription.digitize":schema("vet.prescription.digitize",["healthcare","atlas"],"medium","within_envelope",["bookings.manage"],{appointmentId:{type:"string"},providerId:{type:"string"},sourceType:{type:"string"},clinicalNotes:{type:"string"},sourceMediaRef:{type:"string"}},["appointmentId","providerId","sourceType","clinicalNotes"]),
 "finance.vet_payout.calculate":schema("finance.vet_payout.calculate",["finance","healthcare","atlas"],"high","within_envelope",["finance.manage"],{appointmentId:{type:"string"},providerId:{type:"string"}},["appointmentId","providerId"]),
};

async function opsVoice(db:D1Database,env:Row,args:Row,actor:AuthenticatedActor,idempotencyKey:string){
 const booking=await db.prepare("SELECT id,customer_id,city_id,status FROM canonical_bookings WHERE id=?").bind(text(args.bookingId)).first<Row>();
 if(!booking||!["confirmed","assigned","in_progress"].includes(text(booking.status)))throw new Response("Active canonical booking is required for Ops voice dispatch",{status:409});
 const customer=await db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(text(booking.customer_id)).first<Row>();
 if(!customer||!text(customer.primary_phone))throw new Response("Canonical customer phone is unavailable",{status:409});
 return requestOutboundVoiceCall(db,env,{idempotencyKey,useCase:text(args.useCase)||"booking_confirmation",phone:text(customer.primary_phone),cityId:text(booking.city_id),customerId:text(booking.customer_id),bookingId:text(booking.id),actorId:actor.email,actorPermissions:actor.permissions});
}

async function surge(db:D1Database,args:Row){
 await ensureMarginPolicyTables(db);
 const booking=await db.prepare("SELECT id,service_code,city_id,total_amount FROM canonical_bookings WHERE id=?").bind(text(args.bookingId)).first<Row>();if(!booking)throw new Response("Canonical booking not found",{status:404});
 const service=text(booking.service_code)==="boarding"?"boarding":"mobile_grooming";
 const quote=calculateSurgePricing({service,basePricePaise:Math.round(Number(booking.total_amount)*100),zone:args.zone as never,weather:args.weather as never,capacity:args.capacity as never});
 if(quote.availability!=="available")return{...quote,marginFloorChecked:false};
 const policy=await db.prepare("SELECT minimum_margin_bps FROM finance_ai_margin_policies WHERE status='active' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND service_code IN (?, '') AND city_id IN (?, '') ORDER BY CASE WHEN service_code=? THEN 0 ELSE 1 END,CASE WHEN city_id=? THEN 0 ELSE 1 END,version DESC LIMIT 1").bind(text(booking.service_code),text(booking.city_id),text(booking.service_code),text(booking.city_id)).first<Row>();
 if(!policy)throw new Response("Approved Finance margin floor is required",{status:409});
 const payout=await db.prepare("SELECT provider_net_payout,platform_gst,pawspace_gst_on_order FROM provider_payout_computations WHERE booking_id=?").bind(text(booking.id)).first<Row>();if(!payout)throw new Response("Canonical provider cost is required before surge evaluation",{status:409});
 const costPaise=Math.round((Number(payout.provider_net_payout||0)+Number(payout.platform_gst||0)+Number(payout.pawspace_gst_on_order||0))*100),marginBps=quote.quotedPricePaise>0?Math.floor((quote.quotedPricePaise-costPaise)*10000/quote.quotedPricePaise):-10000;
 if(marginBps<Number(policy.minimum_margin_bps))throw new Response("Surge quote violates approved minimum margin floor",{status:422});return{...quote,marginFloorChecked:true,marginBps,minimumMarginBps:Number(policy.minimum_margin_bps)};
}

async function vetTriage(db:D1Database,args:Row){const pet=await db.prepare("SELECT id,customer_id FROM canonical_pets WHERE id=?").bind(text(args.petId)).first<Row>();if(!pet||text(pet.customer_id)!==text(args.customerId))throw new Response("Canonical pet ownership verification failed",{status:403});return evaluateVetTriage({symptoms:text(args.symptoms)});}
async function requireVerifiedVet(db:D1Database,providerId:string){await ensureVetHealthcareTables(db);const row=await db.prepare("SELECT vci_verification_status FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();if(!row||text(row.vci_verification_status)!=="verified")throw new Response("Verified VCI registration is required",{status:409});}
async function vetPrescription(db:D1Database,args:Row){const providerId=text(args.providerId);await requireVerifiedVet(db,providerId);const source=text(args.sourceType);if(!["handwritten_upload","voice_dictation","typed_notes"].includes(source))throw new Response("Unsupported prescription source type",{status:400});return digitizeVetPrescriptionDraft(db,{appointmentId:text(args.appointmentId),providerId,sourceType:source as "handwritten_upload"|"voice_dictation"|"typed_notes",clinicalNotes:text(args.clinicalNotes),sourceMediaRef:text(args.sourceMediaRef)||null});}
async function vetPayout(db:D1Database,args:Row,actor:AuthenticatedActor){await requireVerifiedVet(db,text(args.providerId));const result=await calculateVetPayout(db,{appointmentId:text(args.appointmentId),providerId:text(args.providerId),actorId:actor.email});if(result.taxPaise!==0||result.gstRatePercent!==0||result.sacCode!=="998351")throw new Error("Vet finance tax invariant violated");return result;}

export type Phase2ExecutionInput={agentCode:string;goalId:string;toolCode:Phase2ToolCode;arguments:Row;actor:AuthenticatedActor;idempotencyKey?:string;env?:Row};
function targetVertical(code:Phase2ToolCode){return code.startsWith("ops.")?"ops":code.startsWith("marketing.")?"marketing":code.startsWith("vet.")?"healthcare":"finance" as const;}
export async function executePhase2Tool(db:D1Database,input:Phase2ExecutionInput){
 const env=input.env||{},target=targetVertical(input.toolCode),mutation=phase2ToolSchemas[input.toolCode].riskClass!=="read",runtime=resolveVerticalRuntime(env,target,mutation?"execute_within_envelope":"recommend");
 if(runtime.mode==="disabled")return{status:"human_handoff" as const,executed:false,reason:`${target} AI runtime is disabled`};
 if(input.toolCode==="ops.voice.dispatch"&&!enabled(env.AI_EXTERNAL_COMMUNICATION_ACTIVE))return{status:"human_handoff" as const,executed:false,reason:"AI external communication is disabled"};
 if(input.toolCode==="finance.vet_payout.calculate"&&!enabled(env.AI_FINANCIAL_MUTATION_ACTIVE))return{status:"human_handoff" as const,executed:false,reason:"AI financial mutation is disabled"};
 if(mutation&&runtime.mode!=="execute_within_envelope")return{status:"human_handoff" as const,executed:false,reason:`${target} mutation requires execute_within_envelope runtime`};
 if(mutation&&!text(input.idempotencyKey))throw new Error("Idempotency key is required for Phase 2 mutation tools");
 const a=input.arguments;
 switch(input.toolCode){
  case"ops.voice.dispatch":return{status:"completed" as const,executed:true,result:await opsVoice(db,env,a,input.actor,input.idempotencyKey!)};
  case"marketing.ads.read_metrics":return{status:"completed" as const,executed:true,result:await marketingAdsReadMetrics(db,{from:text(a.from),to:text(a.to),platform:text(a.platform) as MarketingAdPlatform||undefined,campaignId:text(a.campaignId)||undefined})};
  case"marketing.proposal.submit":return{status:"completed" as const,executed:true,result:await submitMarketingProposal(db,{toolName:text(a.toolName) as "marketing.ads.budget.reallocate"|"marketing.ads.keyword.mutate",platform:text(a.platform) as MarketingAdPlatform,why:text(a.why),payload:a.payload as Row,requestedBy:input.actor.email})};
  case"marketing.ads.budget.reallocate":return{status:"completed" as const,executed:true,result:await marketingBudgetReallocate(db,env,{approvalId:text(a.approvalId),platform:text(a.platform) as MarketingAdPlatform,accountId:text(a.accountId),fromResourceId:text(a.fromResourceId),toResourceId:text(a.toResourceId),fromDailyMinor:int(a.fromDailyMinor),toDailyMinor:int(a.toDailyMinor),shiftMinor:int(a.shiftMinor),reason:text(a.reason),actor:input.actor.email})};
  case"marketing.ads.keyword.mutate":return{status:"completed" as const,executed:true,result:await marketingKeywordMutate(db,env,{approvalId:text(a.approvalId),platform:text(a.platform) as MarketingAdPlatform,accountId:text(a.accountId),campaignId:text(a.campaignId),adGroupId:text(a.adGroupId),criterionId:text(a.criterionId)||undefined,keyword:text(a.keyword),operation:text(a.operation) as "add_negative"|"pause"|"enable",matchType:(text(a.matchType)||"EXACT") as "EXACT"|"PHRASE"|"BROAD",currentDailyMinor:int(a.currentDailyMinor),reason:text(a.reason),actor:input.actor.email})};
  case"finance.yield.calculate_surge":return{status:"completed" as const,executed:true,result:await surge(db,a)};
  case"vet.triage.evaluate":return{status:"completed" as const,executed:true,result:await vetTriage(db,a)};
  case"vet.prescription.digitize":return{status:"completed" as const,executed:true,result:await vetPrescription(db,a)};
  case"finance.vet_payout.calculate":return{status:"completed" as const,executed:true,result:await vetPayout(db,a,input.actor)};
 }
}
