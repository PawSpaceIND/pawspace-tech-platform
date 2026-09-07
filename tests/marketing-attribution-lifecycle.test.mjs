import test from"node:test";
import assert from"node:assert/strict";
import{DatabaseSync}from"node:sqlite";
import{makeD1,installAiHooks}from"./helpers/ai-harness.mjs";

installAiHooks();
const attribution=await import("../lib/marketing-attribution.ts");
const server=await import("../lib/marketing-attribution-server.ts");
const conversion=await import("../lib/lead-conversion-attribution.ts");
const atomic=await import("../lib/marketing-ad-atomic-sync.ts");
const connectors=await import("../lib/marketing-ad-connectors.ts");

function fresh(){const sqlite=new DatabaseSync(":memory:");return{sqlite,db:makeD1(sqlite)};}
function grantGoogleConsent(sqlite,customerId){sqlite.exec("CREATE TABLE IF NOT EXISTS google_ads_conversion_consent (customer_id TEXT PRIMARY KEY,ad_user_data TEXT NOT NULL,ad_personalization TEXT NOT NULL)");sqlite.prepare("INSERT OR REPLACE INTO google_ads_conversion_consent VALUES (?,?,?)").run(customerId,"Granted","Granted");}

if(process.env.PAWSPACE_PAYMENT_ENV!=="sandbox")throw new Error("marketing attribution tests require PAWSPACE_PAYMENT_ENV=sandbox");
if(String(process.env.PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED).toLowerCase()!=="false")throw new Error("marketing attribution tests require external marketing writes disabled");

test("query capture keeps typed Google/Meta ids and complete UTM vocabulary without browser hydration dependency",()=>{
 const capture=attribution.parseMarketingAttributionSearch("?gclid=G-1&wbraid=W-1&gbraid=B-1&fbclid=F-1&utm_source=google&utm_medium=cpc&utm_campaign=grooming&utm_content=hero&utm_term=dog+grooming");
 assert.deepEqual(capture,{gclid:"G-1",wbraid:"W-1",gbraid:"B-1",fbclid:"F-1",utm_source:"google",utm_medium:"cpc",utm_campaign:"grooming",utm_content:"hero",utm_term:"dog grooming"});
 assert.equal(attribution.inferMarketingSourcePlatform(capture),"google");
 assert.deepEqual(attribution.googleAdIdentifier(capture),{type:"gclid",value:"G-1"});
});

test("first-party attribution persists without a WhatsApp thread and queues idempotent typed provider facts",async()=>{
 const{sqlite,db}=fresh();await server.ensureFirstPartyMarketingAttribution(db);
 await server.persistLeadMarketingAttribution(db,{leadId:"L1",customerId:"C1",capture:{wbraid:"WB-1",fbclid:"FB-1",utm_source:"google",utm_campaign:"paid-grooming"}});
 const row=sqlite.prepare("SELECT * FROM lead_marketing_attribution WHERE lead_id='L1'").get();
 assert.equal(row.wbraid,"WB-1");assert.equal(row.fbclid,"FB-1");assert.equal(row.utm_campaign,"paid-grooming");
 const first=await server.recordMarketingConversionFact(db,{eventType:"lead_qualified",businessReference:"L1",leadId:"L1",customerId:"C1"});
 const second=await server.recordMarketingConversionFact(db,{eventType:"lead_qualified",businessReference:"L1",leadId:"L1",customerId:"C1"});
 assert.equal(first.queued,2);assert.equal(second.duplicatePrevented,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_conversion_facts").get().n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_conversion_outbox").get().n,2);
 const google=JSON.parse(sqlite.prepare("SELECT payload_json FROM marketing_conversion_outbox WHERE platform='google'").get().payload_json);
 assert.deepEqual(google.adIdentifier,{type:"wbraid",value:"WB-1"});
});

test("canonical booking and payment transitions emit booking_created and payment_captured automatically",async()=>{
 const{sqlite,db}=fresh();
 sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,service_code TEXT,total_amount REAL,currency TEXT);CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,status TEXT,amount REAL,currency TEXT,updated_at INTEGER)");
 await conversion.ensureLeadWorkItemsTable(db);
 const now=Date.now();
 sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,recycle_cycle,opt_out,created_at,updated_at,lifecycle_state) VALUES ('L2','C2','website','grooming','owner','manager','active','day_1',1,?,?,?,0,0,?,?,'new')").run(now,now,now,now,now);
 sqlite.prepare("INSERT INTO canonical_bookings VALUES ('B2','grooming',1499,'INR')").run();
 await server.persistLeadMarketingAttribution(db,{leadId:"L2",customerId:"C2",capture:{gclid:"GCLID-2",utm_source:"google"}});
 const linked=await conversion.attributeBookingToOpenLead(db,{customerId:"C2",bookingId:"B2"});assert.equal(linked.leadId,"L2");
 assert.deepEqual(sqlite.prepare("SELECT event_type FROM marketing_conversion_facts ORDER BY event_type").all().map(r=>r.event_type),["booking_created","lead_qualified"]);
 sqlite.prepare("INSERT INTO booking_payments VALUES ('P2','B2','captured',1499,'INR',?)").run(now+1);
 const paid=await conversion.convertLeadOnPaymentCaptured(db,{customerId:"C2",bookingId:"B2"});assert.equal(paid.leadId,"L2");
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_conversion_facts WHERE event_type='payment_captured'").get().n,1);
});

test("Google first-party outbox remains blocked without explicit Granted/Granted consent",async()=>{
 const{db}=fresh();await server.persistLeadMarketingAttribution(db,{leadId:"LC",customerId:"CC",capture:{gclid:"G-CONSENT"}});await server.recordMarketingConversionFact(db,{eventType:"lead_qualified",businessReference:"LC",leadId:"LC",customerId:"CC"});let called=false;
 const runtime={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED:"false",GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN:"token",GOOGLE_ADS_CUSTOMER_ID:"1234567890",GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED:"11"};
 const out=await server.dispatchMarketingConversionOutbox(db,runtime,{fetchImpl:async()=>{called=true;return new Response("{}")}});assert.equal(called,false);assert.ok(out.results.some(r=>r.platform==="google"&&r.status==="consent_blocked"));
});

test("sandbox dispatch holds Meta and sends consented Google only as Data Manager validateOnly with the typed identifier",async()=>{
 const{sqlite,db}=fresh();grantGoogleConsent(sqlite,"C3");await server.persistLeadMarketingAttribution(db,{leadId:"L3",customerId:"C3",capture:{gbraid:"GB-3",fbclid:"FB-3"}});await server.recordMarketingConversionFact(db,{eventType:"payment_captured",businessReference:"P3",leadId:"L3",customerId:"C3",bookingId:"B3",paymentId:"P3",valueMinor:9900});
 const calls=[];const runtime={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED:"false",PAWSPACE_GOOGLE_DATA_MANAGER_UPLOAD_ENABLED:"true",PAWSPACE_META_CAPI_UPLOAD_ENABLED:"true",GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN:"token",GOOGLE_ADS_CUSTOMER_ID:"1234567890",GOOGLE_ADS_LOGIN_CUSTOMER_ID:"1234567890",GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED:"11",GOOGLE_ADS_CONVERSION_ACTION_BOOKING_CREATED:"12",GOOGLE_ADS_CONVERSION_ACTION_PAYMENT_CAPTURED:"13",META_PIXEL_ID:"pixel",META_CAPI_ACCESS_TOKEN:"meta",META_ADS_API_VERSION:"v24.0"};
 const out=await server.dispatchMarketingConversionOutbox(db,runtime,{fetchImpl:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return new Response(JSON.stringify({requestId:"REQ-3"}),{status:200});}});
 assert.equal(calls.length,1);assert.equal(calls[0].url,"https://datamanager.googleapis.com/v1/events:ingest");assert.equal(calls[0].body.validateOnly,true);assert.equal(calls[0].body.events[0].adIdentifiers.gbraid,"GB-3");
 assert.ok(out.results.some(r=>r.platform==="meta"&&r.status==="sandbox_held"));assert.equal(sqlite.prepare("SELECT external_mutation FROM marketing_conversion_outbox WHERE platform='google'").get().external_mutation,0);
});

const GOOGLE_RUNTIME={GOOGLE_ADS_CUSTOMER_ID:"1234567890",GOOGLE_ADS_LOGIN_CUSTOMER_ID:"1234567890",GOOGLE_ADS_DEVELOPER_TOKEN:"dev",GOOGLE_ADS_OAUTH_ACCESS_TOKEN:"oauth",GOOGLE_ADS_API_VERSION:"v25"};
function googleRows(){return{results:[{campaign:{id:"100",name:"Campaign"},adGroup:{id:"200",name:"Group",cpcBidMicros:"5000000"},adGroupCriterion:{keyword:{text:"pet grooming bangalore",matchType:"EXACT"},ageRange:{type:"AGE_RANGE_25_34"},gender:{type:"FEMALE"}},searchTermView:{searchTerm:"pet grooming bangalore"},customer:{currencyCode:"INR"},segments:{date:"2026-09-06",device:"MOBILE"},metrics:{impressions:"100",clicks:"10",costMicros:"10000000",conversions:2,conversionsValue:1000}}]};}

test("atomic Google sync leaves the prior snapshot untouched on a mid-pull failure and promotes only a complete rerun",async()=>{
 const{sqlite,db}=fresh();await connectors.ensureMarketingAdConnectorTables(db);
 sqlite.prepare("INSERT INTO marketing_ad_metric_facts (dimension_key,platform,account_id,report_date,dimension_type,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,pulled_at,updated_at) VALUES ('old','google_ads','1','2026-09-06','keyword',1,1,1,1,1,'INR',1,1,1,1,1)").run();
 let n=0;await assert.rejects(()=>atomic.syncGoogleAdsMetricsAtomic(db,GOOGLE_RUNTIME,{from:"2026-09-06",to:"2026-09-06",fetchImpl:async()=>{n++;if(n===3)return new Response(JSON.stringify({error:{message:"simulated third-query failure"}}),{status:500});return new Response(JSON.stringify(googleRows()),{status:200});}}));
 assert.equal(sqlite.prepare("SELECT dimension_key FROM marketing_ad_metric_facts").get().dimension_key,"old");
 n=0;const result=await atomic.syncGoogleAdsMetricsAtomic(db,GOOGLE_RUNTIME,{from:"2026-09-06",to:"2026-09-06",fetchImpl:async()=>{n++;return new Response(JSON.stringify(googleRows()),{status:200});}});assert.equal(result.atomicPromotion,true);assert.equal(n,4);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_ad_metric_facts WHERE dimension_key='old'").get().n,0);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_ad_metric_facts WHERE platform='google_ads'").get().n,4);
});
