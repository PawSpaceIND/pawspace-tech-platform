/**
 * Provider-facing field projection for Dog Training sessions.
 *
 * Same class of gap as Grooming pilot audit P0-6: listTrainerSessions returned
 * SELECT * row blobs plus raw training_session_events.detail_json and actor_id.
 * Staff notes, emails, free-text reasons and unbounded event detail could reach
 * service_provider sessions even when customer_name was already maskName'd.
 *
 * Rule: trainers get operational session state only. Contact data, internal
 * notes, staff actor ids and unbounded free text are dropped.
 */

type Row = Record<string, unknown>;

const SAFE_EVENT_DETAIL_KEYS = new Set([
  "action",
  "from",
  "to",
  "status",
  "sessionId",
  "distanceMeters",
  "thresholdMeters",
  "consumedExactlyOnce",
  "evidenceRefs",
  "ownerHandoverMinutes",
  "nextSession",
  "programme",
  "closure",
  "reason",
  "code",
]);

const PII_VALUE = /(?:\+?91[\s-]?)?\d{10}|@|street|road|nagar|layout|apartment|flat\s*#|email|phone|called customer/i;

function looksLikePii(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.length > 240) return true;
  return PII_VALUE.test(s);
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  const text = String(raw ?? "").trim();
  if (!text || text[0] !== "{") return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function sanitizeTrainingEventDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail as Row)) {
    if (!SAFE_EVENT_DETAIL_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.filter((item) => typeof item === "string" && !looksLikePii(item)).map(String);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      // Nested objects (nextSession, programme, closure) are operational; keep shallow safe scalars only.
      if (key === "nextSession" || key === "programme" || key === "closure") {
        const nested: Record<string, unknown> = {};
        for (const [nk, nv] of Object.entries(value as Row)) {
          if (typeof nv === "object" && nv !== null) continue;
          if (looksLikePii(nv)) continue;
          nested[nk] = nv;
        }
        out[key] = nested;
      }
      continue;
    }
    if (looksLikePii(value)) continue;
    out[key] = value;
  }
  return out;
}

export function projectTrainingSessionEvent(row: Row) {
  return {
    eventType: String(row.event_type || ""),
    // Never return staff email / actor id raw to trainers
    actorId: "provider_or_system",
    detail: sanitizeTrainingEventDetail(
      typeof row.detail_json === "string" ? parseJsonObject(row.detail_json) : row.detail_json,
    ),
    createdAt: Number(row.created_at || 0),
  };
}

/**
 * Project a single trainer session row for the provider-facing API.
 * customer_name is expected to already be maskName'd by the route; we still
 * refuse to pass through any other contact-shaped fields from the raw join.
 */
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
    // Opaque operational id only; display name must already be masked by caller
    customer_name: String(row.customer_name || "Customer"),
    plan_code: String(row.plan_code || ""),
    plan_name: String(row.plan_name || ""),
    total_sessions: Number(row.total_sessions || 0),
    completed_sessions: Number(row.completed_sessions || 0),
    no_show_sessions: Number(row.no_show_sessions || 0),
    cancelled_sessions: Number(row.cancelled_sessions || 0),
    programme_status: String(row.programme_status || ""),
    petIds: Array.isArray(row.petIds) ? row.petIds.filter((x) => typeof x === "string").map(String) : [],
    requirements: Array.isArray(row.requirements)
      ? (row.requirements as unknown[]).filter((x) => typeof x === "string" && !looksLikePii(x)).map(String)
      : [],
    attendance: row.attendance && typeof row.attendance === "object" && !Array.isArray(row.attendance) ? row.attendance : {},
    homework: row.homework && typeof row.homework === "object" && !Array.isArray(row.homework) ? row.homework : {},
    progress: row.progress && typeof row.progress === "object" && !Array.isArray(row.progress) ? row.progress : {},
    evidenceRefs: Array.isArray(row.evidenceRefs)
      ? (row.evidenceRefs as unknown[]).filter((x) => typeof x === "string").map(String)
      : [],
    events,
  };
}
