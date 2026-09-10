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

// Explicit schemas are the privacy boundary. A value-shaped PII check alone cannot
// decide whether an arbitrary nested key (for example internalNote) is operational.
type ScalarKind = "text" | "number" | "boolean";
const EVENT_FIELDS: Record<string, ScalarKind> = {
  action: "text", from: "text", to: "text", status: "text", sessionId: "text",
  distanceMeters: "number", thresholdMeters: "number", consumedExactlyOnce: "boolean",
  ownerHandoverMinutes: "number", code: "text",
  phase: "text", durationMinutes: "number", minimumMinutes: "number", completed: "boolean",
  caseId: "text", consumption: "text", newStart: "text", newEnd: "text",
  scheduledStart: "text", scheduledEnd: "text", reportSaved: "boolean",
};
const NEXT_SESSION_FIELDS: Record<string, ScalarKind> = {
  sessionId: "text", sequenceNo: "number", status: "text",
};
const PROGRAMME_FIELDS: Record<string, ScalarKind> = {
  total: "number", completed: "number", noShow: "number", cancelled: "number",
  status: "text", terminal: "boolean",
};
const CLOSURE_FIELDS: Record<string, ScalarKind> = {
  certificateNumber: "text", reviewDispatched: "boolean",
};
const PROGRESS_FIELDS: Record<string, ScalarKind> = {
  focus: "number", recall: "number", impulse: "number", parent: "number", sit: "number",
};
const PII_VALUE = /@|(?:\+?91[\s().-]*)?(?:\d[\s().-]*){9}\d|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:street|road|nagar|layout|apartment|flat)\b|flat\s*#|\b(?:email|phone|mobile|contact)\b|called customer/i;

function looksLikePii(value: unknown): boolean {
  return typeof value === "string" && (value.trim().length > 240 || PII_VALUE.test(value));
}

function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function projectScalars(value: unknown, fields: Record<string, ScalarKind>): Row {
  const row = object(value);
  const out: Row = {};
  for (const [key, kind] of Object.entries(fields)) {
    if (!Object.hasOwn(row, key)) continue;
    const item = row[key];
    if (kind === "text" && typeof item === "string" && !looksLikePii(item)) out[key] = item;
    if (kind === "number" && typeof item === "number" && Number.isFinite(item)) out[key] = item;
    if (kind === "boolean" && typeof item === "boolean") out[key] = item;
  }
  return out;
}

function projectAttendance(value: unknown): Row {
  const row = object(value);
  const out = projectScalars(row, { parentOrCaretakerConfirmed: "boolean", safeAreaConfirmed: "boolean" });
  if (row.mode === "parent" || row.mode === "trainer_led") out.mode = row.mode;
  return out;
}

function projectHomework(value: unknown): Row {
  const row = object(value);
  // Homework is intentional trainer-facing content, not arbitrary metadata. Do not
  // erase a legitimate assignment just because event summaries are shorter; retain the current 1000-character bound.
  return typeof row.text === "string" && row.text.trim().length > 0 && row.text.length <= 1000 && !PII_VALUE.test(row.text) ? { text: row.text } : {};
}

function projectProgress(value: unknown): Row {
  return Object.fromEntries(Object.entries(projectScalars(value, PROGRESS_FIELDS))
    .filter(([, score]) => Number(score) >= 1 && Number(score) <= 10));
}

function evidenceRefs(value: unknown): string[] {
  // The Training lifecycle/media API uses opaque canonical media refs. Never return
  // signed URLs, arbitrary strings, or contact data smuggled into a refs array.
  return Array.isArray(value) ? value.filter((item): item is string =>
    typeof item === "string" && !PII_VALUE.test(item) && /^media:\/\/asset\/[A-Za-z0-9_-]{1,128}$/.test(item)) : [];
}

function parseJsonObject(raw: unknown): Row {
  if (typeof raw !== "string") return object(raw);
  try { return object(JSON.parse(raw)); } catch { return {}; }
}

export function sanitizeTrainingEventDetail(detail: unknown): Row {
  const row = object(detail);
  // Free-text staff reasons, actor IDs and reports are intentionally not event fields.
  const out = projectScalars(row, EVENT_FIELDS);
  for (const [key, fields] of Object.entries({
    nextSession: NEXT_SESSION_FIELDS, programme: PROGRAMME_FIELDS, closure: CLOSURE_FIELDS,
    geofence: { distanceMeters: "number", thresholdMeters: "number", verified: "boolean" } as const,
  })) {
    if (!Object.hasOwn(row, key)) continue;
    if (row[key] === null) out[key] = null;
    else out[key] = projectScalars(row[key], fields);
  }
  if (Object.hasOwn(row, "evidenceRefs")) out.evidenceRefs = evidenceRefs(row.evidenceRefs);
  return out;
}

export function projectTrainingSessionEvent(value: unknown) {
  const row = object(value);
  return {
    eventType: typeof row.event_type === "string" && !looksLikePii(row.event_type) ? row.event_type : "",
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
export function projectTrainerSession(value: unknown) {
  const row = object(value);
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
    attendance: projectAttendance(row.attendance),
    homework: projectHomework(row.homework),
    progress: projectProgress(row.progress),
    evidenceRefs: evidenceRefs(row.evidenceRefs),
    events,
  };
}
