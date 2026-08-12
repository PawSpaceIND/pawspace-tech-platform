import{authError,authorize,database,resolveActor,requirePermission,securityAudit}from"../../../lib/server-auth";
import{saveCommercialTerm,activateCommercialTerm,setOrderCommercialOverride,computeOrderPayout,commercialTermsDirectory}from"../../../lib/provider-commercial-terms";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin commercial-terms write blocked",{status:403});}

export async function GET(request:Request){try{await authorize(request,"finance.view");const db=await database();return json({data:await commercialTermsDirectory(db),productionReady:false});}catch(error){return authError(error,"Unable to load commercial terms");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database();const body=await request.json() as Row,action=text(body.action);let result:unknown;
 if(action==="save_term")result=await saveCommercialTerm(db,{serviceCode:text(body.serviceCode),providerId:text(body.providerId)||null,engagementModel:text(body.engagementModel) as never,providerSharePct:body.providerSharePct==null?undefined:Number(body.providerSharePct),gstMode:body.gstMode?text(body.gstMode) as never:undefined,platformGstRate:body.platformGstRate==null?undefined:Number(body.platformGstRate),cashAllowed:body.cashAllowed==null?undefined:Boolean(body.cashAllowed),onboardingFee:Number(body.onboardingFee)||0,renewalFee:Number(body.renewalFee)||0,renewalMonths:body.renewalMonths==null?undefined:Number(body.renewalMonths),effectiveFrom:text(body.effectiveFrom),reason:text(body.reason),actorId:actor.email});
 else if(action==="activate_term")result=await activateCommercialTerm(db,{termId:text(body.termId),approvalReference:text(body.approvalReference),actorId:actor.email});
 else if(action==="order_override")result=await setOrderCommercialOverride(db,{bookingId:text(body.bookingId),providerSharePct:body.providerSharePct==null?null:Number(body.providerSharePct),engagementModel:body.engagementModel?text(body.engagementModel) as never:null,gstMode:body.gstMode?text(body.gstMode) as never:null,reason:text(body.reason),actorId:actor.email});
 else if(action==="compute_payout")result=await computeOrderPayout(db,{bookingId:text(body.bookingId),actorId:actor.email});
 else return json({error:"Unknown commercial-terms action"},400);
 await securityAudit(db,actor,`commercial_terms.${action}`,"provider_commercial_terms",text(body.termId)||text(body.bookingId)||null,"completed");
 return json({data:result,productionReady:false});}catch(error){return authError(error,"Commercial-terms update failed");}}
