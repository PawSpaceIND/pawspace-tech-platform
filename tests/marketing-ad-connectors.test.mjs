import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./helpers/ai-harness.mjs";

const mod = await import("../lib/marketing-ad-connectors.ts");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  return { sqlite, db };
}

const GOOGLE_RUNTIME = {
  GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "987-654-3210",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_OAUTH_ACCESS_TOKEN: "oauth-token",
  GOOGLE_ADS_API_VERSION: "v25",
};

function googleMetricResult() {
  return {
    results: [{
      campaign: { id: "100", name: "PawSpace Grooming Search" },
      adGroup: { id: "200", name: "Bangalore Exact", cpcBidMicros: "5000000" },
      adGroupCriterion: { keyword: { text: "pet grooming bangalore", matchType: "EXACT" }, ageRange: { type: "AGE_RANGE_25_34" }, gender: { type: "FEMALE" } },
      searchTermView: { searchTerm: "pet grooming bangalore" },
      customer: { currencyCode: "INR" },
      segments: { date: "2026-09-04", device: "MOBILE" },
      metrics: { impressions: "1000", clicks: "100", costMicros: "200000000", conversions: 20, conversionsValue: 10000 },
    }],
  };
}

test("Google Ads pull writes normalized keyword/search/demographic facts and optimizer uses real metric facts", async () => {
  const { sqlite, db } = freshDb();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.match(String(url), /googleads\.googleapis\.com\/v25\/customers\/1234567890\/googleAds:search$/);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["developer-token"], "dev-token");
    assert.equal(init.headers["login-customer-id"], "9876543210");
    return new Response(JSON.stringify(googleMetricResult()), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await mod.syncGoogleAdsMetrics(db, GOOGLE_RUNTIME, { from: "2026-09-04", to: "2026-09-04", fetchImpl });
  assert.equal(result.status, "completed");
  assert.equal(result.externalRead, true);
  assert.equal(calls.length, 4, "keyword, search-term, age and gender queries must execute");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_ad_metric_facts").get().n, 4);
  const keyword = sqlite.prepare("SELECT * FROM marketing_ad_metric_facts WHERE dimension_type='keyword'").get();
  assert.equal(keyword.keyword, "pet grooming bangalore");
  assert.equal(keyword.impressions, 1000);
  assert.equal(keyword.clicks, 100);
  assert.equal(keyword.spend_minor, 20000);
  assert.equal(keyword.cpc_minor, 200);
  assert.equal(keyword.cpa_minor, 1000);

  const recommendation = await mod.petGroomingBangaloreRecommendation(db, { from: "2026-09-04", to: "2026-09-04", targetCpaMinor: 1500 });
  assert.equal(recommendation.length, 1);
  assert.equal(recommendation[0].adjustmentPercent, 10);
  assert.equal(recommendation[0].recommendedBidMinor, 550);
});

test("Meta Ads pull writes daily ad-set/ad/demographic facts with spend and derived CPA", async () => {
  const { sqlite, db } = freshDb();
  const runtime = { META_ADS_ACCOUNT_ID: "act_112233", META_ADS_ACCESS_TOKEN: "meta-token", META_ADS_API_VERSION: "v24.0" };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.hostname, "graph.facebook.com");
    assert.equal(parsed.pathname, "/v24.0/act_112233/insights");
    assert.equal(parsed.searchParams.get("time_increment"), "1");
    assert.equal(parsed.searchParams.get("breakdowns"), "age,gender");
    assert.equal(init.headers.authorization, "Bearer meta-token");
    return new Response(JSON.stringify({ data: [{ campaign_id: "300", campaign_name: "Grooming", adset_id: "301", adset_name: "HSR", ad_id: "302", ad_name: "Doorstep", date_start: "2026-09-04", account_currency: "INR", impressions: "500", clicks: "25", spend: "50.00", conversions: [{ value: "5" }], age: "25-34", gender: "female" }] }), { status: 200 });
  };
  const result = await mod.syncMetaAdsMetrics(db, runtime, { from: "2026-09-04", to: "2026-09-04", fetchImpl });
  assert.equal(result.status, "completed");
  const row = sqlite.prepare("SELECT * FROM marketing_ad_metric_facts WHERE platform='meta_ads'").get();
  assert.equal(row.ad_set_id, "301");
  assert.equal(row.ad_id, "302");
  assert.equal(row.age_range, "25-34");
  assert.equal(row.gender, "female");
  assert.equal(row.spend_minor, 5000);
  assert.equal(row.cpa_minor, 1000);
});

test("real daily/weekly/monthly report windows are persisted rather than three labels for one day", async () => {
  const { sqlite, db } = freshDb();
  await mod.ensureMarketingAdConnectorTables(db);
  sqlite.prepare("INSERT INTO marketing_ad_metric_facts (dimension_key,platform,account_id,report_date,dimension_type,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,pulled_at,updated_at) VALUES ('k1','google_ads','1','2026-09-06','keyword',100,10,1000,2,4000,'INR',10,100,500,1,1)").run();
  sqlite.prepare("INSERT INTO marketing_ad_metric_facts (dimension_key,platform,account_id,report_date,dimension_type,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,pulled_at,updated_at) VALUES ('k2','meta_ads','2','2026-08-15','demographic_ad',200,20,2000,4,8000,'INR',10,100,500,1,1)").run();
  const asOf = Date.parse("2026-09-07T08:00:00+05:30");
  const reports = await mod.generateMarketingAdReports(db, { asOf });
  assert.equal(reports.daily.from, "2026-09-06");
  assert.equal(reports.daily.to, "2026-09-06");
  assert.equal(reports.weekly.from, "2026-08-31");
  assert.equal(reports.weekly.to, "2026-09-06");
  assert.equal(reports.monthly.from, "2026-08-01");
  assert.equal(reports.monthly.to, "2026-08-31");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_ad_report_runs").get().n, 3);
});

test("provider budget mutation is fail-closed and audited when explicitly enabled", async () => {
  const { sqlite, db } = freshDb();
  await assert.rejects(() => mod.mutateMarketingAdResource(db, GOOGLE_RUNTIME, { platform: "google_ads", mutationType: "budget", resourceId: "444", amountMinor: 150000, actor: "marketer@pawspace.test", reason: "Approved budget adjustment", fetchImpl: async () => new Response("{}") }), error => error instanceof Response && error.status === 409);

  let body;
  const result = await mod.mutateMarketingAdResource(db, { ...GOOGLE_RUNTIME, PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED: "true" }, { platform: "google_ads", mutationType: "budget", resourceId: "444", amountMinor: 150000, actor: "marketer@pawspace.test", reason: "Approved budget adjustment", fetchImpl: async (url, init) => {
    assert.match(String(url), /campaignBudgets:mutate$/);
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [{}], requestId: "REQ-G-1" }), { status: 200 });
  } });
  assert.equal(result.externalMutation, true);
  assert.equal(body.operations[0].update.amountMicros, "1500000000");
  assert.equal(sqlite.prepare("SELECT status FROM marketing_ad_mutation_audit").get().status, "completed");
});

test("Google Data Manager validate-only upload uses GCLID, conversion action destination, INR and granted consent", async () => {
  const { sqlite, db } = freshDb();
  await mod.ensureMarketingAdConnectorTables(db);
  sqlite.exec("CREATE TABLE whatsapp_lead_attribution (id TEXT PRIMARY KEY,source_platform TEXT NOT NULL,lead_id TEXT NOT NULL,customer_id TEXT NOT NULL,thread_id TEXT NOT NULL,click_id TEXT,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE whatsapp_conversion_facts (id TEXT PRIMARY KEY,event_type TEXT NOT NULL,business_reference TEXT NOT NULL,lead_id TEXT NOT NULL,customer_id TEXT NOT NULL,thread_id TEXT NOT NULL,value_minor INTEGER NOT NULL,occurred_at INTEGER NOT NULL)");
  const at = Date.parse("2026-09-04T06:12:34.000Z");
  sqlite.prepare("INSERT INTO whatsapp_lead_attribution VALUES ('A1','google','L1','C1','T1','GCLID-VALID-1',?)").run(at-1000);
  sqlite.prepare("INSERT INTO whatsapp_conversion_facts VALUES ('F1','payment_captured','PAY-1','L1','C1','T1',149900,?)").run(at);
  const runtime = { GOOGLE_ADS_CUSTOMER_ID: "1234567890", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9876543210", GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN: "dm-token", GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED: "11", GOOGLE_ADS_CONVERSION_ACTION_BOOKING_CREATED: "12", GOOGLE_ADS_CONVERSION_ACTION_PAYMENT_CAPTURED: "13" };
  let payload;
  const result = await mod.uploadGoogleOfflineConversionsDataManager(db, runtime, { from: at-5000, to: at+5000, validateOnly: true, fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://datamanager.googleapis.com/v1/events:ingest");
    assert.equal(init.headers.authorization, "Bearer dm-token");
    payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ requestId: "DM-REQ-1" }), { status: 200 });
  } });
  assert.equal(result.submitted, 1);
  assert.equal(result.externalMutation, false);
  assert.equal(payload.destinations[0].operatingAccount.accountType, "GOOGLE_ADS");
  assert.equal(payload.destinations[0].operatingAccount.accountId, "1234567890");
  assert.equal(payload.destinations[0].loginAccount.accountId, "9876543210");
  assert.equal(payload.destinations[0].productDestinationId, "13");
  assert.equal(payload.events[0].adIdentifiers.gclid, "GCLID-VALID-1");
  assert.equal(payload.events[0].conversionValue, 1499);
  assert.equal(payload.events[0].currency, "INR");
  assert.equal(payload.events[0].eventSource, "WEB");
  assert.equal(payload.consent.adUserData, "CONSENT_GRANTED");
  assert.equal(payload.consent.adPersonalization, "CONSENT_GRANTED");
  assert.equal(payload.validateOnly, true);
});
