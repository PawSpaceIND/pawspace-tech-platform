/*
 * WHO created this booking, and THROUGH WHAT CHANNEL.
 *
 * app/api/canonical-bookings/route.ts bound both as constants for every caller: channel "customer_app"
 * and created_by input.customer.id. So a booking a staff member took on a call was recorded as the
 * customer booking themselves in the app, and every booking_lifecycle_events row on it was attributed
 * to the customer too.
 *
 * app/api/assisted-orders/route.ts already corrected its own two columns afterwards with a second
 * UPDATE [R3-C/F10], and tests/r3c-crm-lead-conversion.test.mjs pins that. But that test stubs
 * globalThis.fetch, so the canonical writer never runs in it - what it proves is the assisted-order
 * UPDATE, not the writer. Every OTHER staff caller (lib/ai-tool-registry.ts, the pre-launch swarm, any
 * future one) got the customer id, and nothing corrected the event log on any path.
 *
 * These tests drive the REAL route handler against a real SQLite-backed D1 with a real actor and read
 * canonical_bookings and booking_lifecycle_events back out, so the assertion is about what the
 * database holds. executeCanonicalBookingRequest takes an actor override, which is what lets one
 * fixture be driven as a customer and as a staff member without inventing a session for either.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__ATTRIBUTION_DB__", "__ATTRIBUTION_ENV__");

const CUSTOMER_NAME = "Asha Kulkarni";
const PRIMARY_PHONE = "+919800000077";
const STAFF_EMAIL = "ops.admin@pawspace.test";

function freshWorld() {
  const harness = freshCountingD1();
  globalThis.__ATTRIBUTION_DB__ = harness.db;
  globalThis.__ATTRIBUTION_ENV__ = {
    PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat",
    PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on", PAWSPACE_MAPS_ENV: "sandbox",
  };
  harness.sqlite.exec("PRAGMA journal_mode=MEMORY;");
  return harness;
}

/* The two actors, in the exact shape lib/server-auth.ts resolves.
 *
 * A customer arrives through an identity subject (customer OTP); a staff member through a workspace
 * email. `developmentPreview` is the third case and is deliberately NOT read as staff - see the
 * comment on the derivation itself. */
const customerActor = (customerId) => ({
  email: `customer:${customerId}`, name: `Customer ${customerId}`, roleCode: "customer",
  permissions: ["scheduling.book"], developmentPreview: false, identitySource: "customer_otp",
  principalType: "identity_subject", principalKey: customerId, subjectType: "customer",
});
const staffActor = () => ({
  email: STAFF_EMAIL, name: "Ops Admin", roleCode: "admin", permissions: ["*"],
  developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: STAFF_EMAIL,
});
const previewActor = () => ({
  email: "preview@pawspace.test", name: "Preview operator", roleCode: "superuser", permissions: ["*"],
  developmentPreview: true, identitySource: "workspace", principalType: "email", principalKey: "preview@pawspace.test",
});

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)",
  "CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)",
];

function futureWindow({ startInHours = 48, durationHours = 1 } = {}) {
  const startMs = Math.floor((Date.now() + startInHours * 3_600_000) / 1000) * 1000;
  return { scheduledStart: new Date(startMs).toISOString(), scheduledEnd: new Date(startMs + durationHours * 3_600_000).toISOString() };
}

let seq = 0;
const tag = () => `${++seq}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** One confirmed pet-sitting booking, driven through the real route as `actor`. */
async function book(makeActor) {
  const { sqlite, db } = freshWorld();
  const customerId = `CUS-ATTR-${tag()}`, petId = `PET-ATTR-${tag()}`, groupId = `GRP-ATTR-${tag()}`;
  const providerId = "sit_sana", now = Date.now();
  const actor = makeActor(customerId);
  const account = await import("../lib/customer-account.ts");
  await account.ensureCustomerAccountTables(db);
  /* requireCustomerOwnership resolves a customer actor through its identity binding, so the binding
     is part of the fixture: without it the route refuses before it ever reaches the write. */
  const binding = await import("../lib/identity-binding.ts");
  await binding.ensureIdentityBindingTables(db);
  if (actor?.principalType === "identity_subject") {
    await binding.upsertIdentityBinding(db, {
      identitySource: actor.identitySource, principalType: actor.principalType, principalKey: customerId,
      subjectType: "customer", subjectId: customerId, cityId: "blr", actorId: "fixture",
      reason: "attribution fixture binds this customer to their own record",
    });
  }
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, "blr", CUSTOMER_NAME, PRIMARY_PHONE, now, now);
  sqlite.prepare("INSERT INTO canonical_pets(id,customer_id,source_pet_id,name,species,breed,vaccination_status,created_at,updated_at) VALUES (?,?,?,?,'dog','Indie','verified',?,?)")
    .run(petId, customerId, petId, "Bruno", now, now);

  const window = futureWindow({ durationHours: 1 });
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,'[]',?,'assigned','fixture','seeded',?)")
    .run(groupId, "governed", providerId, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'pet_sitting','blr','koramangala',?,?,?,?,1,1,NULL,'held','{}',?)")
    .run(`RES-${groupId}`, groupId, providerId, customerId, JSON.stringify([petId]), window.scheduledStart, window.scheduledEnd, now);

  const { createCapturedCanonicalSittingQuote } = await import("./helpers/canonical-sitting-commercial.mjs");
  const { quote } = await createCapturedCanonicalSittingQuote(db, { ...window, cityId: "blr", zoneId: "koramangala", petCount: 1, paymentMode: "prepaid", paymentKey: `attr:${groupId}` });

  const route = await import("../app/api/canonical-bookings/route.ts");
  const request = new Request("http://localhost/api/canonical-bookings", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: `attr:${groupId}`, scheduleGroupId: groupId,
      customer: { id: customerId, name: CUSTOMER_NAME, primaryPhone: PRIMARY_PHONE },
      pets: [{ sourceId: petId, name: "Bruno", species: "dog", vaccinationStatus: "verified" }],
      cityId: "blr", zoneId: "koramangala", serviceCode: "pet_sitting",
      packageCode: quote.packageCode, packageName: quote.packageName,
      scheduledStart: window.scheduledStart, scheduledEnd: window.scheduledEnd,
      provider: { id: providerId, name: "Sana S.", model: "full_time" },
      totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
      payment: { method: "upi", mode: quote.paymentMode, status: "captured", detail: "attribution fixture" },
      pricing: { discount: 0, sittingQuoteId: quote.quoteId },
    }),
  });
  const response = await route.executeCanonicalBookingRequest(request, actor);
  const text = await response.clone().text();
  assert.ok(response.status === 200 || response.status === 201, `${response.status}: ${text.slice(0, 400)}`);
  const row = sqlite.prepare("SELECT id,channel,created_by,customer_id FROM canonical_bookings WHERE customer_id=?").get(customerId);
  assert.ok(row, "fixture: the booking was written");
  const events = sqlite.prepare("SELECT DISTINCT actor_id FROM booking_lifecycle_events WHERE booking_id=?").all(row.id).map((r) => r.actor_id);
  return { row, events, customerId, sqlite };
}

test("ATTRIB-1: a customer booking through the app is recorded as the customer on the app channel", async () => {
  const { row, events, customerId } = await book(customerActor);
  // The actor's principalKey is not what is stored - customer_id from the payload is, and the two
  // agree because requireCustomerOwnership has already established that this actor owns the record.
  assert.equal(row.channel, "customer_app", "a customer's own booking arrived through the app");
  assert.equal(row.created_by, customerId, "and the customer created it");
  assert.deepEqual(events, [customerId], "every lifecycle event is theirs too");
});

test("ATTRIB-2: a booking a staff member places names the STAFF member, on the assisted channel", async () => {
  const { row, events, customerId } = await book(staffActor);
  assert.equal(row.created_by, STAFF_EMAIL,
    "this is the defect: created_by was bound input.customer.id for every caller, so the ledger said the customer booked themselves");
  assert.notEqual(row.created_by, customerId);
  assert.equal(row.channel, "assisted_staff",
    "and channel was bound the literal 'customer_app', contradicting the assisted-order audit beside it");
  assert.deepEqual(events, [STAFF_EMAIL],
    "the event log was attributed to the customer for the same reason, and nothing corrected it on any path");
});

test("ATTRIB-3: the development-preview actor is not read as staff", async () => {
  /*
   * lib/development-preview.ts's actor is a stand-in for whoever the operator wants to be, and it is
   * what carries every local UAT request. Reading it as staff would quietly relabel every booking made
   * during a customer-journey walkthrough as staff-assisted, which is a worse answer than the old one.
   */
  const { row, customerId } = await book(previewActor);
  assert.equal(row.channel, "customer_app");
  assert.equal(row.created_by, customerId);
});
