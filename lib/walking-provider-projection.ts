/**
 * Provider-facing field projection for Dog Walking.
 *
 * Same class of gap as Grooming P0-6 / Training #676:
 * listWalkingBookings returned SELECT * booking rows, raw walking_session_events
 * (actor_id + detail_json), and recovery/payment blobs to service_provider sessions.
 *
 * Rule: providers get operational walk state only.
 */

type Row = Record<string, unknown>;

const SAFE_EVENT_DETAIL_KEYS = new Set([
  "action", "providerId", "status", "from", "to", "sessionId", "distanceMeters",
  "thresholdMeters", "geofence", "gpsConnected", "telemetryMode", "reason", "code",
  "method", "uatAttestation", "otpConnected", "walkCount", "bookingPreserved",
  "recoveryId", "failedSessionId", "handoverStatus",
]);

const PII_VALUE = /(?:\+?91[\s().-]*)?(?:\d[\s().-]*){9}\d|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:street|road|nagar|layout|apartment|flat)\b|flat\s*#|\b(?:email|phone|mobile|contact)\b|called customer/i;
const SENSITIVE_KEY = /(?:email|phone|mobile|address|street|contact|staff|actor|internal|note)/i;

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
    sessionId: row.session_id != null ? String(row.session_id) : null,
    eventType: String(row.event_type || ""),
    actorId: "provider_or_system",
    detail: sanitizeDetail(row.detail ?? row.detail_json),
    createdAt: Number(row.created_at || 0),
  };
}

function projectSession(row: Row) {
  return {
    id: String(row.id || ""),
    occurrenceNumber: Number(row.occurrence_number || 0),
    providerId: String(row.provider_id || ""),
    scheduledStart: String(row.scheduled_start || ""),
    scheduledEnd: String(row.scheduled_end || ""),
    status: String(row.status || ""),
    handoverStatus: row.handover_status != null ? String(row.handover_status) : null,
    updatedAt: Number(row.updated_at || 0),
  };
}

function projectRecovery(row: Row | null | undefined) {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    status: String(row.status || ""),
    reasonCode: String(row.reason_code || ""),
    failedProviderId: String(row.failed_provider_id || ""),
    failedSessionId: row.failed_session_id ? String(row.failed_session_id) : null,
    replacementProviderId: row.replacement_provider_id ? String(row.replacement_provider_id) : null,
    openedAt: Number(row.opened_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

function projectPet(row: Row) {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    species: String(row.species || ""),
    breed: row.breed != null ? String(row.breed) : null,
  };
}

export function projectWalkingProviderBooking(row: Row) {
  return {
    id: String(row.id || ""),
    status: String(row.status || ""),
    serviceCode: String(row.service_code || "dog_walking"),
    packageCode: String(row.package_code || ""),
    packageName: String(row.package_name || ""),
    cityId: String(row.city_id || ""),
    zoneId: String(row.zone_id || ""),
    scheduledStart: String(row.scheduled_start || ""),
    scheduledEnd: String(row.scheduled_end || ""),
    providerId: String(row.provider_id || ""),
    customerId: String(row.customer_id || ""),
    workOrderStatus: row.work_order_status != null ? String(row.work_order_status) : null,
    paymentStatus: row.payment_status != null ? String(row.payment_status) : null,
    totalAmount: Number(row.total_amount || 0),
    currency: String(row.currency || "INR"),
    pets: Array.isArray(row.pets) ? (row.pets as Row[]).map(projectPet) : [],
    sessions: Array.isArray(row.sessions) ? (row.sessions as Row[]).map(projectSession) : [],
    events: Array.isArray(row.events) ? (row.events as Row[]).map(projectEvent) : [],
    recovery: projectRecovery(row.recovery as Row | null | undefined),
  };
}
