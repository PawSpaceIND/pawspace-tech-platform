import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { projectBoardingProviderStay } from "../lib/boarding-provider-projection.ts";
import { projectTaxiProviderBooking } from "../lib/taxi-provider-projection.ts";

const boardingRoute = readFileSync(new URL("../app/api/boarding-stays/route.ts", import.meta.url), "utf8");
const boardingClient = readFileSync(new URL("../lib/boarding-stay-client.ts", import.meta.url), "utf8");
const taxiRoute = readFileSync(new URL("../app/api/taxi-lifecycle/route.ts", import.meta.url), "utf8");

test("boarding-stays imports provider projection", () => {
  assert.match(boardingRoute, /projectBoardingProviderStay/);
});

test("taxi-lifecycle imports provider projection", () => {
  assert.match(taxiRoute, /projectTaxiProviderBooking/);
});

test("boarding projection strips emergency/vet free text and staff actor", () => {
  const out = projectBoardingProviderStay({
    id: "S1",
    booking_id: "B1",
    status: "in_progress",
    host_provider_id: "host_1",
    customer_id: "c1",
    city_id: "blr",
    zone_id: "blr-east",
    package_code: "boarding-4h",
    package_name: "Overnight",
    provider_name: "Maya & Rohan",
    check_in_at: "2026-09-10T10:00:00Z",
    check_out_at: "2026-09-11T10:00:00Z",
    billed_units: 1,
    pet_count: 2,
    updated_at: 99,
    care_plan_status: "ready",
    check_in_status: "pending",
    check_out_status: "pending",
    extension_status: "none",
    total_amount: 1500,
    carePlan: {
      status: "ready",
      plan: { feeding: "Twice daily", emergencyContact: "+91 9000000000", vet: "Clinic 9888877777" },
      updatedAt: 1,
    },
    events: [{ id: "e1", event_type: "checked_in", actor_id: "ops@pawspace.in", detail: { note: "call 9000000000" }, created_at: 2 }],
    extension: null,
  });
  const s = JSON.stringify(out);
  assert.equal(out.events[0].actorId, "provider_or_system");
  assert.equal(out.petCount, 2);
  assert.equal(out.checkInStatus, "pending");
  assert.equal(out.updatedAt, 99);
  assert.equal(out.carePlan.plan.hasEmergencyContact, true);
  assert.ok(!s.includes("9000000000"));
  assert.ok(!s.includes("ops@pawspace.in"));
});


test("boarding Host client handles provider-safe camelCase lifecycle projection", () => {
  assert.match(boardingClient, /row\.event_type\?\?row\.eventType/);
  assert.match(boardingClient, /row\.actor_id\?\?row\.actorId/);
  assert.match(boardingClient, /row\.created_at\?\?row\.createdAt/);
  assert.match(boardingClient, /row\.check_in_status\?\?row\.checkInStatus/);
  assert.match(boardingClient, /row\.requested_end\?\?row\.requestedEnd/);
});

test("taxi projection strips staff actor and contact-shaped detail", () => {
  const out = projectTaxiProviderBooking({
    id: "T1",
    status: "assigned",
    service_code: "pet_taxi",
    package_code: "taxi-std",
    package_name: "Standard",
    city_id: "blr",
    zone_id: "blr-east",
    scheduled_start: "2026-09-10T09:00:00Z",
    scheduled_end: "2026-09-10T10:00:00Z",
    provider_id: "drv_1",
    customer_id: "c2",
    trip_id: "trip_1",
    trip_status: "assigned",
    origin_label: "Indiranagar",
    destination_label: "Koramangala",
    total_amount: 400,
    currency: "INR",
    events: [{ id: "e1", trip_id: "trip_1", event_type: "accepted", actor_id: "staff@pawspace.in", detail: { phone: "9123456789" }, created_at: 3 }],
    recovery: null,
  });
  const s = JSON.stringify(out);
  assert.equal(out.events[0].actorId, "provider_or_system");
  assert.ok(!s.includes("staff@pawspace.in"));
  assert.ok(!s.includes("9123456789"));
});
