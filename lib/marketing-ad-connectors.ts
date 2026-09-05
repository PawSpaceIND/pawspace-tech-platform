type Db = D1Database;
type Row = Record<string, unknown>;
type Runtime = Record<string, unknown>;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type MarketingAdPlatform = "google_ads" | "meta_ads";
export type MarketingMutationType = "budget" | "bid";

const text = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const integer = (value: unknown) => Math.max(0, Math.trunc(number(value)));
const truthy = (value: unknown) => ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const apiVersion = (value: unknown, fallback: string) => /^v\d+(?:\.\d+)?$/.test(text(value)) ? text(value) : fallback;
const cleanAccountId = (value: unknown) => text(value).replace(/[^0-9]/g, "");
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

function assertDate(value: string, field: string) {
  if (!dateOnly.test(value)) throw new Error(`${field} must use YYYY-MM-DD`);
}
function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function monthStart(value: string) { return `${value.slice(0, 7)}-01`; }
function previousMonth(value: string) {
  const date = new Date(`${monthStart(value)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}
function istDate(value: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (kind: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === kind)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function istHour(value: number) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date(value)));
}
function dayOfWeek(value: string) { return new Date(`${value}T00:00:00.000Z`).getUTCDay(); }
function mondayOfWeek(value: string) {
  const dow = dayOfWeek(value);
  return addDays(value, -((dow + 6) % 7));
}
function microsToMinor(value: unknown) { return Math.max(0, Math.round(number(value) / 10_000)); }
function unitsToMinor(value: unknown) { return Math.max(0, Math.round(number(value) * 100)); }
function metricDerived(impressions: number, clicks: number, spendMinor: number, conversions: number) {
  return {
    ctrPercent: impressions > 0 ? clicks / impressions * 100 : 0,
    cpcMinor: clicks > 0 ? Math.round(spendMinor / clicks) : 0,
    cpaMinor: conversions > 0 ? Math.round(spendMinor / conversions) : 0,
  };
}
function dimensionKey(input: Record<string, unknown>) {
  return ["platform", "accountId", "reportDate", "dimensionType", "campaignId", "adSetId", "adId", "keyword", "searchTerm", "matchType", "device", "ageRange", "gender"]
    .map(key => text(input[key]).toLowerCase().replaceAll("|", "%7C"))
    .join("|");
}

export async function ensureMarketingAdConnectorTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS marketing_ad_metric_facts (dimension_key TEXT PRIMARY KEY,platform TEXT NOT NULL,account_id TEXT NOT NULL,report_date TEXT NOT NULL,dimension_type TEXT NOT NULL,campaign_id TEXT,campaign_name TEXT,ad_set_id TEXT,ad_set_name TEXT,ad_id TEXT,ad_name TEXT,keyword TEXT,search_term TEXT,match_type TEXT,device TEXT,age_range TEXT,gender TEXT,impressions INTEGER NOT NULL DEFAULT 0,clicks INTEGER NOT NULL DEFAULT 0,spend_minor INTEGER NOT NULL DEFAULT 0,conversions REAL NOT NULL DEFAULT 0,conversion_value_minor INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'INR',ctr_percent REAL NOT NULL DEFAULT 0,cpc_minor INTEGER NOT NULL DEFAULT 0,cpa_minor INTEGER NOT NULL DEFAULT 0,current_bid_minor INTEGER,pulled_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS marketing_ad_metric_date_idx ON marketing_ad_metric_facts(report_date,platform,campaign_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS marketing_ad_metric_keyword_idx ON marketing_ad_metric_facts(keyword,report_date)"),
    db.prepare("CREATE TABLE IF NOT EXISTS marketing_ad_sync_runs (id TEXT PRIMARY KEY,platform TEXT NOT NULL,from_date TEXT NOT NULL,to_date TEXT NOT NULL,status TEXT NOT NULL,rows_written INTEGER NOT NULL DEFAULT 0,external_read INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 1,last_error TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,updated_at INTEGER NOT NULL,UNIQUE(platform,from_date,to_date))"),
    db.prepare("CREATE TABLE IF NOT EXISTS marketing_ad_report_runs (id TEXT PRIMARY KEY,cadence TEXT NOT NULL,period_key TEXT NOT NULL,from_date TEXT NOT NULL,to_date TEXT NOT NULL,status TEXT NOT NULL,row_count INTEGER NOT NULL DEFAULT 0,metrics_json TEXT NOT NULL DEFAULT '{}',generated_at INTEGER NOT NULL,UNIQUE(cadence,period_key))"),
    db.prepare("CREATE TABLE IF NOT EXISTS marketing_ad_mutation_audit (id TEXT PRIMARY KEY,platform TEXT NOT NULL,mutation_type TEXT NOT NULL,resource_id TEXT NOT NULL,amount_minor INTEGER NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,provider_request_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS marketing_offline_conversion_uploads (id TEXT PRIMARY KEY,fact_id TEXT NOT NULL,event_type TEXT NOT NULL,business_reference TEXT NOT NULL,click_id TEXT NOT NULL,conversion_action_id TEXT NOT NULL,status TEXT NOT NULL,validate_only INTEGER NOT NULL DEFAULT 0,request_id TEXT,last_error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(fact_id,conversion_action_id,validate_only))"),
  ]);
}

function googleConfig(runtime: Runtime) {
  const customerId = cleanAccountId(runtime.GOOGLE_ADS_CUSTOMER_ID);
  const developerToken = text(runtime.GOOGLE_ADS_DEVELOPER_TOKEN);
  const accessToken = text(runtime.GOOGLE_ADS_OAUTH_ACCESS_TOKEN);
  const loginCustomerId = cleanAccountId(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || customerId;
  return { customerId, developerToken, accessToken, loginCustomerId, version: apiVersion(runtime.GOOGLE_ADS_API_VERSION, "v25"), configured: Boolean(customerId && developerToken && accessToken) };
}
function metaConfig(runtime: Runtime) {
  const accountId = cleanAccountId(runtime.META_ADS_ACCOUNT_ID);
  const accessToken = text(runtime.META_ADS_ACCESS_TOKEN);
  const versionRaw = text(runtime.META_ADS_API_VERSION);
  return { accountId, accessToken, version: apiVersion(versionRaw, ""), configured: Boolean(accountId && accessToken && /^v\d+(?:\.\d+)?$/.test(versionRaw)) };
}
function dataManagerConfig(runtime: Runtime) {
  const customerId = cleanAccountId(runtime.GOOGLE_ADS_CUSTOMER_ID);
  const loginCustomerId = cleanAccountId(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || customerId;
  const accessToken = text(runtime.GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN);
  const actions: Record<string, string> = {
    lead_qualified: cleanAccountId(runtime.GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED),
    booking_created: cleanAccountId(runtime.GOOGLE_ADS_CONVERSION_ACTION_BOOKING_CREATED),
    payment_captured: cleanAccountId(runtime.GOOGLE_ADS_CONVERSION_ACTION_PAYMENT_CAPTURED),
  };
  return { customerId, loginCustomerId, accessToken, actions, configured: Boolean(customerId && accessToken && Object.values(actions).every(Boolean)) };
}

async function parseProviderResponse(response: Response, provider: string) {
  const raw = await response.text();
  let body: unknown = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw: raw.slice(0, 500) }; }
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
    throw new Error(`${provider} request failed (${response.status}): ${text(nested.message || record.message || response.statusText).slice(0, 300)}`);
  }
  return body as Record<string, unknown>;
}
function googleHeaders(config: ReturnType<typeof googleConfig>) {
  const headers: Record<string, string> = { "content-type": "application/json", "authorization": `Bearer ${config.accessToken}`, "developer-token": config.developerToken };
  if (config.loginCustomerId) headers["login-customer-id"] = config.loginCustomerId;
  return headers;
}

async function googleSearchAll(runtime: Runtime, query: string, fetchImpl: Fetcher) {
  const config = googleConfig(runtime);
  if (!config.configured) throw new Error("Google Ads connector is not configured");
  const endpoint = `https://googleads.googleapis.com/${config.version}/customers/${config.customerId}/googleAds:search`;
  const results: Row[] = [];
  let pageToken = "";
  for (let page = 0; page < 100; page += 1) {
    const response = await fetchImpl(endpoint, { method: "POST", headers: googleHeaders(config), body: JSON.stringify({ query, pageSize: 10_000, ...(pageToken ? { pageToken } : {}) }) });
    const body = await parseProviderResponse(response, "Google Ads");
    if (Array.isArray(body.results)) results.push(...body.results as Row[]);
    pageToken = text(body.nextPageToken);
    if (!pageToken) break;
  }
  return results;
}

async function metaInsightsAll(runtime: Runtime, from: string, to: string, fetchImpl: Fetcher) {
  const config = metaConfig(runtime);
  if (!config.configured) throw new Error("Meta Ads connector is not configured; META_ADS_API_VERSION must be explicit");
  const url = new URL(`https://graph.facebook.com/${config.version}/act_${config.accountId}/insights`);
  url.searchParams.set("fields", "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,date_start,account_currency,impressions,clicks,spend,ctr,cpc,conversions");
  url.searchParams.set("level", "ad");
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since: from, until: to }));
  url.searchParams.set("breakdowns", "age,gender");
  url.searchParams.set("limit", "500");
  const rows: Row[] = [];
  let next: string | null = url.toString();
  for (let page = 0; page < 100 && next; page += 1) {
    const parsed = new URL(next);
    if (parsed.protocol !== "https:" || parsed.hostname !== "graph.facebook.com") throw new Error("Meta pagination URL failed provider-host validation");
    const response = await fetchImpl(parsed, { headers: { authorization: `Bearer ${config.accessToken}` } });
    const body = await parseProviderResponse(response, "Meta Ads");
    if (Array.isArray(body.data)) rows.push(...body.data as Row[]);
    const paging = body.paging && typeof body.paging === "object" ? body.paging as Record<string, unknown> : {};
    next = text(paging.next) || null;
  }
  return rows;
}

function googleMetricRow(raw: Row, accountId: string, dimensionType: string) {
  const campaign = raw.campaign && typeof raw.campaign === "object" ? raw.campaign as Row : {};
  const adGroup = raw.adGroup && typeof raw.adGroup === "object" ? raw.adGroup as Row : {};
  const criterion = raw.adGroupCriterion && typeof raw.adGroupCriterion === "object" ? raw.adGroupCriterion as Row : {};
  const keyword = criterion.keyword && typeof criterion.keyword === "object" ? criterion.keyword as Row : {};
  const ageRange = criterion.ageRange && typeof criterion.ageRange === "object" ? criterion.ageRange as Row : {};
  const gender = criterion.gender && typeof criterion.gender === "object" ? criterion.gender as Row : {};
  const searchTermView = raw.searchTermView && typeof raw.searchTermView === "object" ? raw.searchTermView as Row : {};
  const segments = raw.segments && typeof raw.segments === "object" ? raw.segments as Row : {};
  const metrics = raw.metrics && typeof raw.metrics === "object" ? raw.metrics as Row : {};
  const customer = raw.customer && typeof raw.customer === "object" ? raw.customer as Row : {};
  const impressions = integer(metrics.impressions), clicks = integer(metrics.clicks), spendMinor = microsToMinor(metrics.costMicros), conversions = Math.max(0, number(metrics.conversions));
  const derived = metricDerived(impressions, clicks, spendMinor, conversions);
  const currentBidMinor = text(adGroup.cpcBidMicros) ? microsToMinor(adGroup.cpcBidMicros) : null;
  const row = {
    platform: "google_ads", accountId, reportDate: text(segments.date), dimensionType,
    campaignId: text(campaign.id), campaignName: text(campaign.name), adSetId: text(adGroup.id), adSetName: text(adGroup.name), adId: "", adName: "",
    keyword: text(keyword.text), searchTerm: text(searchTermView.searchTerm), matchType: text(keyword.matchType || segments.matchType), device: text(segments.device),
    ageRange: text(ageRange.type), gender: text(gender.type), impressions, clicks, spendMinor, conversions,
    conversionValueMinor: unitsToMinor(metrics.conversionsValue), currency: text(customer.currencyCode) || "INR", ...derived, currentBidMinor,
  };
  return { ...row, dimensionKey: dimensionKey(row) };
}
function metaConversionCount(value: unknown) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + number(item && typeof item === "object" ? (item as Row).value : item), 0);
  return Math.max(0, number(value));
}
function metaMetricRow(raw: Row, accountId: string) {
  const impressions = integer(raw.impressions), clicks = integer(raw.clicks), spendMinor = unitsToMinor(raw.spend), conversions = metaConversionCount(raw.conversions);
  const derived = metricDerived(impressions, clicks, spendMinor, conversions);
  const row = {
    platform: "meta_ads", accountId, reportDate: text(raw.date_start), dimensionType: "demographic_ad",
    campaignId: text(raw.campaign_id), campaignName: text(raw.campaign_name), adSetId: text(raw.adset_id), adSetName: text(raw.adset_name), adId: text(raw.ad_id), adName: text(raw.ad_name),
    keyword: "", searchTerm: "", matchType: "", device: "", ageRange: text(raw.age), gender: text(raw.gender), impressions, clicks, spendMinor, conversions,
    conversionValueMinor: 0, currency: text(raw.account_currency) || "INR", ...derived, currentBidMinor: null as number | null,
  };
  return { ...row, dimensionKey: dimensionKey(row) };
}

type NormalizedMetric = ReturnType<typeof googleMetricRow>;
async function upsertMetric(db: Db, row: NormalizedMetric, pulledAt: number) {
  const result = await db.prepare("INSERT INTO marketing_ad_metric_facts (dimension_key,platform,account_id,report_date,dimension_type,campaign_id,campaign_name,ad_set_id,ad_set_name,ad_id,ad_name,keyword,search_term,match_type,device,age_range,gender,impressions,clicks,spend_minor,conversions,conversion_value_minor,currency,ctr_percent,cpc_minor,cpa_minor,current_bid_minor,pulled_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dimension_key) DO UPDATE SET campaign_name=excluded.campaign_name,ad_set_name=excluded.ad_set_name,ad_name=excluded.ad_name,impressions=excluded.impressions,clicks=excluded.clicks,spend_minor=excluded.spend_minor,conversions=excluded.conversions,conversion_value_minor=excluded.conversion_value_minor,currency=excluded.currency,ctr_percent=excluded.ctr_percent,cpc_minor=excluded.cpc_minor,cpa_minor=excluded.cpa_minor,current_bid_minor=excluded.current_bid_minor,pulled_at=excluded.pulled_at,updated_at=excluded.updated_at")
    .bind(row.dimensionKey,row.platform,row.accountId,row.reportDate,row.dimensionType,row.campaignId||null,row.campaignName||null,row.adSetId||null,row.adSetName||null,row.adId||null,row.adName||null,row.keyword||null,row.searchTerm||null,row.matchType||null,row.device||null,row.ageRange||null,row.gender||null,row.impressions,row.clicks,row.spendMinor,row.conversions,row.conversionValueMinor,row.currency,row.ctrPercent,row.cpcMinor,row.cpaMinor,row.currentBidMinor,pulledAt,pulledAt).run();
  return Number(result.meta?.changes || 0);
}
async function beginSyncRun(db: Db, platform: MarketingAdPlatform, from: string, to: string, now: number) {
  const existing = await db.prepare("SELECT * FROM marketing_ad_sync_runs WHERE platform=? AND from_date=? AND to_date=?").bind(platform, from, to).first<Row>();
  if (text(existing?.status) === "completed") return { id: text(existing?.id), duplicate: true };
  const id = text(existing?.id) || uid("MADSYNC");
  if (existing) await db.prepare("UPDATE marketing_ad_sync_runs SET status='running',attempts=attempts+1,last_error=NULL,started_at=?,updated_at=? WHERE id=?").bind(now, now, id).run();
  else await db.prepare("INSERT INTO marketing_ad_sync_runs (id,platform,from_date,to_date,status,rows_written,external_read,attempts,started_at,updated_at) VALUES (?,?,?,?,'running',0,0,1,?,?)").bind(id, platform, from, to, now, now).run();
  return { id, duplicate: false };
}
async function finishSyncRun(db: Db, id: string, status: "completed" | "failed", rows: number, externalRead: boolean, error: string | null, now: number) {
  await db.prepare("UPDATE marketing_ad_sync_runs SET status=?,rows_written=?,external_read=?,last_error=?,finished_at=?,updated_at=? WHERE id=?").bind(status, rows, externalRead ? 1 : 0, error, now, now, id).run();
}

export async function syncGoogleAdsMetrics(db: Db, runtime: Runtime, input: { from: string; to: string; fetchImpl?: Fetcher }) {
  assertDate(input.from, "from"); assertDate(input.to, "to"); if (input.from > input.to) throw new Error("from must not be after to");
  await ensureMarketingAdConnectorTables(db);
  const config = googleConfig(runtime); if (!config.configured) return { platform: "google_ads" as const, status: "not_configured", rowsWritten: 0, externalRead: false };
  const now = Date.now(), run = await beginSyncRun(db, "google_ads", input.from, input.to, now); if (run.duplicate) return { platform: "google_ads" as const, status: "completed", rowsWritten: 0, externalRead: true, duplicatePrevented: true };
  const fetchImpl = input.fetchImpl || fetch;
  const common = `segments.date,segments.device,campaign.id,campaign.name,ad_group.id,ad_group.name,ad_group.cpc_bid_micros,customer.currency_code,metrics.impressions,metrics.clicks,metrics.cost_micros,metrics.conversions,metrics.conversions_value`;
  const queries = [
    { type: "keyword", sql: `SELECT ${common},ad_group_criterion.criterion_id,ad_group_criterion.keyword.text,ad_group_criterion.keyword.match_type FROM keyword_view WHERE segments.date BETWEEN '${input.from}' AND '${input.to}'` },
    { type: "search_term", sql: `SELECT ${common},search_term_view.search_term FROM search_term_view WHERE segments.date BETWEEN '${input.from}' AND '${input.to}'` },
    { type: "age", sql: `SELECT ${common},ad_group_criterion.age_range.type FROM age_range_view WHERE segments.date BETWEEN '${input.from}' AND '${input.to}'` },
    { type: "gender", sql: `SELECT ${common},ad_group_criterion.gender.type FROM gender_view WHERE segments.date BETWEEN '${input.from}' AND '${input.to}'` },
  ];
  try {
    let rowsWritten = 0;
    for (const query of queries) {
      const rows = await googleSearchAll(runtime, query.sql, fetchImpl);
      for (const raw of rows) {
        const normalized = googleMetricRow(raw, config.customerId, query.type);
        if (!dateOnly.test(normalized.reportDate)) continue;
        rowsWritten += await upsertMetric(db, normalized, now);
      }
    }
    await finishSyncRun(db, run.id, "completed", rowsWritten, true, null, Date.now());
    return { platform: "google_ads" as const, status: "completed", rowsWritten, externalRead: true, duplicatePrevented: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(db, run.id, "failed", 0, false, message, Date.now());
    throw error;
  }
}

export async function syncMetaAdsMetrics(db: Db, runtime: Runtime, input: { from: string; to: string; fetchImpl?: Fetcher }) {
  assertDate(input.from, "from"); assertDate(input.to, "to"); if (input.from > input.to) throw new Error("from must not be after to");
  await ensureMarketingAdConnectorTables(db);
  const config = metaConfig(runtime); if (!config.configured) return { platform: "meta_ads" as const, status: "not_configured", rowsWritten: 0, externalRead: false };
  const now = Date.now(), run = await beginSyncRun(db, "meta_ads", input.from, input.to, now); if (run.duplicate) return { platform: "meta_ads" as const, status: "completed", rowsWritten: 0, externalRead: true, duplicatePrevented: true };
  const fetchImpl = input.fetchImpl || fetch;
  try {
    const rows = await metaInsightsAll(runtime, input.from, input.to, fetchImpl);
    let rowsWritten = 0;
    for (const raw of rows) {
      const normalized = metaMetricRow(raw, config.accountId) as NormalizedMetric;
      if (!dateOnly.test(normalized.reportDate)) continue;
      rowsWritten += await upsertMetric(db, normalized, now);
    }
    await finishSyncRun(db, run.id, "completed", rowsWritten, true, null, Date.now());
    return { platform: "meta_ads" as const, status: "completed", rowsWritten, externalRead: true, duplicatePrevented: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(db, run.id, "failed", 0, false, message, Date.now());
    throw error;
  }
}

export async function syncMarketingAdMetrics(db: Db, runtime: Runtime, input: { from: string; to: string; fetchImpl?: Fetcher }) {
  const settled = await Promise.allSettled([syncGoogleAdsMetrics(db, runtime, input), syncMetaAdsMetrics(db, runtime, input)]);
  return settled.map((result, index) => result.status === "fulfilled" ? result.value : { platform: index === 0 ? "google_ads" : "meta_ads", status: "failed", error: result.reason instanceof Error ? result.reason.message : String(result.reason), rowsWritten: 0, externalRead: false });
}

async function lastSuccessfulSync(db: Db, platform: MarketingAdPlatform) {
  return db.prepare("SELECT * FROM marketing_ad_sync_runs WHERE platform=? AND status='completed' AND external_read=1 ORDER BY finished_at DESC LIMIT 1").bind(platform).first<Row>();
}
export async function marketingAdConnectorStatus(db: Db, runtime: Runtime) {
  await ensureMarketingAdConnectorTables(db);
  const google = googleConfig(runtime), meta = metaConfig(runtime), [googleLast, metaLast] = await Promise.all([lastSuccessfulSync(db, "google_ads"), lastSuccessfulSync(db, "meta_ads")]);
  const state = (configured: boolean, last: Row | null) => last ? "verified_connected" : configured ? "configured_unverified" : "not_configured";
  return {
    googleAds: { state: state(google.configured, googleLast), configured: google.configured, lastSuccessfulSync: googleLast || null },
    metaAds: { state: state(meta.configured, metaLast), configured: meta.configured, lastSuccessfulSync: metaLast || null },
    externalWritesEnabled: truthy(runtime.PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED),
    googleDataManager: { configured: dataManagerConfig(runtime).configured, uploadEnabled: truthy(runtime.PAWSPACE_GOOGLE_DATA_MANAGER_UPLOAD_ENABLED) },
  };
}

export async function listMarketingAdMetrics(db: Db, input: { from: string; to: string; platform?: MarketingAdPlatform; limit?: number }) {
  assertDate(input.from, "from"); assertDate(input.to, "to");
  await ensureMarketingAdConnectorTables(db);
  const limit = Math.min(5000, Math.max(1, Math.trunc(input.limit || 1000)));
  if (input.platform) return (await db.prepare("SELECT * FROM marketing_ad_metric_facts WHERE report_date>=? AND report_date<=? AND platform=? ORDER BY report_date DESC,campaign_name,ad_set_name LIMIT ?").bind(input.from,input.to,input.platform,limit).all<Row>()).results;
  return (await db.prepare("SELECT * FROM marketing_ad_metric_facts WHERE report_date>=? AND report_date<=? ORDER BY report_date DESC,platform,campaign_name,ad_set_name LIMIT ?").bind(input.from,input.to,limit).all<Row>()).results;
}

async function reportAggregate(db: Db, from: string, to: string) {
  const total = await db.prepare("SELECT COUNT(*) row_count,COALESCE(SUM(impressions),0) impressions,COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(spend_minor),0) spend_minor,COALESCE(SUM(conversions),0) conversions,COALESCE(SUM(conversion_value_minor),0) conversion_value_minor FROM marketing_ad_metric_facts WHERE report_date>=? AND report_date<=?").bind(from,to).first<Row>();
  const platforms = await db.prepare("SELECT platform,COUNT(*) row_count,COALESCE(SUM(impressions),0) impressions,COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(spend_minor),0) spend_minor,COALESCE(SUM(conversions),0) conversions,COALESCE(SUM(conversion_value_minor),0) conversion_value_minor FROM marketing_ad_metric_facts WHERE report_date>=? AND report_date<=? GROUP BY platform ORDER BY platform").bind(from,to).all<Row>();
  const spend = integer(total?.spend_minor), conversions = Math.max(0, number(total?.conversions)), revenue = integer(total?.conversion_value_minor);
  return { ...total, cpa_minor: conversions > 0 ? Math.round(spend / conversions) : 0, roas: spend > 0 ? revenue / spend : 0, platforms: platforms.results };
}
async function persistReport(db: Db, cadence: "daily" | "weekly" | "monthly", periodKey: string, from: string, to: string, now: number) {
  const existing = await db.prepare("SELECT * FROM marketing_ad_report_runs WHERE cadence=? AND period_key=?").bind(cadence,periodKey).first<Row>();
  if (existing) return { ...existing, duplicatePrevented: true };
  const metrics = await reportAggregate(db, from, to), id = uid("MADREP"), rowCount = integer(metrics.row_count);
  await db.prepare("INSERT INTO marketing_ad_report_runs (id,cadence,period_key,from_date,to_date,status,row_count,metrics_json,generated_at) VALUES (?,?,?,?,?,'generated',?,?,?)").bind(id,cadence,periodKey,from,to,rowCount,JSON.stringify(metrics),now).run();
  return { id,cadence,periodKey,from,to,status:"generated",rowCount,metrics,duplicatePrevented:false };
}
export async function generateMarketingAdReports(db: Db, input: { asOf?: number } = {}) {
  await ensureMarketingAdConnectorTables(db);
  const asOf = input.asOf ?? Date.now(), today = istDate(asOf), yesterday = addDays(today,-1), currentMonday = mondayOfWeek(today), previousMonday = addDays(currentMonday,-7), previousSunday = addDays(currentMonday,-1), prevMonth = previousMonth(today), prevMonthEnd = addDays(monthStart(today),-1);
  return {
    daily: await persistReport(db,"daily",yesterday,yesterday,yesterday,asOf),
    weekly: await persistReport(db,"weekly",`${previousMonday}_${previousSunday}`,previousMonday,previousSunday,asOf),
    monthly: await persistReport(db,"monthly",prevMonth.slice(0,7),prevMonth,prevMonthEnd,asOf),
  };
}
export async function recentMarketingAdReports(db: Db, limit = 30) {
  await ensureMarketingAdConnectorTables(db);
  return (await db.prepare("SELECT * FROM marketing_ad_report_runs ORDER BY generated_at DESC LIMIT ?").bind(Math.min(100,Math.max(1,Math.trunc(limit)))).all<Row>()).results;
}

export async function mutateMarketingAdResource(db: Db, runtime: Runtime, input: { platform: MarketingAdPlatform; mutationType: MarketingMutationType; resourceId: string; amountMinor: number; actor: string; reason: string; fetchImpl?: Fetcher }) {
  await ensureMarketingAdConnectorTables(db);
  if (!truthy(runtime.PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED)) throw new Response("External marketing writes are disabled", { status: 409 });
  const resourceId = cleanAccountId(input.resourceId), amountMinor = Math.max(1, Math.trunc(input.amountMinor)), actor = text(input.actor), reason = text(input.reason);
  if (!resourceId || !Number.isFinite(input.amountMinor) || amountMinor <= 0 || !actor || reason.length < 8) throw new Response("Resource ID, positive amount, actor and a clear reason are required", { status: 400 });
  const now = Date.now(), auditId = uid("MADMUT"), fetchImpl = input.fetchImpl || fetch;
  await db.prepare("INSERT INTO marketing_ad_mutation_audit (id,platform,mutation_type,resource_id,amount_minor,actor,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'running',?,?)").bind(auditId,input.platform,input.mutationType,resourceId,amountMinor,actor,reason,now,now).run();
  try {
    let response: Response;
    if (input.platform === "google_ads") {
      const config = googleConfig(runtime); if (!config.configured) throw new Error("Google Ads connector is not configured");
      const endpointType = input.mutationType === "budget" ? "campaignBudgets" : "adGroups";
      const resourceType = input.mutationType === "budget" ? "campaignBudgets" : "adGroups";
      const field = input.mutationType === "budget" ? "amountMicros" : "cpcBidMicros";
      const updateMask = input.mutationType === "budget" ? "amount_micros" : "cpc_bid_micros";
      response = await fetchImpl(`https://googleads.googleapis.com/${config.version}/customers/${config.customerId}/${endpointType}:mutate`, { method:"POST",headers:googleHeaders(config),body:JSON.stringify({operations:[{update:{resourceName:`customers/${config.customerId}/${resourceType}/${resourceId}`,[field]:String(amountMinor*10_000)},updateMask}]}) });
    } else {
      const config = metaConfig(runtime); if (!config.configured) throw new Error("Meta Ads connector is not configured; META_ADS_API_VERSION must be explicit");
      const body = new URLSearchParams(); body.set(input.mutationType === "budget" ? "daily_budget" : "bid_amount", String(amountMinor));
      response = await fetchImpl(`https://graph.facebook.com/${config.version}/${resourceId}`, { method:"POST",headers:{authorization:`Bearer ${config.accessToken}`,"content-type":"application/x-www-form-urlencoded"},body:body.toString() });
    }
    const parsed = await parseProviderResponse(response, input.platform === "google_ads" ? "Google Ads" : "Meta Ads");
    const requestId = response.headers.get("request-id") || response.headers.get("x-fb-trace-id") || text(parsed.requestId || parsed.id);
    await db.prepare("UPDATE marketing_ad_mutation_audit SET status='completed',provider_request_id=?,updated_at=? WHERE id=?").bind(requestId||null,Date.now(),auditId).run();
    return { id:auditId,platform:input.platform,mutationType:input.mutationType,resourceId,amountMinor,status:"completed",externalMutation:true,providerRequestId:requestId||null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare("UPDATE marketing_ad_mutation_audit SET status='failed',updated_at=? WHERE id=?").bind(Date.now(),auditId).run();
    throw error;
  }
}

export async function petGroomingBangaloreRecommendation(db: Db, input: { from: string; to: string; targetCpaMinor: number }) {
  assertDate(input.from,"from"); assertDate(input.to,"to"); await ensureMarketingAdConnectorTables(db);
  const rows = await db.prepare("SELECT ad_set_id,ad_set_name,current_bid_minor,SUM(impressions) impressions,SUM(clicks) clicks,SUM(spend_minor) spend_minor,SUM(conversions) conversions,SUM(conversion_value_minor) conversion_value_minor FROM marketing_ad_metric_facts WHERE platform='google_ads' AND dimension_type='keyword' AND report_date>=? AND report_date<=? AND LOWER(TRIM(keyword))='pet grooming bangalore' GROUP BY ad_set_id,ad_set_name,current_bid_minor ORDER BY spend_minor DESC").bind(input.from,input.to).all<Row>();
  const target = Math.max(1,Math.trunc(input.targetCpaMinor));
  return rows.results.map(row=>{const spend=integer(row.spend_minor),conversions=Math.max(0,number(row.conversions)),currentBid=integer(row.current_bid_minor),cpa=conversions>0?Math.round(spend/conversions):null;let factor=1;if(conversions===0&&spend>0)factor=0.9;else if(cpa!=null&&cpa>target*1.1)factor=0.9;else if(cpa!=null&&cpa<target*0.9)factor=1.1;return{keyword:"pet grooming bangalore",adSetId:text(row.ad_set_id),adSetName:text(row.ad_set_name),impressions:integer(row.impressions),clicks:integer(row.clicks),spendMinor:spend,conversions,cpaMinor:cpa,targetCpaMinor:target,currentBidMinor:currentBid||null,recommendedBidMinor:currentBid?Math.max(1,Math.round(currentBid*factor)):null,adjustmentPercent:Math.round((factor-1)*100),reason:conversions===0&&spend>0?"spend_without_conversion":cpa!=null&&cpa>target*1.1?"cpa_above_target":cpa!=null&&cpa<target*0.9?"cpa_below_target":"within_target_band"};});
}

function conversionAction(config: ReturnType<typeof dataManagerConfig>, eventType: string) { return text(config.actions[eventType]); }
export async function uploadGoogleOfflineConversionsDataManager(db: Db, runtime: Runtime, input: { from?: number; to?: number; validateOnly?: boolean; fetchImpl?: Fetcher } = {}) {
  await ensureMarketingAdConnectorTables(db);
  const config = dataManagerConfig(runtime); if (!config.configured) return { status:"not_configured",submitted:0,externalMutation:false };
  const validateOnly = Boolean(input.validateOnly), uploadEnabled = truthy(runtime.PAWSPACE_GOOGLE_DATA_MANAGER_UPLOAD_ENABLED);
  if (!validateOnly && !uploadEnabled) throw new Response("Google Data Manager live upload is disabled",{status:409});
  const from = Number.isFinite(input.from) ? Number(input.from) : 0, to = Number.isFinite(input.to) ? Number(input.to) : Number.MAX_SAFE_INTEGER;
  if (from > to) throw new Error("from must not be after to");
  const facts = await db.prepare(`SELECT facts.id fact_id,facts.event_type,facts.business_reference,facts.occurred_at,facts.value_minor,attribution.click_id FROM whatsapp_conversion_facts facts INNER JOIN whatsapp_lead_attribution attribution ON attribution.id=(SELECT a.id FROM whatsapp_lead_attribution a WHERE a.lead_id=facts.lead_id AND a.customer_id=facts.customer_id AND a.thread_id=facts.thread_id AND a.source_platform='google' AND a.click_id IS NOT NULL AND TRIM(a.click_id)<>'' ORDER BY a.created_at DESC,a.id DESC LIMIT 1) WHERE facts.event_type IN ('lead_qualified','booking_created','payment_captured') AND facts.occurred_at>=? AND facts.occurred_at<=? ORDER BY facts.occurred_at,facts.id`).bind(from,to).all<Row>();
  const pending: Row[]=[];
  for(const fact of facts.results){const action=conversionAction(config,text(fact.event_type));if(!action)continue;const prior=await db.prepare("SELECT status FROM marketing_offline_conversion_uploads WHERE fact_id=? AND conversion_action_id=? AND validate_only=?").bind(fact.fact_id,action,validateOnly?1:0).first<Row>();if(text(prior?.status)==="submitted")continue;pending.push({...fact,conversion_action_id:action});}
  if(!pending.length)return{status:"completed",submitted:0,externalMutation:false,duplicatePrevented:true};
  const groups=new Map<string,Row[]>();for(const row of pending){const action=text(row.conversion_action_id);groups.set(action,[...(groups.get(action)||[]),row]);}
  const fetchImpl=input.fetchImpl||fetch;let submitted=0;const requestIds:string[]=[];
  for(const[action,rows]of groups){const events=rows.map(row=>({adIdentifiers:{gclid:text(row.click_id)},conversionValue:number(row.value_minor)/100,currency:"INR",eventTimestamp:new Date(number(row.occurred_at)).toISOString(),transactionId:text(row.business_reference),eventSource:"WEB"}));const destination={operatingAccount:{accountType:"GOOGLE_ADS",accountId:config.customerId},loginAccount:{accountType:"GOOGLE_ADS",accountId:config.loginCustomerId},productDestinationId:action};const response=await fetchImpl("https://datamanager.googleapis.com/v1/events:ingest",{method:"POST",headers:{authorization:`Bearer ${config.accessToken}`,"content-type":"application/json"},body:JSON.stringify({destinations:[destination],events,consent:{adUserData:"CONSENT_GRANTED",adPersonalization:"CONSENT_GRANTED"},validateOnly})});const parsed=await parseProviderResponse(response,"Google Data Manager");const requestId=text(parsed.requestId);if(requestId)requestIds.push(requestId);for(const row of rows){await db.prepare("INSERT INTO marketing_offline_conversion_uploads (id,fact_id,event_type,business_reference,click_id,conversion_action_id,status,validate_only,request_id,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,'submitted',?,?,NULL,?,?) ON CONFLICT(fact_id,conversion_action_id,validate_only) DO UPDATE SET status='submitted',request_id=excluded.request_id,last_error=NULL,updated_at=excluded.updated_at").bind(uid("MADOFF"),row.fact_id,row.event_type,row.business_reference,row.click_id,action,validateOnly?1:0,requestId||null,Date.now(),Date.now()).run();submitted++;}}
  return{status:"completed",submitted,externalMutation:!validateOnly,validateOnly,requestIds};
}

async function runtimeFromCloudflare() {
  try { const { env } = await import("cloudflare:workers"); return env as unknown as Runtime; } catch { return {}; }
}
export async function runMarketingConnectorScheduler(db: Db, input: { asOf?: number; runtime?: Runtime; fetchImpl?: Fetcher } = {}) {
  const asOf=input.asOf??Date.now(),runtime=input.runtime??await runtimeFromCloudflare(),today=istDate(asOf),yesterday=addDays(today,-1),fetchImpl=input.fetchImpl;
  await ensureMarketingAdConnectorTables(db);
  const sync=istHour(asOf)>=6?await syncMarketingAdMetrics(db,runtime,{from:yesterday,to:yesterday,fetchImpl}):[];
  const reports=await generateMarketingAdReports(db,{asOf});
  let offlineConversions:unknown={status:"not_due"};
  if(dayOfWeek(today)===1&&istHour(asOf)>=7){const from=addDays(mondayOfWeek(today),-7),to=addDays(mondayOfWeek(today),-1);const fromMs=Date.parse(`${from}T00:00:00+05:30`),toMs=Date.parse(`${to}T23:59:59.999+05:30`);offlineConversions=await uploadGoogleOfflineConversionsDataManager(db,runtime,{from:fromMs,to:toMs,validateOnly:false,fetchImpl}).catch(error=>({status:"failed",error:error instanceof Error?error.message:String(error)}));}
  return{sync,reports,offlineConversions,connectorStatus:await marketingAdConnectorStatus(db,runtime),externalDelivery:false};
}
