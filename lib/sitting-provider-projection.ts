/**
 * Provider-facing field projection for Pet Sitting.
 *
 * Same class of gap as Grooming P0-6 / Training #676:
 * listSittingBookings returned SELECT * booking rows, raw sitting_care_events
 * (actor_id + detail_json), and the full care plan including emergency contact,
 * vet and home-access free text to service_provider sessions.
 *
 * Rule: providers get operational state required for the assigned visit only.
 */

type Row = Record<string, unknown>;

const SAFE_EVENT_DETAIL_KEYS = new Set([
  "action", "providerId", "status", "from", "to", "sessionId", "distanceMeters",
  "thresholdMeters", "geofence", "gpsConnected", "simulated", "telemetryMode",
  "reason", "code", "fields", "eventType", "legacyAcceptancePromoted",
  "bookingPreserved", "recoveryId",
]);

const PII_VALUE = /(?:\+?91[\s().-]*)?(?:\d[\s().-]*){9}\d|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:street|road|nagar|layout|apartment|flat)\b|flat\s*#|\b(?:email|phone|mobile|contact|otp|pin|password|key\s*code)\b|called customer/i;
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
    if (Array.isArray(value)) {
      out[key] = value.map((item) => safeString(item)).filter((item): item is string => item !== null);
      continue;
    }
    if (typeof value === "object" && value !== null) continue;
    if (typeof value === "string") {
      const s = safeString(value);
      if (s !== null) out[key] = s;
      continue;
    }
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

/** Care plan fields a sitter needs for the visit — contact-shaped values stripped. */
function projectCarePlan(care: Row | null | undefined) {
  if (!care) return null;
  const plan = (care.plan && typeof care.plan === "object" && !Array.isArray(care.plan)
    ? care.plan
    : {}) as Row;
  const out: Row = {};
  for (const key of ["feeding", "medication", "specialInstructions"] as const) {
    const s = safeString(plan[key], 1000);
    if (s !== null) out[key] = s;
  }
  // Presence flags only — never raw emergency/vet/home-access free text to the list API.
  out.hasEmergencyContact = Boolean(safeString(plan.emergencyContact, 200) || String(plan.emergencyContact || "").trim());
  out.hasVet = Boolean(safeString(plan.vet, 200) || String(plan.vet || "").trim());
  out.hasHomeAccess = Boolean(safeString(plan.homeAccess, 200) || String(plan.homeAccess || "").trim());
  return {
    status: String(care.status || ""),
    plan: out,
    updatedAt: Number(care.updatedAt || care.updated_at || 0),
  };
}

function projectRecovery(row: Row | null | undefined) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    status: String(row.status || ""),
    reasonCode: String(row.reason_code || ""),
    failedProviderId: String(row.failed_provider_id || ""),
    replacementProviderId: row.replacement_provider_id ? String(row.replacement_provider_id) : null,
    openedAt: Number(row.opened_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

export function projectSittingProviderBooking(row: Row) {
  return {
    id: String(row.id || ""),
    status: String(row.status || ""),
    serviceCode: String(row.service_code || "pet_sitting"),
    packageCode: String(row.package_code || ""),
    packageName: String(row.package_name || ""),
    cityId: String(row.city_id || ""),
    zoneId: String(row.zone_id || ""),
    scheduledStart: String(row.scheduled_start || ""),
    scheduledEnd: String(row.scheduled_end || ""),
    providerId: String(row.provider_id || ""),
    customerId: String(row.customer_id || ""),
    workOrderId: row.work_order_id ? String(row.work_order_id) : null,
    workOrderStatus: row.work_order_status != null ? String(row.work_order_status) : null,
    totalAmount: Number(row.total_amount || 0),
    currency: String(row.currency || "INR"),
    carePlan: projectCarePlan(row.carePlan as Row | null | undefined),
    events: Array.isArray(row.events) ? (row.events as Row[]).map(projectEvent) : [],
    recovery: projectRecovery(row.recovery as Row | null | undefined),
  };
}
