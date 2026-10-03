import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, ALLOWLISTED_PHONE, OTHER_PHONE } from "./helpers/voice-harness.mjs";

/*
 * Merged-integration acceptance for the post-service feedback slice (PR #1261), executed against the
 * real route and module on node:sqlite with verified platform sessions.
 *
 * Regression F1: a customer who cancelled a feedback call and then asked for the SAME minute again was
 * answered 200 {scheduled:false, duplicatePrevented:true} with no row created, the route audited a
 * completed schedule, and the screen's success branch would have said a call was scheduled. The
 * module now refuses that minute (409 time_already_used) once the earlier request is no longer live,
 * while a replay of a still-live request keeps answering with the existing row.
 */
installWorkersHooks("__PSFC_ACCEPT_DB__", "__PSFC_ACCEPT_ENV__");
const mod = await import("../lib/post-service-feedback-call.ts");
const gov = await import("../lib/voice-outbound-governance.ts");
const commGov = await import("../lib/communication-governance.ts");
const engine = await import("../lib/communication-engine.ts");
const auth = await import("../lib/server-auth.ts");
const bindings = await import("../lib/identity-binding.ts");
const sessions = await import("../lib/platform-session.ts");
const route = await import("../app/api/post-service-feedback/route.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const HOUR = 3_600_000, MINUTE = 60_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 5, 8, 30);
/** Fixture values for the module-level checks: synthetic, not business policy. */
const FIXTURE_POLICY = { maxHorizonMs: 14 * DAY, dispatchWindowMs: 90 * MINUTE, source: "acceptance_fixture_policy" };
const ORIGIN = "https://ops.pawspace.example";
const ROUTE_ENV = { APP_ENV: "staging", PAWSPACE_DEPLOYMENT_ENV: "staging", FORBID_PRODUCTION: "true", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_HORIZON_HOURS: "336", PAWSPACE_POST_SERVICE_FEEDBACK_CALL_DISPATCH_WINDOW_MINUTES: "90" };

async function sessionCookie(db, subjectType, subjectId, principalKey) {
  const identitySource = subjectType === "customer" ? "customer_otp" : "partner_otp";
  await bindings.upsertIdentityBinding(db, { identitySource, principalType: "identity_subject", principalKey, subjectType, subjectId, verificationState: "verified", actorId: "qa", reason: "acceptance" });
  const binding = await bindings.findIdentityBinding(db, { identitySource, principalType: "identity_subject", principalKey, subjectType });
  const issued = await sessions.issuePlatformSession(db, { bindingId: String(binding.id), identitySource, principalType: "identity_subject", principalKey, subjectType, subjectId });
  return `${sessions.PLATFORM_SESSION_COOKIE}=${encodeURIComponent(String(issued.token ?? issued.sessionToken))}`;
}

async function world(envOverrides = {}) {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__PSFC_ACCEPT_DB__ = db;
  globalThis.__PSFC_ACCEPT_ENV__ = { DB: db, ...ROUTE_ENV, ...envOverrides };
  await gov.ensureVoiceCallTables(db);
  seedRecipient(sqlite); // CON-V1 owns BKG-V1 on the allow-listed phone
  sqlite.prepare("UPDATE canonical_bookings SET status='completed',service_code='grooming',city_id='blr',provider_id='PROV-1' WHERE id='BKG-V1'").run();
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,primary_phone,secondary_phone,consent_json) VALUES ('CON-OTHER',?,NULL,NULL)").run(OTHER_PHONE);
  await engine.seedCommunicationPolicy(db);
  sqlite.prepare("INSERT INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES ('CON-V1',1,0,'voice','Asia/Kolkata','test',1)").run();
  await commGov.ensureCommunicationGovernance(db);
  sqlite.prepare("INSERT INTO communication_consent (customer_id,global_opt_out,whatsapp_allowed,email_allowed,voice_allowed,sms_allowed,source,updated_by,updated_at) VALUES ('CON-V1',0,1,1,1,1,'test','qa',1)").run();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "customer_app_settings", actorId: "qa", asOf: NOW - HOUR });
  await mod.ensurePostServiceFeedbackTables(db);
  await auth.ensureSecurityTables(db);
  await bindings.ensureIdentityBindingTables(db);
  const owner = await sessionCookie(db, "customer", "CON-V1", "9000000111");
  const other = await sessionCookie(db, "customer", "CON-OTHER", "9000000112");
  const provider = await sessionCookie(db, "provider", "PROV-1", "9000000221");
  const post = (body, cookie = owner, origin = ORIGIN) => route.POST(new Request(`${origin}/api/post-service-feedback`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: JSON.stringify(body) }));
  const get = (query, cookie = owner, origin = ORIGIN) => route.GET(new Request(`${origin}/api/post-service-feedback?${query}`, { headers: cookie ? { cookie } : {} }));
  const body = async (response) => ({ status: response.status, ...(await response.json()) });
  const rows = () => sqlite.prepare("SELECT id,status,scheduled_for,outcome FROM post_service_feedback_calls ORDER BY created_at").all().map((row) => ({ ...row }));
  const audits = () => sqlite.prepare("SELECT action,outcome,detail_json FROM security_audit_events WHERE action LIKE 'post_service_feedback.%' ORDER BY created_at").all().map((row) => ({ ...row }));
  const schedule = (preferredAt, cookie = owner, extra = {}) => post({ action: "schedule_call", bookingId: "BKG-V1", preferredAt, consentConfirmed: true, ...extra }, cookie);
  return { sqlite, db, owner, other, provider, post, get, body, rows, audits, schedule };
}

/** 26 hours ahead on the real clock, shifted into IST daytime so the seeded quiet hours never apply. */
function daytimeTomorrowIso(offsetMinutes = 0) {
  const probe = new Date(Date.now() + 26 * HOUR + offsetMinutes * MINUTE);
  const istHour = (probe.getUTCHours() + 5 + (probe.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
  const shift = istHour >= 21 ? (24 - istHour + 10) : istHour < 9 ? (10 - istHour) : 0;
  return new Date(probe.getTime() + shift * HOUR).toISOString();
}

test("F1 regression: after cancelling, the same minute is refused as used instead of reported as scheduled", async () => {
  const w = await world();
  const when = daytimeTomorrowIso();
  const first = await w.body(await w.schedule(when));
  assert.equal(first.status, 201, JSON.stringify(first));
  const cancelled = await w.body(await w.post({ action: "cancel_call", bookingId: "BKG-V1" }));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.cancelled, true);

  const again = await w.body(await w.schedule(when));
  assert.equal(again.status, 409, JSON.stringify(again));
  assert.equal(again.code, "time_already_used");
  assert.ok(!("data" in again), "no success payload for a request that scheduled nothing");
  assert.deepEqual(w.rows().map((row) => row.status), ["cancelled"], "no row was created and the cancelled one is untouched");
  const scheduleAudits = w.audits().filter((row) => row.action === "post_service_feedback.call.schedule");
  assert.equal(scheduleAudits.length, 1, "only the real schedule was audited as completed");
  const view = await w.body(await w.get("bookingId=BKG-V1"));
  assert.equal(view.status, 200);
  assert.equal(view.data.call.existing, null, "nothing is scheduled");
  assert.equal(view.data.call.eligible, true, "the customer may still ask for another minute");

  const another = await w.body(await w.schedule(daytimeTomorrowIso(1)));
  assert.equal(another.status, 201, JSON.stringify(another));
  assert.equal(another.data.scheduled, true);
  assert.deepEqual(w.rows().map((row) => row.status), ["cancelled", "scheduled"]);
  assert.equal((await w.body(await w.get("bookingId=BKG-V1"))).data.call.existing.id, another.data.schedule.id);
});

test("a replay of a still-live request keeps answering with the existing row, and one live request per booking holds", async () => {
  const w = await world();
  // Floored to the minute so the +30s replay below stays inside the same minute.
  const when = new Date(Math.floor(Date.parse(daytimeTomorrowIso()) / MINUTE) * MINUTE).toISOString();
  const first = await w.body(await w.schedule(when));
  assert.equal(first.status, 201);
  const replay = await w.body(await w.schedule(new Date(Date.parse(when) + 30_000).toISOString()));
  assert.equal(replay.status, 200, "a same-minute replay of a live request is a duplicate, not a new request");
  assert.equal(replay.data.duplicatePrevented, true);
  assert.equal(replay.data.scheduled, true);
  assert.equal(replay.data.schedule.id, first.data.schedule.id);
  const other = await w.body(await w.schedule(daytimeTomorrowIso(3)));
  assert.equal(other.status, 409);
  assert.equal(other.code, "already_scheduled");
  assert.equal(w.rows().length, 1);
});

test("a closed request's minute stays used: placed, missed and simulated rows refuse the same minute at module level", async () => {
  const { db, sqlite } = await world();
  // Module-level with the fixture clock, so the terminal statuses can be set without a sweep.
  for (const [status, minute] of [["cancelled", 0], ["simulated", 1], ["missed", 2], ["placed", 3]]) {
    const at = NOW + 3 * HOUR + minute * MINUTE;
    const created = await mod.scheduleFeedbackCall(db, { bookingId: "BKG-V1", customerId: "CON-V1", actorId: "CON-V1", consentConfirmed: true, policy: FIXTURE_POLICY, asOf: NOW, preferredAt: at });
    assert.equal(created.scheduled, true, status);
    sqlite.prepare("UPDATE post_service_feedback_calls SET status=?,outcome='acceptance' WHERE id=?").run(status, created.schedule.id);
    await assert.rejects(
      mod.scheduleFeedbackCall(db, { bookingId: "BKG-V1", customerId: "CON-V1", actorId: "CON-V1", consentConfirmed: true, policy: FIXTURE_POLICY, asOf: NOW, preferredAt: at + 10_000 }),
      (error) => error.code === "time_already_used" && error.status === 409,
      `${status}: the used minute is refused`,
    );
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM post_service_feedback_calls").get().n, 4, "no extra rows were created by the refusals");
  // A dispatching row is still live: the replay answers with it rather than refusing.
  const live = await mod.scheduleFeedbackCall(db, { bookingId: "BKG-V1", customerId: "CON-V1", actorId: "CON-V1", consentConfirmed: true, policy: FIXTURE_POLICY, asOf: NOW, preferredAt: NOW + 5 * HOUR });
  sqlite.prepare("UPDATE post_service_feedback_calls SET status='dispatching' WHERE id=?").run(live.schedule.id);
  const replay = await mod.scheduleFeedbackCall(db, { bookingId: "BKG-V1", customerId: "CON-V1", actorId: "CON-V1", consentConfirmed: true, policy: FIXTURE_POLICY, asOf: NOW, preferredAt: NOW + 5 * HOUR });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.scheduled, false, "dispatching is live but not 'scheduled'");
  assert.equal(replay.schedule.id, live.schedule.id);
});

test("after the one allowed synthetic attempt, every further request is refused and nothing is dialled", async () => {
  const w = await world();
  const when = daytimeTomorrowIso();
  const first = await w.body(await w.schedule(when));
  assert.equal(first.status, 201);
  const sweep = await mod.dispatchPostServiceFeedbackTestCalls(w.db, { placer: mod.syntheticFeedbackCallPlacer("acceptance_no_dial"), policy: FIXTURE_POLICY, asOf: first.data.schedule.scheduledFor + MINUTE, actorId: "acceptance" });
  assert.equal(sweep.simulated, 1);
  assert.equal(sweep.placed, 0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM voice_call_orders").get().n, 0, "no voice order exists: nothing was dialled");
  for (const preferredAt of [when, daytimeTomorrowIso(9)]) {
    const refused = await w.body(await w.schedule(preferredAt));
    assert.equal(refused.status, 409, JSON.stringify(refused));
    assert.equal(refused.code, "attempts_exhausted");
  }
  const view = await w.body(await w.get("bookingId=BKG-V1"));
  assert.equal(view.data.call.eligible, false);
  assert.deepEqual(view.data.call.reasons, ["attempts_exhausted"]);
  assert.equal(view.data.call.existing, null);
});

test("concurrent requests for different minutes through the route leave one live row and one explicit refusal", async () => {
  const w = await world();
  let competitor;
  w.db.onSql("INSERT INTO post_service_feedback_calls", async () => { competitor = await w.body(await w.schedule(daytimeTomorrowIso(7))); });
  const original = await w.body(await w.schedule(daytimeTomorrowIso()));
  assert.ok(competitor, "the competing request ran inside the gap");
  assert.deepEqual([original.status, competitor.status].sort(), [201, 409], JSON.stringify({ original, competitor }));
  assert.equal((original.status === 409 ? original : competitor).code, "already_scheduled");
  assert.equal(w.rows().length, 1);
  assert.equal(w.rows()[0].status, "scheduled");
});

test("customer actions bind to the verified customer session only: forged customerId, another customer, a provider session, no session and the preview host are refused", async () => {
  const w = await world();
  const when = daytimeTomorrowIso();
  assert.equal((await w.body(await w.get("bookingId=BKG-V1&customerId=CON-OTHER"))).status, 403, "forged customerId on the owner's own session");
  assert.equal((await w.body(await w.schedule(when, w.owner, { customerId: "CON-OTHER" }))).status, 403);
  assert.equal((await w.body(await w.get("bookingId=BKG-V1", w.other))).status, 403, "another verified customer");
  assert.equal((await w.body(await w.schedule(when, w.other))).status, 403);
  assert.equal((await w.body(await w.get("bookingId=BKG-V1", w.provider))).status, 401, "a provider session is not a customer");
  assert.equal((await w.body(await w.schedule(when, w.provider))).status, 401);
  assert.equal((await w.body(await w.get("bookingId=BKG-V1", ""))).status, 401, "anonymous");
  assert.equal((await w.body(await w.get("bookingId=BKG-V1&customerId=CON-V1", "", "http://localhost"))).status, 401, "the preview superuser host is not a customer");
  assert.equal((await w.body(await w.schedule(when, "", { customerId: "CON-V1" }))).status, 401);
  assert.equal(w.rows().length, 0);
  assert.equal(w.audits().length, 0, "refusals before the principal is known write no customer audit");
});

test("synthetic dispatch is default-off and refuses production-shaped runtimes, with the preview operator refused even with the switch on", async () => {
  assert.equal(mod.syntheticDispatchPermitted({ ...ROUTE_ENV }), false, "no switch, no dispatch");
  assert.equal(mod.syntheticDispatchPermitted({ ...ROUTE_ENV, PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "on" }), true, "staging + forbid-production + switch");
  for (const overrides of [{ APP_ENV: "production" }, { PAWSPACE_DEPLOYMENT_ENV: "production" }, { FORBID_PRODUCTION: "false" }, { PAWSPACE_VOICE_ENV: "live" }, { NODE_ENV: "production" }, { APP_ENV: "" }, { PAWSPACE_DEPLOYMENT_ENV: "" }]) {
    assert.equal(mod.syntheticDispatchPermitted({ ...ROUTE_ENV, PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "on", ...overrides }), false, JSON.stringify(overrides));
  }
  const w = await world({ PAWSPACE_POST_SERVICE_FEEDBACK_CALL_TEST_DISPATCH: "on" });
  const previous = process.env.PAWSPACE_LOCAL_PREVIEW;
  process.env.PAWSPACE_LOCAL_PREVIEW = "on";
  try {
    const preview = await w.body(await w.post({ action: "dispatch_due" }, "", "http://localhost"));
    assert.equal(preview.status, 403, JSON.stringify(preview));
  } finally { if (previous === undefined) delete process.env.PAWSPACE_LOCAL_PREVIEW; else process.env.PAWSPACE_LOCAL_PREVIEW = previous; }
  const customer = await w.body(await w.post({ action: "dispatch_due" }));
  assert.ok(customer.status === 401 || customer.status === 403, `a customer session may not run the sweep: ${JSON.stringify(customer)}`);
});

test("server-rendered screen evidence: the invitation mounts only behind a known customer identity and starts in its loading state", async () => {
  const Invitation = (await import("../app/mobile-app/post-service-review-invitation.tsx")).default;
  const Feedback = (await import("../app/mobile-app/booking-service-feedback.tsx")).default;
  const invitation = renderToStaticMarkup(React.createElement(Invitation, { bookingId: "BKG-V1", customerId: "CON-V1" }));
  assert.match(invitation, /aria-label="Share an honest review"/);
  assert.match(invitation, /Loading review options/);
  assert.ok(!/href=/.test(invitation), "no link is rendered before the approved configuration has been read");
  assert.equal(renderToStaticMarkup(React.createElement(Feedback, { bookingId: "BKG-V1", completed: false })), "", "nothing renders for an incomplete service");
  const completed = renderToStaticMarkup(React.createElement(Feedback, { bookingId: "BKG-V1", completed: true }));
  assert.match(completed, /No pending feedback request is available/);
  assert.ok(!/Share an honest review/.test(completed), "the invitation is not mounted until the customer identity has resolved");
});
