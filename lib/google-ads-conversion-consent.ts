import {
  generateMarketingAdReports,
  marketingAdConnectorStatus,
  syncMarketingAdMetrics,
  uploadGoogleOfflineConversionsDataManager as uploadUncheckedGoogleOfflineConversionsDataManager,
} from "./marketing-ad-connectors";

type Db = D1Database;
type Row = Record<string, unknown>;
type Runtime = Record<string, unknown>;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type GoogleAdsConsentValue = "Granted" | "Denied";

const text = (value: unknown) => String(value ?? "").trim();
const truthy = (value: unknown) => ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

function istDate(value: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (kind: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === kind)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function istHour(value: number) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date(value)));
}
function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function mondayOfWeek(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  const day = date.getUTCDay();
  return addDays(value, -((day + 6) % 7));
}
function dayOfWeek(value: string) {
  return new Date(`${value}T00:00:00.000Z`).getUTCDay();
}

export async function ensureGoogleAdsConversionConsent(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS google_ads_conversion_consent (customer_id TEXT PRIMARY KEY,ad_user_data TEXT NOT NULL CHECK(ad_user_data IN ('Granted','Denied')),ad_personalization TEXT NOT NULL CHECK(ad_personalization IN ('Granted','Denied')),source TEXT NOT NULL,captured_at INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS google_ads_conversion_consent_audit (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,ad_user_data TEXT NOT NULL,ad_personalization TEXT NOT NULL,source TEXT NOT NULL,captured_at INTEGER NOT NULL,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS google_ads_conversion_consent_audit_customer_idx ON google_ads_conversion_consent_audit(customer_id,created_at DESC)"),
  ]);
}

export async function recordGoogleAdsConversionConsent(db: Db, input: {
  customerId: string;
  adUserData: GoogleAdsConsentValue;
  adPersonalization: GoogleAdsConsentValue;
  source: string;
  capturedAt: number;
  actor: string;
}) {
  await ensureGoogleAdsConversionConsent(db);
  const customerId = text(input.customerId), source = text(input.source), actor = text(input.actor);
  if (!customerId || !source || source.length < 3 || !actor) throw new Response("Customer, consent source and actor are required", { status: 400 });
  if (!(["Granted", "Denied"] as string[]).includes(input.adUserData) || !(["Granted", "Denied"] as string[]).includes(input.adPersonalization)) throw new Response("Google consent values must be Granted or Denied", { status: 400 });
  if (!Number.isFinite(input.capturedAt) || input.capturedAt <= 0 || input.capturedAt > Date.now() + 60_000) throw new Response("A valid consent capture timestamp is required", { status: 400 });
  const customer = await db.prepare("SELECT id FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
  if (!customer) throw new Response("Canonical customer not found", { status: 404 });
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO google_ads_conversion_consent (customer_id,ad_user_data,ad_personalization,source,captured_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET ad_user_data=excluded.ad_user_data,ad_personalization=excluded.ad_personalization,source=excluded.source,captured_at=excluded.captured_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(customerId,input.adUserData,input.adPersonalization,source,Math.trunc(input.capturedAt),actor,now),
    db.prepare("INSERT INTO google_ads_conversion_consent_audit (id,customer_id,ad_user_data,ad_personalization,source,captured_at,updated_by,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(uid("GCONS"),customerId,input.adUserData,input.adPersonalization,source,Math.trunc(input.capturedAt),actor,now),
  ]);
  return { customerId, adUserData: input.adUserData, adPersonalization: input.adPersonalization, source, capturedAt: Math.trunc(input.capturedAt), actor };
}

async function conversionConsentCoverage(db: Db, from: number, to: number) {
  await ensureGoogleAdsConversionConsent(db);
  const row = await db.prepare(`
    SELECT
      COUNT(*) candidate_count,
      SUM(CASE WHEN consent.ad_user_data='Granted' AND consent.ad_personalization='Granted' THEN 1 ELSE 0 END) granted_count,
      SUM(CASE WHEN consent.customer_id IS NULL THEN 1 ELSE 0 END) missing_count,
      SUM(CASE WHEN consent.customer_id IS NOT NULL AND (consent.ad_user_data!='Granted' OR consent.ad_personalization!='Granted') THEN 1 ELSE 0 END) denied_count
    FROM whatsapp_conversion_facts facts
    INNER JOIN whatsapp_lead_attribution attribution
      ON attribution.id=(
        SELECT a.id FROM whatsapp_lead_attribution a
        WHERE a.lead_id=facts.lead_id
          AND a.customer_id=facts.customer_id
          AND a.thread_id=facts.thread_id
          AND a.source_platform='google'
          AND a.click_id IS NOT NULL
          AND TRIM(a.click_id)<>''
        ORDER BY a.created_at DESC,a.id DESC LIMIT 1
      )
    LEFT JOIN google_ads_conversion_consent consent ON consent.customer_id=facts.customer_id
    WHERE facts.event_type IN ('lead_qualified','booking_created','payment_captured')
      AND facts.occurred_at>=? AND facts.occurred_at<=?
  `).bind(from,to).first<Row>();
  return {
    candidates: Number(row?.candidate_count || 0),
    granted: Number(row?.granted_count || 0),
    missing: Number(row?.missing_count || 0),
    denied: Number(row?.denied_count || 0),
  };
}

export async function uploadGoogleOfflineConversionsDataManager(db: Db, runtime: Runtime, input: { from?: number; to?: number; validateOnly?: boolean; fetchImpl?: Fetcher } = {}) {
  const from = Number.isFinite(input.from) ? Number(input.from) : 0;
  const to = Number.isFinite(input.to) ? Number(input.to) : Number.MAX_SAFE_INTEGER;
  if (from > to) throw new Error("from must not be after to");
  const coverage = await conversionConsentCoverage(db, from, to);
  if (!coverage.candidates) return { status: "completed", submitted: 0, externalMutation: false, consent: coverage, duplicatePrevented: true };
  if (coverage.missing || coverage.denied || coverage.granted !== coverage.candidates) {
    return { status: "blocked_consent", submitted: 0, externalMutation: false, consent: coverage };
  }
  const result = await uploadUncheckedGoogleOfflineConversionsDataManager(db, runtime, input);
  return { ...result, consent: coverage };
}

export async function runMarketingConnectorScheduler(db: Db, input: { asOf?: number; runtime?: Runtime; fetchImpl?: Fetcher } = {}) {
  const asOf = input.asOf ?? Date.now(), runtime = input.runtime ?? {}, today = istDate(asOf), yesterday = addDays(today,-1), fetchImpl = input.fetchImpl;
  if (!dateOnly.test(today)) throw new Error("Unable to derive scheduler date");
  const sync = istHour(asOf) >= 6 ? await syncMarketingAdMetrics(db,runtime,{from:yesterday,to:yesterday,fetchImpl}) : [];
  const reports = await generateMarketingAdReports(db,{asOf});
  let offlineConversions: unknown = { status: "not_due" };
  if (dayOfWeek(today) === 1 && istHour(asOf) >= 7) {
    const fromDate = addDays(mondayOfWeek(today),-7), toDate = addDays(mondayOfWeek(today),-1);
    const from = Date.parse(`${fromDate}T00:00:00+05:30`), to = Date.parse(`${toDate}T23:59:59.999+05:30`);
    if (truthy(runtime.PAWSPACE_GOOGLE_DATA_MANAGER_UPLOAD_ENABLED)) offlineConversions = await uploadGoogleOfflineConversionsDataManager(db,runtime,{from,to,validateOnly:false,fetchImpl});
    else offlineConversions = { status: "live_upload_disabled", submitted: 0, externalMutation: false };
  }
  return { sync, reports, offlineConversions, connectorStatus: await marketingAdConnectorStatus(db,runtime), externalDelivery: false };
}
