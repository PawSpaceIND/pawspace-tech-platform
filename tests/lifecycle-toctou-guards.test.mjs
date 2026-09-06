import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const STALE_ERROR = "Unable to update lifecycle. Invalid or stale state.";

const modules = [
  "lib/sitting-lifecycle.ts",
  "lib/taxi-lifecycle.ts",
  "lib/walking-lifecycle.ts",
  "lib/boarding-stay-lifecycle.ts",
  "lib/training-session-lifecycle.ts",
];

for (const path of modules) {
  test(`P0-4: ${path} rejects a zero-row lifecycle claim as HTTP 409`, async () => {
    const source = await read(path);
    assert.match(source, /meta\?\.changes/);
    assert.match(source, /status:409/);
    assert.ok(source.includes(STALE_ERROR), `${path} must expose the canonical stale-state conflict`);
    assert.match(source, /assertLifecycleClaim/);
  });
}

test("P0-4: Sitting canonical booking transitions are conditional", async () => {
  const source = await read("lib/sitting-lifecycle.ts");
  assert.match(source, /SET status='assigned'.*WHERE id=\? AND status=\?/s);
  assert.match(source, /SET status='in_progress'.*WHERE id=\? AND status='assigned'/s);
  assert.match(source, /SET status='completed'.*WHERE id=\? AND status='in_progress'/s);
  assert.match(source, /SET status='reassignment_needed'.*WHERE id=\? AND status=\?/s);
});

test("P0-4: Taxi booking and trip transitions are conditional", async () => {
  const source = await read("lib/taxi-lifecycle.ts");
  assert.match(source, /canonical_bookings SET status='assigned'.*status='confirmed'/s);
  for (const state of ["accepted", "vehicle_assigned", "pickup_confirmed", "in_progress", "arrived_dropoff", "dropoff_confirmed", "completed", "recovery_pending"]) {
    assert.match(source, new RegExp(`taxi_trips SET[^\n]*status='${state}'[^\n]*AND status`), `${state} must be a conditional Taxi transition`);
  }
});

test("P0-4: Walking booking/session transitions are conditional", async () => {
  const source = await read("lib/walking-lifecycle.ts");
  assert.match(source, /canonical_bookings SET status='assigned'.*status='confirmed'/s);
  assert.match(source, /walking_sessions SET status='ready_to_start'.*status='scheduled'/s);
  assert.match(source, /walking_sessions SET status='in_progress'.*status='ready_to_start'/s);
  assert.match(source, /walking_sessions SET status='completed'.*status='in_progress'/s);
  assert.match(source, /canonical_bookings SET status='reassignment_needed'.*AND status=\?/s);
});

test("P0-4: Boarding stay and booking transitions are conditional", async () => {
  const source = await read("lib/boarding-stay-lifecycle.ts");
  assert.match(source, /boarding_stays SET status='confirmed'.*AND status=\?/s);
  assert.match(source, /boarding_stays SET status='in_progress'.*status='confirmed'/s);
  assert.match(source, /boarding_stays SET status='completed'.*status='in_progress'/s);
  assert.match(source, /boarding_stays SET status='recovery_pending'.*AND status=\?/s);
  assert.match(source, /canonical_bookings SET status='reassignment_needed'.*AND status=\?/s);
});

test("P0-4: Training session transitions bind the expected prior state", async () => {
  const source = await read("lib/training-session-lifecycle.ts");
  for (const [to, from] of [
    ["accepted", "scheduled"],
    ["on_the_way", "accepted"],
    ["arrived", "on_the_way"],
    ["in_session", "arrived"],
    ["completed", "in_session"],
  ]) {
    assert.match(source, new RegExp(`training_sessions SET[^\n]*status='${to}'[^\n]*AND status='${from}'`), `${from} -> ${to} must be conditional`);
  }
  for (const to of ["reschedule_requested", "no_show", "scheduled", "cancelled"]) {
    assert.match(source, new RegExp(`training_sessions SET[^\n]*status='${to}'[^\n]*AND status=\\?`), `${to} must bind the state observed before the write`);
  }
});

test("existing executable journeys still exercise linear lifecycle order and 409 invalid transitions", async () => {
  const [sitting, taxi, training] = await Promise.all([
    read("tests/sitting-gate2.test.mjs"),
    read("tests/taxi-gate2.test.mjs"),
    read("tests/training-hardening.test.mjs"),
  ]);
  assert.match(sitting, /check_out[\s\S]*status, 409[\s\S]*check_in[\s\S]*check_out/);
  assert.match(taxi, /accept[\s\S]*confirm_pickup[\s\S]*start_trip[\s\S]*arrive_dropoff[\s\S]*confirm_dropoff[\s\S]*complete_trip/);
  assert.match(training, /accept[\s\S]*on_the_way[\s\S]*arrive[\s\S]*start[\s\S]*owner_handover[\s\S]*complete/);
});
