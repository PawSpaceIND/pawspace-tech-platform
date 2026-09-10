import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { projectSittingProviderBooking } from "../lib/sitting-provider-projection.ts";
import { projectWalkingProviderBooking } from "../lib/walking-provider-projection.ts";

const sittingRoute = readFileSync(new URL("../app/api/sitting-lifecycle/route.ts", import.meta.url), "utf8");
const walkingRoute = readFileSync(new URL("../app/api/walking-lifecycle/route.ts", import.meta.url), "utf8");

test("sitting-lifecycle imports provider projection for provider-scoped reads", () => {
  assert.match(sittingRoute, /projectSittingProviderBooking/);
  assert.match(sittingRoute, /from"\.\.\/\.\.\/\.\.\/lib\/sitting-provider-projection"/);
});

test("walking-lifecycle imports provider projection for provider-scoped reads", () => {
  assert.match(walkingRoute, /projectWalkingProviderBooking/);
  assert.match(walkingRoute, /from"\.\.\/\.\.\/\.\.\/lib\/walking-provider-projection"/);
});

test("sitting projection strips emergency/vet/home-access free text and staff actor", () => {
  const out = projectSittingProviderBooking({
    id: "B1",
    status: "in_progress",
    service_code: "pet_sitting",
    package_code: "sitting-visit-60",
    package_name: "60 min visit",
    city_id: "blr",
    zone_id: "blr-east",
    scheduled_start: "2026-09-10T10:00:00Z",
    scheduled_end: "2026-09-10T11:00:00Z",
    provider_id: "sit_1",
    customer_id: "cust_1",
    work_order_id: "wo_1",
    work_order_status: "in_progress",
    total_amount: 499,
    currency: "INR",
    carePlan: {
      status: "ready",
      plan: {
        feeding: "Morning kibble",
        medication: "None",
        emergencyContact: "+91 98765 43210 Mom",
        vet: "Dr Rao 9988776655",
        homeAccess: "Gate code 4455, key under mat",
        specialInstructions: "Dog is friendly",
      },
      updatedAt: 1,
    },
    events: [
      {
        id: "e1",
        event_type: "checked_in",
        actor_id: "ops@pawspace.in",
        detail: { distanceMeters: 12, staffNote: "called customer at 9876543210" },
        created_at: 2,
      },
    ],
    recovery: null,
  });
  const serialized = JSON.stringify(out);
  assert.equal(out.events[0].actorId, "provider_or_system");
  assert.equal(out.carePlan.plan.hasEmergencyContact, true);
  assert.equal(out.carePlan.plan.hasHomeAccess, true);
  assert.equal(out.carePlan.plan.feeding, "Morning kibble");
  assert.ok(!serialized.includes("98765"));
  assert.ok(!serialized.includes("ops@pawspace.in"));
  assert.ok(!serialized.includes("Gate code"));
  assert.ok(!serialized.includes("staffNote"));
});

test("walking projection strips staff actor and raw event detail", () => {
  const out = projectWalkingProviderBooking({
    id: "W1",
    status: "assigned",
    service_code: "dog_walking",
    package_code: "walk-30",
    package_name: "30 min",
    city_id: "blr",
    zone_id: "blr-east",
    scheduled_start: "2026-09-10T07:00:00Z",
    scheduled_end: "2026-09-10T07:30:00Z",
    provider_id: "walk_1",
    customer_id: "cust_2",
    work_order_status: "accepted",
    payment_status: "captured",
    total_amount: 299,
    currency: "INR",
    pets: [{ id: "p1", name: "Bruno", species: "dog", breed: "Indie" }],
    sessions: [{ id: "s1", occurrence_number: 1, provider_id: "walk_1", scheduled_start: "2026-09-10T07:00:00Z", scheduled_end: "2026-09-10T07:30:00Z", status: "scheduled", handover_status: "pending", updated_at: 1 }],
    events: [
      {
        id: "e1",
        session_id: "s1",
        event_type: "walker_accepted",
        actor_id: "staff@pawspace.in",
        detail: { walkCount: 5, note: "customer phone 9123456789" },
        created_at: 3,
      },
    ],
    recovery: null,
  });
  const serialized = JSON.stringify(out);
  assert.equal(out.events[0].actorId, "provider_or_system");
  assert.equal(out.sessions[0].status, "scheduled");
  assert.ok(!serialized.includes("staff@pawspace.in"));
  assert.ok(!serialized.includes("9123456789"));
  assert.ok(!serialized.includes("customer phone"));
});
