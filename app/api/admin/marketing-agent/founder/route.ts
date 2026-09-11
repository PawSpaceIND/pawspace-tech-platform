import { authError, database, resolveActor, securityAudit } from "../../../../../lib/server-auth";
import { requireFounderRole } from "../../../../../lib/intelligence/atlas-data";
import { ensureMarketingAgentGatewayTables, founderDecideMarketingProposal, marketingBudgetReallocate, marketingKeywordMutate, upsertMarketingBudgetEnvelope } from "../../../../../lib/marketing-agent-gateway";
import type { MarketingAdPlatform } from "../../../../../lib/marketing-ad-connectors";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
const sameOrigin=(request:Request)=>{const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin founder marketing write blocked",{status:403});};
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const founder=requireFounderRole(await resolveActor(request));
    const body=await request.json() as Record<string,unknown>;
    const action=text(body.action),db=await database();
    await ensureMarketingAgentGatewayTables(db);
    if(action==="marketing.proposal.decide"){
      const decision=text(body.decision);
      if(!body.approvalId||!["approved","rejected"].includes(decision))return json({error:"approvalId and approved/rejected decision are required"},400);
      const data=await founderDecideMarketingProposal(db,{approvalId:text(body.approvalId),decision:decision as "approved"|"rejected",founderActor:founder.email,note:text(body.note)});
      await securityAudit(db,founder,`marketing.proposal.${decision}`,"pending_approval",text(body.approvalId),"completed",{explicitFounderApproval:decision==="approved"});
      return json({data});
    }
    if(action==="marketing.budget_envelope.upsert"){
      const platform=text(body.platform),accountId=text(body.accountId),resourceId=text(body.resourceId),dailyLimitMinor=Math.trunc(Number(body.dailyLimitMinor));
      if(!["google_ads","meta_ads"].includes(platform)||!accountId||!Number.isFinite(dailyLimitMinor)||dailyLimitMinor<0)return json({error:"platform, accountId and non-negative dailyLimitMinor are required"},400);
      const data=await upsertMarketingBudgetEnvelope(db,{id:text(body.id)||undefined,platform:platform as MarketingAdPlatform,accountId,resourceId:resourceId||undefined,dailyLimitMinor,effectiveFrom:body.effectiveFrom==null?undefined:Number(body.effectiveFrom),effectiveTo:body.effectiveTo==null?null:Number(body.effectiveTo),founderActor:founder.email});
      await securityAudit(db,founder,"marketing.budget_envelope.upsert","gce_budget_envelope",data.id,"completed",{platform,accountId,resourceId:resourceId||null,dailyLimitMinor});
      return json({data});
    }
    if(action==="marketing.ads.budget.reallocate"){
      const data=await marketingBudgetReallocate(db,await runtime(),{approvalId:text(body.approvalId),platform:body.platform as MarketingAdPlatform,accountId:text(body.accountId),fromResourceId:text(body.fromResourceId),toResourceId:text(body.toResourceId),fromDailyMinor:Number(body.fromDailyMinor),toDailyMinor:Number(body.toDailyMinor),shiftMinor:Number(body.shiftMinor),reason:text(body.reason),actor:founder.email});
      await securityAudit(db,founder,"marketing.ads.budget.reallocate",String(body.platform),text(body.approvalId),"completed",{explicitFounderApproval:true,budgetEnvelopeValidated:true});
      return json({data});
    }
    if(action==="marketing.ads.keyword.mutate"){
      const data=await marketingKeywordMutate(db,await runtime(),{approvalId:text(body.approvalId),platform:body.platform as MarketingAdPlatform,accountId:text(body.accountId),campaignId:text(body.campaignId),adGroupId:text(body.adGroupId),criterionId:text(body.criterionId)||undefined,keyword:text(body.keyword),operation:body.operation as "add_negative"|"pause"|"enable",matchType:body.matchType as "EXACT"|"PHRASE"|"BROAD"|undefined,currentDailyMinor:Number(body.currentDailyMinor),reason:text(body.reason),actor:founder.email});
      await securityAudit(db,founder,"marketing.ads.keyword.mutate","google_ads",text(body.approvalId),"completed",{explicitFounderApproval:true,budgetEnvelopeValidated:true});
      return json({data});
    }
    return json({error:"Unsupported Founder marketing action"},400);
  }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to execute Founder marketing action");}
}
