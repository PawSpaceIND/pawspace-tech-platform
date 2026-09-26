/*
 * Owner decision, 26 Sept 2026 (work package G): the M2 GPS speed rule, part 2 - its bypasses and edge cases.
 *
 * The first version of M2 compared a new fix with the last trusted fix by DEVICE time only, and only on the
 * Grooming pipeline. Two ways round it were verified on the real code:
 *   - a phone could backdate its comparison fix by up to the 300 s freshness window, so a 10 km jump one real
 *     second later read as 120 km/h and was trusted;
 *   - /api/location-recovery record_location (recordLocationEvidence) stored accepted fixes with no speed check
 *     at all, and Grooming arrival reads those rows as evidence.
 * Elapsed time is now min(device gap, server gap + 30 s), the comparison is the newest accepted fix by
 * server_received_at inside the freshness window, and recordLocationEvidence applies the same rule.
 *
 * Everything below runs the real pipeline and SQL on the in-memory harness with a controlled server clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GPS_SPEED_BYPASS_DB__", "__GPS_SPEED_BYPASS_ENV__");
const pipeline = await import("../lib/grooming-gps-pipeline.ts");
const policy = await import("../lib/gps-telemetry-policy.ts");
const location = await import("../lib/universal-location-recovery.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");

const DOOR = { latitude: 12.9166, longitude: 77.6101 };
const north = (meters) => ({ latitude: DOOR.latitude + meters / 111_194.93, longitude: DOOR.longitude });
const actor = { email: "groomer@pawspace.test", name: "Groomer", roleCode: "provider", permissions: [], developmentPreview: false, identitySource: "partner_otp", principalType: "identity_subject", principalKey: "provider:PRV-1" };

const realNow = Date.now;
let T0 = 0, clock = 0;
function freeze(t) { T0 = realNow(); clock = T0; Date.now = () => clock; t.after(() => { Date.now = realNow; }); }
const at = (seconds) => { clock = T0 + seconds * 1000; return clock; };

async function gpsWorld(t) {
  freeze(t);
  const { sqlite, db } = world("__GPS_SPEED_BYPASS_DB__", "__GPS_SPEED_BYPASS_ENV__", {});
  await ensureSecurityTables(db);
  await location.ensureUniversalLocationTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,provider_id TEXT,service_code TEXT,city_id TEXT,status TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','PRV-1','grooming','blr','on_the_way')").run();
  // The staging values: 300 s freshness, 50 m accuracy (scripts/uat-staging-provider-capacity.sql).
  sqlite.prepare("INSERT INTO booking_punctuality_policies (id,service_code,city_id,tracking_enabled,eta_freshness_seconds,allowed_accuracy_meters,approval_state,effective_from,effective_to,approved_by,updated_at) VALUES ('POL-1','grooming',NULL,1,300,50,'approved','2020-01-01',NULL,'test',0)").run();
  return { sqlite, db };
}

/** One fix through the real Grooming pipeline (prepare + commit), received at server second `seconds`. */
async function send(db, point, seconds, { accuracy = 10, capturedAt } = {}) {
  const received = at(seconds);
  const telemetry = { bookingId: "BK-1", providerId: "PRV-1", latitude: point.latitude, longitude: point.longitude, accuracyMeters: accuracy, capturedAt: capturedAt ?? received - 500 };
  const prepared = await pipeline.prepareGroomingTelemetry(db, telemetry, actor.email);
  const response = await pipeline.commitGroomingTelemetry(db, { telemetry, prepared, destinationAddress: "Doorstep", route: null, actor, travelState: "on_the_way" });
  return { trustState: prepared.verdict.trustState, reason: prepared.verdict.reason, eventId: response.providerLocation.eventId, sessionId: prepared.sessionId };
}

test("T5: a comparison fix backdated by 299 s cannot buy a 10 km jump one real second later", async (t) => {
  const { db } = await gpsWorld(t);
  const home = await send(db, north(10_000), 0, { capturedAt: T0 - 299_000 });
  assert.equal(home.trustState, "accepted", "299 s old is still inside the freshness window, so the backdated fix is stored");
  // Device clocks say 300 s passed (10 km / 300 s is exactly 120 km/h); the server saw 1 s.
  const jump = await send(db, DOOR, 1, { capturedAt: T0 + 1_000 });
  assert.deepEqual([jump.trustState, jump.reason], ["rejected", "implausible_speed"]);
  // The pure rule, both ways round: elapsed is the device gap capped at the server gap + 30 s.
  const a = { ...north(10_000), capturedAt: -299_000, serverReceivedAt: 0 }, b = { ...DOOR, capturedAt: 1_000, serverReceivedAt: 1_000 };
  assert.equal(policy.gpsElapsedMs(a, b), 31_000);
  assert.equal(policy.implausibleGpsJump(a, b), true);
  assert.equal(policy.gpsElapsedMs({ ...a, serverReceivedAt: undefined }, { ...b, serverReceivedAt: undefined }), 300_000, "no server times: the device gap alone, as before");
});

test("T6: refused fixes never become the comparison point, and out-of-order timestamps do not throw", async (t) => {
  const { db } = await gpsWorld(t);
  assert.equal((await send(db, DOOR, 0)).trustState, "accepted");
  assert.equal((await send(db, north(9_000), 10)).reason, "implausible_speed");
  assert.equal((await send(db, north(9_000), 20, { accuracy: 500 })).trustState, "low_accuracy");
  assert.equal((await send(db, DOOR, 30)).trustState, "accepted", "compared with the accepted doorstep fix, not with the refused far ones");
  // A capture time EARLIER than the comparison fix's (a phone replaying a buffered reading): a verdict, not a throw.
  const replayNear = await send(db, north(100), 40, { capturedAt: T0 + 5_000 });
  assert.equal(replayNear.trustState, "accepted");
  const replayFar = await send(db, north(9_000), 45, { capturedAt: T0 + 6_000 });
  assert.deepEqual([replayFar.trustState, replayFar.reason], ["rejected", "implausible_speed"]);
  assert.equal(policy.implausibleGpsJump({ ...DOOR, capturedAt: 10_000 }, { ...north(100), capturedAt: 0 }), false);
  assert.equal(policy.implausibleGpsJump({ ...DOOR, capturedAt: Number.NaN }, { ...north(9_000), capturedAt: Number.NaN }), true, "unknown times are read as 1 s, not waved through");
});

test("T6: the comparison is the newest accepted fix by server receipt, and only inside the freshness window", async (t) => {
  const { db } = await gpsWorld(t);
  assert.equal((await send(db, north(12_000), 0)).trustState, "accepted");
  assert.equal((await send(db, DOOR, 60)).reason, "implausible_speed", "12 km in 60 s");
  assert.equal((await send(db, DOOR, 301)).trustState, "accepted", "the far fix is older than 300 s, so there is nothing to compare with");
});

test("T7: record_location cannot store a doorstep fix the Grooming pipeline refused, so arrival evidence stays honest", async (t) => {
  const { db } = await gpsWorld(t);
  const home = await send(db, north(7_000), 0);
  assert.equal(home.trustState, "accepted");
  at(1);
  const viaRecovery = await location.recordLocationEvidence(db, { sessionId: home.sessionId, providerId: "PRV-1", lat: DOOR.latitude, lng: DOOR.longitude, accuracyMeters: 8, clientCapturedAt: clock, actor });
  assert.deepEqual([viaRecovery.trustState, viaRecovery.rejectionReason], ["rejected", "implausible_speed"]);
  const trusted = await pipeline.latestTrustedGroomingObservation(db, "BK-1", "PRV-1");
  assert.equal(trusted.ok, true);
  assert.equal(trusted.evidence.id, home.eventId, "the refused doorstep row is not arrival evidence");
  assert.equal(policy.arrivalGeofenceVerdict(trusted.evidence, DOOR).within, false);
  // And the other way round: a fix record_location accepted is a comparison point for the pipeline.
  at(400);
  const near = await location.recordLocationEvidence(db, { sessionId: home.sessionId, providerId: "PRV-1", lat: DOOR.latitude, lng: DOOR.longitude, accuracyMeters: 8, clientCapturedAt: clock, actor });
  assert.equal(near.trustState, "accepted");
  assert.equal((await send(db, north(7_000), 401)).reason, "implausible_speed");
});

test("T7: record_location resets an isolated outlier the same way, and audits it", async (t) => {
  const { sqlite, db } = await gpsWorld(t);
  const outlier = await send(db, north(5_000), 0, { accuracy: 20 });
  const record = (seconds) => { at(seconds); return location.recordLocationEvidence(db, { sessionId: outlier.sessionId, providerId: "PRV-1", lat: DOOR.latitude, lng: DOOR.longitude, accuracyMeters: 10, clientCapturedAt: clock - 500, actor }); };
  assert.equal((await record(15)).rejectionReason, "implausible_speed");
  assert.equal((await record(30)).rejectionReason, "implausible_speed");
  const third = await record(45);
  assert.deepEqual([third.trustState, third.gpsBaselineReset], ["accepted", true]);
  const audit = sqlite.prepare("SELECT actor_email,resource_id,detail_json FROM security_audit_events WHERE action='gps_baseline_reset'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_email, actor.email);
  assert.equal(audit[0].resource_id, "BK-1");
  const detail = JSON.parse(audit[0].detail_json);
  assert.equal(detail.setAsideEventId, outlier.eventId);
  assert.equal(detail.acceptedEventId, third.id);
  assert.equal(detail.corroboratingEventIds.length, 2);
  assert.equal(detail.setAside, undefined, "event ids and a distance, not raw coordinates");
  assert.ok(Math.abs(detail.setAsideDistanceMeters - 5_000) <= 1);
});

const fix = (id, point, seconds, extra = {}) => ({ id, ...point, capturedAt: seconds * 1000, serverReceivedAt: seconds * 1000, accuracyMeters: 10, ...extra });
const refused = (id, point, seconds) => fix(id, point, seconds, { trustState: "rejected", reason: "implausible_speed" });

test("the reset needs three consistent refusals spanning 30 s, whatever the send rate", () => {
  const outlier = fix("OUT", north(5_000), 0);
  // The route card sends every 8 s: three fixes span only 16 s, so the fifth fix (40 s) is the one that resets.
  const at8 = [8, 16, 24, 32].map((s) => refused(`R${s}`, DOOR, s));
  assert.equal(policy.gpsSpeedDecision(fix("C", DOOR, 24), [outlier], at8.slice(0, 2)).outcome, "implausible", "3 fixes over 16 s");
  assert.equal(policy.gpsSpeedDecision(fix("C", DOOR, 32), [outlier], at8.slice(0, 3)).outcome, "implausible", "4 fixes over 24 s");
  const reset = policy.gpsSpeedDecision(fix("C", DOOR, 40), [outlier], at8);
  assert.equal(reset.outcome, "baseline_reset");
  assert.equal(reset.comparison.id, "OUT");
  assert.deepEqual(reset.corroborating.map((f) => f.id), ["R32", "R24", "R16", "R8"], "newest first, stopping as soon as 30 s is covered");
  assert.equal(reset.spanMs, 32_000);
  // The duty tracker sends every 15 s: the third fix already spans 30 s.
  const at15 = [15, 30].map((s) => refused(`R${s}`, DOOR, s));
  assert.equal(policy.gpsSpeedDecision(fix("C", DOOR, 45), [outlier], at15).outcome, "baseline_reset");
});

test("a comparison fix corroborated by other accepted fixes in the window is never reset", () => {
  const home = [0, 15, 30, 45, 60].map((s) => fix(`H${s}`, north(12_000), s));
  const refusals = [75, 90, 105, 120].map((s) => refused(`R${s}`, DOOR, s));
  const decision = policy.gpsSpeedDecision(fix("C", DOOR, 135), home, refusals);
  assert.equal(decision.outcome, "implausible");
  assert.equal(decision.comparison.id, "H60", "the newest accepted fix by server receipt");
});

test("refusals that disagree with each other, or predate the comparison fix, never reset it", () => {
  const outlier = fix("OUT", north(5_000), 100);
  const scattered = [refused("A", north(-3_000), 115), refused("B", DOOR, 130)];
  assert.equal(policy.gpsSpeedDecision(fix("C", DOOR, 145), [outlier], scattered).outcome, "implausible", "a 3 km swing in 15 s is not agreement");
  const stale = [refused("A", DOOR, 60), refused("B", DOOR, 80)];
  assert.equal(policy.gpsSpeedDecision(fix("C", DOOR, 145), [outlier], stale).outcome, "implausible", "refusals from before the outlier do not outvote it");
  const interrupted = [refused("B", DOOR, 130), fix("L", DOOR, 120, { trustState: "low_accuracy", reason: "accuracy_outside_approved_policy" }), refused("A", DOOR, 110)];
  assert.equal(policy.gpsSpeedDecision(fix("C", DOOR, 145), [outlier], interrupted).outcome, "implausible", "the refusals must be the latest fixes, back to back");
  assert.equal(policy.gpsSpeedDecision(fix("C", DOOR, 145), [], []).outcome, "no_comparison", "first fix of a job: never checked");
});

test("T9: the partner reads a sentence, not a token, when a fix is refused for speed", async (t) => {
  const { db } = await gpsWorld(t);
  await send(db, north(5_000), 0);
  const refusedFix = await send(db, DOOR, 15);
  assert.equal(refusedFix.reason, "implausible_speed");
  const note = policy.IMPLAUSIBLE_SPEED_NOTE;
  assert.doesNotMatch(note, /_|km\/h/, "no codes or thresholds in partner copy");
  assert.match(note, /not used/);
  assert.match(note, /30 seconds/, "tells the partner what will clear it");
  const card = readFileSync(new URL("../app/partner-app/grooming-route-card.tsx", import.meta.url), "utf8");
  const tracker = readFileSync(new URL("../app/partner-app/use-duty-tracking.ts", import.meta.url), "utf8");
  assert.match(card, new RegExp(`\\b${refusedFix.reason}:IMPLAUSIBLE_SPEED_NOTE`), "the route card maps the verdict the pipeline returned");
  assert.match(tracker, new RegExp(`rejectionReason==="${refusedFix.reason}"\\?IMPLAUSIBLE_SPEED_NOTE`), "the on-duty tracker, which sends most fixes, shows the same sentence");
});
