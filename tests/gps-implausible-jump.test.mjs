/** Owner decision (QA M2): a 5 km jump in 70 s (~260 km/h) was trusted, so a spoofed fix could pass the arrival geofence. */
import test from "node:test";
import assert from "node:assert/strict";
const { implausibleGpsJump } = await import("../lib/gps-telemetry-policy.ts");
const indiranagar = { latitude: 12.9784, longitude: 77.6408 }, cityCentre = { latitude: 12.9716, longitude: 77.5946 };

test("a 5 km jump in 70 seconds is rejected", () => {
  assert.equal(implausibleGpsJump({ ...cityCentre, capturedAt: 0, accuracyMeters: 20 }, { ...indiranagar, capturedAt: 70_000, accuracyMeters: 20 }), true);
});
test("the same distance covered over 10 minutes by road is accepted", () => {
  assert.equal(implausibleGpsJump({ ...cityCentre, capturedAt: 0, accuracyMeters: 20 }, { ...indiranagar, capturedAt: 600_000, accuracyMeters: 20 }), false);
});
test("GPS noise and poor accuracy are not treated as a jump", () => {
  const nearby = { latitude: 12.9786, longitude: 77.6411 };
  assert.equal(implausibleGpsJump({ ...indiranagar, capturedAt: 0, accuracyMeters: 30 }, { ...nearby, capturedAt: 8_000, accuracyMeters: 30 }), false);
  assert.equal(implausibleGpsJump({ ...cityCentre, capturedAt: 0, accuracyMeters: 3000 }, { ...indiranagar, capturedAt: 60_000, accuracyMeters: 3000 }), false);
});
