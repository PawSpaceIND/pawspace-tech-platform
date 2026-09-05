type D1Row = Record<string, unknown>;
type D1Result<T> = { results?: T[] };
type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  all: <T = D1Row>() => Promise<D1Result<T>>;
};
type D1Like = { prepare: (sql: string) => D1PreparedStatement };

export type GoogleAdsOfflineConversion = {
  googleClickId: string;
  conversionName: string;
  conversionTime: string;
  conversionValue: string;
  conversionCurrency: "INR";
  adUserData: "Granted";
  adPersonalization: "Granted";
};

const CSV_PARAMETER_ROW = "Parameters:TimeZone=Asia/Kolkata,,,,,,";
const CSV_HEADER_ROW = "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Ad User Data,Ad Personalization";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function formatIstTimestamp(epochMs: number) {
  if (!Number.isFinite(epochMs)) throw new Error("Conversion occurred_at must be a finite epoch millisecond timestamp");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function formatMinorValue(valueMinor: unknown) {
  const minor = Number(valueMinor);
  if (!Number.isFinite(minor)) throw new Error("Conversion value_minor must be finite");
  return (minor / 100).toFixed(2);
}

function conversionName(eventType: unknown) {
  switch (text(eventType)) {
    case "payment_captured": return "PawSpace Paid Booking";
    case "booking_created": return "PawSpace Booking Created";
    case "lead_qualified": return "PawSpace Qualified Lead";
    default: throw new Error(`Unsupported conversion event: ${text(eventType) || "<empty>"}`);
  }
}

export function buildGoogleAdsOfflineConversionCsv(rows: D1Row[]) {
  const dataRows = rows.map(row => {
    const clickId = text(row.click_id);
    if (!clickId) throw new Error("Google Click ID is required for offline conversion export");
    const record: GoogleAdsOfflineConversion = {
      googleClickId: clickId,
      conversionName: conversionName(row.event_type),
      conversionTime: formatIstTimestamp(Number(row.occurred_at)),
      conversionValue: formatMinorValue(row.value_minor),
      conversionCurrency: "INR",
      adUserData: "Granted",
      adPersonalization: "Granted",
    };
    return [
      record.googleClickId,
      record.conversionName,
      record.conversionTime,
      record.conversionValue,
      record.conversionCurrency,
      record.adUserData,
      record.adPersonalization,
    ].map(csvCell).join(",");
  });
  return [CSV_PARAMETER_ROW, CSV_HEADER_ROW, ...dataRows].join("\n");
}

export async function exportGoogleAdsOfflineConversions(db: D1Like, input: { from?: number; to?: number } = {}) {
  const from = Number.isFinite(input.from) ? Number(input.from) : 0;
  const to = Number.isFinite(input.to) ? Number(input.to) : Number.MAX_SAFE_INTEGER;
  if (from > to) throw new Error("Conversion export from must be less than or equal to to");

  const query = `
    SELECT
      attribution.click_id,
      facts.event_type,
      facts.occurred_at,
      facts.value_minor
    FROM whatsapp_conversion_facts AS facts
    INNER JOIN whatsapp_lead_attribution AS attribution
      ON attribution.lead_id = facts.lead_id
     AND attribution.customer_id = facts.customer_id
     AND attribution.thread_id = facts.thread_id
    WHERE attribution.source_platform = 'google'
      AND attribution.click_id IS NOT NULL
      AND TRIM(attribution.click_id) <> ''
      AND facts.event_type IN ('lead_qualified','booking_created','payment_captured')
      AND facts.occurred_at >= ?
      AND facts.occurred_at <= ?
    ORDER BY facts.occurred_at ASC, facts.id ASC
  `;
  const result = await db.prepare(query).bind(from, to).all<D1Row>();
  const rows = Array.isArray(result.results) ? result.results : [];
  return buildGoogleAdsOfflineConversionCsv(rows);
}

export const GOOGLE_ADS_OFFLINE_CONVERSION_PARAMETER_ROW = CSV_PARAMETER_ROW;
export const GOOGLE_ADS_OFFLINE_CONVERSION_HEADER_ROW = CSV_HEADER_ROW;
