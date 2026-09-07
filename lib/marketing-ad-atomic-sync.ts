import{ensureMarketingAdConnectorTables,syncGoogleAdsMetrics,syncMetaAdsMetrics,type MarketingAdPlatform}from"./marketing-ad-connectors";

type Db=D1Database;type Fetcher=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
const METRIC_COLUMNS="dimension_key,platform,account_id,report_date,dimension_type,campaign_id,campaign_name,ad_set_id,ad_set_name,ad_id,ad_name,keyword,search_term,match_type,device,age_range,gender,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,current_bid_minor,pulled_at,updated_at";

function stageSql(sql:string){return sql.replace(/\bmarketing_ad_metric_facts\b/g,"marketing_ad_metric_stage").replace(/\bmarketing_ad_sync_runs\b/g,"marketing_ad_sync_runs_stage");}
function stageDb(db:Db):Db{
 return{prepare:(sql:string)=>db.prepare(stageSql(sql)),batch:(statements:any[])=>db.batch(statements)}as unknown as Db;
}
async function prepareStage(db:Db,platform:MarketingAdPlatform,from:string,to:string){
 const staged=stageDb(db);await ensureMarketingAdConnectorTables(staged);
 await db.batch([
  db.prepare("DELETE FROM marketing_ad_metric_stage WHERE platform=? AND report_date>=? AND report_date<=?").bind(platform,from,to),
  db.prepare("DELETE FROM marketing_ad_sync_runs_stage WHERE platform=? AND from_date=? AND to_date=?").bind(platform,from,to),
 ]);
 return staged;
}
async function promote(db:Db,platform:MarketingAdPlatform,from:string,to:string,rowsWritten:number){
 await ensureMarketingAdConnectorTables(db);const now=Date.now(),runId=`MADSYNC-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.batch([
  db.prepare("DELETE FROM marketing_ad_metric_facts WHERE platform=? AND report_date>=? AND report_date<=?").bind(platform,from,to),
  db.prepare(`INSERT INTO marketing_ad_metric_facts (${METRIC_COLUMNS}) SELECT ${METRIC_COLUMNS} FROM marketing_ad_metric_stage WHERE platform=? AND report_date>=? AND report_date<=?`).bind(platform,from,to),
  db.prepare("INSERT INTO marketing_ad_sync_runs (id,platform,from_date,to_date,status,rows_written,external_read,attempts,last_error,started_at,finished_at,updated_at) VALUES (?,?,?,?,'completed',?,1,1,NULL,?,?,?) ON CONFLICT(platform,from_date,to_date) DO UPDATE SET status='completed',rows_written=excluded.rows_written,external_read=1,attempts=marketing_ad_sync_runs.attempts+1,last_error=NULL,started_at=excluded.started_at,finished_at=excluded.finished_at,updated_at=excluded.updated_at").bind(runId,platform,from,to,rowsWritten,now,now,now),
 ]);
}

export async function syncGoogleAdsMetricsAtomic(db:Db,runtime:Record<string,unknown>,input:{from:string;to:string;fetchImpl?:Fetcher}){
 const staged=await prepareStage(db,"google_ads",input.from,input.to);const result=await syncGoogleAdsMetrics(staged,runtime,input);
 if(result.status!=="completed")return result;await promote(db,"google_ads",input.from,input.to,result.rowsWritten);
 return{...result,atomicPromotion:true,duplicatePrevented:false};
}
export async function syncMetaAdsMetricsAtomic(db:Db,runtime:Record<string,unknown>,input:{from:string;to:string;fetchImpl?:Fetcher}){
 const staged=await prepareStage(db,"meta_ads",input.from,input.to);const result=await syncMetaAdsMetrics(staged,runtime,input);
 if(result.status!=="completed")return result;await promote(db,"meta_ads",input.from,input.to,result.rowsWritten);
 return{...result,atomicPromotion:true,duplicatePrevented:false};
}
export async function syncMarketingAdMetricsAtomic(db:Db,runtime:Record<string,unknown>,input:{from:string;to:string;fetchImpl?:Fetcher}){
 const settled=await Promise.allSettled([syncGoogleAdsMetricsAtomic(db,runtime,input),syncMetaAdsMetricsAtomic(db,runtime,input)]);
 return settled.map((result,index)=>result.status==="fulfilled"?result.value:{platform:index===0?"google_ads":"meta_ads",status:"failed",error:result.reason instanceof Error?result.reason.message:String(result.reason),rowsWritten:0,externalRead:false,atomicPromotion:false});
}
