/*
 * Day-31 cross-module test 9: the marketing attribution loop, all the way out to the ad platforms.
 *
 * ad click captured at intake -> lead -> booking -> payment captured -> conversion fact ->
 * feedback outbox -> what is actually sent to Google Data Manager and Meta CAPI.
 *
 * This is the one flow that deliberately sends PawSpace data OUT to third parties, so it carries
 * two obligations that pull in opposite directions from "make the numbers look good":
 *
 *   CONSENT   under India's DPDP regime, an ad-personalisation upload needs the customer's consent
 *             on record. Absent consent is not "assume yes"; it is do not send.
 *   MINIMISE  the upload needs the click identifier and the amount. It does not need a name, a
 *             phone number, an email or an address, and the platform must not leak one by
 *             accident just because the row it was built from had them.
 *
 * And one integrity obligation: one real booking is one conversion. An outbox that double-fires
 * inflates reported ROAS and moves real ad budget onto the wrong campaigns.
 *
 * The provider is stubbed through the module's own fetchImpl parameter - no network, and the
 * outbound body itself is inspected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_MKT_DB__", "__D31_MKT_ENV__");

const CONTACT = "CON-D31-MKT";
const LEAD = "LEAD-D31-MKT";
const BOOKING = "BK-D31-MKT";
const GCLID = "Cj0KCQjw-D31-test-click-id";

/* Real customer PII that lives beside the attribution row and must never leave with it. */
const CUSTOMER_PHONE = "9876500011";
const CUSTOMER_EMAIL = "rhea.nair@example.com";
const CUSTOMER_NAME = "Rhea Nair";

const RUNTIME_SANDBOX = {
  PAWSPACE_PAYMENT_ENV: "sandbox",
  PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED: "true",
  PAWSPACE_GOOGLE_DATA_MANAGER_UPLOAD_ENABLED: "true",
  PAWSPACE_META_CAPI_UPLOAD_ENABLED: "true",
  GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN: "uat-fixture-token",
  GOOGLE_ADS_CUSTOMER_ID: "1234567890",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1234567890",
  GOOGLE_ADS_CONVERSION_ACTION_PAYMENT_CAPTURED: "9001",
  GOOGLE_ADS_CONVERSION_ACTION_BOOKING_CREATED: "9002",
  GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED: "9003",
  META_PIXEL_ID: "111222333",
  META_CAPI_ACCESS_TOKEN: "uat-fixture-meta-token",
  META_ADS_API_VERSION: "v21.0",
};

async function seedMarketing({ platform = "google", consent = true } = {}) {
  const { sqlite, db } = world("__D31_MKT_DB__", "__D31_MKT_ENV__", RUNTIME_SANDBOX);
  const intake = await import("../lib/lead-intake-ad-attribution.ts");
  const feedback = await import("../lib/marketing-conversion-feedback.ts");
  await intake.ensureLeadIntakeAdAttribution(db);
  await feedback.ensureMarketingConversionFeedback(db);

  /*
   * A REAL lead/customer link. recordLeadIntakeAdAttribution refuses (409) unless lead_work_items
   * genuinely holds this lead against this customer - attribution may not be bound to somebody
   * else's lead - so seeding it is part of the flow, not scaffolding around it.
   */
  const seededAt = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO lead_work_items (id,customer_id,source,service,owner,manager,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(LEAD, CONTACT, platform === "meta" ? "meta_ads" : "google_ads", "grooming", "rep@pawspace.in", "manager@pawspace.in", seededAt, seededAt, seededAt, seededAt, seededAt);

  await intake.recordLeadIntakeAdAttribution(db, {
    contactId: CONTACT, leadId: LEAD, origin: "public_contact",
    gclid: platform === "google" ? GCLID : null,
    fbclid: platform === "meta" ? "fb.D31.test.click" : null,
    utmSource: platform, utmMedium: "cpc", utmCampaign: "blr-grooming-oct",
    landingUrl: "https://pawspace.in/grooming?utm_source=" + platform,
  });

  if (consent) {
    sqlite.exec("CREATE TABLE IF NOT EXISTS google_ads_conversion_consent (customer_id TEXT PRIMARY KEY,ad_user_data TEXT,ad_personalization TEXT,updated_at INTEGER)");
    sqlite.prepare("INSERT OR REPLACE INTO google_ads_conversion_consent (customer_id,ad_user_data,ad_personalization,updated_at) VALUES (?,'Granted','Granted',?)")
      .run(CONTACT, Date.now());
  }
  return { sqlite, db, feedback };
}

/** Stub the provider through the module's own injection point and keep every request. */
function stubProvider(status = 200, body = { requestId: "req-d31" }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-fb-trace-id": "trace-d31" } });
  };
  return { calls, fetchImpl };
}

const captureFact = (feedback, db, extra = {}) => feedback.recordMarketingConversionFact(db, {
  eventType: "payment_captured", businessReference: `PAY-${BOOKING}`, leadId: LEAD,
  customerId: CONTACT, bookingId: BOOKING, valueMinor: 149900, currency: "INR",
  occurredAt: Date.now(), ...extra,
});

test("a click captured at intake follows the lead all the way to a queued conversion", async () => {
  const { sqlite, db, feedback } = await seedMarketing();
  const stored = sqlite.prepare("SELECT gclid,source_platform,utm_campaign FROM lead_intake_ad_attribution WHERE lead_id=?").get(LEAD);
  assert.equal(stored.gclid, GCLID);
  assert.equal(stored.source_platform, "google");

  await captureFact(feedback, db);
  const queued = sqlite.prepare("SELECT platform,status FROM marketing_conversion_feedback_outbox").all();
  assert.ok(queued.some((row) => row.platform === "google"), "a Google click must produce a Google conversion upload");
});

test("one real payment is one conversion, however many times the event is replayed", async () => {
  /*
   * A duplicated conversion inflates reported ROAS and moves real ad budget onto the wrong
   * campaign. Payment webhooks retry, so this event genuinely arrives more than once.
   */
  const { sqlite, db, feedback } = await seedMarketing();
  const first = await captureFact(feedback, db);
  const second = await captureFact(feedback, db);
  const third = await captureFact(feedback, db, { valueMinor: 999900 });

  assert.equal(first.duplicatePrevented, false);
  assert.equal(second.duplicatePrevented, true);
  assert.equal(third.duplicatePrevented, true, "a replay carrying a different amount is still the same conversion");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_conversion_facts").get().n, 1);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM marketing_conversion_feedback_outbox WHERE platform='google'").get().n, 1,
    "and exactly one upload may be queued for it",
  );
  assert.equal(
    sqlite.prepare("SELECT value_minor FROM marketing_conversion_facts").get().value_minor, 149900,
    "the first, real amount stands - a replay must not restate the conversion value",
  );
});

test("without recorded consent, nothing is sent to Google at all", async () => {
  const { db, feedback } = await seedMarketing({ consent: false });
  await captureFact(feedback, db);
  const provider = stubProvider();

  const result = await feedback.dispatchMarketingConversionFeedback(db, RUNTIME_SANDBOX, { fetchImpl: provider.fetchImpl });
  const google = result.results.find((row) => row.platform === "google");
  assert.equal(google.status, "consent_blocked");
  assert.equal(google.externalMutation, false);
  assert.equal(provider.calls.length, 0, "a consent refusal must happen before the request, not after");
});

test("the upload carries the click id and the amount - and no customer PII", async () => {
  /*
   * Data minimisation, asserted against the serialised request body rather than against intent.
   * The attribution row sits next to a contact record holding a name, a phone and an email; none
   * of them has any business being in an ad-platform upload.
   */
  const { sqlite, db, feedback } = await seedMarketing();
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT OR REPLACE INTO crm_contacts (id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(CONTACT, CUSTOMER_NAME, CUSTOMER_PHONE, CUSTOMER_EMAIL, Date.now(), Date.now());
  await captureFact(feedback, db);

  const provider = stubProvider();
  await feedback.dispatchMarketingConversionFeedback(db, RUNTIME_SANDBOX, { fetchImpl: provider.fetchImpl });
  assert.ok(provider.calls.length > 0, "a consented conversion must reach the provider");

  for (const call of provider.calls) {
    const serialized = JSON.stringify(call.body);
    assert.doesNotMatch(serialized, new RegExp(CUSTOMER_PHONE), "a phone number must never leave with a conversion");
    assert.doesNotMatch(serialized, new RegExp(CUSTOMER_EMAIL.replace(".", "\\.")), "an email must never leave with a conversion");
    assert.doesNotMatch(serialized, new RegExp(CUSTOMER_NAME), "a customer name must never leave with a conversion");
    assert.doesNotMatch(call.url, /uat-fixture-token/, "the access token must not be in the URL, where it would be logged");
  }
  const googleCall = provider.calls.find((call) => call.url.includes("datamanager.googleapis.com"));
  assert.equal(googleCall.body.events[0].adIdentifiers.gclid, GCLID, "the click id is what makes the conversion attributable");
  assert.equal(googleCall.body.events[0].conversionValue, 1499);
});

test("a sandbox environment never records a real conversion at an ad platform", async () => {
  /*
   * PAWSPACE_PAYMENT_ENV=sandbox must beat PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED=true.
   * A UAT run that quietly wrote live conversions would corrupt the ad accounts' optimisation
   * data with test bookings, and that damage is not undoable from our side.
   */
  const { db, feedback } = await seedMarketing();
  await captureFact(feedback, db);
  const provider = stubProvider();

  const result = await feedback.dispatchMarketingConversionFeedback(db, RUNTIME_SANDBOX, { fetchImpl: provider.fetchImpl });
  assert.equal(result.externalWrites, false, "sandbox must not enable external writes");
  for (const row of result.results) {
    assert.equal(row.externalMutation, false, `${row.platform} must not mutate an ad account from sandbox`);
  }
  const googleCall = provider.calls.find((call) => call.url.includes("datamanager.googleapis.com"));
  if (googleCall) assert.equal(googleCall.body.validateOnly, true, "any sandbox Google call must be validate-only");
});

test("a failing provider retries with backoff and then dead-letters instead of hammering forever", async () => {
  const { sqlite, db, feedback } = await seedMarketing();
  await captureFact(feedback, db);
  const provider = stubProvider(500, { error: { message: "upstream unavailable" } });

  let last;
  for (let attempt = 1; attempt <= 6; attempt++) {
    last = await feedback.dispatchMarketingConversionFeedback(db, RUNTIME_SANDBOX, {
      fetchImpl: provider.fetchImpl, now: Date.now() + attempt * 7200_000,
    });
  }
  const row = sqlite.prepare("SELECT status,attempts,external_mutation,last_error FROM marketing_conversion_feedback_outbox WHERE platform='google'").get();
  assert.ok(provider.calls.length > 0, "the upload must actually have been attempted");
  assert.match(String(row.last_error), /500|upstream unavailable/,
    `must have dead-lettered on the provider failure, not on a misconfiguration: ${row.last_error}`);
  assert.equal(row.status, "dead_letter", "a permanently failing upload must stop and become visible, not retry forever");
  assert.equal(row.attempts, 5, "the retry ceiling is 5 attempts");
  assert.equal(row.external_mutation, 0, "a failed upload must never be recorded as having mutated an ad account");
  assert.ok(last.results.every((r) => r.externalMutation === false));
});

test("reconciliation reports the loop honestly rather than assuming delivery", async () => {
  const { db, feedback } = await seedMarketing();
  await captureFact(feedback, db);
  const summary = await feedback.marketingConversionReconciliation(db, {});
  const serialized = JSON.stringify(summary);
  assert.match(serialized, /payment_captured/, "the fact recorded must appear in reconciliation");
  assert.doesNotMatch(serialized, /"delivered":\s*1/, "nothing has been dispatched yet, so nothing may be reported as delivered");
});

test("attribution cannot be bound to a lead that is not the customer's", async () => {
  /*
   * Attribution decides which campaign gets credited - and therefore where real ad budget goes.
   * Binding a click to somebody else's lead would let one campaign harvest another's conversion.
   */
  const { db } = await seedMarketing();
  const intake = await import("../lib/lead-intake-ad-attribution.ts");
  await assert.rejects(
    () => intake.recordLeadIntakeAdAttribution(db, {
      contactId: "CON-SOMEONE-ELSE", leadId: LEAD, threadId: null,
      gclid: "Cj0-stolen-click", utmSource: "google", utmMedium: "cpc",
    }),
    (error) => { assert.equal(error.status, 409); return true; },
    "a click may only be attributed to the lead's own customer",
  );
});
