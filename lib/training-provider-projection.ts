type Row = Record<string, unknown>;

const SAFE_EVENT_DETAIL_KEYS = new Set([
  "action", "from", "to", "status", "sessionId", "distanceMeters", "thresholdMeters",
  "consumedExactlyOnce", "evidenceRefs", "ownerHandoverMinutes", "nextSession", "programme",
  "closure", "reason", "code", "phase", "durationMinutes", "minimumMinutes", "completed",
  "caseId", "consumption", "newStart", "newEnd", "scheduledStart", "scheduledEnd", "geofence",
  "reportSaved",
]);
const PII_VALUE = /(?:\+?91[\s().-]*)?(?:\d[\s().-]*){9}\d|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:street|road|nagar|layout|apartment|flat)\b|flat\s*#|\b(?:email|phone|mobile|contact)\b|called customer/i;
const SENSITIVE_KEY = /(?:email|phone|mobile|address|street|contact|staff|actor|internal|note)/i;

function safeString(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > max || PII_VALUE.test(s)) return null;
  return s;
}
function parseJsonObject(raw: unknown): Record<string, unknown> {
  const text = String(raw ?? "").trim();
  if (!text || text[0] !== "{") return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
  } catch {
    return {};
  }
}
function sanitizeOperationalObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Row = {};
  for (const [key, raw] of Object.entries(value as Row)) {
    if (SENSITIVE_KEY.test(key) || PII_VALUE.test(key)) continue;
    if (typeof raw === "string") { const s = safeString(raw); if (s !== null) out[key] = s; continue; }
    if (typeof raw === "number" && Number.isFinite(raw)) { if (!PII_VALUE.test(String(raw))) out[key] = raw; continue; }
    if (typeof raw === "boolean" || raw === null) { out[key] = raw; continue; }
    if (Array.isArray(raw)) { out[key] = raw.map(item => safeString(item)).filter((item): item is string => item !== null); }
  }
  return out;
}
function sanitizeAttendance(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Row, out: Row = {};
  const mode = safeString(row.mode, 32);
  if (mode && ["parent", "trainer_led"].includes(mode)) out.mode = mode;
  if (typeof row.safeAreaConfirmed === "boolean") out.safeAreaConfirmed = row.safeAreaConfirmed;
  if (typeof row.parentOrCaretakerConfirmed === "boolean") out.parentOrCaretakerConfirmed = row.parentOrCaretakerConfirmed;
  return out;
}
function sanitizeHomework(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const text = safeString((value as Row).text, 1000);
  return text ? {text} : {};
}
function sanitizeProgress(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Row)) {
    if (SENSITIVE_KEY.test(key) || PII_VALUE.test(key) || !/^[A-Za-z0-9 _-]{1,60}$/.test(key)) continue;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 10) out[key] = raw;
  }
  return out;
}
function safeEvidenceRefs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => safeString(item, 180)).filter((item): item is string => item !== null && /^media:\/\/asset\/[A-Za-z0-9_-]+$/.test(item))
    : [];
}

export function sanitizeTrainingEventDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  const out: Row = {};
  for (const [key, value] of Object.entries(detail as Row)) {
    if (!SAFE_EVENT_DETAIL_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    if (key === "evidenceRefs") { out[key] = safeEvidenceRefs(value); continue; }
    if (Array.isArray(value)) { out[key] = value.map(item => safeString(item)).filter((item): item is string => item !== null); continue; }
    if (typeof value === "object" && value !== null) { out[key] = sanitizeOperationalObject(value); continue; }
    if (typeof value === "string") { const s = safeString(value); if (s !== null) out[key] = s; continue; }
    if (typeof value === "number" && Number.isFinite(value)) { out[key] = value; continue; }
    if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

export function projectTrainingSessionEvent(row: Row) {
  return {
    eventType: String(row.event_type || ""),
    actorId: "provider_or_system",
    detail: sanitizeTrainingEventDetail(typeof row.detail_json === "string" ? parseJsonObject(row.detail_json) : row.detail_json),
    createdAt: Number(row.created_at || 0),
  };
}

export function projectTrainerSession(row: Row) {
  const events = Array.isArray(row.events) ? (row.events as Row[]).map(projectTrainingSessionEvent) : [];
  return {
    id: String(row.id || ""),
    programme_id: String(row.programme_id || ""),
    booking_id: String(row.booking_id || ""),
    sequence_no: Number(row.sequence_no || 0),
    provider_id: String(row.provider_id || ""),
    scheduled_start: String(row.scheduled_start || ""),
    scheduled_end: String(row.scheduled_end || ""),
    status: String(row.status || ""),
    customer_id: String(row.customer_id || ""),
    customer_name: String(row.customer_name || "Customer"),
    plan_code: String(row.plan_code || ""),
    plan_name: String(row.plan_name || ""),
    total_sessions: Number(row.total_sessions || 0),
    completed_sessions: Number(row.completed_sessions || 0),
    no_show_sessions: Number(row.no_show_sessions || 0),
    cancelled_sessions: Number(row.cancelled_sessions || 0),
    programme_status: String(row.programme_status || ""),
    petIds: Array.isArray(row.petIds) ? row.petIds.filter(x => typeof x === "string").map(String) : [],
    requirements: Array.isArray(row.requirements) ? row.requirements.map(item => safeString(item)).filter((item): item is string => item !== null) : [],
    attendance: sanitizeAttendance(row.attendance),
    homework: sanitizeHomework(row.homework),
    progress: sanitizeProgress(row.progress),
    evidenceRefs: safeEvidenceRefs(row.evidenceRefs),
    events,
  };
}
