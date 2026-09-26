/*
 * QA M1, made usable before it is switched on for staging: the booked-time window for arrive/start, and the
 * Operations "Authorise early/late start" override.
 *
 * What was wrong:
 *   - Once granted, an override lasted for the life of the booking. The route looked for ANY
 *     service_window_override_authorised event, so a reschedule to another day kept the old exception and the
 *     groomer could arrive and start at any time on the new day too.
 *   - Operations could not see who authorised an override or when (the provider bundle hides staff emails),
 *     and the gateway let any bookings.view caller through to an action the route then refused.
 *   - Only the pure window function was tested; the route's enforcement and override had no tests at all.
 *
 * Now the override is stored with the booked start it was granted for and applies only while the booking still
 * starts then and has not been rescheduled since (a move away and back to the same time also ends it). Every case drives the real route handlers (scheduling, booking, signature-verified sandbox
 * capture, GPS route, change route, lifecycle route) on in-memory node:sqlite through the journey harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { fixtureChecklist } from "./helpers/partner-checklist-fixture.mjs";

const LIFECYCLE_MODULE = "../app/api/grooming-lifecycle/route.ts";
const CHANGE_ROUTE = "../../app/api/grooming-booking-change/route.ts";
const windowLib = await import("../lib/grooming-service-window.ts");
const MANAGER = "ops.manager@pawspace.test", ASSOCIATE = "ops.associate@pawspace.test";
const REASON = "UAT tester running the lifecycle ahead of the booked slot";
const IST_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

/** Calls the lifecycle route as a signed-in staff member (workspace identity) or with a session cookie. */
async function lifecycleCall(method, { email, cookie, body, query = "" }) {
  const route = await import(LIFECYCLE_MODULE);
  const headers = { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : { "oai-authenticated-user-email": email, "oai-authenticated-user-full-name": encodeURIComponent(email.split("@")[0]), "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" }) };
  const response = await route[method](new Request(`https://uat.pawspace.in/api/grooming-lifecycle${query}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { status: response.status, body: await response.json() };
}

/** A paid Grooming booking at 09:00 IST `daysAhead` days out, with a manager (bookings.manage) and an associate (bookings.view only) provisioned. */
async function bookedJob(t, id, { enforcement, daysAhead = 2 }) {
  const ctx = await setupJourney(); t.after(ctx.close);
  if (enforcement) Object.assign(globalThis.__GROOM_GOLDEN_ENV__, { PAWSPACE_SERVICE_WINDOW_ENFORCEMENT: enforcement });
  const now = Date.now();
  ctx.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-SW-MGR',?,'Ops manager','manager','active',?,?)").run(MANAGER, now, now);
  ctx.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-SW-ASC',?,'Ops associate','associate','active',?,?)").run(ASSOCIATE, now, now);
  const start = new Date(Date.now() + daysAhead * 86_400_000); start.setUTCHours(3, 30, 0, 0); // 09:00 IST
  const config = { customerId: `CUST-SW-${id}`, customerName: "Mira", phone: "+919900000616", petSourceId: `PET-SW-${id}`, petName: "Milo", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: `GROOM-SW-${id}`, start: start.toISOString(), stopAfterCapture: true };
  const result = await runCompletedJourney(ctx, config);
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(result.bookingId).status, "captured");
  const { bookingId, provider } = result;
  const providerCookie = await sessionCookie(ctx.db, "provider", provider.id, `provider:${provider.id}`);
  const latitude = Number(result.location.body.data.latitude), longitude = Number(result.location.body.data.longitude);
  const step = action => lifecycleCall("POST", { cookie: providerCookie, body: { bookingId, action, checklist: fixtureChecklist(action) } });
  const gps = async () => { const capturedAt = Date.now(); const fix = await routeCall("../../app/api/grooming-route/route.ts", "POST", "/api/grooming-route", { bookingId, providerId: provider.id, latitude, longitude, accuracyMeters: 10, capturedAt, idempotencyKey: `sw:${bookingId}:${capturedAt}:${Math.random()}` }, providerCookie); assert.equal(fix.status, 201, JSON.stringify(fix.body)); };
  const authorise = (email, reason = REASON) => lifecycleCall("POST", { email, body: { bookingId, action: "authorise_service_window", reason } });
  const windowView = (options) => lifecycleCall("GET", { ...options, query: `?bookingId=${encodeURIComponent(bookingId)}&view=service_window` });
  const status = () => ctx.sqlite.prepare("SELECT b.status booking,w.status work,b.scheduled_start FROM canonical_bookings b JOIN provider_work_orders w ON w.booking_id=b.id WHERE b.id=?").get(bookingId);
  const overrideEvents = () => ctx.sqlite.prepare("SELECT actor_id,detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type='service_window_override_authorised' ORDER BY occurred_at").all(bookingId).map(row => ({ actor: row.actor_id, ...JSON.parse(row.detail_json) }));
  // A reschedule that keeps the groomer leaves the booking 'assigned', so accept is only needed before one.
  const onTheWay = async () => { for (const action of status().booking === "assigned" ? ["on_the_way"] : ["accept", "on_the_way"]) { const moved = await step(action); assert.equal(moved.status, 200, `${action}: ${JSON.stringify(moved.body)}`); } };
  const earlyMessage = startIso => { const day = IST_DAY.format(Date.parse(startIso)); return `This job starts ${day}, 9:00 am IST. You can mark arrival or start from ${day}, 8:00 am IST.`; };
  return { ...ctx, result, config, bookingId, provider, providerCookie, start: start.toISOString(), step, gps, authorise, windowView, status, overrideEvents, onTheWay, earlyMessage };
}

test("enforcement off: booking two days out, arrive and start at once work exactly as before", async t => {
  const job = await bookedJob(t, "OFF", {});
  await job.onTheWay(); await job.gps();
  const arrived = await job.step("arrived");
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  const started = await job.step("start_service");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual({ booking: job.status().booking, work: job.status().work }, { booking: "in_service", work: "in_service" });
});

test("enforcement off: Ops is told the window is not switched on, and an authorisation is still recorded", async t => {
  const job = await bookedJob(t, "OFFVIEW", {});
  const view = await job.windowView({ email: MANAGER });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.serviceWindow.enforced, false);
  assert.equal(view.body.serviceWindow.override, null);
  assert.equal((await job.authorise(MANAGER)).status, 200);
  assert.equal((await job.windowView({ email: MANAGER })).body.serviceWindow.override.authorisedBy, MANAGER);
});

test("enforcement on: arrive two days early is refused with the IST message and nothing moves", async t => {
  const job = await bookedJob(t, "ON", { enforcement: "on" });
  await job.onTheWay(); await job.gps();
  const arrived = await job.step("arrived");
  assert.equal(arrived.status, 409, JSON.stringify(arrived.body));
  assert.equal(arrived.body.code, "outside_service_window");
  assert.equal(arrived.body.error, job.earlyMessage(job.start));
  assert.equal(arrived.body.overrideForEarlierTime, false);
  assert.deepEqual({ booking: job.status().booking, work: job.status().work }, { booking: "on_the_way", work: "on_the_way" });
  const view = await job.windowView({ email: MANAGER });
  assert.equal(view.body.serviceWindow.enforced, true);
  assert.equal(view.body.serviceWindow.opensAt, Date.parse(job.start) - 60 * 60_000);
  assert.equal(view.body.serviceWindow.closesAt, Date.parse(job.start) + 120 * 60_000);
});

test("enforcement on: start service is window-checked on its own, even after an arrival", async t => {
  const job = await bookedJob(t, "START", {});
  await job.onTheWay(); await job.gps();
  assert.equal((await job.step("arrived")).status, 200, "arrived while the window was not enforced");
  globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_SERVICE_WINDOW_ENFORCEMENT = "on";
  const started = await job.step("start_service");
  assert.equal(started.status, 409, JSON.stringify(started.body));
  assert.equal(started.body.code, "outside_service_window");
  assert.equal(started.body.error, job.earlyMessage(job.start));
  assert.equal(job.status().booking, "arrived");
});

test("a bookings.manage user authorises an early start: who and when are recorded, then arrive and start succeed", async t => {
  const job = await bookedJob(t, "OVR", { enforcement: "on" });
  const before = Date.now();
  const granted = await job.authorise(MANAGER);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const override = granted.body.serviceWindowOverride;
  assert.equal(override.authorisedBy, MANAGER);
  assert.ok(override.authorisedAt >= before && override.authorisedAt <= Date.now(), "authorised now");
  assert.equal(override.reason, REASON);
  assert.equal(override.scheduledStart, job.start, "tied to the booked start");
  assert.deepEqual(job.overrideEvents(), [{ actor: MANAGER, providerId: job.provider.id, reason: REASON, scheduledStart: job.start }]);
  const audit = job.sqlite.prepare("SELECT actor_email,outcome,detail_json FROM security_audit_events WHERE action='grooming.authorise_service_window' AND resource_id=?").get(job.bookingId);
  assert.equal(audit.outcome, "completed");
  assert.equal(JSON.parse(audit.detail_json).scheduledStart, job.start);

  const view = await job.windowView({ email: MANAGER });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual(view.body.serviceWindow.override, { authorisedBy: MANAGER, authorisedAt: override.authorisedAt, reason: REASON, scheduledStart: job.start });
  assert.deepEqual(view.body.serviceWindow.earlierOverrides, []);
  const providerBundle = await lifecycleCall("GET", { cookie: job.providerCookie, query: `?bookingId=${job.bookingId}` });
  assert.equal(providerBundle.status, 200, JSON.stringify(providerBundle.body));
  assert.doesNotMatch(JSON.stringify(providerBundle.body), /ops\.manager@pawspace\.test/, "the groomer never sees the staff email");

  await job.onTheWay(); await job.gps();
  const arrived = await job.step("arrived");
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  const started = await job.step("start_service");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(job.status().booking, "in_service");
});

test("an override granted before a reschedule no longer applies after it; a fresh one does", async t => {
  const job = await bookedJob(t, "RESCHED", { enforcement: "on", daysAhead: 3 });
  assert.equal((await job.authorise(MANAGER)).status, 200);
  const target = new Date(Date.parse(job.start) + 86_400_000).toISOString();
  const moved = await routeCall(CHANGE_ROUTE, "POST", "/api/grooming-booking-change", { bookingId: job.bookingId, customerId: job.config.customerId, action: "reschedule", reason: "Customer needs another day", scheduledStart: target, scheduledEnd: new Date(Date.parse(target) + 7_200_000).toISOString() }, job.result.customerCookie);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(job.status().scheduled_start, target);

  await job.onTheWay(); await job.gps();
  const refused = await job.step("arrived");
  assert.equal(refused.status, 409, `the old override must not let the groomer arrive on the new day: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.code, "outside_service_window");
  assert.ok(refused.body.error.startsWith(job.earlyMessage(target)), refused.body.error);
  assert.match(refused.body.error, / The early or late start authorised earlier does not cover the time this job is booked for now; ask operations to authorise it again\.$/);
  assert.equal(refused.body.overrideForEarlierTime, true);
  assert.equal(job.status().booking, "on_the_way");

  const view = await job.windowView({ email: MANAGER });
  assert.equal(view.body.serviceWindow.override, null, "nothing is authorised for the new booked time");
  assert.equal(view.body.serviceWindow.earlierOverrides.length, 1);
  assert.equal(view.body.serviceWindow.earlierOverrides[0].scheduledStart, job.start);
  assert.equal(view.body.serviceWindow.earlierOverrides[0].authorisedBy, MANAGER);

  const again = await job.authorise(MANAGER, "Tester still running the lifecycle after the reschedule");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.serviceWindowOverride.scheduledStart, target);
  await job.gps();
  const arrived = await job.step("arrived");
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  assert.equal((await job.step("start_service")).status, 200);
});

test("moving the booking away and back to the same time still ends the override: the reschedule, not the clock time, is what counts", async t => {
  const job = await bookedJob(t, "BACK", { enforcement: "on", daysAhead: 3 });
  assert.equal((await job.authorise(MANAGER)).status, 200);
  const reschedule = async (startIso, reason) => {
    const moved = await routeCall(CHANGE_ROUTE, "POST", "/api/grooming-booking-change", { bookingId: job.bookingId, customerId: job.config.customerId, action: "reschedule", reason, scheduledStart: startIso, scheduledEnd: new Date(Date.parse(startIso) + 7_200_000).toISOString() }, job.result.customerCookie);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
  };
  await reschedule(new Date(Date.parse(job.start) + 86_400_000).toISOString(), "Customer needs another day");
  await reschedule(job.start, "Customer can make the first day after all");
  assert.equal(Date.parse(job.status().scheduled_start), Date.parse(job.start), "back on the originally authorised booked time");

  await job.onTheWay(); await job.gps();
  const refused = await job.step("arrived");
  assert.equal(refused.status, 409, `an override from before two reschedules must not come back to life: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.code, "outside_service_window");
  assert.equal(refused.body.overrideForEarlierTime, true);
  const view = await job.windowView({ email: MANAGER });
  assert.equal(view.body.serviceWindow.override, null);
  assert.deepEqual(view.body.serviceWindow.earlierOverrides.map(item => item.scheduledStart), [job.start]);

  assert.equal((await job.authorise(MANAGER, "Re-authorised after the booking came back to its first time")).status, 200);
  const covered = await job.windowView({ email: MANAGER });
  assert.equal(covered.body.serviceWindow.override.reason, "Re-authorised after the booking came back to its first time");
  assert.equal(covered.body.serviceWindow.earlierOverrides.length, 1, "the pre-reschedule authorisation stays listed as no longer applying");
  await job.gps();
  assert.equal((await job.step("arrived")).status, 200);
  assert.equal((await job.step("start_service")).status, 200);
});

test("without bookings.manage the override is refused, records nothing, and the window still holds", async t => {
  const job = await bookedJob(t, "DENY", { enforcement: "on" });
  const associate = await job.authorise(ASSOCIATE);
  assert.equal(associate.status, 403, JSON.stringify(associate.body));
  const groomer = await lifecycleCall("POST", { cookie: job.providerCookie, body: { bookingId: job.bookingId, action: "authorise_service_window", reason: REASON } });
  assert.equal(groomer.status, 403, "the groomer cannot authorise their own early start");
  const shortReason = await job.authorise(MANAGER, "too short");
  assert.equal(shortReason.status, 400);
  assert.match(shortReason.body.error, /at least 10 characters/);
  assert.deepEqual(job.overrideEvents(), []);
  assert.equal((await job.windowView({ email: ASSOCIATE })).status, 403, "who authorised is an Ops read");
  assert.equal((await job.windowView({ cookie: job.providerCookie })).status, 403);

  await job.onTheWay(); await job.gps();
  const arrived = await job.step("arrived");
  assert.equal(arrived.status, 409);
  assert.equal(arrived.body.code, "outside_service_window");
});

test("the gateway asks for bookings.manage exactly where the route does", async () => {
  const { requiredPermission } = await import("../lib/api-gateway.ts");
  const post = action => requiredPermission(new Request("https://uat.pawspace.in/api/grooming-lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: "BK-1", action }) }));
  assert.equal(await post("authorise_service_window"), "bookings.manage");
  assert.equal(await post("arrived"), "bookings.view");
  assert.equal(await requiredPermission(new Request("https://uat.pawspace.in/api/grooming-lifecycle?bookingId=BK-1&view=service_window")), "bookings.manage");
  assert.equal(await requiredPermission(new Request("https://uat.pawspace.in/api/grooming-lifecycle?bookingId=BK-1")), "bookings.view");
});

test("an override matches the booked instant, not its spelling, and one stored without a start never applies", () => {
  const { serviceWindowOverrides } = windowLib;
  assert.equal(typeof serviceWindowOverrides, "function");
  const rows = [
    { actor_id: "legacy@pawspace.test", occurred_at: 3, detail_json: JSON.stringify({ reason: "Granted before starts were stored" }) },
    { actor_id: "a@pawspace.test", occurred_at: 1, detail_json: JSON.stringify({ reason: "Old slot", scheduledStart: "2026-09-28T03:30:00.000Z" }) },
    { actor_id: "b@pawspace.test", occurred_at: 2, detail_json: JSON.stringify({ reason: "New slot", scheduledStart: "2026-09-29T09:00:00+05:30" }) },
  ];
  const state = serviceWindowOverrides(rows, "2026-09-29T03:30:00.000Z");
  assert.equal(state.current.authorisedBy, "b@pawspace.test");
  assert.deepEqual(state.earlier.map(item => item.authorisedBy), ["legacy@pawspace.test", "a@pawspace.test"]);
  assert.equal(serviceWindowOverrides(rows.slice(0, 1), "2026-09-28T03:30:00.000Z").current, null);
  // A reschedule after the override ends it even when the booked time is the same instant again; one before it does not.
  assert.equal(serviceWindowOverrides(rows, "2026-09-29T03:30:00.000Z", 5).current, null);
  assert.equal(serviceWindowOverrides(rows, "2026-09-29T03:30:00.000Z", 5).earlier.length, 3);
  assert.equal(serviceWindowOverrides(rows, "2026-09-29T03:30:00.000Z", 2).current.authorisedBy, "b@pawspace.test", "granted in the same millisecond as the move, for the new time");
  assert.equal(serviceWindowOverrides(rows, "2026-09-29T03:30:00.000Z", 1).current.authorisedBy, "b@pawspace.test");
  // Two authorisations for the same booked time: the newer one applies and the older is not listed as "no longer applies".
  const twice = [...rows, { actor_id: "c@pawspace.test", occurred_at: 4, detail_json: JSON.stringify({ reason: "Again, same slot", scheduledStart: "2026-09-29T03:30:00.000Z" }) }];
  const repeated = serviceWindowOverrides(twice, "2026-09-29T03:30:00.000Z");
  assert.equal(repeated.current.authorisedBy, "c@pawspace.test");
  assert.deepEqual(repeated.earlier.map(item => item.authorisedBy), ["legacy@pawspace.test", "a@pawspace.test"]);
});
