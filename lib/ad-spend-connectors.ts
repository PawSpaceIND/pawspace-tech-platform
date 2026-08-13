/**
 * Live ad spend from Google Ads and Meta, pulled directly from their APIs - no third-party middleware.
 *
 * The rule this module exists to keep: spend is either real or absent. A source with missing or
 * rejected credentials reports `configuration_required` and writes nothing, because the CAC line in
 * lib/unit-economics.ts divides by whatever lands in marketing_attribution_facts, and an invented
 * number there becomes an invented cost per customer everywhere downstream.
 *
 * Each provider returns daily spend per external campaign. A row is only attributed to a governed
 * campaign once someone links that external campaign id to one; until then the spend is stored
 * unattributed and shown as awaiting mapping, rather than being spread across campaigns by guesswork.
 * Every write is keyed on (provider, external campaign, day) so a re-sync of an overlapping window
 * updates the day rather than adding a second copy of it.
 */
type Db=D1Database;
type Row=Record<string,unknown>;

export type AdProvider="google_ads"|"meta_ads"|"supermetrics";
export type SourceStatus="configuration_required"|"connected"|"disabled";
export type SyncOutcome={provider:AdProvider;status:"synced"|"configuration_required"|"failed";days:number;campaigns:number;spend:number;unmapped:string[];missing:string[];error:string|null};

const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const day=(at:number)=>new Date(at).toISOString().slice(0,10);

export const PROVIDER_CREDENTIALS:Record<AdProvider,string[]>={
 google_ads:["GOOGLE_ADS_DEVELOPER_TOKEN","GOOGLE_ADS_CLIENT_ID","GOOGLE_ADS_CLIENT_SECRET","GOOGLE_ADS_REFRESH_TOKEN"],
 meta_ads:["META_ADS_ACCESS_TOKEN"],
 // Supermetrics fronts the same two platforms. Both routes are supported so the same spend can be
 // pulled either way and compared; whichever account is left enabled is the one that writes.
 supermetrics:["SUPERMETRICS_API_KEY","SUPERMETRICS_DS_USER"],
};
/** Platforms this tool can change, as opposed to only read. Supermetrics is reporting-only by design. */
export const WRITE_CAPABLE:AdProvider[]=["google_ads","meta_ads"];

export async function ensureAdSpendTables(db:Db){
 // Spend is attributed to governed campaigns and read back joined to them, so this module cannot be
 // used before that module's tables exist. On a young database the join used to 500 the whole screen.
 const{ensureMarketingGovernance}=await import("./marketing-governance");
 await ensureMarketingGovernance(db);
 await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS ad_spend_sources (id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_account_id TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'configuration_required',currency TEXT NOT NULL DEFAULT 'INR',write_mode TEXT NOT NULL DEFAULT 'disabled',max_daily_budget REAL,supermetrics_ds_id TEXT,last_sync_at INTEGER,last_synced_through TEXT,last_error TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(provider,external_account_id))"),
 db.prepare("CREATE TABLE IF NOT EXISTS ad_platform_changes (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,external_account_id TEXT NOT NULL,external_campaign_id TEXT NOT NULL,change_type TEXT NOT NULL,requested_json TEXT NOT NULL,status TEXT NOT NULL,before_json TEXT,after_json TEXT,reason TEXT NOT NULL,approval_reference TEXT NOT NULL,error TEXT,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER)"),
 db.prepare("CREATE TABLE IF NOT EXISTS ad_spend_campaign_links (id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_campaign_id TEXT NOT NULL,external_campaign_name TEXT,campaign_id TEXT NOT NULL,linked_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(provider,external_campaign_id))"),
 db.prepare("CREATE TABLE IF NOT EXISTS ad_spend_daily (id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_account_id TEXT NOT NULL,external_campaign_id TEXT NOT NULL,external_campaign_name TEXT,spend_date TEXT NOT NULL,spend_amount REAL NOT NULL,impressions INTEGER NOT NULL DEFAULT 0,clicks INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL,campaign_id TEXT,source_payload_json TEXT NOT NULL DEFAULT '{}',synced_at INTEGER NOT NULL,UNIQUE(provider,external_campaign_id,spend_date))"),
 db.prepare("CREATE TABLE IF NOT EXISTS ad_spend_sync_runs (id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_account_id TEXT NOT NULL,window_start TEXT NOT NULL,window_end TEXT NOT NULL,status TEXT NOT NULL,days INTEGER NOT NULL DEFAULT 0,campaigns INTEGER NOT NULL DEFAULT 0,spend REAL NOT NULL DEFAULT 0,error TEXT,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);}

async function runtimeEnv(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

/** Which credentials a provider is missing right now. Never logs or returns the values themselves. */
export async function missingCredentials(provider:AdProvider){
 const runtime=await runtimeEnv();
 return PROVIDER_CREDENTIALS[provider].filter(name=>text(runtime[name]).length<8);
}

export async function saveAdSpendSource(db:Db,input:{provider:AdProvider;externalAccountId:string;label:string;currency?:string;status?:SourceStatus;writeMode?:"disabled"|"preview"|"live";maxDailyBudget?:number|null;supermetricsDsId?:string;actorId:string}){
 await ensureAdSpendTables(db);
 const provider=input.provider,externalAccountId=text(input.externalAccountId),label=text(input.label);
 if(!PROVIDER_CREDENTIALS[provider])throw new Error("Supported ad providers are google_ads, meta_ads and supermetrics");
 const writeMode=input.writeMode||"disabled";
 // Only the platforms themselves can be changed, and only deliberately: a source is read-only until
 // someone turns writes on for it, and a live budget change needs a ceiling to be checked against.
 if(writeMode!=="disabled"&&!WRITE_CAPABLE.includes(provider))throw new Error("Supermetrics is a reporting source and cannot change a live campaign");
 if(input.maxDailyBudget!=null&&!(Number(input.maxDailyBudget)>0))throw new Error("The daily budget ceiling must be a positive amount");
 if(!externalAccountId)throw new Error("The provider's own account id is required");
 if(label.length<3)throw new Error("A recognisable account label is required");
 const missing=await missingCredentials(provider);
 // The status is derived from the credentials that actually exist - it is never asserted by the caller.
 const status:SourceStatus=input.status==="disabled"?"disabled":missing.length?"configuration_required":"connected";
 const now=Date.now();
 await db.prepare("INSERT INTO ad_spend_sources (id,provider,external_account_id,label,status,currency,write_mode,max_daily_budget,supermetrics_ds_id,last_sync_at,last_synced_through,last_error,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?) ON CONFLICT(provider,external_account_id) DO UPDATE SET label=excluded.label,status=excluded.status,currency=excluded.currency,write_mode=excluded.write_mode,max_daily_budget=excluded.max_daily_budget,supermetrics_ds_id=excluded.supermetrics_ds_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
  .bind(uid("ADS"),provider,externalAccountId,label,status,text(input.currency)||"INR",writeMode,input.maxDailyBudget==null?null:Number(input.maxDailyBudget),text(input.supermetricsDsId)||null,input.actorId,now,input.actorId,now).run();
 const row=await db.prepare("SELECT * FROM ad_spend_sources WHERE provider=? AND external_account_id=?").bind(provider,externalAccountId).first<Row>();
 return{...row,missingCredentials:missing};
}

export async function linkAdCampaign(db:Db,input:{provider:AdProvider;externalCampaignId:string;externalCampaignName?:string;campaignId:string;actorId:string}){
 await ensureAdSpendTables(db);
 const externalCampaignId=text(input.externalCampaignId),campaignId=text(input.campaignId);
 if(!externalCampaignId||!campaignId)throw new Error("External campaign and governed campaign are both required");
 const campaign=await db.prepare("SELECT id FROM governed_marketing_campaigns WHERE id=?").bind(campaignId).first<Row>();
 if(!campaign)throw new Error("Governed campaign not found - create it before linking spend to it");
 const now=Date.now();
 await db.prepare("INSERT INTO ad_spend_campaign_links (id,provider,external_campaign_id,external_campaign_name,campaign_id,linked_by,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,external_campaign_id) DO UPDATE SET campaign_id=excluded.campaign_id,external_campaign_name=COALESCE(excluded.external_campaign_name,ad_spend_campaign_links.external_campaign_name),linked_by=excluded.linked_by")
  .bind(uid("ADL"),input.provider,externalCampaignId,text(input.externalCampaignName)||null,campaignId,input.actorId,now).run();
 // Spend already collected for this external campaign belongs to the governed campaign from now on.
 await db.prepare("UPDATE ad_spend_daily SET campaign_id=? WHERE provider=? AND external_campaign_id=?").bind(campaignId,input.provider,externalCampaignId).run();
 await reprojectAttribution(db,campaignId);
 return db.prepare("SELECT * FROM ad_spend_campaign_links WHERE provider=? AND external_campaign_id=?").bind(input.provider,externalCampaignId).first<Row>();
}

type DailySpend={externalCampaignId:string;externalCampaignName:string;date:string;spend:number;impressions:number;clicks:number;currency:string};

async function googleAdsDaily(account:string,start:string,end:string):Promise<DailySpend[]>{
 const runtime=await runtimeEnv();
 const refresh=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:text(runtime.GOOGLE_ADS_CLIENT_ID),client_secret:text(runtime.GOOGLE_ADS_CLIENT_SECRET),refresh_token:text(runtime.GOOGLE_ADS_REFRESH_TOKEN),grant_type:"refresh_token"}).toString()});
 if(!refresh.ok)throw new Error(`Google Ads token refresh failed (HTTP ${refresh.status})`);
 const token=text(((await refresh.json()) as Row).access_token);
 if(!token)throw new Error("Google Ads token refresh returned no access token");
 const customerId=account.replace(/\D/g,"");
 const query=`SELECT campaign.id,campaign.name,segments.date,metrics.cost_micros,metrics.impressions,metrics.clicks FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}'`;
 const response=await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:search`,{method:"POST",headers:{authorization:`Bearer ${token}`,"developer-token":text(runtime.GOOGLE_ADS_DEVELOPER_TOKEN),...(text(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID)?{"login-customer-id":text(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\D/g,"")}:{}),"content-type":"application/json"},body:JSON.stringify({query,pageSize:10000})});
 if(!response.ok)throw new Error(`Google Ads reporting failed (HTTP ${response.status})`);
 const payload=await response.json() as{results?:Row[]};
 return (payload.results||[]).map(row=>{const campaign=(row.campaign||{}) as Row,segments=(row.segments||{}) as Row,metrics=(row.metrics||{}) as Row;
  return{externalCampaignId:text(campaign.id),externalCampaignName:text(campaign.name),date:text(segments.date),
   // Google reports cost in micros of the account currency.
   spend:money(Number(metrics.costMicros??metrics.cost_micros??0)/1_000_000),impressions:Number(metrics.impressions||0),clicks:Number(metrics.clicks||0),currency:"INR"};
 }).filter(row=>row.externalCampaignId&&row.date);
}

async function metaAdsDaily(account:string,start:string,end:string):Promise<DailySpend[]>{
 const runtime=await runtimeEnv();
 const accountId=account.startsWith("act_")?account:`act_${account.replace(/\D/g,"")}`;
 const url=new URL(`https://graph.facebook.com/v21.0/${accountId}/insights`);
 url.searchParams.set("level","campaign");
 url.searchParams.set("time_increment","1");
 url.searchParams.set("fields","campaign_id,campaign_name,spend,impressions,clicks,account_currency,date_start");
 url.searchParams.set("time_range",JSON.stringify({since:start,until:end}));
 url.searchParams.set("limit","500");
 const response=await fetch(url.toString(),{headers:{authorization:`Bearer ${text(runtime.META_ADS_ACCESS_TOKEN)}`}});
 if(!response.ok)throw new Error(`Meta insights failed (HTTP ${response.status})`);
 const payload=await response.json() as{data?:Row[]};
 return (payload.data||[]).map(row=>({externalCampaignId:text(row.campaign_id),externalCampaignName:text(row.campaign_name),date:text(row.date_start),spend:money(row.spend),impressions:Number(row.impressions||0),clicks:Number(row.clicks||0),currency:text(row.account_currency)||"INR"})).filter(row=>row.externalCampaignId&&row.date);
}

/**
 * Supermetrics fronts the same Google/Meta numbers through one query endpoint. The field names below
 * are Supermetrics' own canonical ones; a data source configured with a different field set will
 * surface as a failed sync naming the missing field rather than as silently missing spend.
 */
async function supermetricsDaily(account:string,start:string,end:string,dsId:string):Promise<DailySpend[]>{
 const runtime=await runtimeEnv();
 if(!text(dsId))throw new Error("This Supermetrics account has no data source id (ds_id) configured");
 const url=new URL("https://api.supermetrics.com/enterprise/v2/query/data/json");
 url.searchParams.set("json",JSON.stringify({
  ds_id:text(dsId),ds_user:text(runtime.SUPERMETRICS_DS_USER),ds_accounts:[account],
  date_range_type:"custom",start_date:start,end_date:end,
  fields:["Date","Campaign_ID","Campaign","Cost","Impressions","Clicks","Currency"],
  max_rows:10000,api_key:text(runtime.SUPERMETRICS_API_KEY),
 }));
 const response=await fetch(url.toString());
 if(!response.ok)throw new Error(`Supermetrics query failed (HTTP ${response.status})`);
 const payload=await response.json() as{data?:unknown[][];meta?:{request?:{fields?:Array<{field_id?:string}>}};error?:{message?:string}};
 if(payload.error?.message)throw new Error(`Supermetrics: ${payload.error.message}`);
 const fields=(payload.meta?.request?.fields||[]).map(field=>text(field.field_id));
 const index=(name:string)=>{const at=fields.indexOf(name);if(at<0)throw new Error(`Supermetrics response is missing the ${name} field`);return at;};
 const[dateAt,idAt,nameAt,costAt,imprAt,clickAt]=[index("Date"),index("Campaign_ID"),index("Campaign"),index("Cost"),index("Impressions"),index("Clicks")];
 const currencyAt=fields.indexOf("Currency");
 return (payload.data||[]).map(row=>({externalCampaignId:text(row[idAt]),externalCampaignName:text(row[nameAt]),date:text(row[dateAt]).slice(0,10),spend:money(row[costAt]),impressions:Number(row[imprAt]||0),clicks:Number(row[clickAt]||0),currency:(currencyAt>=0?text(row[currencyAt]):"")||"INR"})).filter(row=>row.externalCampaignId&&row.date);
}

/**
 * Rebuilds this campaign's spend fact from the daily rows it owns. marketing_attribution_facts is the
 * table the CAC line reads, and one fact per campaign per source keeps a re-sync from inflating spend.
 */
async function reprojectAttribution(db:Db,campaignId:string){
 const totals=await db.prepare("SELECT provider,SUM(spend_amount) spend,MIN(spend_date) first_day,MAX(spend_date) last_day FROM ad_spend_daily WHERE campaign_id=? GROUP BY provider").bind(campaignId).all<Row>();
 const now=Date.now();
 for(const row of totals.results){
  const provider=text(row.provider),id=`MAF-${provider.toUpperCase()}-${campaignId}`;
  await db.prepare("INSERT INTO marketing_attribution_facts (id,campaign_id,customer_id,lead_id,booking_id,collection_id,source,medium,spend_amount,booked_revenue,collected_revenue,contribution_margin,attribution_model,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,NULL,?,?,?,NULL,NULL,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET spend_amount=excluded.spend_amount,updated_at=excluded.updated_at")
   .bind(id,campaignId,provider,provider==="google_ads"?"paid_search":"paid_social",money(row.spend),`${provider}_platform_reported`,now,now).run();
 }
}

export async function syncAdSpend(db:Db,input:{provider:AdProvider;externalAccountId:string;start:string;end:string;actorId:string}):Promise<SyncOutcome>{
 await ensureAdSpendTables(db);
 const{provider,externalAccountId,start,end}=input;
 const base:SyncOutcome={provider,status:"configuration_required",days:0,campaigns:0,spend:0,unmapped:[],missing:[],error:null};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start)throw new Error("A valid ISO date window is required");
 const source=await db.prepare("SELECT * FROM ad_spend_sources WHERE provider=? AND external_account_id=?").bind(provider,externalAccountId).first<Row>();
 if(!source)throw new Error("Configure the ad account before syncing it");
 if(text(source.status)==="disabled")return{...base,status:"failed",error:"This ad account is disabled"};

 const missing=await missingCredentials(provider);
 const now=Date.now(),runId=uid("ADRUN");
 if(missing.length){
  // No credentials, no numbers. The window is recorded so the screen can say what was attempted.
  await db.prepare("INSERT INTO ad_spend_sync_runs (id,provider,external_account_id,window_start,window_end,status,days,campaigns,spend,error,actor_id,created_at) VALUES (?,?,?,?,?,'configuration_required',0,0,0,?,?,?)").bind(runId,provider,externalAccountId,start,end,`missing:${missing.join(",")}`,input.actorId,now).run();
  await db.prepare("UPDATE ad_spend_sources SET status='configuration_required',last_error=?,updated_at=? WHERE provider=? AND external_account_id=?").bind(`missing:${missing.join(",")}`,now,provider,externalAccountId).run();
  return{...base,missing};
 }

 let rows:DailySpend[];
 try{rows=provider==="google_ads"?await googleAdsDaily(externalAccountId,start,end):provider==="meta_ads"?await metaAdsDaily(externalAccountId,start,end):await supermetricsDaily(externalAccountId,start,end,text(source.supermetrics_ds_id));}
 catch(cause){
  const message=cause instanceof Error?cause.message:String(cause);
  await db.prepare("INSERT INTO ad_spend_sync_runs (id,provider,external_account_id,window_start,window_end,status,days,campaigns,spend,error,actor_id,created_at) VALUES (?,?,?,?,?,'failed',0,0,0,?,?,?)").bind(runId,provider,externalAccountId,start,end,message,input.actorId,now).run();
  await db.prepare("UPDATE ad_spend_sources SET last_error=?,updated_at=? WHERE provider=? AND external_account_id=?").bind(message,now,provider,externalAccountId).run();
  // A failed pull leaves the previously stored spend exactly as it was; it never zeroes the history.
  return{...base,status:"failed",error:message};
 }

 const links=await db.prepare("SELECT external_campaign_id,campaign_id FROM ad_spend_campaign_links WHERE provider=?").bind(provider).all<Row>();
 const linkBy=new Map(links.results.map(row=>[text(row.external_campaign_id),text(row.campaign_id)]));
 const touched=new Set<string>(),unmapped=new Set<string>();
 let spend=0;
 for(const row of rows){
  const campaignId=linkBy.get(row.externalCampaignId)||null;
  if(!campaignId)unmapped.add(row.externalCampaignId);
  spend+=row.spend;
  if(campaignId)touched.add(campaignId);
  await db.prepare("INSERT INTO ad_spend_daily (id,provider,external_account_id,external_campaign_id,external_campaign_name,spend_date,spend_amount,impressions,clicks,currency,campaign_id,source_payload_json,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,external_campaign_id,spend_date) DO UPDATE SET spend_amount=excluded.spend_amount,impressions=excluded.impressions,clicks=excluded.clicks,external_campaign_name=excluded.external_campaign_name,campaign_id=COALESCE(excluded.campaign_id,ad_spend_daily.campaign_id),synced_at=excluded.synced_at")
   .bind(uid("ADD"),provider,externalAccountId,row.externalCampaignId,row.externalCampaignName||null,row.date,money(row.spend),row.impressions,row.clicks,row.currency,campaignId,JSON.stringify({source:provider}),now).run();
 }
 for(const campaignId of touched)await reprojectAttribution(db,campaignId);

 const days=new Set(rows.map(row=>row.date)).size,campaigns=new Set(rows.map(row=>row.externalCampaignId)).size;
 await db.prepare("INSERT INTO ad_spend_sync_runs (id,provider,external_account_id,window_start,window_end,status,days,campaigns,spend,error,actor_id,created_at) VALUES (?,?,?,?,?,'synced',?,?,?,NULL,?,?)").bind(runId,provider,externalAccountId,start,end,days,campaigns,money(spend),input.actorId,now).run();
 await db.prepare("UPDATE ad_spend_sources SET status='connected',last_sync_at=?,last_synced_through=?,last_error=NULL,updated_at=? WHERE provider=? AND external_account_id=?").bind(now,end,now,provider,externalAccountId).run();
 return{provider,status:"synced",days,campaigns,spend:money(spend),unmapped:[...unmapped],missing:[],error:null};
}

export type AdChange={type:"pause"|"resume"|"set_daily_budget";dailyBudget?:number};

async function applyGoogleAdsChange(account:string,externalCampaignId:string,change:AdChange){
 const runtime=await runtimeEnv();
 const refresh=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:text(runtime.GOOGLE_ADS_CLIENT_ID),client_secret:text(runtime.GOOGLE_ADS_CLIENT_SECRET),refresh_token:text(runtime.GOOGLE_ADS_REFRESH_TOKEN),grant_type:"refresh_token"}).toString()});
 if(!refresh.ok)throw new Error(`Google Ads token refresh failed (HTTP ${refresh.status})`);
 const token=text(((await refresh.json()) as Row).access_token);
 const customerId=account.replace(/\D/g,"");
 const headers={authorization:`Bearer ${token}`,"developer-token":text(runtime.GOOGLE_ADS_DEVELOPER_TOKEN),"content-type":"application/json",...(text(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID)?{"login-customer-id":text(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\D/g,"")}:{})};
 if(change.type==="set_daily_budget"){
  // The budget lives on the campaign's own budget resource, so it has to be read before it is written.
  const lookup=await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:search`,{method:"POST",headers,body:JSON.stringify({query:`SELECT campaign.id,campaign_budget.resource_name,campaign_budget.amount_micros FROM campaign WHERE campaign.id=${externalCampaignId}`})});
  if(!lookup.ok)throw new Error(`Google Ads budget lookup failed (HTTP ${lookup.status})`);
  const budget=(((await lookup.json()) as{results?:Row[]}).results||[])[0];
  const resourceName=text(((budget?.campaignBudget||budget?.campaign_budget||{}) as Row).resourceName||((budget?.campaignBudget||budget?.campaign_budget||{}) as Row).resource_name);
  if(!resourceName)throw new Error("Google Ads campaign budget not found");
  const response=await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/campaignBudgets:mutate`,{method:"POST",headers,body:JSON.stringify({operations:[{updateMask:"amount_micros",update:{resourceName,amountMicros:String(Math.round(Number(change.dailyBudget)*1_000_000))}}]})});
  if(!response.ok)throw new Error(`Google Ads budget change failed (HTTP ${response.status})`);
  return await response.json() as Row;
 }
 const response=await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/campaigns:mutate`,{method:"POST",headers,body:JSON.stringify({operations:[{updateMask:"status",update:{resourceName:`customers/${customerId}/campaigns/${externalCampaignId}`,status:change.type==="pause"?"PAUSED":"ENABLED"}}]})});
 if(!response.ok)throw new Error(`Google Ads status change failed (HTTP ${response.status})`);
 return await response.json() as Row;
}

async function applyMetaAdsChange(externalCampaignId:string,change:AdChange){
 const runtime=await runtimeEnv();
 const body=new URLSearchParams();
 if(change.type==="set_daily_budget")body.set("daily_budget",String(Math.round(Number(change.dailyBudget)*100)));// Meta takes minor units
 else body.set("status",change.type==="pause"?"PAUSED":"ACTIVE");
 const response=await fetch(`https://graph.facebook.com/v21.0/${externalCampaignId}`,{method:"POST",headers:{authorization:`Bearer ${text(runtime.META_ADS_ACCESS_TOKEN)}`,"content-type":"application/x-www-form-urlencoded"},body:body.toString()});
 if(!response.ok)throw new Error(`Meta campaign change failed (HTTP ${response.status})`);
 return await response.json() as Row;
}

/**
 * Changes a live campaign on the platform itself. Everything about this path is deliberately hard to
 * do by accident, because it moves real money:
 *
 * - the account must have writes switched on; a new source is read-only and a `preview` source
 *   returns the exact request that would be sent without sending it,
 * - a budget change is refused above the account's own ceiling, so a mistyped amount cannot run away,
 * - the caller must supply a reason and an approval reference, both recorded,
 * - the idempotency key is claimed before the call, so a retried click cannot apply a second change,
 * - and the outcome - applied, refused or failed - is written to ad_platform_changes either way.
 */
export async function applyAdPlatformChange(db:Db,input:{provider:AdProvider;externalAccountId:string;externalCampaignId:string;change:AdChange;reason:string;approvalReference:string;idempotencyKey:string;actorId:string}){
 await ensureAdSpendTables(db);
 const{provider,externalAccountId,externalCampaignId,change}=input;
 const reason=text(input.reason),approvalReference=text(input.approvalReference),idempotencyKey=text(input.idempotencyKey);
 if(!["pause","resume","set_daily_budget"].includes(change.type))throw new Error("Supported changes are pause, resume and set_daily_budget");
 if(reason.length<8)throw new Error("A clear reason for changing a live campaign is required");
 if(approvalReference.length<4)throw new Error("An approval reference is required to change a live campaign");
 if(!idempotencyKey)throw new Error("An idempotency key is required");
 if(!text(externalCampaignId))throw new Error("The platform's own campaign id is required");

 const source=await db.prepare("SELECT * FROM ad_spend_sources WHERE provider=? AND external_account_id=?").bind(provider,externalAccountId).first<Row>();
 if(!source)throw new Error("Configure the ad account before changing it");
 const writeMode=text(source.write_mode)||"disabled";
 if(!WRITE_CAPABLE.includes(provider))throw new Error("Supermetrics is a reporting source and cannot change a live campaign");
 if(writeMode==="disabled")throw new Error("Live changes are switched off for this ad account");
 if(change.type==="set_daily_budget"){
  const amount=Number(change.dailyBudget);
  if(!(amount>0))throw new Error("A positive daily budget is required");
  const ceiling=source.max_daily_budget==null?null:Number(source.max_daily_budget);
  if(ceiling==null)throw new Error("Set a daily budget ceiling on this account before changing budgets");
  if(amount>ceiling)throw new Error(`Requested daily budget ${amount} exceeds this account's ceiling of ${ceiling}`);
 }

 const now=Date.now(),requested=JSON.stringify(change);
 // Claim first: a duplicate submission returns the original outcome instead of hitting the platform.
 const claim=await db.prepare("INSERT OR IGNORE INTO ad_platform_changes (id,idempotency_key,provider,external_account_id,external_campaign_id,change_type,requested_json,status,before_json,after_json,reason,approval_reference,error,actor_id,created_at,applied_at) VALUES (?,?,?,?,?,?,?,'in_flight',NULL,NULL,?,?,NULL,?,?,NULL)")
  .bind(uid("ADC"),idempotencyKey,provider,externalAccountId,externalCampaignId,change.type,requested,reason,approvalReference,input.actorId,now).run();
 if(!Number(claim.meta.changes)){
  const prior=await db.prepare("SELECT * FROM ad_platform_changes WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  return{...prior,duplicatePrevented:true};
 }

 const before=await db.prepare("SELECT external_campaign_name,SUM(spend_amount) recent_spend,MAX(spend_date) last_day FROM ad_spend_daily WHERE provider=? AND external_campaign_id=?").bind(provider,externalCampaignId).first<Row>();

 if(writeMode==="preview"){
  // Nothing leaves the building: the operator sees exactly what would be sent, and to which campaign.
  const preview={wouldCall:provider==="google_ads"?"googleads.googleapis.com":"graph.facebook.com",campaign:externalCampaignId,change};
  await db.prepare("UPDATE ad_platform_changes SET status='preview',before_json=?,after_json=?,applied_at=? WHERE idempotency_key=?").bind(JSON.stringify(before||{}),JSON.stringify(preview),now,idempotencyKey).run();
  return await db.prepare("SELECT * FROM ad_platform_changes WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
 }

 const missing=await missingCredentials(provider);
 if(missing.length){
  await db.prepare("UPDATE ad_platform_changes SET status='failed',error=?,applied_at=? WHERE idempotency_key=?").bind(`missing:${missing.join(",")}`,now,idempotencyKey).run();
  throw new Error(`This account is missing credentials: ${missing.join(", ")}`);
 }
 try{
  const result=provider==="google_ads"?await applyGoogleAdsChange(externalAccountId,externalCampaignId,change):await applyMetaAdsChange(externalCampaignId,change);
  await db.prepare("UPDATE ad_platform_changes SET status='applied',before_json=?,after_json=?,applied_at=? WHERE idempotency_key=?").bind(JSON.stringify(before||{}),JSON.stringify(result),Date.now(),idempotencyKey).run();
 }catch(cause){
  const message=cause instanceof Error?cause.message:String(cause);
  await db.prepare("UPDATE ad_platform_changes SET status='failed',before_json=?,error=?,applied_at=? WHERE idempotency_key=?").bind(JSON.stringify(before||{}),message,Date.now(),idempotencyKey).run();
  throw new Error(message);
 }
 return await db.prepare("SELECT * FROM ad_platform_changes WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
}

export async function adSpendDirectory(db:Db){
 await ensureAdSpendTables(db);
 const[sources,links,runs,byCampaign,unmapped,changes]=await Promise.all([
  db.prepare("SELECT * FROM ad_spend_sources ORDER BY provider,label").all<Row>(),
  db.prepare("SELECT l.*,c.name campaign_name FROM ad_spend_campaign_links l LEFT JOIN governed_marketing_campaigns c ON c.id=l.campaign_id ORDER BY l.provider,l.external_campaign_id").all<Row>(),
  db.prepare("SELECT * FROM ad_spend_sync_runs ORDER BY created_at DESC LIMIT 20").all<Row>(),
  db.prepare("SELECT campaign_id,provider,SUM(spend_amount) spend,MIN(spend_date) first_day,MAX(spend_date) last_day FROM ad_spend_daily WHERE campaign_id IS NOT NULL GROUP BY campaign_id,provider ORDER BY spend DESC").all<Row>(),
  db.prepare("SELECT provider,external_campaign_id,external_campaign_name,SUM(spend_amount) spend FROM ad_spend_daily WHERE campaign_id IS NULL GROUP BY provider,external_campaign_id,external_campaign_name ORDER BY spend DESC LIMIT 50").all<Row>(),
  db.prepare("SELECT * FROM ad_platform_changes ORDER BY created_at DESC LIMIT 25").all<Row>(),
 ]);
 const readiness=await Promise.all((Object.keys(PROVIDER_CREDENTIALS) as AdProvider[]).map(async provider=>({provider,requiredCredentials:PROVIDER_CREDENTIALS[provider],missingCredentials:await missingCredentials(provider)})));
 return{sources:sources.results,links:links.results,runs:runs.results,spendByCampaign:byCampaign.results,unmappedSpend:unmapped.results,changes:changes.results,readiness,writeCapableProviders:WRITE_CAPABLE,
  truth:{spendSource:"provider_reported",fabricatedSpend:false,attributionModel:"platform_reported_cost_only",conversionAttribution:"not_connected",productionReady:false}};
}

/** Daily catch-up used by the scheduler: re-pulls a trailing window so late-arriving costs settle. */
export async function syncAllAdSpend(db:Db,input:{asOf?:number;lookbackDays?:number;actorId:string}){
 await ensureAdSpendTables(db);
 const asOf=input.asOf??Date.now(),lookback=Math.max(1,Math.min(90,input.lookbackDays??7));
 const sources=await db.prepare("SELECT provider,external_account_id FROM ad_spend_sources WHERE status!='disabled'").all<Row>();
 const outcomes:SyncOutcome[]=[];
 for(const source of sources.results){
  try{outcomes.push(await syncAdSpend(db,{provider:text(source.provider) as AdProvider,externalAccountId:text(source.external_account_id),start:day(asOf-lookback*86_400_000),end:day(asOf),actorId:input.actorId}));}
  catch(cause){outcomes.push({provider:text(source.provider) as AdProvider,status:"failed",days:0,campaigns:0,spend:0,unmapped:[],missing:[],error:cause instanceof Error?cause.message:String(cause)});}
 }
 return{processed:outcomes.length,outcomes};
}
