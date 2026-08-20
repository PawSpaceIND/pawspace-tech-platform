import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{adSpendDirectory,applyAdPlatformChange,linkAdCampaign,saveAdSpendSource,syncAdSpend,syncAllAdSpend,type AdProvider}from"../../../lib/ad-spend-connectors";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const providers=new Set(["google_ads","meta_ads","supermetrics"]);

export async function GET(request:Request){try{await authorize(request,"marketing.view");const db=await database();return json({data:await adSpendDirectory(db),productionReady:false});}catch(error){return authError(error,"Unable to load ad spend connectors");}}

export async function POST(request:Request){try{
 const db=await database(),body=await request.json() as Row,action=String(body.action||"").trim(),actor=await authorize(request,"marketing.manage");
 const provider=String(body.provider||"") as AdProvider;

 if(action==="save_source"){
  if(!providers.has(provider))return json({error:"Supported providers are google_ads, meta_ads and supermetrics"},400);
  const data=await saveAdSpendSource(db,{provider,externalAccountId:String(body.externalAccountId||""),label:String(body.label||""),currency:body.currency?String(body.currency):undefined,status:body.status==="disabled"?"disabled":undefined,writeMode:["disabled","preview","live"].includes(String(body.writeMode))?String(body.writeMode) as "disabled"|"preview"|"live":undefined,maxDailyBudget:body.maxDailyBudget==null?null:Number(body.maxDailyBudget),supermetricsDsId:body.supermetricsDsId?String(body.supermetricsDsId):undefined,actorId:actor.email});
  await securityAudit(db,actor,"ad_spend.source.save","ad_spend_source",`${provider}:${String(body.externalAccountId||"")}`,"completed",{writeMode:body.writeMode||"disabled",maxDailyBudget:body.maxDailyBudget??null});
  return json({data},201);
 }

 if(action==="link_campaign"){
  if(!providers.has(provider))return json({error:"Supported providers are google_ads, meta_ads and supermetrics"},400);
  const data=await linkAdCampaign(db,{provider,externalCampaignId:String(body.externalCampaignId||""),externalCampaignName:body.externalCampaignName?String(body.externalCampaignName):undefined,campaignId:String(body.campaignId||""),actorId:actor.email});
  await securityAudit(db,actor,"ad_spend.campaign.link","marketing_campaign",String(body.campaignId||""),"completed",{provider,externalCampaignId:body.externalCampaignId});
  return json({data});
 }

 if(action==="sync"){
  if(!providers.has(provider))return json({error:"Supported providers are google_ads, meta_ads and supermetrics"},400);
  const data=await syncAdSpend(db,{provider,externalAccountId:String(body.externalAccountId||""),start:String(body.start||""),end:String(body.end||""),actorId:actor.email});
  await securityAudit(db,actor,"ad_spend.sync","ad_spend_source",`${provider}:${String(body.externalAccountId||"")}`,"completed",{status:data.status,days:data.days,spend:data.spend});
  return json({data});
 }

 if(action==="sync_all"){
  const data=await syncAllAdSpend(db,{lookbackDays:body.lookbackDays?Number(body.lookbackDays):undefined,actorId:actor.email});
  await securityAudit(db,actor,"ad_spend.sync_all","ad_spend_source","all","completed",{processed:data.processed});
  return json({data});
 }

 if(action==="apply_change"){
  // Changing a live campaign is a separate, higher bar than reading from it.
  if(!providers.has(provider))return json({error:"Supported providers are google_ads and meta_ads"},400);
  const change=typeof body.change==="object"&&body.change?body.change as Record<string,unknown>:{};
  const data=await applyAdPlatformChange(db,{provider,externalAccountId:String(body.externalAccountId||""),externalCampaignId:String(body.externalCampaignId||""),
   change:{type:String(change.type||"") as "pause"|"resume"|"set_daily_budget",dailyBudget:change.dailyBudget==null?undefined:Number(change.dailyBudget)},
   reason:String(body.reason||""),approvalReference:String(body.approvalReference||""),idempotencyKey:String(body.idempotencyKey||""),actorId:actor.email});
  await securityAudit(db,actor,"ad_spend.platform_change","ad_campaign",String(body.externalCampaignId||""),"completed",{provider,change,status:(data as Row)?.status,reason:body.reason,approvalReference:body.approvalReference});
  return json({data});
 }

 return json({error:"Unsupported ad spend action"},400);
}catch(error){return authError(error,"Unable to update ad spend connectors");}}
