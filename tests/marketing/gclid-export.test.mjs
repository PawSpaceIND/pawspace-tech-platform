import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks } from "../helpers/ai-harness.mjs";

installAiHooks();
const mod = await import("../../scripts/export-google-ads-conversions.ts");

function mockD1(rows) {
  const calls = [];
  const db = {
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      const statement = {
        bind(...values) {
          call.bindings = values;
          return statement;
        },
        async all() {
          return { results: rows };
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
  };
  return { db, calls };
}

test("GCLID export joins canonical attribution/conversion facts, requires explicit granted consent, and emits the strict Google Ads CSV contract", async () => {
  const { db, calls } = mockD1([
    {
      click_id: "GCLID-PS-0001",
      event_type: "payment_captured",
      occurred_at: Date.parse("2026-09-05T06:12:34.000Z"),
      value_minor: 149900,
    },
  ]);

  const csv = await mod.exportGoogleAdsOfflineConversions(db, {
    from: Date.parse("2026-09-01T00:00:00.000Z"),
    to: Date.parse("2026-09-07T23:59:59.999Z"),
  });

  const queryCall = calls.find(call => /FROM whatsapp_conversion_facts AS facts/.test(call.sql));
  assert.ok(queryCall);
  assert.match(queryCall.sql, /INNER JOIN whatsapp_lead_attribution AS attribution/);
  assert.match(queryCall.sql, /INNER JOIN google_ads_conversion_consent AS consent/);
  assert.match(queryCall.sql, /consent\.ad_user_data = 'Granted'/);
  assert.match(queryCall.sql, /consent\.ad_personalization = 'Granted'/);
  assert.match(queryCall.sql, /facts\.event_type IN \('lead_qualified','booking_created','payment_captured'\)/);
  assert.deepEqual(queryCall.bindings, [
    Date.parse("2026-09-01T00:00:00.000Z"),
    Date.parse("2026-09-07T23:59:59.999Z"),
  ]);

  assert.equal(
    csv,
    [
      "Parameters:TimeZone=Asia/Kolkata,,,,,,",
      "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Ad User Data,Ad Personalization",
      "GCLID-PS-0001,PawSpace Paid Booking,2026-09-05 11:42:34,1499.00,INR,Granted,Granted",
    ].join("\n"),
  );
});

test("GCLID export preserves exact two-row header for an empty consent-eligible conversion set", async () => {
  const { db } = mockD1([]);
  const csv = await mod.exportGoogleAdsOfflineConversions(db);
  assert.equal(
    csv,
    "Parameters:TimeZone=Asia/Kolkata,,,,,,\nGoogle Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Ad User Data,Ad Personalization",
  );
});
