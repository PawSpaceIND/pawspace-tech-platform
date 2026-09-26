/** Provider-facing projection for Boarding stays (parity with sitting-provider-projection). */
type Row = Record<string, unknown>;
// The offer view computed by lib/provider-offer-state.ts (state and times only). Inlined, not imported, so this projection stays dependency-free.
const OFFER_STATES = new Set(["open", "expired", "withdrawn", "accepted", "awaiting_payment", "closed"]);
function projectOffer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Row, state = String(row.state || ""), time = (item: unknown) => item != null && Number.isFinite(Number(item)) ? Number(item) : null;
  return OFFER_STATES.has(state) ? { state, expiresAt: time(row.expiresAt), offeredAt: time(row.offeredAt) } : null;
}

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
// Emergency contact, vet and any home access stay with the customer until the host holds a paid, accepted stay.
// Acceptance requires captured payment (lib/boarding-stay-lifecycle.ts) and is the only way a stay becomes
// confirmed, then in_progress at check-in: the same rule as Pet Sitting (lib/sitting-provider-projection.ts).
const CONTACT_RELEASE_STATUSES = new Set(["confirmed", "in_progress"]);
const CONTACT_FIELDS = new Set(["emergencyContact", "vet", "homeAccess"]);
function careText(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s && s.length <= max ? s : null;
}
// Boarding extras are not priced add-ons (canonical bookings refuse add-ons outside Grooming): the customer's
// picks are saved only as this labelled line of the care plan's specialInstructions, written by
// boardingCareDraft in lib/boarding-customer-care.ts. Kept here rather than imported so this projection stays
// dependency-free; tests/boarding-host-care-plan.test.mjs round-trips the two.
const REQUESTED_EXTRAS_LABEL = "Requested extras (subject to host agreement):";
function splitRequestedExtras(specialInstructions: unknown) {
  const extras: string[] = [], rest: string[] = [];
  for (const line of typeof specialInstructions === "string" ? specialInstructions.split(/\r?\n/) : []) {
    const text = line.trim();
    if (!text.startsWith(REQUESTED_EXTRAS_LABEL)) { rest.push(line); continue; }
    for (const item of text.slice(REQUESTED_EXTRAS_LABEL.length).split(",").map(value => value.trim())) if (item && !extras.includes(item)) extras.push(item);
  }
  return { extras, rest: rest.join("\n").trim() };
}
/** The extras the customer requested at booking, as the host may see them at any status. */
export function boardingProviderExtras(specialInstructions: unknown): string[] {
  return splitRequestedExtras(specialInstructions).extras.map(item => safeString(item, 120)).filter((item): item is string => item !== null);
}
function projectCarePlan(care: Row | null | undefined, stayStatus: string) {
  if (!care) return null;
  const plan = (care.plan && typeof care.plan === "object" && !Array.isArray(care.plan) ? care.plan : {}) as Row;
  const released = CONTACT_RELEASE_STATUSES.has(stayStatus);
  const fields: Row = { ...plan, specialInstructions: splitRequestedExtras(plan.specialInstructions).rest };
  const out: Row = {}, withheld: string[] = [];
  for (const key of ["feeding", "medication", "specialInstructions", "emergencyContact", "vet", "homeAccess"] as const) {
    const s = careText(fields[key]);
    if (s === null) continue;
    // Before acceptance the host reads the routine it is deciding on, never a contact or access detail;
    // routine text that carries contact-shaped content waits for acceptance with the contact fields.
    if (released || (!CONTACT_FIELDS.has(key) && safeString(s, 1000) !== null)) out[key] = s;
    else withheld.push(key);
  }
  out.hasEmergencyContact = Boolean(String(plan.emergencyContact || "").trim());
  out.hasVet = Boolean(String(plan.vet || "").trim());
  return {
    status: String(care.status || ""),
    plan: out,
    requestedExtras: boardingProviderExtras(plan.specialInstructions),
    updatedAt: Number(care.updatedAt || care.updated_at || 0),
    ...(withheld.length ? { withheldUntilAccepted: withheld } : {}),
  };
}
function projectPet(value: unknown) {
  const row = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Row;
  return {
    name: String(row.name || "").trim().slice(0, 80) || "Pet",
    species: String(row.species || "").trim().slice(0, 40),
    breed: row.breed != null && String(row.breed).trim() ? String(row.breed).trim().slice(0, 80) : null,
  };
}

export function projectBoardingProviderStay(row: Row) {
  return {
    id: String(row.id || ""),
    bookingId: String(row.booking_id || ""),
    status: String(row.status || ""),
    bookingStatus: row.booking_status != null ? String(row.booking_status) : null,
    paymentStatus: row.payment_status != null ? String(row.payment_status) : null,
    hostProviderId: String(row.host_provider_id || ""),
    customerId: String(row.customer_id || ""),
    cityId: String(row.city_id || ""),
    zoneId: String(row.zone_id || ""),
    packageCode: String(row.package_code || ""),
    packageName: String(row.package_name || ""),
    providerName: String(row.provider_name || ""),
    checkInAt: String(row.check_in_at || ""),
    checkOutAt: String(row.check_out_at || ""),
    billedUnits: Number(row.billed_units || 0),
    petCount: Number(row.pet_count || 0),
    updatedAt: Number(row.updated_at || 0),
    carePlanStatus: row.care_plan_status != null ? String(row.care_plan_status) : null,
    checkInStatus: row.check_in_status != null ? String(row.check_in_status) : null,
    checkOutStatus: row.check_out_status != null ? String(row.check_out_status) : null,
    extensionStatus: row.extension_status != null ? String(row.extension_status) : null,
    totalAmount: Number(row.total_amount || 0),
    amountDueNow: row.amount_due_now != null ? Number(row.amount_due_now) : null,
    pets: Array.isArray(row.pets) ? (row.pets as unknown[]).map(projectPet) : [],
    carePlan: projectCarePlan(row.carePlan as Row | null | undefined, String(row.status || "")),
    events: Array.isArray(row.events) ? (row.events as Row[]).map(projectEvent) : [],
    offer: projectOffer(row.offer),
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
