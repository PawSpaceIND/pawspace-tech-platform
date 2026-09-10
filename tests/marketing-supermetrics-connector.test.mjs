import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {makeD1,installAiHooks} from "./helpers/ai-harness.mjs";
installAiHooks();
const mod=await import("../lib/marketing-supermetrics-connector.ts");
const fresh=()=>{const sqlite=new DatabaseSync(":memory:");return{sqlite,db:makeD1(sqlite)}};
const config=JSON.stringify({queries:[{name:"google-via-supermetrics",platform:"google_ads",ds_id:"ADWORDS",ds_accounts:"123",fields:"date,account_id,campaign_id,campaign_name,impressions,clicks,spend,conversions,conversion_value,currency"}]});

test("Supermetrics is fail-closed when not configured or disabled",async()=>{
 const {db}=fresh();
 let status=await mod.supermetricsConnectorStatus(db,{});assert.equal(status.state,"not_configured");
 let sync=await mod.syncSupermetricsMarketing(db,{SUPERMETRICS_API_KEY:"secret",SUPERMETRICS_QUERY_CONFIG_JSON:config},{from:"2026-09-10",to:"2026-09-10",fetchImpl:async()=>{throw new Error("must not call")}});assert.equal(sync.status,"disabled");
});

test("Supermetrics keyjson pull uses bearer auth and writes canonical marketing facts",async()=>{
 const {sqlite,db}=fresh();let request;
 const runtime={SUPERMETRICS_API_KEY:"secret-key",SUPERMETRICS_QUERY_CONFIG_JSON:config,PAWSPACE_SUPERMETRICS_SYNC_ENABLED:"true"};
 const result=await mod.syncSupermetricsMarketing(db,runtime,{from:"2026-09-10",to:"2026-09-10",fetchImpl:async(url,init)=>{request={url:String(url),init};return new Response(JSON.stringify([{date:"2026-09-10",account_id:"123",campaign_id:"C1",campaign_name:"Grooming",impressions:"1000",clicks:"100",spend:"250.50",conversions:"10",conversion_value:"900.00",currency:"INR"}]),{status:200,headers:{"x-request-id":"SM-1"}})}});
 assert.equal(request.url,"https://api.supermetrics.com/enterprise/v2/query/data/keyjson");
 assert.equal(request.init.headers.authorization,"Bearer secret-key");
 assert.equal(result.status,"completed");assert.equal(result.externalMutation,false);
 const row=sqlite.prepare("SELECT * FROM marketing_ad_metric_facts").get();assert.equal(row.platform,"google_ads");assert.equal(row.spend_minor,25050);assert.equal(row.conversion_value_minor,90000);
 const run=sqlite.prepare("SELECT * FROM marketing_supermetrics_sync_runs").get();assert.equal(run.status,"completed");assert.equal(run.request_id,"SM-1");
});

test("Supermetrics provider errors are audited without deleting prior canonical facts",async()=>{
 const {sqlite,db}=fresh();
 await mod.ensureSupermetricsTables(db);sqlite.exec("INSERT INTO marketing_ad_metric_facts (dimension_key,platform,account_id,report_date,dimension_type,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,pulled_at,updated_at) VALUES ('old','google_ads','1','2026-09-10','campaign',1,1,100,1,200,'INR',100,100,100,1,1)");
 const result=await mod.syncSupermetricsMarketing(db,{SUPERMETRICS_API_KEY:"secret",SUPERMETRICS_QUERY_CONFIG_JSON:config,PAWSPACE_SUPERMETRICS_SYNC_ENABLED:"true"},{from:"2026-09-10",to:"2026-09-10",fetchImpl:async()=>new Response("provider down",{status:503})});
 assert.equal(result.status,"partial_failure");assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_ad_metric_facts").get().n,1);assert.equal(sqlite.prepare("SELECT status FROM marketing_supermetrics_sync_runs").get().status,"failed");
});

test("Supermetrics GA4 rows land in canonical web analytics, never the ad-spend table",async()=>{
 const {sqlite,db}=fresh();
 const ga4Config=JSON.stringify({queries:[{name:"ga4-web",platform:"ga4",ds_id:"GAWA",ds_accounts:"property-1",fields:"date,source_medium,campaign_name,landing_page,device,sessions,users,new_users,engaged_sessions,conversions,conversion_value,currency"}]});
 const runtime={SUPERMETRICS_API_KEY:"secret-key",SUPERMETRICS_QUERY_CONFIG_JSON:ga4Config,PAWSPACE_SUPERMETRICS_SYNC_ENABLED:"true"};
 const result=await mod.syncSupermetricsMarketing(db,runtime,{from:"2026-09-10",to:"2026-09-10",fetchImpl:async()=>new Response(JSON.stringify([{date:"2026-09-10",source_medium:"google / organic",campaign_name:"(organic)",landing_page:"/services/grooming",device:"mobile",sessions:"120",users:"90",new_users:"40",engaged_sessions:"80",conversions:"6",conversion_value:"5400",currency:"INR"}]),{status:200})});
 assert.equal(result.status,"completed");
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_ad_metric_facts").get().n,0);
 const row=sqlite.prepare("SELECT * FROM marketing_web_metric_facts").get();assert.equal(row.source,"ga4");assert.equal(row.sessions,120);assert.equal(row.users,90);assert.equal(row.revenue_minor,540000);
 const snap=await mod.supermetricsWebAnalyticsSnapshot(db,{from:"2026-09-10",to:"2026-09-10"});assert.equal(snap.hasData,true);assert.equal(snap.sessions,120);assert.equal(snap.conversions,6);
});


test("Supermetrics completed window is idempotent and does not call provider twice",async()=>{
 const {sqlite,db}=fresh();let calls=0;
 const runtime={SUPERMETRICS_API_KEY:"secret-key",SUPERMETRICS_QUERY_CONFIG_JSON:config,PAWSPACE_SUPERMETRICS_SYNC_ENABLED:"true"};
 const fetchImpl=async()=>{calls++;return new Response(JSON.stringify([{date:"2026-09-10",account_id:"123",campaign_id:"C1",campaign_name:"Grooming",impressions:"10",clicks:"1",spend:"10",conversions:"1",conversion_value:"20",currency:"INR"}]),{status:200});};
 const first=await mod.syncSupermetricsMarketing(db,runtime,{from:"2026-09-10",to:"2026-09-10",fetchImpl});
 const second=await mod.syncSupermetricsMarketing(db,runtime,{from:"2026-09-10",to:"2026-09-10",fetchImpl});
 assert.equal(first.status,"completed");assert.equal(second.status,"completed");assert.equal(calls,1);
 assert.equal(second.queries[0].duplicatePrevented,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_supermetrics_sync_runs").get().n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_ad_metric_facts").get().n,1);
});

test("Supermetrics failed window retries using the same run identity",async()=>{
 const {sqlite,db}=fresh();let calls=0;
 const runtime={SUPERMETRICS_API_KEY:"secret-key",SUPERMETRICS_QUERY_CONFIG_JSON:config,PAWSPACE_SUPERMETRICS_SYNC_ENABLED:"true"};
 const fetchImpl=async()=>{calls++;return calls===1?new Response("down",{status:503}):new Response(JSON.stringify([{date:"2026-09-10",account_id:"123",campaign_id:"C1",campaign_name:"Grooming",impressions:"10",clicks:"1",spend:"10",conversions:"1",conversion_value:"20",currency:"INR"}]),{status:200});};
 const first=await mod.syncSupermetricsMarketing(db,runtime,{from:"2026-09-10",to:"2026-09-10",fetchImpl});
 const second=await mod.syncSupermetricsMarketing(db,runtime,{from:"2026-09-10",to:"2026-09-10",fetchImpl});
 assert.equal(first.status,"partial_failure");assert.equal(second.status,"completed");assert.equal(calls,2);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_supermetrics_sync_runs").get().n,1);
 assert.equal(sqlite.prepare("SELECT status FROM marketing_supermetrics_sync_runs").get().status,"completed");
});
