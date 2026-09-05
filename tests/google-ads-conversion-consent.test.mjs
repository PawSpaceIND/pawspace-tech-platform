import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeD1, installAiHooks } from "./helpers/ai-harness.mjs";

installAiHooks();
const connectors = await import("../lib/marketing-ad-connectors.ts");
const consent = await import("../lib/google-ads-conversion-consent.ts");

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY)");
  sqlite.exec("CREATE TABLE whatsapp_lead_attribution (id TEXT PRIMARY KEY,source_platform TEXT NOT NULL,lead_id TEXT NOT NULL,customer_id TEXT NOT NULL,thread_id TEXT NOT NULL,click_id TEXT,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE whatsapp_conversion_facts (id TEXT PRIMARY KEY,event_type TEXT NOT NULL,business_reference TEXT NOT NULL,lead_id TEXT NOT NULL,customer_id TEXT NOT NULL,thread_id TEXT NOT NULL,value_minor INTEGER NOT NULL,occurred_at INTEGER NOT NULL)");
  return { sqlite, db };
}

function seed(sqlite) {
  const at = Date.parse("2026-09-04T06:12:34.000Z");
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('C1')").run();
  sqlite.prepare("INSERT INTO whatsapp_lead_attribution VALUES ('A1','google','L1','C1','T1','GCLID-VALID-1',?)").run(at - 1000);
  sqlite.prepare("INSERT INTO whatsapp_conversion_facts VALUES ('F1','payment_captured','PAY-1','L1','C1','T1',149900,?)").run(at);
  return at;
}

const runtime = {
  GOOGLE_ADS_CUSTOMER_ID: "1234567890",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9876543210",
  GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN: "dm-token",
  GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED: "11",
  GOOGLE_ADS_CONVERSION_ACTION_BOOKING_CREATED: "12",
  GOOGLE_ADS_CONVERSION_ACTION_PAYMENT_CAPTURED: "13",
};

test("offline conversion delivery is blocked when explicit Google consent provenance is missing", async () => {
  const { sqlite, db } = world();
  await connectors.ensureMarketingAdConnectorTables(db);
  const at = seed(sqlite);
  let called = false;
  const result = await consent.uploadGoogleOfflineConversionsDataManager(db, runtime, {
    from: at - 5000,
    to: at + 5000,
    validateOnly: true,
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });
  assert.equal(result.status, "blocked_consent");
  assert.equal(result.submitted, 0);
  assert.equal(result.consent.missing, 1);
  assert.equal(called, false);
});

test("offline conversion validate-only delivery proceeds after audited Granted/Granted consent", async () => {
  const { sqlite, db } = world();
  await connectors.ensureMarketingAdConnectorTables(db);
  const at = seed(sqlite);
  await consent.recordGoogleAdsConversionConsent(db, {
    customerId: "C1",
    adUserData: "Granted",
    adPersonalization: "Granted",
    source: "customer_consent_v1",
    capturedAt: at - 2000,
    actor: "customer-consent-service",
  });
  let payload;
  const result = await consent.uploadGoogleOfflineConversionsDataManager(db, runtime, {
    from: at - 5000,
    to: at + 5000,
    validateOnly: true,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://datamanager.googleapis.com/v1/events:ingest");
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ requestId: "DM-REQ-1" }), { status: 200 });
    },
  });
  assert.equal(result.submitted, 1);
  assert.equal(result.externalMutation, false);
  assert.equal(result.consent.granted, 1);
  assert.equal(payload.events[0].adIdentifiers.gclid, "GCLID-VALID-1");
  assert.equal(payload.events[0].currency, "INR");
  assert.equal(payload.consent.adUserData, "CONSENT_GRANTED");
  assert.equal(payload.consent.adPersonalization, "CONSENT_GRANTED");
  assert.equal(payload.validateOnly, true);
});
