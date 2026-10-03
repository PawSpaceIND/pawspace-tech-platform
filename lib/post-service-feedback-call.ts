/**
 * Post-service honest review invitation + consented feedback call.
 *
 * Two small, additive contracts on top of owners that already exist:
 *
 *   1. `postServiceReviewInvitation` projects the public review links a customer may OPTIONALLY use
 *      after a service that actually completed for them. Links come only from the maker/checker
 *      approved review configuration (lib/review-configuration-governance.ts). No approved link means
 *      no destination: nothing here falls back to a constant URL. The projection never reads the
 *      customer's rating, never carries a reward, and never records that a review was posted.
 *      The private feedback-completion reward stays entirely inside lib/service-review-governance.ts.
 *
 *   2. `scheduleFeedbackCall` / `dispatchPostServiceFeedbackTestCalls` let a customer ask for ONE automated
 *      feedback call at a time they choose, and later hand that request to an INJECTED, test-only call
 *      placer. This module never imports or invokes a telephony entry point: the sweep refuses to run
 *      unless a caller supplies a provider that declares itself test-only, and a scheduler owner is
 *      the one who decides, separately, whether anything is ever wired to it. The pieces added here are
 *      the ones no existing gate knows about - completed-booking lineage, the customer's chosen time,
 *      their timezone, and an explicit consent record. Attempt ceilings reuse the voice owner's
 *      `feedback_request` catalogue entry; quiet hours reuse the city communication policy.
 *
 *   Every unknown refuses: no timezone on record, no quiet-hours policy for the city, no phone, no
 *   explicit consent, no configured scheduling horizon or dispatch window. None of those has a default.
 */
import { getActiveReviewConfig } from "./review-configuration-governance";
import { voiceUseCase } from "./voice-outbound-governance";
import { normalisedDialKey } from "./voice-call-gate";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

export const FEEDBACK_CALL_USE_CASE = "feedback_request";
export const FEEDBACK_CALL_ACTOR = "system:post-service-feedback";
export type ReviewPlatform = "google" | "app";

export class PostServiceFeedbackError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PostServiceFeedbackError";
    this.code = code;
    this.status = status;
  }
}

// --- scheduling policy: explicit, validated, no defaults ------------------------------------------------

export type FeedbackCallPolicy = {
  /** How far ahead a customer may ask for the call, in milliseconds. */
  maxHorizonMs: number;
  /** How long after the chosen time the sweep may still place the call, in milliseconds. */
  dispatchWindowMs: number;
  /** Where the values came from, for the audit row. */
  source: string;
};

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/**
 * Validate a candidate policy. Both values must be explicit positive integers inside sane physical
 * bounds (a horizon of at least one hour and at most a year; a window of at least one minute and at
 * most a day). Anything else is "unknown", and unknown refuses - there is deliberately no fallback.
 */
export function validateFeedbackCallPolicy(candidate: { maxHorizonMs?: unknown; dispatchWindowMs?: unknown; source?: unknown } | null | undefined): FeedbackCallPolicy | null {
  if (!candidate || typeof candidate !== "object") return null;
  const horizon = Number(candidate.maxHorizonMs), window = Number(candidate.dispatchWindowMs);
  if (!Number.isInteger(horizon) || horizon < HOUR || horizon > 366 * DAY) return null;
  if (!Number.isInteger(window) || window < MINUTE || window > DAY) return null;
  const source = text(candidate.source);
  if (!source) return null;
  return { maxHorizonMs: horizon, dispatchWindowMs: window, source };
}

export const FEEDBACK_CALL_POLICY_ENV = {
  horizonHours: "PAWSPACE_POST_SERVICE_FEEDBACK_CALL_HORIZON_HOURS",
  dispatchWindowMinutes: "PAWSPACE_POST_SERVICE_FEEDBACK_CALL_DISPATCH_WINDOW_MINUTES",
} as const;

/** Read the policy from configuration. Unset or invalid values yield null, never a default. */
export function feedbackCallPolicyFromEnv(env: Env): FeedbackCallPolicy | null {
  const hours = text(env[FEEDBACK_CALL_POLICY_ENV.horizonHours]), minutes = text(env[FEEDBACK_CALL_POLICY_ENV.dispatchWindowMinutes]);
  if (!/^\d+$/.test(hours) || !/^\d+$/.test(minutes)) return null;
  return validateFeedbackCallPolicy({ maxHorizonMs: Number(hours) * HOUR, dispatchWindowMs: Number(minutes) * MINUTE, source: "environment_configuration" });
}

// --- injected call placement: test-only, no default -------------------------------------------------------

export type FeedbackCallPlacementRequest = {
  idempotencyKey: string; useCase: typeof FEEDBACK_CALL_USE_CASE; phone: string; cityId: string; customerId: string; bookingId: string;
  scheduleId: string; attempt: number; actorId: string; asOf: number;
};
export type FeedbackCallPlacementResult = {
  callId: string | null;
  /** `dialled` means a recipient was reached by a test transport; `simulated` means nothing was dialled. */
  outcome: "dialled" | "simulated" | "blocked" | "failed";
  state: string;
  blockedBy?: string | null;
  detail?: string | null;
  productionCall?: boolean;
};
/**
 * The only way a call leaves this module. The literal `testOnly: true` is required on the object, so a
 * production telephony client cannot be passed in by accident: whoever wires one must write that word
 * next to it, and the sweep still refuses any result that reports a production call.
 */
export type FeedbackCallPlacer = { testOnly: true; label: string; placeCall(request: FeedbackCallPlacementRequest): Promise<FeedbackCallPlacementResult> };

export const FEEDBACK_CALL_TEST_DISPATCH_ENV = "PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH";
/** The deployment markers this repository uses for environments that are explicitly not production. */
export const NON_PRODUCTION_DEPLOYMENT_MARKERS = ["staging", "test", "development", "local", "checkout-sandbox"] as const;
export const NON_PRODUCTION_APP_ENVS = ["staging", "test", "development"] as const;
const lower = (value: unknown) => text(value).toLowerCase();
/**
 * May the customer route run the synthetic no-dial sweep? Default off. Every clause must hold: the
 * environment must POSITIVELY declare itself non-production through known markers (a missing marker
 * is unknown, and unknown refuses), production must be forbidden, voice must not be live, and the
 * dedicated switch must be on. Values are compared case-insensitively so "Production" cannot slip past
 * a case-sensitive inequality. No single flag enables this.
 */
export function syntheticDispatchPermitted(env: Env) {
  return lower(env.FORBID_PRODUCTION) === "true"
    && (NON_PRODUCTION_APP_ENVS as readonly string[]).includes(lower(env.APP_ENV))
    && (NON_PRODUCTION_DEPLOYMENT_MARKERS as readonly string[]).includes(lower(env.PAWSPACE_DEPLOYMENT_ENV))
    && lower(env.NODE_ENV) !== "production"
    && lower(env.PAWSPACE_VOICE_ENV) !== "live"
    && lower(env[FEEDBACK_CALL_TEST_DISPATCH_ENV]) === "on";
}

/** A placer that reaches nobody: it records a synthetic outcome and dials nothing. */
export function syntheticFeedbackCallPlacer(label = "synthetic_no_dial"): FeedbackCallPlacer {
  return {
    testOnly: true,
    label,
    async placeCall(request) {
      return { callId: `SYN-${request.scheduleId}-${request.attempt}`, outcome: "simulated", state: "simulated_no_dial", productionCall: false, detail: `No call placed (${label})` };
    },
  };
}

export async function ensurePostServiceFeedbackTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS post_service_feedback_calls (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,provider_id TEXT,service_code TEXT NOT NULL,city_id TEXT NOT NULL,phone_key TEXT NOT NULL,timezone TEXT NOT NULL,scheduled_for INTEGER NOT NULL,dispatch_window_ms INTEGER NOT NULL,policy_source TEXT NOT NULL,consent_source TEXT NOT NULL,consent_confirmed_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',attempt_count INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,voice_call_id TEXT,outcome TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    // One live request per booking, whatever its idempotency key. SQLite evaluates the partial index
    // on insert, so two concurrent schedules for the same booking cannot both land.
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_post_service_feedback_calls_active ON post_service_feedback_calls(booking_id) WHERE status IN ('scheduled','dispatching')"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_post_service_feedback_calls_due ON post_service_feedback_calls(status,scheduled_for)"),
    db.prepare("CREATE TABLE IF NOT EXISTS post_service_feedback_call_events (id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,event_type TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',actor TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
}

async function recordEvent(db: Db, scheduleId: string, eventType: string, actor: string, detail: Row, at: number) {
  await db.prepare("INSERT INTO post_service_feedback_call_events (id,schedule_id,event_type,detail_json,actor,created_at) VALUES (?,?,?,?,?,?)")
    .bind(uid("PSFCE"), scheduleId, eventType, JSON.stringify(detail), actor, at).run();
}

// --- lineage ----------------------------------------------------------------------------------------

export type CompletedOwnedBooking = { bookingId: string; customerId: string; providerId: string | null; serviceCode: string; cityId: string; status: string };

/**
 * The booking must exist, belong to this customer, and have actually completed. Ownership failures
 * are refused as authorization (403) before completion is even considered, so a customer cannot learn
 * another customer's booking state from the error.
 */
export async function completedOwnedBooking(db: Db, bookingId: string, customerId: string): Promise<CompletedOwnedBooking> {
  const id = text(bookingId), owner = text(customerId);
  if (!id || !owner) throw new PostServiceFeedbackError("booking_required", "A booking and a signed-in customer are required", 400);
  const row = await db.prepare("SELECT id,customer_id,provider_id,service_code,city_id,status FROM canonical_bookings WHERE id=?").bind(id).first<Row>().catch(() => null);
  if (!row || text(row.customer_id) !== owner) throw new PostServiceFeedbackError("booking_not_owned", "This booking does not belong to the signed-in customer", 403);
  if (text(row.status) !== "completed") throw new PostServiceFeedbackError("booking_not_completed", "Only a completed service can be reviewed or followed up", 409);
  return { bookingId: id, customerId: owner, providerId: text(row.provider_id) || null, serviceCode: text(row.service_code), cityId: text(row.city_id), status: "completed" };
}

// --- honest public review invitation ------------------------------------------------------------------

export type ReviewDestination = { platform: ReviewPlatform; label: string; url: string; configId: string; configVersion: number };
export type ReviewInvitation = {
  bookingId: string;
  serviceCode: string;
  /** Empty when no approved configuration carries a usable https link. Never a fallback. */
  destinations: ReviewDestination[];
  source: "approved_review_config" | "no_approved_config";
  /** Stated as data so a UI cannot drift from the rule. */
  terms: { optional: true; rewarded: false; ratingGated: false; postingVerified: false; honestOnly: true };
};

function approvedHttpsUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try { const url = new URL(candidate); return url.protocol === "https:" ? url.toString() : null; } catch { return null; }
}

/**
 * Which public review pages this customer may optionally visit for a completed service. Only links a
 * second staff member approved in the review configuration qualify; a blank or non-https link is
 * simply absent. The rating is deliberately never consulted: an invitation that depends on the score
 * is a filtered-review scheme, whatever the copy says.
 */
export async function postServiceReviewInvitation(db: Db, input: { bookingId: string; customerId: string }): Promise<ReviewInvitation> {
  const booking = await completedOwnedBooking(db, input.bookingId, input.customerId);
  const config = booking.serviceCode ? await getActiveReviewConfig(db, booking.serviceCode).catch(() => null) : null;
  const terms = { optional: true, rewarded: false, ratingGated: false, postingVerified: false, honestOnly: true } as const;
  if (!config) return { bookingId: booking.bookingId, serviceCode: booking.serviceCode, destinations: [], source: "no_approved_config", terms };
  const candidates: Array<{ platform: ReviewPlatform; label: string; url: string | null }> = [
    { platform: "google", label: "Google", url: approvedHttpsUrl(config.googleReviewLink) },
    { platform: "app", label: "the app store", url: approvedHttpsUrl(config.appReviewLink) },
  ];
  const preferred = text(config.publicReviewDestination);
  const destinations = candidates
    .filter((candidate): candidate is { platform: ReviewPlatform; label: string; url: string } => Boolean(candidate.url))
    .sort((a, b) => Number(b.platform === preferred) - Number(a.platform === preferred))
    .map(candidate => ({ platform: candidate.platform, label: candidate.label, url: candidate.url, configId: config.id, configVersion: config.version }));
  return { bookingId: booking.bookingId, serviceCode: booking.serviceCode, destinations, source: destinations.length ? "approved_review_config" : "no_approved_config", terms };
}

// --- consented feedback call: eligibility ---------------------------------------------------------------

function validTimezone(value: unknown): string | null {
  const zone = text(value);
  if (!zone) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone; } catch { return null; }
}

/** Hour of day (0-23) at `at` in the given IANA zone. */
export function localHourIn(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(at));
  const hour = Number(parts.find(part => part.type === "hour")?.value);
  return Number.isFinite(hour) ? hour % 24 : NaN;
}

export function hourInQuietWindow(hour: number, start: number, end: number) {
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

async function cityQuietHoursPolicy(db: Db, cityId: string, at: number) {
  if (!cityId) return null;
  const date = new Date(at).toISOString().slice(0, 10);
  const row = await db.prepare("SELECT quiet_start_hour,quiet_end_hour,version FROM communication_policies WHERE city_id=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY version DESC LIMIT 1")
    .bind(cityId, date, date).first<Row>().catch(() => null);
  if (!row) return null;
  const start = Number(row.quiet_start_hour), end = Number(row.quiet_end_hour);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) return null;
  return { start, end, version: Number(row.version || 0) };
}

export type FeedbackCallSchedule = {
  id: string; bookingId: string; status: string; scheduledFor: number; timezone: string; attemptCount: number; maxAttempts: number; voiceCallId: string | null; outcome: string | null;
};

export type FeedbackCallEligibility = {
  bookingId: string;
  eligible: boolean;
  reasons: string[];
  timezone: string | null;
  quietHours: { start: number; end: number } | null;
  policy: { maxHorizonMs: number; dispatchWindowMs: number; source: string } | null;
  maxAttempts: number;
  attemptsUsed: number;
  existing: FeedbackCallSchedule | null;
};

const summarise = (row: Row): FeedbackCallSchedule => ({
  id: text(row.id), bookingId: text(row.booking_id), status: text(row.status), scheduledFor: Number(row.scheduled_for), timezone: text(row.timezone),
  attemptCount: Number(row.attempt_count || 0), maxAttempts: Number(row.max_attempts || 0), voiceCallId: text(row.voice_call_id) || null, outcome: text(row.outcome) || null,
});

const CONSENT_REASONS = ["voice_consent_not_explicit", "global_opt_out", "voice_consent_missing", "voice_opt_out", "service_updates_declined"];

type Prerequisites = {
  booking: CompletedOwnedBooking; reasons: string[]; phone: string | null; phoneKey: string; timezone: string | null;
  quietHours: { start: number; end: number } | null; policy: FeedbackCallPolicy | null; maxAttempts: number; attemptsUsed: number;
};

/**
 * Everything that must already be TRUE on record before a feedback call can be asked for or placed.
 * Each absence is a named reason, and absence refuses: a missing consent row is not consent, a
 * missing timezone is not Asia/Kolkata, a missing city policy is not "no quiet hours", and a missing
 * scheduling policy is not "any time".
 */
async function prerequisites(db: Db, booking: CompletedOwnedBooking, policy: FeedbackCallPolicy | null, at: number): Promise<Prerequisites> {
  const reasons: string[] = [];
  const useCase = voiceUseCase(FEEDBACK_CALL_USE_CASE);
  const maxAttempts = useCase ? useCase.maxAttempts : 0;
  if (!useCase || !(maxAttempts > 0)) reasons.push("voice_use_case_unavailable");

  const validPolicy = validateFeedbackCallPolicy(policy);
  if (!validPolicy) reasons.push("call_policy_unknown");

  const customer = await db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(booking.customerId).first<Row>().catch(() => null);
  const phone = text(customer?.primary_phone) || null;
  const phoneKey = phone ? normalisedDialKey(phone) : "";
  if (!phoneKey) reasons.push("phone_unknown");

  // Explicit central consent: the row must exist and say yes. communication-governance treats an
  // absent row as "allowed" for ordinary messaging; an automated call to a customer is held to the
  // stricter reading the task requires.
  const central = await db.prepare("SELECT global_opt_out,voice_allowed FROM communication_consent WHERE customer_id=?").bind(booking.customerId).first<Row>().catch(() => null);
  if (!central) reasons.push("voice_consent_not_explicit");
  else if (Number(central.global_opt_out || 0) === 1) reasons.push("global_opt_out");
  else if (central.voice_allowed == null || Number(central.voice_allowed) !== 1) reasons.push("voice_consent_not_explicit");

  // Phone-level voice consent and opt-out are the voice owner's records; read, never written, here.
  const voiceConsent = phoneKey ? await db.prepare("SELECT granted,revoked_at FROM voice_call_consents WHERE phone_key=?").bind(phoneKey).first<Row>().catch(() => null) : null;
  if (phoneKey && !(voiceConsent && Number(voiceConsent.granted) === 1 && voiceConsent.revoked_at == null)) reasons.push("voice_consent_missing");
  const optOut = phoneKey ? await db.prepare("SELECT recorded_at FROM voice_call_opt_outs WHERE phone_key=?").bind(phoneKey).first<Row>().catch(() => null) : null;
  if (optOut) reasons.push("voice_opt_out");

  const preference = await db.prepare("SELECT timezone,service_updates FROM communication_preferences WHERE customer_id=?").bind(booking.customerId).first<Row>().catch(() => null);
  const timezone = preference ? validTimezone(preference.timezone) : null;
  if (!timezone) reasons.push("timezone_unknown");
  if (preference && preference.service_updates != null && Number(preference.service_updates) === 0) reasons.push("service_updates_declined");

  const quietHours = await cityQuietHoursPolicy(db, booking.cityId, at);
  if (!quietHours) reasons.push("quiet_hours_policy_unknown");

  const attempts = await db.prepare("SELECT COUNT(*) n FROM post_service_feedback_calls WHERE booking_id=? AND attempt_count>0").bind(booking.bookingId).first<Row>();
  const attemptsUsed = Number(attempts?.n || 0);
  if (maxAttempts > 0 && attemptsUsed >= maxAttempts) reasons.push("attempts_exhausted");

  return { booking, reasons, phone, phoneKey, timezone, quietHours: quietHours ? { start: quietHours.start, end: quietHours.end } : null, policy: validPolicy, maxAttempts, attemptsUsed };
}

async function activeSchedule(db: Db, bookingId: string) {
  const row = await db.prepare("SELECT * FROM post_service_feedback_calls WHERE booking_id=? AND status IN ('scheduled','dispatching') ORDER BY created_at DESC LIMIT 1").bind(bookingId).first<Row>();
  return row ? summarise(row) : null;
}

/** What the customer may do right now, with every blocker named. Ownership failures still throw. */
export async function feedbackCallEligibility(db: Db, input: { bookingId: string; customerId: string; policy: FeedbackCallPolicy | null; asOf?: number }): Promise<FeedbackCallEligibility> {
  await ensurePostServiceFeedbackTables(db);
  const at = input.asOf ?? Date.now();
  const booking = await completedOwnedBooking(db, input.bookingId, input.customerId);
  const pre = await prerequisites(db, booking, input.policy, at);
  const existing = await activeSchedule(db, booking.bookingId);
  return {
    bookingId: booking.bookingId, eligible: pre.reasons.length === 0, reasons: pre.reasons, timezone: pre.timezone, quietHours: pre.quietHours,
    policy: pre.policy ? { maxHorizonMs: pre.policy.maxHorizonMs, dispatchWindowMs: pre.policy.dispatchWindowMs, source: pre.policy.source } : null,
    maxAttempts: pre.maxAttempts, attemptsUsed: pre.attemptsUsed, existing,
  };
}

// --- consented feedback call: schedule / cancel -------------------------------------------------------

export type ScheduleFeedbackCallInput = {
  bookingId: string; customerId: string; preferredAt: number; consentConfirmed: boolean; consentSource?: string; actorId: string;
  /** Explicit scheduling policy. null is "unknown" and refuses. */
  policy: FeedbackCallPolicy | null; asOf?: number;
};

/**
 * The customer asks for one feedback call at a time of their choosing. Idempotent on
 * (booking, chosen time); a second live request for the same booking at another time is refused until
 * the first is cancelled, so "reschedule" is an explicit cancel followed by a new request.
 */
export async function scheduleFeedbackCall(db: Db, input: ScheduleFeedbackCallInput) {
  await ensurePostServiceFeedbackTables(db);
  const now = input.asOf ?? Date.now();
  const booking = await completedOwnedBooking(db, input.bookingId, input.customerId);
  if (input.consentConfirmed !== true) throw new PostServiceFeedbackError("consent_not_confirmed", "Please confirm that you are asking PawSpace to call you for feedback", 400);
  const pre = await prerequisites(db, booking, input.policy, now);
  if (pre.reasons.length) throw new PostServiceFeedbackError(pre.reasons[0], `A feedback call cannot be scheduled: ${pre.reasons.join(", ")}`, pre.reasons[0] === "attempts_exhausted" ? 409 : 412);
  const policy = pre.policy!, timezone = pre.timezone!, quietHours = pre.quietHours!;

  const preferredAt = Number(input.preferredAt);
  if (!Number.isFinite(preferredAt)) throw new PostServiceFeedbackError("time_required", "Choose a time for the call", 400);
  const scheduledFor = Math.floor(preferredAt / MINUTE) * MINUTE;
  if (scheduledFor <= now) throw new PostServiceFeedbackError("time_in_past", "The call time must be in the future", 400);
  if (scheduledFor > now + policy.maxHorizonMs) throw new PostServiceFeedbackError("time_too_far", `Choose a time within the next ${Math.floor(policy.maxHorizonMs / HOUR)} hours`, 400);
  const localHour = localHourIn(scheduledFor, timezone);
  if (!Number.isFinite(localHour)) throw new PostServiceFeedbackError("timezone_unknown", "Your timezone could not be applied to the chosen time", 412);
  if (hourInQuietWindow(localHour, quietHours.start, quietHours.end)) throw new PostServiceFeedbackError("quiet_hours", `PawSpace does not call between ${quietHours.start}:00 and ${quietHours.end}:00 in your timezone (${timezone})`, 422);

  const idempotencyKey = `post-service-feedback-call:${booking.bookingId}:${scheduledFor}`;
  const prior = await db.prepare("SELECT * FROM post_service_feedback_calls WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { scheduled: text(prior.status) === "scheduled", duplicatePrevented: true, schedule: summarise(prior) };
  const live = await activeSchedule(db, booking.bookingId);
  if (live) throw new PostServiceFeedbackError("already_scheduled", "A feedback call is already scheduled for this booking. Cancel it to choose another time.", 409);

  const id = uid("PSFC");
  const consentSource = text(input.consentSource) || "customer_app_feedback_call_request";
  try {
    await db.prepare("INSERT INTO post_service_feedback_calls (id,idempotency_key,booking_id,customer_id,provider_id,service_code,city_id,phone_key,timezone,scheduled_for,dispatch_window_ms,policy_source,consent_source,consent_confirmed_at,status,attempt_count,max_attempts,voice_call_id,outcome,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',0,?,NULL,NULL,?,?,?)")
      .bind(id, idempotencyKey, booking.bookingId, booking.customerId, booking.providerId, booking.serviceCode, booking.cityId, pre.phoneKey, timezone, scheduledFor, policy.dispatchWindowMs, policy.source, consentSource, now, pre.maxAttempts, text(input.actorId) || booking.customerId, now, now).run();
  } catch (error) {
    // Lost a race on either unique constraint: report the row that won instead of a 500.
    const raced = await db.prepare("SELECT * FROM post_service_feedback_calls WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
    if (raced) return { scheduled: text(raced.status) === "scheduled", duplicatePrevented: true, schedule: summarise(raced) };
    const other = await activeSchedule(db, booking.bookingId);
    if (other) throw new PostServiceFeedbackError("already_scheduled", "A feedback call is already scheduled for this booking. Cancel it to choose another time.", 409);
    throw error;
  }
  await recordEvent(db, id, "scheduled", text(input.actorId) || booking.customerId, { scheduledFor, timezone, localHour, consentSource, policySource: policy.source, dispatchWindowMs: policy.dispatchWindowMs }, now);
  const row = await db.prepare("SELECT * FROM post_service_feedback_calls WHERE id=?").bind(id).first<Row>();
  return { scheduled: true, duplicatePrevented: false, schedule: summarise(row!) };
}

export async function cancelFeedbackCall(db: Db, input: { bookingId: string; customerId: string; actorId: string; reason?: string; asOf?: number }) {
  await ensurePostServiceFeedbackTables(db);
  const now = input.asOf ?? Date.now();
  const id = text(input.bookingId), owner = text(input.customerId);
  if (!id || !owner) throw new PostServiceFeedbackError("booking_required", "A booking and a signed-in customer are required", 400);
  // Ownership is checked on the booking, not only on the row, so another customer is refused rather than
  // told "nothing to cancel". Completion is not required here: a request on a booking that was later
  // reopened may still be withdrawn by its owner.
  const booking = await db.prepare("SELECT customer_id FROM canonical_bookings WHERE id=?").bind(id).first<Row>().catch(() => null);
  if (!booking || text(booking.customer_id) !== owner) throw new PostServiceFeedbackError("booking_not_owned", "This booking does not belong to the signed-in customer", 403);
  const row = await db.prepare("SELECT * FROM post_service_feedback_calls WHERE booking_id=? AND status='scheduled' ORDER BY created_at DESC LIMIT 1").bind(id).first<Row>();
  if (!row || text(row.customer_id) !== owner) return { cancelled: false, reason: "no_scheduled_call" };
  const changed = await db.prepare("UPDATE post_service_feedback_calls SET status='cancelled',outcome=?,updated_at=? WHERE id=? AND status='scheduled'").bind(text(input.reason) || "customer_cancelled", now, text(row.id)).run();
  if (!Number(changed.meta.changes)) return { cancelled: false, reason: "no_scheduled_call" };
  await recordEvent(db, text(row.id), "cancelled", text(input.actorId) || owner, { reason: text(input.reason) || "customer_cancelled" }, now);
  return { cancelled: true, scheduleId: text(row.id) };
}

export async function listFeedbackCallsForBooking(db: Db, input: { bookingId: string; customerId: string }) {
  await ensurePostServiceFeedbackTables(db);
  const booking = await completedOwnedBooking(db, input.bookingId, input.customerId);
  const rows = await db.prepare("SELECT * FROM post_service_feedback_calls WHERE booking_id=? ORDER BY created_at DESC LIMIT 10").bind(booking.bookingId).all<Row>();
  return rows.results.map(summarise);
}

// --- consented feedback call: dispatch ----------------------------------------------------------------

async function finish(db: Db, id: string, status: string, outcome: string, voiceCallId: string | null, actor: string, detail: Row, at: number) {
  await db.prepare("UPDATE post_service_feedback_calls SET status=?,outcome=?,voice_call_id=COALESCE(?,voice_call_id),updated_at=? WHERE id=?").bind(status, outcome, voiceCallId, at, id).run();
  await recordEvent(db, id, status, actor, { outcome, voiceCallId, ...detail }, at);
}

export type FeedbackCallSweepInput = {
  /** Required. There is no default placer; without one the sweep refuses and changes nothing. */
  placer: FeedbackCallPlacer | null | undefined;
  /** Required. null refuses every due row as policy-unknown, without dialling. */
  policy: FeedbackCallPolicy | null;
  asOf?: number; limit?: number; actorId?: string;
};

/**
 * Hand due requests to the injected test-only placer. Every prerequisite is re-read at dispatch - a
 * consent withdrawn or an opt-out recorded after scheduling cancels the row and nothing is placed. The
 * row is claimed before the placer is called so a concurrent sweep cannot place it twice, and a placer
 * that reports a production call stops the sweep: that is a wiring error, not an outcome to record.
 *
 * Nothing in this repository wires a placer by default. The customer route only ever injects the
 * synthetic no-dial placer, and only in an explicitly non-production configuration.
 */
export async function dispatchPostServiceFeedbackTestCalls(db: Db, input: FeedbackCallSweepInput) {
  await ensurePostServiceFeedbackTables(db);
  const placer = input.placer;
  if (!placer || placer.testOnly !== true || typeof placer.placeCall !== "function" || !text(placer.label)) {
    throw new PostServiceFeedbackError("call_placer_not_injected", "Feedback calls can only be placed through an injected test-only placer; none was supplied", 503);
  }
  const asOf = input.asOf ?? Date.now();
  const actor = text(input.actorId) || FEEDBACK_CALL_ACTOR;
  const limit = Math.max(1, Math.min(50, Number(input.limit || 20)));
  const due = await db.prepare("SELECT * FROM post_service_feedback_calls WHERE status='scheduled' AND scheduled_for<=? ORDER BY scheduled_for ASC LIMIT ?").bind(asOf, limit).all<Row>();
  const summary = { sweep: "post_service_feedback_calls", placer: placer.label, asOf, scanned: 0, placed: 0, simulated: 0, blocked: 0, cancelled: 0, missed: 0, failed: 0, skipped: 0 };
  const outcomes: Array<{ scheduleId: string; status: string; outcome: string; voiceCallId: string | null }> = [];
  const close = async (id: string, status: "placed" | "simulated" | "blocked" | "cancelled" | "missed" | "failed", outcome: string, voiceCallId: string | null, detail: Row) => {
    await finish(db, id, status, outcome, voiceCallId, actor, detail, asOf);
    summary[status]++;
    outcomes.push({ scheduleId: id, status, outcome, voiceCallId });
  };

  for (const row of due.results) {
    summary.scanned++;
    const id = text(row.id);
    const scheduledFor = Number(row.scheduled_for);
    const windowMs = Number(row.dispatch_window_ms);
    if (!Number.isInteger(windowMs) || windowMs < MINUTE) { await close(id, "blocked", "call_policy_unknown", null, { dispatchWindowMs: row.dispatch_window_ms }); continue; }
    if (asOf > scheduledFor + windowMs) { await close(id, "missed", "dispatch_window_elapsed", null, { scheduledFor, asOf, windowMs }); continue; }

    let booking: CompletedOwnedBooking;
    try { booking = await completedOwnedBooking(db, text(row.booking_id), text(row.customer_id)); }
    catch (error) {
      await close(id, "cancelled", error instanceof PostServiceFeedbackError ? error.code : "lineage_unavailable", null, {});
      continue;
    }
    const pre = await prerequisites(db, booking, input.policy, asOf);
    // The attempt this row is about to make is not "used" yet; only earlier rows count here.
    const blockers = pre.reasons.filter(reason => reason !== "attempts_exhausted" || pre.attemptsUsed >= pre.maxAttempts);
    if (blockers.length) {
      await close(id, blockers.some(reason => CONSENT_REASONS.includes(reason)) ? "cancelled" : "blocked", blockers[0], null, { reasons: blockers });
      continue;
    }
    const localHour = localHourIn(asOf, pre.timezone!);
    if (hourInQuietWindow(localHour, pre.quietHours!.start, pre.quietHours!.end)) { await close(id, "blocked", "quiet_hours", null, { localHour, timezone: pre.timezone }); continue; }
    if (pre.phoneKey !== text(row.phone_key)) { await close(id, "cancelled", "phone_changed_since_consent", null, {}); continue; }

    // Claim the row before touching the placer so a concurrent sweep cannot place it twice.
    const claimed = await db.prepare("UPDATE post_service_feedback_calls SET status='dispatching',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='scheduled' AND attempt_count<max_attempts").bind(asOf, id).run();
    if (!Number(claimed.meta.changes)) { summary.skipped++; outcomes.push({ scheduleId: id, status: text(row.status), outcome: "claim_lost", voiceCallId: null }); continue; }
    const attempt = Number(row.attempt_count || 0) + 1;

    let result: FeedbackCallPlacementResult;
    try {
      result = await placer.placeCall({
        idempotencyKey: `post-service-feedback-call:${id}:${attempt}`, useCase: FEEDBACK_CALL_USE_CASE, phone: pre.phone!, cityId: booking.cityId,
        customerId: booking.customerId, bookingId: booking.bookingId, scheduleId: id, attempt, actorId: actor, asOf,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      const ownership = (error as { name?: string })?.name === "CanonicalRecipientOwnershipError";
      await close(id, ownership ? "blocked" : "failed", ownership ? "recipient_ownership_refused" : "call_placement_failed", null, { message });
      continue;
    }
    const callId = text(result?.callId) || null, state = text(result?.state) || text(result?.outcome);
    if (result?.productionCall === true) {
      // A production call reported through a test-only placer is a wiring error. Record it and stop.
      await close(id, "failed", "production_call_reported", callId, { placer: placer.label, state });
      throw new PostServiceFeedbackError("production_call_reported", `Placer ${placer.label} reported a production call; sweep halted`, 500);
    }
    if (result?.outcome === "dialled") await close(id, "placed", state, callId, { placer: placer.label });
    else if (result?.outcome === "simulated") await close(id, "simulated", state, callId, { placer: placer.label, detail: text(result.detail) });
    else if (result?.outcome === "blocked") await close(id, "blocked", text(result.blockedBy) || state || "blocked", callId, { detail: text(result.detail) });
    else await close(id, "failed", state || "call_placement_failed", callId, { detail: text(result?.detail) });
  }
  return { ...summary, outcomes };
}
