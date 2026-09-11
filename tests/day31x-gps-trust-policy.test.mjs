/*
 * Day-31 wave 13: the GPS trust policy behind live tracking.
 *
 * lib/gps-telemetry-policy.ts decides whether a location report from a groomer's phone is
 * trustworthy, and lib/grooming-gps-pipeline.ts only ever shows a customer an observation the
 * policy ACCEPTED. Neither had a test importing it.
 *
 * Two directions, both customer-facing:
 *
 *   too permissive - a stale or wildly inaccurate fix becomes "your groomer is 5 minutes away"
 *   when they are an hour out, or an arrival geofence fires from a point half a kilometre away
 *
 *   too strict - a perfectly good fix is discarded and the customer sees nothing at all while a
 *   groomer is genuinely on the way
 *
 * Clock skew is the interesting axis: a phone's clock is not the server's, and a device reporting
 * a capture time in the FUTURE is the signal of a tampered or badly set clock rather than a fresh
 * reading.
 */
import test from "node:test";
import assert from "node:assert/strict";

const gps = await import("../lib/gps-telemetry-policy.ts");

const NOW = Date.parse("2026-09-15T10:00:00Z");
const BENGALURU = { latitude: 12.9716, longitude: 77.5946 };

/** A good fix: on time, accurate, ingestion on. Individual fields are overridden per case. */
const observation = (over = {}) => ({
  ...BENGALURU, accuracyMeters: 20,
  clientCapturedAt: NOW - 2_000, serverReceivedAt: NOW,
  freshnessSeconds: 60, allowedAccuracyMeters: 100, gpsIngestionEnabled: true, ...over,
});

test("a good fix is accepted", async () => {
  const verdict = gps.classifyGpsObservation(observation());
  assert.equal(verdict.trustState, "accepted");
  assert.equal(verdict.reason, null);
  assert.equal(verdict.clockSkewMs, 2_000);
});

test("the kill switch stops ingestion before anything else is considered", async () => {
  const verdict = gps.classifyGpsObservation(observation({ gpsIngestionEnabled: false }));
  assert.equal(verdict.trustState, "rejected");
  assert.equal(verdict.reason, "gps_kill_switch_active");
});

test("a coordinate that is not a coordinate is rejected, not plotted", async () => {
  for (const [label, over] of [
    ["NaN latitude", { latitude: Number.NaN }],
    ["NaN longitude", { longitude: Number.NaN }],
    ["latitude past the pole", { latitude: 90.0001 }],
    ["latitude past the south pole", { latitude: -90.0001 }],
    ["longitude past the meridian", { longitude: 180.0001 }],
    ["infinite longitude", { longitude: Infinity }],
  ]) {
    const verdict = gps.classifyGpsObservation(observation(over));
    assert.equal(verdict.trustState, "rejected", label);
    assert.equal(verdict.reason, "invalid_coordinates");
  }
  assert.equal(gps.classifyGpsObservation(observation({ latitude: 0, longitude: 0 })).trustState, "accepted",
    "null island is a real coordinate - rejecting it would be a different bug");
});

test("an old fix is stale exactly at the freshness boundary, not before", async () => {
  const freshnessSeconds = 60;
  assert.equal(
    gps.classifyGpsObservation(observation({ freshnessSeconds, clientCapturedAt: NOW - 60_000 })).trustState,
    "accepted", "a fix exactly at the freshness window is still fresh");
  const justStale = gps.classifyGpsObservation(observation({ freshnessSeconds, clientCapturedAt: NOW - 60_001 }));
  assert.equal(justStale.trustState, "stale");
  assert.equal(justStale.reason, "client_capture_outside_freshness_window");
  assert.equal(justStale.ageMs, 60_001, "the verdict must say how old the reading was");
});

test("a phone whose clock is ahead of the server is not treated as fresh", async () => {
  /*
   * A capture timestamp in the future cannot be a real reading. Allowing it would let a device
   * with a wrong - or deliberately set - clock keep an arbitrarily old position looking current,
   * which is what a customer's "arriving now" is computed from.
   */
  const withinTolerance = gps.classifyGpsObservation(observation({ clientCapturedAt: NOW + gps.MAX_FUTURE_CLOCK_SKEW_MS }));
  assert.equal(withinTolerance.trustState, "accepted", "a few seconds of ordinary clock drift is tolerated");

  const beyond = gps.classifyGpsObservation(observation({ clientCapturedAt: NOW + gps.MAX_FUTURE_CLOCK_SKEW_MS + 1 }));
  assert.equal(beyond.trustState, "stale");
  assert.equal(beyond.reason, "client_capture_ahead_of_server_time");
  assert.ok(beyond.clockSkewMs < 0, "the skew must be reported signed, so an operator can see which way");
});

test("an unusable timestamp is rejected rather than defaulted", async () => {
  for (const clientCapturedAt of [0, -1, Number.NaN, Infinity]) {
    const verdict = gps.classifyGpsObservation(observation({ clientCapturedAt }));
    assert.equal(verdict.trustState, "rejected", `capturedAt ${clientCapturedAt}`);
    assert.equal(verdict.reason, "invalid_capture_timestamp");
  }
});

test("an unconfigured policy rejects rather than trusting everything", async () => {
  /*
   * The fail-open trap. A freshness or accuracy policy that is missing must not mean "no limit".
   */
  for (const [field, reason] of [["freshnessSeconds", "freshness_policy_not_configured"], ["allowedAccuracyMeters", "accuracy_policy_not_configured"]]) {
    for (const value of [0, -1, Number.NaN]) {
      const verdict = gps.classifyGpsObservation(observation({ [field]: value }));
      assert.equal(verdict.trustState, "rejected", `${field}=${value} must not be read as unlimited`);
      assert.equal(verdict.reason, reason);
    }
  }
});

test("accuracy is checked at the boundary, and an unreported accuracy is not perfect accuracy", async () => {
  assert.equal(gps.classifyGpsObservation(observation({ accuracyMeters: 100, allowedAccuracyMeters: 100 })).trustState, "accepted",
    "exactly at the allowed radius is inside it");
  const outside = gps.classifyGpsObservation(observation({ accuracyMeters: 100.1, allowedAccuracyMeters: 100 }));
  assert.equal(outside.trustState, "low_accuracy");
  assert.equal(outside.reason, "accuracy_outside_approved_policy");

  /*
   * A device that does not report accuracy is reporting that it does not know, not that the fix
   * is perfect. Number(undefined) is NaN and Number(null) is 0 - the second would sail through a
   * naive check as a zero-metre fix.
   */
  for (const [label, accuracyMeters] of [["undefined", undefined], ["NaN", Number.NaN], ["negative", -1]]) {
    const verdict = gps.classifyGpsObservation(observation({ accuracyMeters }));
    assert.equal(verdict.trustState, "low_accuracy", `an accuracy of ${label} is not a trustworthy fix`);
    assert.match(String(verdict.reason), /accuracy_(not_reported_by_device|reported_as_negative)/);
  }
});

test("distance is measured on the globe, and an unusable point is infinitely far rather than nearby", async () => {
  /*
   * This distance drives the arrival geofence. Returning 0 or NaN for an unreadable point would
   * fire "your groomer has arrived" for a position nobody can place.
   */
  const mgRoad = { latitude: 12.9752, longitude: 77.6068 };
  const distance = gps.haversineDistanceMeters(BENGALURU, mgRoad);
  assert.ok(distance > 1_200 && distance < 1_600, `about 1.4km across central Bengaluru, got ${Math.round(distance)}m`);
  assert.equal(Math.round(gps.haversineDistanceMeters(BENGALURU, BENGALURU)), 0);
  assert.equal(gps.haversineDistanceMeters(BENGALURU, mgRoad), gps.haversineDistanceMeters(mgRoad, BENGALURU),
    "distance is symmetric");

  for (const bad of [{ latitude: Number.NaN, longitude: 77 }, { latitude: 200, longitude: 77 }]) {
    assert.equal(gps.haversineDistanceMeters(BENGALURU, bad), Number.POSITIVE_INFINITY,
      "an unplaceable point must never read as close enough to be an arrival");
    assert.equal(gps.haversineDistanceMeters(bad, BENGALURU), Number.POSITIVE_INFINITY);
  }
});

test("the arrival geofence is a sane radius and the polling interval is a real interval", async () => {
  assert.ok(gps.ARRIVAL_GEOFENCE_METERS > 0 && gps.ARRIVAL_GEOFENCE_METERS <= 500,
    `an arrival radius of ${gps.ARRIVAL_GEOFENCE_METERS}m must be tight enough to mean "here"`);
  assert.ok(gps.FOREGROUND_GPS_INTERVAL_MS >= 1_000,
    "a sub-second polling interval would flatten a groomer's phone battery mid-round");
  assert.ok(gps.MAX_FUTURE_CLOCK_SKEW_MS > 0 && gps.MAX_FUTURE_CLOCK_SKEW_MS <= 60_000);
});

test("a fix that fails two checks at once reports the more serious one", async () => {
  /*
   * Ordering again: a rejected observation must not be downgraded to merely low-accuracy, because
   * the two are handled differently downstream.
   */
  const killedAndInvalid = gps.classifyGpsObservation(observation({ gpsIngestionEnabled: false, latitude: Number.NaN, accuracyMeters: 9_999 }));
  assert.equal(killedAndInvalid.reason, "gps_kill_switch_active", "the kill switch outranks everything");

  const invalidAndInaccurate = gps.classifyGpsObservation(observation({ latitude: Number.NaN, accuracyMeters: 9_999 }));
  assert.equal(invalidAndInaccurate.trustState, "rejected", "an unplaceable point is rejected, not low-accuracy");

  const staleAndInaccurate = gps.classifyGpsObservation(observation({ clientCapturedAt: NOW - 600_000, accuracyMeters: 9_999 }));
  assert.equal(staleAndInaccurate.trustState, "stale", "staleness is decided before accuracy");
});
