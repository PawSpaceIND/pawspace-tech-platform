import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, seedCanonicalTrip, taxiUrl } from "./helpers/taxi-harness.mjs";
installWorkersHooks("__TAXI_REPLAY_DB__", "__TAXI_REPLAY_ENV__");
// CUST-L-D16: a double submit on /v2/taxi hit the idempotent replay branch of POST /api/taxi-bookings, which
// answered with the raw taxi_trips row (snake_case) instead of the first response's contract, so the
// confirmation printed "→ Invalid Date" and "synthetic km · min estimate".

test("taxi booking replay answers with the same trip contract as the first response", async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__TAXI_REPLAY_DB__ = db;
  const trip = seedCanonicalTrip(sqlite);
  const owner = await customerSessionCookie(db, { principalKey: "+919800000123", customerId: trip.customerId });
  const route = await import("../app/api/taxi-bookings/route.ts");
  const body = {
    idempotencyKey: `replay-${trip.bookingId}`, scheduleGroupId: trip.groupId, taxiQuoteId: "QUOTE-REPLAY",
    customer: { id: trip.customerId, name: "Replay Customer", primaryPhone: "9800000123" },
    pets: [{ sourceId: "PET-1", name: "Rex" }],
    routeCode: "taxi-blr-east-medium", originLabel: "Indiranagar", destinationLabel: "Koramangala",
    scheduledStart: trip.scheduledStart, scheduledEnd: trip.scheduledEnd,
    provider: { id: trip.providerId, name: "Driver" }, totalAmount: trip.amount, amountDueNow: 0,
  };
  const response = await route.POST(new Request(taxiUrl("/api/taxi-bookings"), { method: "POST", headers: { "content-type": "application/json", cookie: owner.cookie, origin: taxiUrl("") }, body: JSON.stringify(body) }));
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const { data } = JSON.parse(raw);
  assert.equal(data.duplicatePrevented, true);
  assert.equal(data.bookingId, trip.bookingId);
  assert.ok(Array.isArray(data.petIds), "petIds is part of the contract on replay too");
  assert.equal(typeof data.trip.scheduledStart, "string");
  assert.ok(Number.isFinite(new Date(data.trip.scheduledStart).getTime()), `scheduledStart must parse: ${data.trip.scheduledStart}`);
  assert.equal(typeof data.trip.syntheticDistanceKm, "number");
  assert.equal(typeof data.trip.estimatedDurationMinutes, "number");
  assert.equal(data.trip.originLabel.length > 0, true);
  for (const snake of ["origin_label", "scheduled_start", "synthetic_distance_km"]) assert.equal(snake in data.trip, false, `${snake} must not leak into the contract`);
});
