import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { projectBoardingProviderStay } from "../lib/boarding-provider-projection.ts";
import { projectTaxiProviderBooking, redactTaxiBookingForProvider } from "../lib/taxi-provider-projection.ts";

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
  // PARTNER-01: emergency contact and vet reach the host once it has accepted a paid stay (confirmed /
  // in_progress, see tests/boarding-host-care-plan.test.mjs); a stay still awaiting acceptance keeps them back.
  const out = projectBoardingProviderStay({
    id: "S1",
    booking_id: "B1",
    status: "awaiting_host_acceptance",
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
  assert.deepEqual(out.carePlan.withheldUntilAccepted, ["emergencyContact", "vet"]);
  assert.ok(!s.includes("9000000000"));
  assert.ok(!s.includes("9888877777"));
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

test("a driver reading one ride by booking id gets it without internals, raw event detail or payment amounts", () => {
  const raw = {
    id: "T2", status: "assigned", provider_id: "drv_1", customer_id: "c2", trip_id: "trip_2", trip_status: "vehicle_assigned",
    origin_label: "Indiranagar", destination_label: "Koramangala", scheduled_start: "2026-09-10T09:00:00Z",
    idempotency_key: "idem-secret", pricing_json: '{"coupon":"STAFF50","margin":120}', created_by: "ops@pawspace.in", source_pet_ids_json: '["account-x"]',
    events: [{ id: "e1", trip_id: "trip_2", event_type: "accepted", actor_id: "staff@pawspace.in", detail_json: '{"note":"called customer 9123456789","status":"accepted"}', created_at: 3 }],
    tripPayment: { status: "due", amount: 284.12, gateway_payment_id: "pay_secret" },
    offer: { state: "accepted", expiresAt: 5, offeredAt: 1, providerId: "drv_1" },
  };
  const out = redactTaxiBookingForProvider(raw), s = JSON.stringify(out);
  // The fields the /driver workspace reads are kept, in their own shape.
  assert.equal(out.trip_status, "vehicle_assigned");
  assert.equal(out.origin_label, "Indiranagar");
  assert.equal(out.events[0].event_type, "accepted");
  assert.equal(out.tripPayment.status, "due");
  assert.equal(out.offer.state, "accepted");
  for (const hidden of ["idem-secret", "STAFF50", "ops@pawspace.in", "account-x", "staff@pawspace.in", "9123456789", "pay_secret", "284.12"]) assert.ok(!s.includes(hidden), hidden);
});

test("taxi-lifecycle redacts a provider's booking-id read, not only provider-scoped lists", () => {
  assert.match(taxiRoute, /await requireProviderOwnership\(db,actor,String\(booking\.provider_id\)\);providerRead=true/);
  assert.match(taxiRoute, /providerRead\?rows\.map\(\(item:Record<string,unknown>\)=>redactTaxiBookingForProvider\(item\)\)/);
});
