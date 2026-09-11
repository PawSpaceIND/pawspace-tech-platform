/** Provider-facing projection for Boarding stays (parity with sitting-provider-projection). */
type Row = Record<string, unknown>;

const SAFE_EVENT_DETAIL_KEYS = new Set([
  "action", "providerId", "status", "from", "to", "reason", "code", "fields",
  "extensionId", "requestedEnd", "commercialPolicy", "stayWindowUnchanged",
  "bookingPreserved", "recoveryId",
]);
const PII_VALUE = /(?:\+?91[\s().-]*)?(?:\d[\s().-]*){9}\d|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:street|road|nagar|layout|apartment|flat)\b|flat\s*#|\b(?:email|phone|mobile|contact|otp|pin|password)\b|called customer/i;
const SENSITIVE_KEY = /(?:email|phone|mobile|address|street|contact|staff|actor|internal|note|otp|pin|password)/i;

function safeString(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > max || PII_VALUE.test(s)) return null;
  return s;
}
function sanitizeDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  const out: Row = {};
  for (const [key, value] of Object.entries(detail as Row)) {
    if (!SAFE_EVENT_DETAIL_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    if (typeof value === "string") { const s = safeString(value); if (s !== null) out[key] = s; continue; }
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}
function projectEvent(row: Row) {
  return {
    id: String(row.id || ""),
    eventType: String(row.event_type || ""),
    actorId: "provider_or_system",
    detail: sanitizeDetail(row.detail ?? row.detail_json),
    createdAt: Number(row.created_at || 0),
  };
}
function projectCarePlan(care: Row | null | undefined) {
  if (!care) return null;
  const plan = (care.plan && typeof care.plan === "object" && !Array.isArray(care.plan) ? care.plan : {}) as Row;
  const out: Row = {};
  for (const key of ["feeding", "medication", "specialInstructions"] as const) {
    const s = safeString(plan[key], 1000);
    if (s !== null) out[key] = s;
  }
  out.hasEmergencyContact = Boolean(String(plan.emergencyContact || "").trim());
  out.hasVet = Boolean(String(plan.vet || "").trim());
  return { status: String(care.status || ""), plan: out, updatedAt: Number(care.updatedAt || care.updated_at || 0) };
}

export function projectBoardingProviderStay(row: Row) {
  return {
    id: String(row.id || ""),
    bookingId: String(row.booking_id || ""),
    status: String(row.status || ""),
    bookingStatus: row.booking_status != null ? String(row.booking_status) : null,
    hostProviderId: String(row.host_provider_id || ""),
    customerId: String(row.customer_id || ""),
    packageName: String(row.package_name || ""),
    checkInAt: String(row.check_in_at || ""),
    checkOutAt: String(row.check_out_at || ""),
    carePlanStatus: row.care_plan_status != null ? String(row.care_plan_status) : null,
    totalAmount: Number(row.total_amount || 0),
    amountDueNow: row.amount_due_now != null ? Number(row.amount_due_now) : null,
    carePlan: projectCarePlan(row.carePlan as Row | null | undefined),
    events: Array.isArray(row.events) ? (row.events as Row[]).map(projectEvent) : [],
    extension: row.extension
      ? {
          id: String((row.extension as Row).id || ""),
          requestedEnd: String((row.extension as Row).requested_end || ""),
          status: String((row.extension as Row).status || ""),
          createdAt: Number((row.extension as Row).created_at || 0),
        }
      : null,
  };
}
