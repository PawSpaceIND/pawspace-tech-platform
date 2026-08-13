/**
 * Live ad data, both routes: straight to Google Ads / Meta, or through Supermetrics - and, for the two
 * platforms themselves, changing a live campaign from this tool.
 *
 * The provider APIs are stubbed at fetch, so these exercise the real module: credential gating, the
 * pull, the mapping to governed campaigns, the CAC fact it produces, and every guardrail on the write
 * path. What is never exercised is a fabricated number: a source without credentials must write
 * nothing at all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

const CF_STUB = "data:text/javascript,export const env=new Proxy({},{get:(t,k)=>k===\"DB\"?globalThis.__AD_DB__:(globalThis.__AD_ENV__??{})[k]});";
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const out = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

// Verbatim from lib/marketing-governance.ts - spend can only be attributed to a governed campaign.
const CAMPAIGNS = "CREATE TABLE IF NOT EXISTS governed_marketing_campaigns (id TEXT PRIMARY KEY,name TEXT NOT NULL,objective TEXT NOT NULL,service_code TEXT,city_id TEXT,audience_rule_json TEXT NOT NULL DEFAULT '{}',budget_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',holdout_percent INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',approval_status TEXT NOT NULL DEFAULT 'approval_required',approved_by TEXT,approved_at INTEGER,start_at INTEGER,end_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const FACTS = "CREATE TABLE IF NOT EXISTS marketing_attribution_facts (id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,customer_id TEXT,lead_id TEXT,booking_id TEXT,collection_id TEXT,source TEXT NOT NULL,medium TEXT,spend_amount REAL,booked_revenue REAL,collected_revenue REAL,contribution_margin REAL,attribution_model TEXT NOT NULL DEFAULT 'unconfigured',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

const GOOGLE_CREDENTIALS = { GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token-1234567890", GOOGLE_ADS_CLIENT_ID: "client-id-1234567890", GOOGLE_ADS_CLIENT_SECRET: "client-secret-1234567890", GOOGLE_ADS_REFRESH_TOKEN: "refresh-token-1234567890" };
const META_CREDENTIALS = { META_ADS_ACCESS_TOKEN: "meta-access-token-1234567890" };
const SUPERMETRICS_CREDENTIALS = { SUPERMETRICS_API_KEY: "sm-api-key-1234567890", SUPERMETRICS_DS_USER: "ops@pawspace.in" };

function setup(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(CAMPAIGNS);
  sqlite.exec(FACTS);
  const now = Date.now();
  sqlite.prepare("INSERT INTO governed_marketing_campaigns (id,name,objective,service_code,city_id,budget_amount,holdout_percent,status,approval_status,created_by,created_at,updated_at) VALUES ('CMP-1','Monsoon grooming refresh','reactivation','grooming','blr',45000,10,'active','approved','seed',?,?)").run(now, now);
  globalThis.__AD_DB__ = makeD1(sqlite);
  globalThis.__AD_ENV__ = env;
  return { sqlite, db: globalThis.__AD_DB__ };
}

/** Records every outbound call so the tests can assert what was (and was not) sent to a platform. */
function stubFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || "GET", body: init.body ? String(init.body) : null });
    const handler = Object.entries(handlers).find(([fragment]) => url.includes(fragment))?.[1];
    if (!handler) throw new Error(`unexpected call to ${url}`);
    const result = typeof handler === "function" ? handler(url, init) : handler;
    return { ok: result.ok !== false, status: result.status || 200, json: async () => result.body ?? {} };
  };
  return calls;
}

const GOOGLE_TOKEN = { body: { access_token: "ya29.live-token" } };
const GOOGLE_REPORT = {
  body: {
    results: [
      { campaign: { id: "111", name: "Search - Grooming BLR" }, segments: { date: "2026-08-01" }, metrics: { costMicros: "1250000000", impressions: 4200, clicks: 310 } },
      { campaign: { id: "111", name: "Search - Grooming BLR" }, segments: { date: "2026-08-02" }, metrics: { costMicros: "980000000", impressions: 3900, clicks: 271 } },
      { campaign: { id: "222", name: "Search - Boarding HYD" }, segments: { date: "2026-08-01" }, metrics: { costMicros: "500000000", impressions: 1500, clicks: 90 } },
    ],
  },
};

test("real execution: a source without credentials reports configuration_required and writes no spend", async () => {
  const { sqlite, db } = setup({});
  const connectors = await import("../lib/ad-spend-connectors.ts");
  const calls = stubFetch({});

  const source = await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", actorId: "ops@pawspace.in" });
  assert.equal(source.status, "configuration_required");
  assert.deepEqual(source.missingCredentials, ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"]);

  const outcome = await connectors.syncAdSpend(db, { provider: "google_ads", externalAccountId: "123-456-7890", start: "2026-08-01", end: "2026-08-07", actorId: "ops@pawspace.in" });
  assert.equal(outcome.status, "configuration_required");
  assert.equal(outcome.spend, 0);
  assert.equal(calls.length, 0, "no credentials means no call to the platform at all");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS value FROM ad_spend_daily").get().value, 0, "and no invented spend rows");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS value FROM marketing_attribution_facts").get().value, 0, "so CAC has nothing false to divide by");
  // The attempt is still recorded, so the screen can say what was tried and what is missing.
  const run = sqlite.prepare("SELECT * FROM ad_spend_sync_runs ORDER BY created_at DESC").get();
  assert.equal(run.status, "configuration_required");
  assert.match(run.error, /GOOGLE_ADS_DEVELOPER_TOKEN/);
});

test("real execution: Google Ads spend lands per day, per campaign, and only on linked campaigns", async () => {
  const { sqlite, db } = setup(GOOGLE_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  stubFetch({ "oauth2.googleapis.com": GOOGLE_TOKEN, "googleAds:search": GOOGLE_REPORT });

  await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", actorId: "ops@pawspace.in" });
  await connectors.linkAdCampaign(db, { provider: "google_ads", externalCampaignId: "111", campaignId: "CMP-1", actorId: "ops@pawspace.in" });

  const outcome = await connectors.syncAdSpend(db, { provider: "google_ads", externalAccountId: "123-456-7890", start: "2026-08-01", end: "2026-08-02", actorId: "ops@pawspace.in" });
  assert.equal(outcome.status, "synced");
  assert.equal(outcome.days, 2);
  assert.equal(outcome.campaigns, 2);
  assert.equal(outcome.spend, 2730, "cost micros are converted to currency: 1250 + 980 + 500");
  assert.deepEqual(outcome.unmapped, ["222"], "the unlinked campaign is reported, not silently attributed");

  const rows = sqlite.prepare("SELECT * FROM ad_spend_daily ORDER BY external_campaign_id,spend_date").all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].spend_amount, 1250);
  assert.equal(rows[0].campaign_id, "CMP-1");
  assert.equal(rows[2].campaign_id, null, "unmapped spend is held, not guessed onto a campaign");

  // The CAC line reads marketing_attribution_facts; only the linked campaign's spend reaches it.
  const fact = sqlite.prepare("SELECT * FROM marketing_attribution_facts WHERE campaign_id='CMP-1'").get();
  assert.equal(fact.spend_amount, 2230, "1250 + 980 from the linked campaign only");
  assert.equal(fact.source, "google_ads");
  assert.equal(fact.attribution_model, "google_ads_platform_reported");
});

test("real execution: re-syncing an overlapping window restates the day instead of doubling it", async () => {
  const { sqlite, db } = setup(GOOGLE_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  stubFetch({ "oauth2.googleapis.com": GOOGLE_TOKEN, "googleAds:search": GOOGLE_REPORT });
  await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", actorId: "ops@pawspace.in" });
  await connectors.linkAdCampaign(db, { provider: "google_ads", externalCampaignId: "111", campaignId: "CMP-1", actorId: "ops@pawspace.in" });

  await connectors.syncAdSpend(db, { provider: "google_ads", externalAccountId: "123-456-7890", start: "2026-08-01", end: "2026-08-02", actorId: "ops@pawspace.in" });
  await connectors.syncAdSpend(db, { provider: "google_ads", externalAccountId: "123-456-7890", start: "2026-08-01", end: "2026-08-02", actorId: "ops@pawspace.in" });

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS value FROM ad_spend_daily").get().value, 3, "one row per campaign-day, however often it is pulled");
  assert.equal(sqlite.prepare("SELECT spend_amount AS value FROM marketing_attribution_facts WHERE campaign_id='CMP-1'").get().value, 2230, "spend is restated, never accumulated");
});

test("real execution: a failed pull keeps the spend already stored and records the failure", async () => {
  const { sqlite, db } = setup(GOOGLE_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  stubFetch({ "oauth2.googleapis.com": GOOGLE_TOKEN, "googleAds:search": GOOGLE_REPORT });
  await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", actorId: "ops@pawspace.in" });
  await connectors.linkAdCampaign(db, { provider: "google_ads", externalCampaignId: "111", campaignId: "CMP-1", actorId: "ops@pawspace.in" });
  await connectors.syncAdSpend(db, { provider: "google_ads", externalAccountId: "123-456-7890", start: "2026-08-01", end: "2026-08-02", actorId: "ops@pawspace.in" });

  stubFetch({ "oauth2.googleapis.com": GOOGLE_TOKEN, "googleAds:search": { ok: false, status: 503 } });
  const outcome = await connectors.syncAdSpend(db, { provider: "google_ads", externalAccountId: "123-456-7890", start: "2026-08-01", end: "2026-08-02", actorId: "ops@pawspace.in" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /HTTP 503/);
  assert.equal(sqlite.prepare("SELECT spend_amount AS value FROM marketing_attribution_facts WHERE campaign_id='CMP-1'").get().value, 2230, "an outage does not zero yesterday's spend");
  assert.match(sqlite.prepare("SELECT last_error AS value FROM ad_spend_sources").get().value, /HTTP 503/);
});

test("real execution: Meta and Supermetrics deliver the same shape through their own APIs", async () => {
  const { sqlite, db } = setup({ ...META_CREDENTIALS, ...SUPERMETRICS_CREDENTIALS });
  const connectors = await import("../lib/ad-spend-connectors.ts");
  const calls = stubFetch({
    "graph.facebook.com": { body: { data: [{ campaign_id: "m-1", campaign_name: "Meta - Boarding", spend: "1800.50", impressions: 22000, clicks: 640, account_currency: "INR", date_start: "2026-08-01" }] } },
    "api.supermetrics.com": {
      body: {
        meta: { request: { fields: [{ field_id: "Date" }, { field_id: "Campaign_ID" }, { field_id: "Campaign" }, { field_id: "Cost" }, { field_id: "Impressions" }, { field_id: "Clicks" }, { field_id: "Currency" }] } },
        data: [["2026-08-01", "sm-9", "Supermetrics - Grooming", 640.25, 8800, 190, "INR"]],
      },
    },
  });

  await connectors.saveAdSpendSource(db, { provider: "meta_ads", externalAccountId: "1234567890", label: "PawSpace Meta", actorId: "ops@pawspace.in" });
  await connectors.linkAdCampaign(db, { provider: "meta_ads", externalCampaignId: "m-1", campaignId: "CMP-1", actorId: "ops@pawspace.in" });
  const meta = await connectors.syncAdSpend(db, { provider: "meta_ads", externalAccountId: "1234567890", start: "2026-08-01", end: "2026-08-01", actorId: "ops@pawspace.in" });
  assert.equal(meta.status, "synced");
  assert.equal(meta.spend, 1800.5);
  assert.ok(calls.some((call) => call.url.includes("act_1234567890/insights")), "Meta is asked for the account's own insights");

  await connectors.saveAdSpendSource(db, { provider: "supermetrics", externalAccountId: "acct-77", label: "Supermetrics - Google", supermetricsDsId: "AW", actorId: "ops@pawspace.in" });
  await connectors.linkAdCampaign(db, { provider: "supermetrics", externalCampaignId: "sm-9", campaignId: "CMP-1", actorId: "ops@pawspace.in" });
  const sm = await connectors.syncAdSpend(db, { provider: "supermetrics", externalAccountId: "acct-77", start: "2026-08-01", end: "2026-08-01", actorId: "ops@pawspace.in" });
  assert.equal(sm.status, "synced");
  assert.equal(sm.spend, 640.25);

  // Both routes are stored side by side, so the same campaign can be compared across sources.
  const facts = sqlite.prepare("SELECT source,spend_amount FROM marketing_attribution_facts WHERE campaign_id='CMP-1' ORDER BY source").all()
    .map((row) => ({ source: row.source, spend: row.spend_amount }));
  assert.deepEqual(facts, [{ source: "meta_ads", spend: 1800.5 }, { source: "supermetrics", spend: 640.25 }]);
});

test("real execution: a Supermetrics data source with the wrong fields fails loudly instead of reporting no spend", async () => {
  const { db } = setup(SUPERMETRICS_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  stubFetch({ "api.supermetrics.com": { body: { meta: { request: { fields: [{ field_id: "Date" }, { field_id: "Clicks" }] } }, data: [] } } });
  await connectors.saveAdSpendSource(db, { provider: "supermetrics", externalAccountId: "acct-77", label: "Supermetrics - Google", supermetricsDsId: "AW", actorId: "ops@pawspace.in" });
  const outcome = await connectors.syncAdSpend(db, { provider: "supermetrics", externalAccountId: "acct-77", start: "2026-08-01", end: "2026-08-01", actorId: "ops@pawspace.in" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /missing the Campaign_ID field/);
});

test("real execution: changing a live campaign is refused until it is deliberately switched on", async () => {
  const { db } = setup(GOOGLE_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  const calls = stubFetch({});
  await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", actorId: "ops@pawspace.in" });

  const attempt = (overrides = {}) => connectors.applyAdPlatformChange(db, {
    provider: "google_ads", externalAccountId: "123-456-7890", externalCampaignId: "111", change: { type: "pause" },
    reason: "Cost per booking above target for six days", approvalReference: "MKT-2026-08-11", idempotencyKey: "pause-111-aug11", actorId: "ops@pawspace.in", ...overrides,
  });

  await assert.rejects(attempt(), /Live changes are switched off/);
  await assert.rejects(attempt({ reason: "cost" }), /clear reason/);
  await assert.rejects(attempt({ approvalReference: "" }), /approval reference is required/);
  assert.equal(calls.length, 0, "nothing reached the platform while it was refused");

  // Supermetrics can never write, however it is configured.
  await assert.rejects(
    connectors.saveAdSpendSource(db, { provider: "supermetrics", externalAccountId: "acct-77", label: "Supermetrics", writeMode: "live", actorId: "ops@pawspace.in" }),
    /reporting source and cannot change a live campaign/,
  );
});

test("real execution: preview mode shows the exact request without sending it", async () => {
  const { sqlite, db } = setup(GOOGLE_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  const calls = stubFetch({});
  await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", writeMode: "preview", maxDailyBudget: 5000, actorId: "ops@pawspace.in" });

  const preview = await connectors.applyAdPlatformChange(db, {
    provider: "google_ads", externalAccountId: "123-456-7890", externalCampaignId: "111", change: { type: "set_daily_budget", dailyBudget: 3000 },
    reason: "Scaling the winning search campaign", approvalReference: "MKT-2026-08-11", idempotencyKey: "budget-111-aug11", actorId: "ops@pawspace.in",
  });
  assert.equal(preview.status, "preview");
  assert.equal(calls.length, 0, "preview never touches the platform");
  const after = JSON.parse(preview.after_json);
  assert.equal(after.wouldCall, "googleads.googleapis.com");
  assert.deepEqual(after.change, { type: "set_daily_budget", dailyBudget: 3000 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS value FROM ad_platform_changes WHERE status='applied'").get().value, 0);
});

test("real execution: a live budget change is capped, applied once, and fully recorded", async () => {
  const { sqlite, db } = setup(GOOGLE_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", writeMode: "live", maxDailyBudget: 5000, actorId: "ops@pawspace.in" });

  // A typo an order of magnitude over the ceiling never leaves the building.
  const overCap = stubFetch({});
  await assert.rejects(
    connectors.applyAdPlatformChange(db, { provider: "google_ads", externalAccountId: "123-456-7890", externalCampaignId: "111", change: { type: "set_daily_budget", dailyBudget: 30000 }, reason: "Scaling the winning search campaign", approvalReference: "MKT-2026-08-11", idempotencyKey: "budget-oops", actorId: "ops@pawspace.in" }),
    /exceeds this account's ceiling of 5000/,
  );
  assert.equal(overCap.length, 0);

  const calls = stubFetch({
    "oauth2.googleapis.com": GOOGLE_TOKEN,
    "googleAds:search": { body: { results: [{ campaign: { id: "111" }, campaignBudget: { resourceName: "customers/1234567890/campaignBudgets/55", amountMicros: "2000000000" } }] } },
    "campaignBudgets:mutate": { body: { results: [{ resourceName: "customers/1234567890/campaignBudgets/55" }] } },
  });
  const applied = await connectors.applyAdPlatformChange(db, {
    provider: "google_ads", externalAccountId: "123-456-7890", externalCampaignId: "111", change: { type: "set_daily_budget", dailyBudget: 3000 },
    reason: "Scaling the winning search campaign", approvalReference: "MKT-2026-08-11", idempotencyKey: "budget-111-aug11", actorId: "ops@pawspace.in",
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.reason, "Scaling the winning search campaign");
  assert.equal(applied.approval_reference, "MKT-2026-08-11");
  assert.equal(applied.actor_id, "ops@pawspace.in");
  const mutate = calls.find((call) => call.url.includes("campaignBudgets:mutate"));
  assert.ok(mutate, "the budget mutation was sent");
  assert.match(mutate.body, /"amountMicros":"3000000000"/, "3000 currency units are sent as micros");

  // A retried click must not apply a second change.
  const replay = await connectors.applyAdPlatformChange(db, {
    provider: "google_ads", externalAccountId: "123-456-7890", externalCampaignId: "111", change: { type: "set_daily_budget", dailyBudget: 3000 },
    reason: "Scaling the winning search campaign", approvalReference: "MKT-2026-08-11", idempotencyKey: "budget-111-aug11", actorId: "ops@pawspace.in",
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(calls.filter((call) => call.url.includes("campaignBudgets:mutate")).length, 1, "the platform was called exactly once");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS value FROM ad_platform_changes WHERE idempotency_key='budget-111-aug11'").get().value, 1);
});

test("real execution: a rejected platform change is recorded as failed and raises", async () => {
  const { sqlite, db } = setup(META_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  stubFetch({ "graph.facebook.com": { ok: false, status: 400 } });
  await connectors.saveAdSpendSource(db, { provider: "meta_ads", externalAccountId: "1234567890", label: "PawSpace Meta", writeMode: "live", maxDailyBudget: 5000, actorId: "ops@pawspace.in" });

  await assert.rejects(
    connectors.applyAdPlatformChange(db, { provider: "meta_ads", externalAccountId: "1234567890", externalCampaignId: "m-1", change: { type: "pause" }, reason: "Creative fatigue on the boarding set", approvalReference: "MKT-2026-08-12", idempotencyKey: "pause-m1", actorId: "ops@pawspace.in" }),
    /HTTP 400/,
  );
  const row = sqlite.prepare("SELECT * FROM ad_platform_changes WHERE idempotency_key='pause-m1'").get();
  assert.equal(row.status, "failed");
  assert.match(row.error, /HTTP 400/);
  assert.equal(row.applied_at !== null, true, "the attempt is timestamped even when it failed");
});

test("real execution: the directory tells an operator exactly what is connected and what is missing", async () => {
  const { db } = setup(META_CREDENTIALS);
  const connectors = await import("../lib/ad-spend-connectors.ts");
  stubFetch({});
  await connectors.saveAdSpendSource(db, { provider: "meta_ads", externalAccountId: "1234567890", label: "PawSpace Meta", actorId: "ops@pawspace.in" });
  await connectors.saveAdSpendSource(db, { provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India", actorId: "ops@pawspace.in" });

  const directory = await connectors.adSpendDirectory(db);
  const byProvider = Object.fromEntries(directory.readiness.map((entry) => [entry.provider, entry]));
  assert.deepEqual(byProvider.meta_ads.missingCredentials, [], "the configured platform reads as ready");
  assert.deepEqual(byProvider.google_ads.missingCredentials, ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"]);
  assert.deepEqual(byProvider.supermetrics.requiredCredentials, ["SUPERMETRICS_API_KEY", "SUPERMETRICS_DS_USER"]);
  assert.deepEqual(directory.writeCapableProviders, ["google_ads", "meta_ads"]);
  assert.equal(directory.truth.fabricatedSpend, false);
  assert.equal(directory.sources.find((row) => row.provider === "meta_ads").status, "connected");
  assert.equal(directory.sources.find((row) => row.provider === "google_ads").status, "configuration_required");
  assert.equal(directory.sources.every((row) => row.write_mode === "disabled"), true, "a new account can read but never write");
});

test("real execution: the API route enforces marketing permissions and the same guardrails", async () => {
  setup(GOOGLE_CREDENTIALS);
  stubFetch({});
  const route = await import("../app/api/ad-spend/route.ts");
  const post = (body) => route.POST(new Request("http://localhost/api/ad-spend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  const saved = await post({ action: "save_source", provider: "google_ads", externalAccountId: "123-456-7890", label: "PawSpace India" });
  assert.equal(saved.status, 201);

  const unknown = await post({ action: "sync", provider: "tiktok_ads", externalAccountId: "1" });
  assert.equal(unknown.status, 400);

  const change = await post({ action: "apply_change", provider: "google_ads", externalAccountId: "123-456-7890", externalCampaignId: "111", change: { type: "pause" }, reason: "Cost per booking above target", approvalReference: "MKT-1", idempotencyKey: "route-pause" });
  assert.equal(change.status, 500, "a write-disabled account is refused through the route too");
  assert.match(String((await change.json()).error), /switched off|Unable to update/);

  const directory = await route.GET(new Request("http://localhost/api/ad-spend"));
  assert.equal(directory.status, 200);
});

test("the operator screen and the docs describe the same guardrails the code enforces", async () => {
  const { readFile } = await import("node:fs/promises");
  const [page, docs, lib, gateway] = await Promise.all([
    readFile(new URL("../app/team/marketing/ad-spend/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/AD_SPEND_CONNECTORS.md", import.meta.url), "utf8"),
    readFile(new URL("../lib/ad-spend-connectors.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8"),
  ]);
  // Both routes are offered, and the screen makes a live account visibly different from a read-only one.
  for (const provider of ["google_ads", "meta_ads", "supermetrics"]) assert.match(page, new RegExp(provider));
  assert.match(page, /Live — changes the real account/);
  assert.match(page, /Daily budget ceiling/);
  // A change always carries a reason and an approval reference from the screen too.
  assert.match(page, /approvalReference/);
  assert.match(page, /idempotencyKey/);
  // The route is behind marketing permissions in the central gateway, reads and writes separately.
  assert.match(gateway, /"\/api\/ad-spend"\)return method==="GET"\?"marketing\.view":"marketing\.manage"/);
  // Credentials are only ever reported as present or missing, never returned.
  assert.doesNotMatch(lib, /console\.(log|warn|error)/);
  assert.match(docs, /wrangler secret put/);
  assert.match(docs, /No spend without credentials/);
});

test("real execution: the console opens on a database that has never seen marketing tables", async () => {
  // Clicking through a fresh deployment answered `D1_ERROR: no such table:
  // governed_marketing_campaigns` and the whole screen failed to load.
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__AD_DB__ = makeD1(sqlite);
  globalThis.__AD_ENV__ = META_CREDENTIALS;
  stubFetch({});
  const connectors = await import("../lib/ad-spend-connectors.ts");

  const directory = await connectors.adSpendDirectory(globalThis.__AD_DB__);
  assert.deepEqual(directory.sources, []);
  assert.deepEqual(directory.spendByCampaign, []);
  assert.equal(directory.readiness.find((entry) => entry.provider === "meta_ads").missingCredentials.length, 0, "readiness still reports honestly on an empty database");
  assert.deepEqual(directory.writeCapableProviders, ["google_ads", "meta_ads"]);
});
