/** Provider-facing projection for Pet Taxi lifecycle lists (parity with walking-provider-projection). */
type Row = Record<string, unknown>;

const SAFE_EVENT_DETAIL_KEYS = new Set([
  "action", "providerId", "status", "from", "to", "reason", "code", "method",
  "vehicleId", "tripId", "bookingPreserved", "recoveryId", "routeCode",
  "pickupVerificationStatus", "dropoffVerificationStatus",
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
    if (typeof value === "string") { const s = safeString(value); if (s !== null) out[key] = s; continue; }
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}
function projectEvent(row: Row) {
  return {
    id: String(row.id || ""),
    tripId: row.trip_id != null ? String(row.trip_id) : null,
    eventType: String(row.event_type || ""),
    actorId: "provider_or_system",
    detail: sanitizeDetail(row.detail ?? row.detail_json),
    createdAt: Number(row.created_at || 0),
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

export function projectTaxiProviderBooking(row: Row) {
  return {
    id: String(row.id || ""),
    status: String(row.status || ""),
    serviceCode: String(row.service_code || "pet_taxi"),
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
    tripId: row.trip_id != null ? String(row.trip_id) : null,
    tripStatus: row.trip_status != null ? String(row.trip_status) : null,
    vehicleId: row.vehicle_id != null ? String(row.vehicle_id) : null,
    originLabel: safeString(row.origin_label, 120),
    destinationLabel: safeString(row.destination_label, 120),
    routeCode: row.route_code != null ? String(row.route_code) : null,
    syntheticDistanceKm: row.synthetic_distance_km != null ? Number(row.synthetic_distance_km) : null,
    estimatedDurationMinutes: row.estimated_duration_minutes != null ? Number(row.estimated_duration_minutes) : null,
    pickupVerificationStatus: row.pickup_verification_status != null ? String(row.pickup_verification_status) : null,
    dropoffVerificationStatus: row.dropoff_verification_status != null ? String(row.dropoff_verification_status) : null,
    totalAmount: Number(row.total_amount || 0),
    currency: String(row.currency || "INR"),
    events: Array.isArray(row.events) ? (row.events as Row[]).map(projectEvent) : [],
    recovery: projectRecovery(row.recovery as Row | null | undefined),
  };
}
