import{authError,authorize,database,resolveActor,requirePermission,securityAudit}from"../../../lib/server-auth";
import{saveCommercialTerm,activateCommercialTerm,setOrderCommercialOverride,rejectOrderCommercialOverride,pendingOrderOverrideRequests,commercialTermsDirectory}from"../../../lib/provider-commercial-terms";
import{activateProviderCommercialTerms,draftProviderCommercialTerms,providerCommercialTermsView}from"../../../lib/provider-commission-setup";
import{approveOrderCommissionOverride}from"../../../lib/provider-commission-governance";
import{computeOrderPayoutStatutory}from"../../../lib/provider-payout-statutory";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin commercial-terms write blocked",{status:403});}

export async function GET(request:Request){try{await authorize(request,"finance.view");const db=await database(),providerId=text(new URL(request.url).searchParams.get("providerId"));if(providerId)return json({data:await providerCommercialTermsView(db,{providerId}),productionReady:false});const[directory,overrideRequests]=await Promise.all([commercialTermsDirectory(db),pendingOrderOverrideRequests(db)]);return json({data:{...directory,overrideRequests},productionReady:false});}catch(error){return authError(error,"Unable to load commercial terms");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database();const body=await request.json() as Row,action=text(body.action);let result:unknown;
 if(action==="save_term")result=await saveCommercialTerm(db,{serviceCode:text(body.serviceCode),providerId:text(body.providerId)||null,engagementModel:text(body.engagementModel) as never,providerSharePct:body.providerSharePct==null?undefined:Number(body.providerSharePct),gstMode:body.gstMode?text(body.gstMode) as never:undefined,platformGstRate:body.platformGstRate==null?undefined:Number(body.platformGstRate),cashAllowed:body.cashAllowed==null?undefined:Boolean(body.cashAllowed),onboardingFee:Number(body.onboardingFee)||0,renewalFee:Number(body.renewalFee)||0,renewalMonths:body.renewalMonths==null?undefined:Number(body.renewalMonths),effectiveFrom:text(body.effectiveFrom),reason:text(body.reason),actorId:actor.email});
 else if(action==="activate_term")result=await activateCommercialTerm(db,{termId:text(body.termId),approvalReference:text(body.approvalReference),actorId:actor.email});
 // A provider's whole set of terms, one per service: the maker proposes, a different person activates (owner decision 8).
 else if(action==="save_provider_terms")result=await draftProviderCommercialTerms(db,{providerId:text(body.providerId),engagement:text(body.engagement),services:Array.isArray(body.services)?body.services as never:[],effectiveFrom:text(body.effectiveFrom)||null,reason:text(body.reason),actorId:actor.email});
 else if(action==="activate_provider_terms")result=await activateProviderCommercialTerms(db,{providerId:text(body.providerId),approvalReference:text(body.approvalReference),actorId:actor.email,termIds:Array.isArray(body.termIds)?body.termIds:null});
 // A per-order override is a request; a second person approves (or rejects) it before it changes the booking.
 else if(action==="order_override")result=await setOrderCommercialOverride(db,{bookingId:text(body.bookingId),providerSharePct:body.providerSharePct==null?null:Number(body.providerSharePct),engagementModel:body.engagementModel?text(body.engagementModel) as never:null,gstMode:body.gstMode?text(body.gstMode) as never:null,reason:text(body.reason),actorId:actor.email});
 else if(action==="approve_order_override")result=await approveOrderCommissionOverride(db,{bookingId:text(body.bookingId),requestId:text(body.requestId)||null,actor:actor.email,note:text(body.note)||null});
 else if(action==="reject_order_override")result=await rejectOrderCommercialOverride(db,{bookingId:text(body.bookingId)||null,requestId:text(body.requestId)||null,actorId:actor.email,note:text(body.note)||null});
 else if(action==="compute_payout")result=await computeOrderPayoutStatutory(db,{bookingId:text(body.bookingId),actorId:actor.email});
 else return json({error:"Unknown commercial-terms action"},400);
 await securityAudit(db,actor,`commercial_terms.${action}`,"provider_commercial_terms",text(body.termId)||text(body.bookingId)||text(body.providerId)||null,"completed");
 return json({data:result,productionReady:false});}catch(error){return authError(error,"Commercial-terms update failed");}}
