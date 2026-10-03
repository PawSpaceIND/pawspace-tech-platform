import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, ALLOWLISTED_PHONE, OTHER_PHONE } from "./helpers/voice-harness.mjs";

// ---------------------------------------------------------------------------
// Post-service honest review invitation + consented feedback call, EXECUTED against node:sqlite.
//
// The public review links must come only from the approved review configuration and must never depend
// on the rating. The feedback call must only be scheduled for a completed booking the customer owns,
// with explicit consent on record, outside quiet hours in the customer's own timezone, under an
// explicitly configured policy, and placed at most once through an INJECTED test-only placer. No
// telephony module is imported by the contract, and every unknown refuses.
// ---------------------------------------------------------------------------

installWorkersHooks("__PSFC_DB__", "__PSFC_ENV__");
const mod = await import("../lib/post-service-feedback-call.ts");
const gov = await import("../lib/voice-outbound-governance.ts");
const reviewConfig = await import("../lib/review-configuration-governance.ts");
const reviews = await import("../lib/service-review-governance.ts");
const commGov = await import("../lib/communication-governance.ts");
const engine = await import("../lib/communication-engine.ts");

// 2026-10-05 14:00 IST (08:30 UTC). Quiet hours in the seeded blr policy are 21:00-09:00.
const NOW = Date.UTC(2026, 9, 5, 8, 30);
const HOUR = 3_600_000, MINUTE = 60_000, DAY = 86_400_000;
const IST_16 = NOW + 2 * HOUR;        // 16:00 IST
const IST_20 = NOW + 6 * HOUR;        // 20:00 IST
const IST_23 = NOW + 9 * HOUR;        // 23:00 IST (quiet)

/** Labelled synthetic fixture values. These are test choices, not business policy. */
const FIXTURE_POLICY = { maxHorizonMs: 14 * DAY, dispatchWindowMs: 90 * MINUTE, source: "test_fixture_policy" };

/** A recording placer: it never contacts anything, it just remembers what it was asked. */
function recordingPlacer(outcome = "dialled", { label = "test_recording_placer", productionCall = false, throwError = null } = {}) {
  const requests = [];
  return {
    placer: { testOnly: true, label, async placeCall(request) { requests.push(request); if (throwError) throw throwError; return { callId: `TEST-${request.scheduleId}-${request.attempt}`, outcome, state: outcome === "dialled" ? "dialing" : outcome === "blocked" ? "blocked_test" : `${outcome}_test`, blockedBy: outcome === "blocked" ? "test_block" : null, productionCall }; } },
    requests,
  };
}

async function world({ status = "completed", voiceConsent = true, timezone = "Asia/Kolkata", policy = true, preferences = true, central = "yes" } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__PSFC_DB__ = db;
  globalThis.__PSFC_ENV__ = {};
  await gov.ensureVoiceCallTables(db);
  seedRecipient(sqlite); // CON-V1 owns BKG-V1 on the allow-listed phone
  sqlite.prepare("UPDATE canonical_bookings SET status=?,service_code='grooming',city_id='blr',provider_id='PROV-1' WHERE id='BKG-V1'").run(status);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,provider_id,status) VALUES ('BKG-OTHER','CON-OTHER','grooming','blr','PROV-2','completed')").run();
  if (policy) await engine.seedCommunicationPolicy(db); else await engine.ensureCommunicationTables(db);
  if (preferences) sqlite.prepare("INSERT INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES ('CON-V1',1,0,'voice',?,'test',1)").run(timezone);
  await commGov.ensureCommunicationGovernance(db);
  if (central !== "absent") sqlite.prepare("INSERT INTO communication_consent (customer_id,global_opt_out,whatsapp_allowed,email_allowed,voice_allowed,sms_allowed,source,updated_by,updated_at) VALUES ('CON-V1',?,1,1,?,1,'test','qa',1)").run(central === "global_opt_out" ? 1 : 0, central === "null" ? null : central === "no" ? 0 : 1);
  if (voiceConsent) await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "customer_app_settings", actorId: "qa", asOf: NOW - HOUR });
  await mod.ensurePostServiceFeedbackTables(db);
  return { sqlite, db };
}

async function approveLinks(db, input = {}) {
  const draft = await reviewConfig.saveReviewConfig(db, { serviceCode: "grooming", questions: [], triggerType: "every_service", channels: ["notification"], googleReviewLink: "https://search.example.test/maps/pawspace/review", appReviewLink: "https://apps.example.test/pawspace/review", publicReviewDestination: "google", ...input }, "maker@pawspace.in");
  await reviewConfig.approveReviewConfig(db, { id: draft.id, approvalReference: "TEST-LINKS", actor: "checker@pawspace.in" });
  return draft;
}

const base = { bookingId: "BKG-V1", customerId: "CON-V1", actorId: "CON-V1", consentConfirmed: true, policy: FIXTURE_POLICY, asOf: NOW };
const scheduleRows = sqlite => sqlite.prepare("SELECT * FROM post_service_feedback_calls ORDER BY created_at").all();
const voiceOrders = sqlite => sqlite.prepare("SELECT COUNT(*) n FROM voice_call_orders").get().n;

// --- invitation ------------------------------------------------------------------------------------

test("no approved review configuration means no destination at all - never a fallback link", async () => {
  const { db } = await world();
  const invitation = await mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" });
  assert.deepEqual(invitation.destinations, []);
  assert.equal(invitation.source, "no_approved_config");
  assert.deepEqual(invitation.terms, { optional: true, rewarded: false, ratingGated: false, postingVerified: false, honestOnly: true });
  assert.ok(!("reward" in invitation) && !("feedbackReward" in invitation), "the invitation carries no reward of any kind");
});

test("only approved https links are offered, preferred destination first, blank or non-https links are dropped", async () => {
  const { db } = await world();
  const approved = await approveLinks(db, { publicReviewDestination: "app" });
  const invitation = await mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" });
  assert.deepEqual(invitation.destinations.map(d => d.platform), ["app", "google"]);
  assert.equal(invitation.destinations[0].url, "https://apps.example.test/pawspace/review");
  assert.equal(invitation.destinations[0].configId, approved.id);
  assert.equal(invitation.source, "approved_review_config");

  // A draft never counts, and a later approved version with a bad app link removes it.
  await reviewConfig.saveReviewConfig(db, { serviceCode: "grooming", questions: [], triggerType: "every_service", channels: ["notification"], googleReviewLink: "https://search.example.test/v3", appReviewLink: "http://insecure.example.test/app" }, "maker@pawspace.in");
  const unchanged = await mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" });
  assert.equal(unchanged.destinations[0].url, "https://apps.example.test/pawspace/review", "an unapproved draft changes nothing");
  await approveLinks(db, { googleReviewLink: "https://search.example.test/v3", appReviewLink: "http://insecure.example.test/app" });
  const next = await mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" });
  assert.deepEqual(next.destinations.map(d => [d.platform, d.url]), [["google", "https://search.example.test/v3"]], "the non-https app link is absent, not rewritten");
});

test("the invitation is identical whether the customer rated 1, rated 5, or has not rated at all", async () => {
  const { db, sqlite } = await world();
  await approveLinks(db);
  await reviews.ensureServiceReviewTables(db);
  const unrated = await mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" });
  sqlite.prepare("INSERT INTO review_requests VALUES ('R1','BKG-V1','grooming','CON-V1','BKG-V1:1','[]','[]','reviewed',1)").run();
  sqlite.prepare("INSERT INTO service_reviews VALUES ('REV1','R1','BKG-V1','CON-V1',1,'{}',1)").run();
  const oneStar = await mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" });
  sqlite.prepare("UPDATE service_reviews SET stars=5 WHERE id='REV1'").run();
  const fiveStar = await mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" });
  assert.deepEqual(oneStar, unrated);
  assert.deepEqual(fiveStar, unrated);
  assert.equal(oneStar.destinations.length, 2);
});

test("the invitation refuses a booking that is not completed, not owned, or unknown", async () => {
  for (const status of ["confirmed", "in_progress", "cancelled"]) {
    const { db } = await world({ status });
    await approveLinks(db);
    await assert.rejects(mod.postServiceReviewInvitation(db, { bookingId: "BKG-V1", customerId: "CON-V1" }), error => error.code === "booking_not_completed" && error.status === 409);
  }
  const { db } = await world();
  await approveLinks(db);
  await assert.rejects(mod.postServiceReviewInvitation(db, { bookingId: "BKG-OTHER", customerId: "CON-V1" }), error => error.code === "booking_not_owned" && error.status === 403);
  await assert.rejects(mod.postServiceReviewInvitation(db, { bookingId: "BKG-MISSING", customerId: "CON-V1" }), error => error.code === "booking_not_owned" && error.status === 403);
});

// --- policy: explicit, validated, no defaults ---------------------------------------------------------

test("scheduling policy has no default: unset, partial, non-integer or out-of-range values are unknown", () => {
  assert.equal(mod.validateFeedbackCallPolicy(null), null);
  assert.equal(mod.validateFeedbackCallPolicy(undefined), null);
  assert.equal(mod.validateFeedbackCallPolicy({}), null);
  assert.equal(mod.validateFeedbackCallPolicy({ maxHorizonMs: 14 * DAY, source: "x" }), null, "missing window");
  assert.equal(mod.validateFeedbackCallPolicy({ dispatchWindowMs: HOUR, source: "x" }), null, "missing horizon");
  assert.equal(mod.validateFeedbackCallPolicy({ maxHorizonMs: 14 * DAY, dispatchWindowMs: HOUR }), null, "missing source");
  assert.equal(mod.validateFeedbackCallPolicy({ maxHorizonMs: 1.5 * DAY + 0.5, dispatchWindowMs: HOUR, source: "x" }), null, "non-integer");
  assert.equal(mod.validateFeedbackCallPolicy({ maxHorizonMs: 30 * MINUTE, dispatchWindowMs: HOUR, source: "x" }), null, "horizon under an hour");
  assert.equal(mod.validateFeedbackCallPolicy({ maxHorizonMs: 400 * DAY, dispatchWindowMs: HOUR, source: "x" }), null, "horizon over a year");
  assert.equal(mod.validateFeedbackCallPolicy({ maxHorizonMs: DAY, dispatchWindowMs: 30_000, source: "x" }), null, "window under a minute");
  assert.equal(mod.validateFeedbackCallPolicy({ maxHorizonMs: DAY, dispatchWindowMs: 2 * DAY, source: "x" }), null, "window over a day");
  assert.deepEqual(mod.validateFeedbackCallPolicy(FIXTURE_POLICY), FIXTURE_POLICY);

  assert.equal(mod.feedbackCallPolicyFromEnv({}), null, "unset environment is unknown");
  assert.equal(mod.feedbackCallPolicyFromEnv({ PAWSPACE_POST_SERVICE_FEEDBACK_CALL_HORIZON_HOURS: "336" }), null, "half-configured is unknown");
  assert.equal(mod.feedbackCallPolicyFromEnv({ PAWSPACE_POST_SERVICE_FEEDBACK_CALL_HORIZON_HOURS: "14d", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_DISPATCH_WINDOW_MINUTES: "90" }), null, "non-numeric is unknown");
  assert.deepEqual(mod.feedbackCallPolicyFromEnv({ PAWSPACE_POST_SERVICE_FEEDBACK_CALL_HORIZON_HOURS: "336", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_DISPATCH_WINDOW_MINUTES: "90" }), { maxHorizonMs: 336 * HOUR, dispatchWindowMs: 90 * MINUTE, source: "environment_configuration" });
});

test("an unknown scheduling policy refuses eligibility, scheduling and dispatch alike", async () => {
  const { db, sqlite } = await world();
  const eligibility = await mod.feedbackCallEligibility(db, { bookingId: "BKG-V1", customerId: "CON-V1", policy: null, asOf: NOW });
  assert.equal(eligibility.eligible, false);
  assert.deepEqual(eligibility.reasons, ["call_policy_unknown"]);
  assert.equal(eligibility.policy, null);
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, policy: null, preferredAt: IST_16 }), error => error.code === "call_policy_unknown" && error.status === 412);
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, policy: { maxHorizonMs: 10, dispatchWindowMs: 10, source: "bad" }, preferredAt: IST_16 }), error => error.code === "call_policy_unknown");
  assert.equal(scheduleRows(sqlite).length, 0);

  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  const { placer, requests } = recordingPlacer();
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: null, asOf: IST_16 });
  assert.equal(run.blocked, 1, JSON.stringify(run));
  assert.equal(requests.length, 0, "the placer was never asked");
  assert.equal(scheduleRows(sqlite)[0].outcome, "call_policy_unknown");
});

// --- eligibility: every unknown refuses ----------------------------------------------------------------

test("a fully consented customer with timezone, city policy and scheduling policy on record is eligible", async () => {
  const { db } = await world();
  const eligibility = await mod.feedbackCallEligibility(db, { bookingId: "BKG-V1", customerId: "CON-V1", policy: FIXTURE_POLICY, asOf: NOW });
  assert.equal(eligibility.eligible, true, eligibility.reasons.join(","));
  assert.deepEqual(eligibility.reasons, []);
  assert.equal(eligibility.timezone, "Asia/Kolkata");
  assert.deepEqual(eligibility.quietHours, { start: 21, end: 9 });
  assert.deepEqual(eligibility.policy, FIXTURE_POLICY);
  assert.equal(eligibility.maxAttempts, 1, "attempt ceiling comes from the voice owner's feedback_request use case");
  assert.equal(eligibility.existing, null);
});

for (const [label, options, reason] of [
  ["central consent row absent", { central: "absent" }, "voice_consent_not_explicit"],
  ["central voice flag null (unknown)", { central: "null" }, "voice_consent_not_explicit"],
  ["central voice flag refused", { central: "no" }, "voice_consent_not_explicit"],
  ["central global opt-out", { central: "global_opt_out" }, "global_opt_out"],
  ["phone-level voice consent missing", { voiceConsent: false }, "voice_consent_missing"],
  ["no timezone on record", { preferences: false }, "timezone_unknown"],
  ["invalid timezone on record", { timezone: "Mars/Olympus" }, "timezone_unknown"],
  ["no quiet-hours policy for the city", { policy: false }, "quiet_hours_policy_unknown"],
]) test(`refuses when ${label}`, async () => {
  const { db, sqlite } = await world(options);
  const eligibility = await mod.feedbackCallEligibility(db, { bookingId: "BKG-V1", customerId: "CON-V1", policy: FIXTURE_POLICY, asOf: NOW });
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reasons.includes(reason), `${reason} in ${eligibility.reasons.join(",")}`);
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 }), error => error.code === reason && error.status === 412);
  assert.equal(scheduleRows(sqlite).length, 0);
});

test("a recorded voice opt-out refuses and is not overridden by an older consent", async () => {
  const { db, sqlite } = await world();
  await gov.recordVoiceOptOut(db, { phone: ALLOWLISTED_PHONE, source: "customer_request", actorId: "qa", asOf: NOW });
  const eligibility = await mod.feedbackCallEligibility(db, { bookingId: "BKG-V1", customerId: "CON-V1", policy: FIXTURE_POLICY, asOf: NOW });
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.reasons.includes("voice_opt_out"));
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 }), /cannot be scheduled/);
  assert.equal(scheduleRows(sqlite).length, 0);
});

test("the module never writes the voice owner's consent or opt-out tables", async () => {
  const { db, sqlite } = await world({ voiceConsent: false });
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 }));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM voice_call_consents").get().n, 0, "asking for a call did not manufacture consent");
});

// --- scheduling ---------------------------------------------------------------------------------------

test("scheduling requires explicit confirmation, a future time within the configured horizon, outside quiet hours", async () => {
  const { db, sqlite } = await world();
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16, consentConfirmed: false }), error => error.code === "consent_not_confirmed" && error.status === 400);
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16, consentConfirmed: "yes" }), error => error.code === "consent_not_confirmed");
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: NOW - HOUR }), error => error.code === "time_in_past");
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: NaN }), error => error.code === "time_required");
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: NOW + FIXTURE_POLICY.maxHorizonMs + HOUR }), error => error.code === "time_too_far");
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_23 }), error => error.code === "quiet_hours" && error.status === 422);
  assert.equal(scheduleRows(sqlite).length, 0);
  const result = await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  assert.equal(result.scheduled, true);
  assert.equal(result.duplicatePrevented, false);
  const row = scheduleRows(sqlite)[0];
  assert.equal(row.status, "scheduled");
  assert.equal(row.booking_id, "BKG-V1"); assert.equal(row.customer_id, "CON-V1"); assert.equal(row.provider_id, "PROV-1"); assert.equal(row.service_code, "grooming");
  assert.equal(row.timezone, "Asia/Kolkata"); assert.equal(row.scheduled_for, IST_16); assert.equal(row.max_attempts, 1); assert.equal(row.attempt_count, 0);
  assert.equal(row.dispatch_window_ms, FIXTURE_POLICY.dispatchWindowMs); assert.equal(row.policy_source, "test_fixture_policy");
  assert.equal(row.consent_source, "customer_app_feedback_call_request");
});

test("quiet hours are evaluated in the customer's own timezone, not a fixed one", async () => {
  // 16:00 IST is 06:30 in New York - inside 21:00-09:00 quiet hours there - while 20:00 IST is 10:30.
  const { db } = await world({ timezone: "America/New_York" });
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 }), error => error.code === "quiet_hours" && /America\/New_York/.test(error.message));
  const ok = await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_20 });
  assert.equal(ok.scheduled, true);
  assert.equal(ok.schedule.timezone, "America/New_York");
});

test("scheduling is idempotent per chosen time and allows one live request per booking", async () => {
  const { db, sqlite } = await world();
  const first = await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  const replay = await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 + 30_000 });
  assert.equal(replay.duplicatePrevented, true, "the same minute replays to the same row");
  assert.equal(replay.schedule.id, first.schedule.id);
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_20 }), error => error.code === "already_scheduled" && error.status === 409);
  assert.equal(scheduleRows(sqlite).length, 1);
  // The partial unique index holds even if the pre-check is bypassed.
  assert.throws(() => sqlite.prepare("INSERT INTO post_service_feedback_calls (id,idempotency_key,booking_id,customer_id,service_code,city_id,phone_key,timezone,scheduled_for,dispatch_window_ms,policy_source,consent_source,consent_confirmed_at,status,max_attempts,created_by,created_at,updated_at) VALUES ('X','k','BKG-V1','CON-V1','grooming','blr','p','Asia/Kolkata',1,60000,'s','s',1,'scheduled',1,'c',1,1)").run(), /UNIQUE/);

  const cancelled = await mod.cancelFeedbackCall(db, { bookingId: "BKG-V1", customerId: "CON-V1", actorId: "CON-V1", asOf: NOW });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await mod.cancelFeedbackCall(db, { bookingId: "BKG-V1", customerId: "CON-V1", actorId: "CON-V1", asOf: NOW })).cancelled, false);
  const rescheduled = await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_20 });
  assert.equal(rescheduled.scheduled, true);
  assert.deepEqual(scheduleRows(sqlite).map(r => r.status), ["cancelled", "scheduled"]);
  const eligibility = await mod.feedbackCallEligibility(db, { bookingId: "BKG-V1", customerId: "CON-V1", policy: FIXTURE_POLICY, asOf: NOW });
  assert.equal(eligibility.existing?.id, rescheduled.schedule.id);
});

test("another customer cannot cancel or schedule against a booking they do not own", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, customerId: "CON-OTHER", actorId: "CON-OTHER", preferredAt: IST_20 }), error => error.status === 403);
  await assert.rejects(mod.cancelFeedbackCall(db, { bookingId: "BKG-V1", customerId: "CON-OTHER", actorId: "CON-OTHER", asOf: NOW }), error => error.code === "booking_not_owned" && error.status === 403);
  assert.equal(scheduleRows(sqlite)[0].status, "scheduled");
  await assert.rejects(mod.feedbackCallEligibility(db, { bookingId: "BKG-V1", customerId: "CON-OTHER", policy: FIXTURE_POLICY, asOf: NOW }), error => error.code === "booking_not_owned");
});

// --- dispatch: injected test-only placer, no default ----------------------------------------------------

test("the sweep refuses to run without an injected test-only placer and changes nothing", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  for (const placer of [undefined, null, {}, { label: "x", async placeCall() { return {}; } }, { testOnly: "true", label: "x", async placeCall() { return {}; } }, { testOnly: true, label: "", async placeCall() { return {}; } }, { testOnly: true, label: "x" }]) {
    await assert.rejects(mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 }), error => error.code === "call_placer_not_injected" && error.status === 503);
  }
  const row = scheduleRows(sqlite)[0];
  assert.equal(row.status, "scheduled"); assert.equal(row.attempt_count, 0);
  assert.equal(voiceOrders(sqlite), 0, "no voice ledger row was ever created");
});

test("a due call is handed to the injected placer exactly once, with the booking lineage, and never twice", async () => {
  const { db, sqlite } = await world();
  const { schedule } = await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  const { placer, requests } = recordingPlacer("dialled");
  const early = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 - HOUR });
  assert.equal(early.scanned, 0, "nothing is placed before the customer's chosen time");
  assert.equal(requests.length, 0);

  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 + MINUTE });
  assert.equal(run.placed, 1, JSON.stringify(run));
  assert.equal(run.placer, "test_recording_placer");
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.useCase, "feedback_request");
  assert.equal(request.bookingId, "BKG-V1"); assert.equal(request.customerId, "CON-V1"); assert.equal(request.cityId, "blr");
  assert.equal(request.phone, ALLOWLISTED_PHONE);
  assert.equal(request.idempotencyKey, `post-service-feedback-call:${schedule.id}:1`);
  assert.equal(request.attempt, 1);
  const row = scheduleRows(sqlite)[0];
  assert.equal(row.status, "placed"); assert.equal(row.attempt_count, 1); assert.equal(row.voice_call_id, `TEST-${schedule.id}-1`);
  assert.equal(voiceOrders(sqlite), 0, "the contract never touched the voice ledger itself");

  const again = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 + 2 * MINUTE });
  assert.equal(again.scanned, 0);
  assert.equal(requests.length, 1, "a second sweep asks for nothing");

  const eligibility = await mod.feedbackCallEligibility(db, { bookingId: "BKG-V1", customerId: "CON-V1", policy: FIXTURE_POLICY, asOf: IST_20 });
  assert.ok(eligibility.reasons.includes("attempts_exhausted"), "feedback_request allows one attempt per booking");
  await assert.rejects(mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_20 + 6 * HOUR, asOf: IST_20 }), error => error.code === "attempts_exhausted" && error.status === 409);
  const events = sqlite.prepare("SELECT event_type FROM post_service_feedback_call_events WHERE schedule_id=? ORDER BY created_at").all(schedule.id).map(e => e.event_type);
  assert.deepEqual(events, ["scheduled", "placed"]);
});

test("the synthetic no-dial placer records a simulated outcome, consumes the attempt, and dials nothing", async () => {
  const { db, sqlite } = await world();
  const { schedule } = await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer: mod.syntheticFeedbackCallPlacer("fixture_synthetic"), policy: FIXTURE_POLICY, asOf: IST_16 });
  assert.equal(run.simulated, 1, JSON.stringify(run)); assert.equal(run.placed, 0);
  const row = scheduleRows(sqlite)[0];
  assert.equal(row.status, "simulated"); assert.equal(row.outcome, "simulated_no_dial"); assert.equal(row.voice_call_id, `SYN-${schedule.id}-1`); assert.equal(row.attempt_count, 1);
  assert.equal(voiceOrders(sqlite), 0);
});

test("a placer that reports a production call is recorded as a failure and halts the sweep", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  const { placer } = recordingPlacer("dialled", { productionCall: true, label: "misconfigured_placer" });
  await assert.rejects(mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 }), error => error.code === "production_call_reported");
  const row = scheduleRows(sqlite)[0];
  assert.equal(row.status, "failed"); assert.equal(row.outcome, "production_call_reported");
});

test("blocked and failed placer outcomes, and a throwing placer, are recorded without a retry", async () => {
  for (const [outcome, expectedStatus, expectedOutcome] of [["blocked", "blocked", "test_block"], ["failed", "failed", "failed_test"]]) {
    const { db, sqlite } = await world();
    await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
    const { placer, requests } = recordingPlacer(outcome);
    const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 });
    assert.equal(run[expectedStatus], 1, JSON.stringify(run));
    assert.equal(scheduleRows(sqlite)[0].outcome, expectedOutcome);
    await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 + MINUTE });
    assert.equal(requests.length, 1, "no automatic retry");
  }
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  const { placer } = recordingPlacer("dialled", { throwError: Object.assign(new Error("owner refused"), { name: "CanonicalRecipientOwnershipError" }) });
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 });
  assert.equal(run.blocked, 1);
  assert.equal(scheduleRows(sqlite)[0].outcome, "recipient_ownership_refused");
});

test("an opt-out recorded after scheduling cancels the call at dispatch and the placer is never asked", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  await gov.recordVoiceOptOut(db, { phone: ALLOWLISTED_PHONE, source: "customer_request", actorId: "qa", asOf: NOW + HOUR });
  const { placer, requests } = recordingPlacer();
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 });
  assert.equal(run.cancelled, 1, JSON.stringify(run));
  assert.equal(requests.length, 0);
  const row = scheduleRows(sqlite)[0];
  assert.equal(row.status, "cancelled");
  assert.ok(["voice_opt_out", "global_opt_out", "voice_consent_missing"].includes(row.outcome), row.outcome);
  assert.equal(row.attempt_count, 0, "a cancelled request did not consume the customer's attempt");
});

test("central consent withdrawn after scheduling cancels the call at dispatch", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  sqlite.prepare("UPDATE communication_consent SET voice_allowed=0 WHERE customer_id='CON-V1'").run();
  const { placer, requests } = recordingPlacer();
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 });
  assert.equal(run.cancelled, 1);
  assert.equal(requests.length, 0);
  assert.equal(scheduleRows(sqlite)[0].outcome, "voice_consent_not_explicit");
});

test("lineage is re-read at dispatch: a booking that is no longer completed or owned is not placed", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='BKG-V1'").run();
  const first = recordingPlacer();
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer: first.placer, policy: FIXTURE_POLICY, asOf: IST_16 });
  assert.equal(run.cancelled, 1);
  assert.equal(scheduleRows(sqlite)[0].outcome, "booking_not_completed");
  assert.equal(first.requests.length, 0);

  const second = await world();
  await mod.scheduleFeedbackCall(second.db, { ...base, preferredAt: IST_16 });
  second.sqlite.prepare("UPDATE canonical_bookings SET customer_id='CON-OTHER' WHERE id='BKG-V1'").run();
  const owner = recordingPlacer();
  const ownerRun = await mod.runPostServiceFeedbackCallSweep(second.db, { placer: owner.placer, policy: FIXTURE_POLICY, asOf: IST_16 });
  assert.equal(ownerRun.cancelled, 1);
  assert.equal(scheduleRows(second.sqlite)[0].outcome, "booking_not_owned");
  assert.equal(owner.requests.length, 0);
});

test("a registered number that changed after consent is not placed", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  sqlite.prepare("UPDATE canonical_customers SET primary_phone=? WHERE id='CON-V1'").run(OTHER_PHONE);
  const { placer, requests } = recordingPlacer();
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 });
  assert.equal(run.placed, 0);
  assert.equal(requests.length, 0);
  assert.equal(scheduleRows(sqlite)[0].status, "cancelled");
});

test("quiet hours are re-checked at dispatch time in the customer's timezone", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_20 });
  sqlite.prepare("UPDATE communication_policies SET quiet_start_hour=19 WHERE city_id='blr'").run();
  const { placer, requests } = recordingPlacer();
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_20 });
  assert.equal(run.blocked, 1, JSON.stringify(run));
  assert.equal(requests.length, 0);
  assert.equal(scheduleRows(sqlite)[0].outcome, "quiet_hours");
});

test("a due call the sweep did not reach inside the configured window is missed, never placed late", async () => {
  const { db, sqlite } = await world();
  await mod.scheduleFeedbackCall(db, { ...base, preferredAt: IST_16 });
  const { placer, requests } = recordingPlacer();
  const run = await mod.runPostServiceFeedbackCallSweep(db, { placer, policy: FIXTURE_POLICY, asOf: IST_16 + FIXTURE_POLICY.dispatchWindowMs + MINUTE });
  assert.equal(run.missed, 1);
  assert.equal(requests.length, 0);
  assert.equal(scheduleRows(sqlite)[0].status, "missed");
});

// --- route dispatch gate: default off, no production flag alone enables it --------------------------------

const DISPATCH_ON = { FORBID_PRODUCTION: "true", APP_ENV: "staging", PAWSPACE_DEPLOYMENT_ENV: "staging", NODE_ENV: "test", PAWSPACE_VOICE_ENV: "uat", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "on" };

test("synthetic route dispatch is off by default and needs explicit non-production markers plus the switch", () => {
  const on = DISPATCH_ON;
  assert.equal(mod.syntheticDispatchPermitted({}), false);
  assert.equal(mod.syntheticDispatchPermitted(on), true);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, APP_ENV: "Staging", PAWSPACE_DEPLOYMENT_ENV: "STAGING", FORBID_PRODUCTION: "TRUE", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "ON" }), true, "case-insensitive");
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "" }), false, "switch unset");
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "true" }), false, "only the literal 'on'");
  assert.equal(mod.syntheticDispatchPermitted({ ...on, FORBID_PRODUCTION: "false" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, FORBID_PRODUCTION: "" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, APP_ENV: "" }), false, "a missing app environment is unknown, not non-production");
  assert.equal(mod.syntheticDispatchPermitted({ ...on, APP_ENV: "production" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, APP_ENV: "Production" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_DEPLOYMENT_ENV: "" }), false, "a missing deployment marker is unknown, not non-production");
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_DEPLOYMENT_ENV: "production" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_DEPLOYMENT_ENV: "PRODUCTION" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_DEPLOYMENT_ENV: "prod" }), false, "an unknown marker is not a non-production marker");
  assert.equal(mod.syntheticDispatchPermitted({ ...on, NODE_ENV: "production" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, NODE_ENV: "PRODUCTION" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_VOICE_ENV: "live" }), false, "a live voice environment never runs even the synthetic sweep");
  assert.equal(mod.syntheticDispatchPermitted({ ...on, PAWSPACE_VOICE_ENV: "LIVE" }), false);
  assert.equal(mod.syntheticDispatchPermitted({ PAWSPACE_VOICE_LIVE_APPROVED: "true", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "on" }), false, "a production approval flag plus the switch is still off");
  assert.equal(mod.syntheticDispatchPermitted({ FORBID_PRODUCTION: "true", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "on" }), false, "forbidding production without declaring what this is stays off");
});

// --- route: the customer principal is the verified session subject, and nobody else -----------------------

const route = await import("../app/api/post-service-feedback/route.ts");
const { upsertIdentityBinding, revokeIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { seedActors } = await import("./helpers/execution-harness.mjs");
const ORIGIN = "https://app.pawspace.in";
// PAWSPACE_WORKSPACE_IDENTITY_TRUST is what lets a declared (staging) deployment accept the dispatch-owned staff
// identity header at all; without it every staff request here would be an anonymous 401 and prove nothing.
const ROUTE_ENV = { ...DISPATCH_ON, PAWSPACE_WORKSPACE_IDENTITY_TRUST: "openai-dispatch", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_HORIZON_HOURS: "336", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_DISPATCH_WINDOW_MINUTES: "90" };
const SUPERUSER = "voice.admin@pawspace.in", MANAGER = "ops.manager@pawspace.in", FINANCE = "finance@pawspace.in";

async function sessionCookie(db, subjectType, subjectId) {
  const identitySource = subjectType === "customer" ? "customer_otp" : "partner_otp", principalType = "identity_subject", principalKey = `${subjectType}:${subjectId}`;
  const binding = await upsertIdentityBinding(db, { identitySource, principalType, principalKey, subjectType, subjectId, verificationState: "verified", actorId: "test", reason: "post-service feedback route regression" });
  const issued = await issuePlatformSession(db, { bindingId: String(binding.id), identitySource, principalType, principalKey, subjectType, subjectId });
  return { cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`, bindingId: String(binding.id) };
}
async function routeWorld(envOverrides = {}) {
  const ctx = await world();
  globalThis.__PSFC_ENV__ = { ...ROUTE_ENV, ...envOverrides };
  ctx.sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,primary_phone,secondary_phone,consent_json) VALUES ('CON-OTHER',?,NULL,NULL)").run(OTHER_PHONE);
  await seedActors(ctx.sqlite, ctx.db, [{ id: "USR-SU", email: SUPERUSER, role: "superuser" }, { id: "USR-MGR", email: MANAGER, role: "manager" }, { id: "USR-FIN", email: FINANCE, role: "finance" }]);
  const owner = await sessionCookie(ctx.db, "customer", "CON-V1");
  const other = await sessionCookie(ctx.db, "customer", "CON-OTHER");
  const provider = await sessionCookie(ctx.db, "provider", "PROV-1");
  return { ...ctx, owner, other, provider };
}
const get = (query, headers = {}, origin = ORIGIN) => route.GET(new Request(`${origin}/api/post-service-feedback?${query}`, { headers }));
const post = (body, headers = {}, origin = ORIGIN) => route.POST(new Request(`${origin}/api/post-service-feedback`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const staff = email => ({ "oai-authenticated-user-email": email });
const scheduleBody = (extra = {}) => ({ action: "schedule_call", bookingId: "BKG-V1", preferredAt: new Date(Date.now() + 26 * HOUR).toISOString(), consentConfirmed: true, ...extra });
const auditRows = sqlite => sqlite.prepare("SELECT actor_email,actor_role,action,outcome FROM security_audit_events WHERE action LIKE 'post_service_feedback.%' ORDER BY created_at").all();
async function withPreviewHost(fn) {
  const previous = process.env.PAWSPACE_LOCAL_PREVIEW;
  process.env.PAWSPACE_LOCAL_PREVIEW = "on";
  try { return await fn(); } finally { if (previous === undefined) delete process.env.PAWSPACE_LOCAL_PREVIEW; else process.env.PAWSPACE_LOCAL_PREVIEW = previous; }
}

/**
 * The route's own scheduling uses the real clock, so the chosen time is "tomorrow at the same hour"
 * shifted into daytime. Pick 26 hours ahead and, if that lands in quiet hours IST, this helper moves it.
 */
function daytimeTomorrowIso() {
  const now = new Date();
  const probe = new Date(now.getTime() + 26 * HOUR);
  const istHour = (probe.getUTCHours() + 5 + (probe.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
  const shift = istHour >= 21 ? (24 - istHour + 10) : istHour < 9 ? (10 - istHour) : 0;
  return new Date(probe.getTime() + shift * HOUR).toISOString();
}

test("route: the booking's own verified customer session can read, schedule and cancel, and the rows name that customer", async () => {
  const { sqlite, owner } = await routeWorld();
  const read = await get("bookingId=BKG-V1", { cookie: owner.cookie });
  assert.equal(read.status, 200);
  const { data } = await read.json();
  assert.equal(data.invitation.bookingId, "BKG-V1");
  assert.deepEqual(data.invitation.destinations, [], "no approved config, no link");
  assert.equal(data.call.eligible, true, data.call.reasons.join(","));
  assert.deepEqual(data.call.policy, { maxHorizonMs: 336 * HOUR, dispatchWindowMs: 90 * MINUTE, source: "environment_configuration" });

  const scheduled = await post(scheduleBody({ preferredAt: daytimeTomorrowIso() }), { cookie: owner.cookie });
  assert.equal(scheduled.status, 201, JSON.stringify(await scheduled.clone().json()));
  const row = scheduleRows(sqlite)[0];
  assert.equal(row.customer_id, "CON-V1"); assert.equal(row.created_by, "CON-V1"); assert.equal(row.consent_source, "customer_app_feedback_call_request");
  const audits = auditRows(sqlite);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_role, "customer");
  assert.ok(!audits[0].actor_email.includes("@pawspace.in"), `the audit names the customer session, not staff: ${audits[0].actor_email}`);

  const same = await get("bookingId=BKG-V1&customerId=CON-V1", { cookie: owner.cookie });
  assert.equal(same.status, 200, "a supplied customerId that matches the session is accepted");
  const cancelled = await post({ action: "cancel_call", bookingId: "BKG-V1" }, { cookie: owner.cookie });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).data.cancelled, true);
  assert.equal(scheduleRows(sqlite)[0].status, "cancelled");
});

test("route: a supplied customerId that differs from the session subject is denied, whoever is signed in", async () => {
  const { sqlite, owner } = await routeWorld();
  assert.equal((await get("bookingId=BKG-V1&customerId=CON-OTHER", { cookie: owner.cookie })).status, 403);
  assert.equal((await post(scheduleBody({ customerId: "CON-OTHER" }), { cookie: owner.cookie })).status, 403);
  assert.equal((await post({ action: "cancel_call", bookingId: "BKG-V1", customerId: "CON-OTHER" }, { cookie: owner.cookie })).status, 403);
  assert.equal(scheduleRows(sqlite).length, 0);
});

test("route: another customer's verified session cannot read, schedule or cancel against this booking", async () => {
  const { sqlite, owner, other } = await routeWorld();
  assert.equal((await get("bookingId=BKG-V1", { cookie: other.cookie })).status, 403);
  const foreign = await post(scheduleBody({ preferredAt: daytimeTomorrowIso() }), { cookie: other.cookie });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).code, "booking_not_owned");
  assert.equal(scheduleRows(sqlite).length, 0);
  assert.equal((await post(scheduleBody({ preferredAt: daytimeTomorrowIso() }), { cookie: owner.cookie })).status, 201);
  const cancel = await post({ action: "cancel_call", bookingId: "BKG-V1" }, { cookie: other.cookie });
  assert.equal(cancel.status, 403, "another customer's cancel never reaches the row");
  assert.equal(scheduleRows(sqlite)[0].status, "scheduled");
});

test("route: staff with customers.manage or bookings.manage cannot act as a customer, even naming the customer explicitly", async () => {
  const { sqlite } = await routeWorld();
  for (const email of [MANAGER, SUPERUSER, FINANCE]) {
    assert.equal((await get("bookingId=BKG-V1", staff(email))).status, 401, `${email} GET`);
    assert.equal((await get("bookingId=BKG-V1&customerId=CON-V1", staff(email))).status, 401, `${email} GET with customerId`);
    const schedule = await post(scheduleBody({ customerId: "CON-V1", preferredAt: daytimeTomorrowIso() }), staff(email));
    assert.equal(schedule.status, 401, `${email} schedule_call`);
    assert.equal((await post({ action: "cancel_call", bookingId: "BKG-V1", customerId: "CON-V1" }, staff(email))).status, 401, `${email} cancel_call`);
  }
  assert.equal(scheduleRows(sqlite).length, 0, "no consent row was created on a customer's behalf");
  assert.equal(auditRows(sqlite).length, 0, "nothing was attributed to the customer");
});

test("route: the development preview operator cannot act as a customer", async () => {
  const { sqlite } = await routeWorld();
  await withPreviewHost(async () => {
    const { isDevelopmentPreviewRequest } = await import("../lib/development-preview.ts");
    assert.equal(isDevelopmentPreviewRequest(new Request("http://localhost/api/post-service-feedback")), true, "the preview host is really active for this test");
    assert.equal((await get("bookingId=BKG-V1&customerId=CON-V1", {}, "http://localhost")).status, 401);
    assert.equal((await post(scheduleBody({ customerId: "CON-V1", preferredAt: daytimeTomorrowIso() }), {}, "http://localhost")).status, 401);
    assert.equal((await post({ action: "cancel_call", bookingId: "BKG-V1", customerId: "CON-V1" }, {}, "http://localhost")).status, 401);
  });
  assert.equal(scheduleRows(sqlite).length, 0);
});

test("route: a provider session and an anonymous request are not customers", async () => {
  const { sqlite, provider } = await routeWorld();
  assert.equal((await get("bookingId=BKG-V1", { cookie: provider.cookie })).status, 401);
  assert.equal((await post(scheduleBody({ customerId: "CON-V1", preferredAt: daytimeTomorrowIso() }), { cookie: provider.cookie })).status, 401);
  assert.equal((await get("bookingId=BKG-V1")).status, 401);
  assert.equal((await post(scheduleBody({ customerId: "CON-V1" }))).status, 401);
  assert.equal(scheduleRows(sqlite).length, 0);
});

test("route: a revoked identity binding ends the customer's access immediately", async () => {
  const { sqlite, db, owner } = await routeWorld();
  assert.equal((await post(scheduleBody({ preferredAt: daytimeTomorrowIso() }), { cookie: owner.cookie })).status, 201);
  await revokeIdentityBinding(db, { id: owner.bindingId, actorId: "trust-safety@pawspace.in", reason: "regression: revoked binding" });
  assert.equal((await get("bookingId=BKG-V1", { cookie: owner.cookie })).status, 401);
  assert.equal((await post({ action: "cancel_call", bookingId: "BKG-V1" }, { cookie: owner.cookie })).status, 401);
  assert.equal((await post(scheduleBody({ preferredAt: daytimeTomorrowIso() }), { cookie: owner.cookie })).status, 401);
  assert.equal(scheduleRows(sqlite)[0].status, "scheduled", "the existing row is untouched by the refused calls");
});

test("route: synthetic dispatch needs a real staff identity with the voice permissions and the non-production gate", async () => {
  const { sqlite, owner } = await routeWorld();
  assert.equal((await post(scheduleBody({ preferredAt: daytimeTomorrowIso() }), { cookie: owner.cookie })).status, 201);
  assert.equal((await post({ action: "dispatch_due" }, { cookie: owner.cookie })).status, 403, "a customer session holds no voice permissions");
  assert.equal((await post({ action: "dispatch_due" }, staff(FINANCE))).status, 403, "finance holds neither permission");
  assert.equal((await post({ action: "dispatch_due" })).status, 401, "anonymous");
  await withPreviewHost(async () => {
    assert.equal((await post({ action: "dispatch_due" }, {}, "http://localhost")).status, 403, "the preview operator is refused even though it holds *");
  });
  globalThis.__PSFC_ENV__ = { ...ROUTE_ENV, PAWSPACE_DEPLOYMENT_ENV: "" };
  const gated = await post({ action: "dispatch_due" }, staff(SUPERUSER));
  assert.equal(gated.status, 403);
  assert.equal((await gated.json()).code, "synthetic_dispatch_not_permitted");
  globalThis.__PSFC_ENV__ = { ...ROUTE_ENV, PAWSPACE_DEPLOYMENT_ENV: "production" };
  assert.equal((await post({ action: "dispatch_due" }, staff(SUPERUSER))).status, 403, "a production deployment marker fails closed");
  globalThis.__PSFC_ENV__ = { ...ROUTE_ENV };
  const run = await post({ action: "dispatch_due" }, staff(SUPERUSER));
  assert.equal(run.status, 200, JSON.stringify(await run.clone().json()));
  const { data } = await run.json();
  assert.equal(data.placer, "route_synthetic_no_dial");
  assert.equal(data.scanned, 0, "the customer's call is tomorrow, so nothing is due yet; the sweep ran and placed nothing");
  assert.equal(voiceOrders(sqlite), 0);
  assert.equal(scheduleRows(sqlite)[0].status, "scheduled");
  const audits = auditRows(sqlite).filter(row => row.action === "post_service_feedback.call.dispatch");
  assert.deepEqual(audits.map(row => [row.actor_email, row.outcome]), [[SUPERUSER, "denied"], [SUPERUSER, "denied"], [SUPERUSER, "completed"]]);
});
