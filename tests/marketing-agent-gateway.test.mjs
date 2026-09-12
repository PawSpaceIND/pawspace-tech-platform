import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeD1, installAiHooks } from "./helpers/ai-harness.mjs";

installAiHooks();
const gateway = await import("../lib/marketing-agent-gateway.ts");
const connectors = await import("../lib/marketing-ad-connectors.ts");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  return { sqlite, db: makeD1(sqlite) };
}
const GOOGLE_RUNTIME = {
  GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "987-654-3210",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_OAUTH_ACCESS_TOKEN: "oauth-token",
  GOOGLE_ADS_API_VERSION: "v25",
  PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED: "true",
};
const now = () => Date.now();

async function envelope(db, { id, resourceId, limit = 200000 }) {
  await gateway.upsertMarketingBudgetEnvelope(db, { id, platform: "google_ads", accountId: "1234567890", resourceId, dailyLimitMinor: limit, effectiveFrom: now() - 1000, founderActor: "founder@pawspace.test" });
}

async function approvedProposal(db, payload, toolName = "marketing.ads.budget.reallocate") {
  const proposal = await gateway.submitMarketingProposal(db, { toolName, platform: "google_ads", why: "Measured CPA supports a bounded, reversible change.", payload, requestedBy: "agent@pawspace.test" });
  await gateway.founderDecideMarketingProposal(db, { approvalId: proposal.id, decision: "approved", founderActor: "founder@pawspace.test", note: "Approved for controlled execution" });
  return proposal;
}

test("Head of Marketing exposes five governed tool schemas", () => {
  const names = Object.keys(gateway.MARKETING_TOOL_SCHEMAS).sort();
  assert.deepEqual(names, ["marketing.ads.budget.reallocate","marketing.ads.keyword.mutate","marketing.ads.read_metrics","marketing.ads.search_terms.analyze","marketing.proposal.submit"].sort());
  assert.ok(gateway.MARKETING_TOOL_SCHEMAS["marketing.ads.budget.reallocate"].required.includes("approvalId"));
  assert.deepEqual(gateway.MARKETING_TOOL_SCHEMAS["marketing.ads.read_metrics"].properties.platform.enum, ["google_ads", "meta_ads"]);
  assert.ok(gateway.MARKETING_TOOL_SCHEMAS["marketing.ads.keyword.mutate"].required.includes("approvalId"));
  assert.equal(gateway.MARKETING_TOOL_SCHEMAS["marketing.ads.keyword.mutate"].properties.platform.const, "google_ads");
  assert.equal(gateway.MARKETING_TOOL_SCHEMAS["marketing.ads.keyword.mutate"].properties.accountId.type, "string");
});

test("read_metrics returns ROAS CPA CPC and search-term analysis identifies waste", async () => {
  const { sqlite, db } = freshDb();
  await connectors.ensureMarketingAdConnectorTables(db);
  sqlite.prepare("INSERT INTO marketing_ad_metric_facts (dimension_key,platform,account_id,report_date,dimension_type,campaign_id,campaign_name,search_term,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,pulled_at,updated_at) VALUES ('k1','google_ads','1234567890','2026-09-11','search_term','100','Grooming','irrelevant free dog wash',1000,100,10000,0,0,'INR',10,100,0,1,1)").run();
  sqlite.prepare("INSERT INTO marketing_ad_metric_facts (dimension_key,platform,account_id,report_date,dimension_type,campaign_id,campaign_name,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,pulled_at,updated_at) VALUES ('k2','google_ads','1234567890','2026-09-11','campaign','200','Training',1000,50,5000,5,20000,'INR',5,100,1000,1,1)").run();
  const metrics = await gateway.marketingAdsReadMetrics(db, { from: "2026-09-11", to: "2026-09-11", platform: "google_ads" });
  assert.equal(metrics.cpcMinor, 100);
  assert.equal(metrics.cpaMinor, 3000);
  assert.equal(metrics.roas, 20000 / 15000);
  const terms = await gateway.marketingSearchTermsAnalyze(db, { from: "2026-09-11", to: "2026-09-11" });
  assert.equal(terms.length, 1);
  assert.equal(terms[0].recommendNegative, true);
});

test("proposal approval is maker-checker and exact-payload bound", async () => {
  const { sqlite, db } = freshDb();
  const payload = { platform:"google_ads",accountId:"1234567890",fromResourceId:"111",toResourceId:"222",fromDailyMinor:100000,toDailyMinor:50000,shiftMinor:10000,reason:"Move budget to lower-CPA campaign" };
  const proposal = await gateway.submitMarketingProposal(db, { toolName:"marketing.ads.budget.reallocate", platform:"google_ads", why:"Target campaign has materially better CPA and sufficient volume.", payload, requestedBy:"founder@pawspace.test" });
  await assert.rejects(() => gateway.founderDecideMarketingProposal(db, { approvalId:proposal.id, decision:"approved", founderActor:"founder@pawspace.test" }), e => e instanceof Response && e.status === 403);
  await gateway.founderDecideMarketingProposal(db, { approvalId:proposal.id, decision:"approved", founderActor:"other-founder@pawspace.test" });
  await gateway.ensureMarketingAgentGatewayTables(db);
  await envelope(db,{id:"E1",resourceId:"111"}); await envelope(db,{id:"E2",resourceId:"222"});
  let calls=0;
  await assert.rejects(() => gateway.marketingBudgetReallocate(db, GOOGLE_RUNTIME, { approvalId:proposal.id, ...payload, shiftMinor:11000, actor:"other-founder@pawspace.test", fetchImpl:async()=>{calls++;return new Response('{}')} }), e => e instanceof Response && e.status === 409);
  assert.equal(calls,0,"tampered payload must fail before provider call");
});

test("over-envelope budget mutation fails before any provider request", async () => {
  const { sqlite, db } = freshDb();
  await gateway.ensureMarketingAgentGatewayTables(db);
  await envelope(db,{id:"E1",resourceId:"111",limit:200000});
  await envelope(db,{id:"E2",resourceId:"222",limit:55000});
  const payload={platform:"google_ads",accountId:"1234567890",fromResourceId:"111",toResourceId:"222",fromDailyMinor:100000,toDailyMinor:50000,shiftMinor:10000,reason:"Move budget to lower-CPA campaign"};
  const proposal=await approvedProposal(db,payload);
  let calls=0;
  await assert.rejects(() => gateway.marketingBudgetReallocate(db,GOOGLE_RUNTIME,{approvalId:proposal.id,...payload,actor:"founder@pawspace.test",fetchImpl:async()=>{calls++;return new Response('{}')}}),e=>e instanceof Response&&e.status===422);
  assert.equal(calls,0);
  assert.equal(sqlite.prepare("SELECT status FROM pending_approvals WHERE id=?").get(proposal.id).status,"approved");
});

test("Founder-approved in-envelope reallocation executes once and consumes approval", async () => {
  const { sqlite, db } = freshDb();
  await gateway.ensureMarketingAgentGatewayTables(db);
  await envelope(db,{id:"E1",resourceId:"111",limit:200000}); await envelope(db,{id:"E2",resourceId:"222",limit:200000});
  const payload={platform:"google_ads",accountId:"1234567890",fromResourceId:"111",toResourceId:"222",fromDailyMinor:100000,toDailyMinor:50000,shiftMinor:10000,reason:"Move budget to lower-CPA campaign"};
  const proposal=await approvedProposal(db,payload);
  const calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return new Response(JSON.stringify({requestId:`REQ-${calls.length}`}),{status:200});};
  const result=await gateway.marketingBudgetReallocate(db,GOOGLE_RUNTIME,{approvalId:proposal.id,...payload,actor:"founder@pawspace.test",fetchImpl});
  assert.equal(result.toDailyMinor,60000); assert.equal(calls.length,2);
  assert.equal(sqlite.prepare("SELECT status FROM pending_approvals WHERE id=?").get(proposal.id).status,"executed");
  await assert.rejects(()=>gateway.marketingBudgetReallocate(db,GOOGLE_RUNTIME,{approvalId:proposal.id,...payload,actor:"founder@pawspace.test",fetchImpl}),e=>e instanceof Response&&[403,409].includes(e.status));
  assert.equal(calls.length,2,"consumed approval must not replay provider mutation");
});

test("keyword mutation requires exact approval and active campaign envelope", async () => {
  const { sqlite, db } = freshDb();
  await gateway.ensureMarketingAgentGatewayTables(db);
  await envelope(db,{id:"EK",resourceId:"100",limit:100000});
  const payload={platform:"google_ads",accountId:"1234567890",campaignId:"100",adGroupId:"200",criterionId:"",keyword:"free dog wash",operation:"add_negative",matchType:"EXACT",currentDailyMinor:50000,reason:"Exclude irrelevant non-converting query"};
  const proposal=await approvedProposal(db,payload,"marketing.ads.keyword.mutate");
  let request;
  const result=await gateway.marketingKeywordMutate(db,GOOGLE_RUNTIME,{approvalId:proposal.id,...payload,actor:"founder@pawspace.test",fetchImpl:async(url,init)=>{request={url:String(url),body:JSON.parse(init.body)};return new Response(JSON.stringify({requestId:"REQ-K1"}),{status:200});}});
  assert.match(request.url,/adGroupCriteria:mutate$/);
  assert.equal(request.body.operations[0].create.negative,true);
  assert.equal(result.status,"completed");
  assert.equal(sqlite.prepare("SELECT status FROM pending_approvals WHERE id=?").get(proposal.id).status,"executed");
});

test("legacy marketing-control route contains no direct provider mutation call", async () => {
  const source=(await import("node:fs/promises")).readFile;
  const route=await source(new URL("../app/api/marketing-control/route.ts",import.meta.url),"utf8");
  assert.doesNotMatch(route,/await\s+mutateMarketingAdResource\s*\(/);
  assert.match(route,/Direct ad mutation is disabled/);
});
