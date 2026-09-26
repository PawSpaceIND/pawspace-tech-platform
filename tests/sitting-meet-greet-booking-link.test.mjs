/**
 * SIT-01 — a Pet Sitting customer's Meet & Greet was never tied to the booking.
 *
 * The master E2E booked nine Sitting stays with a Meet & Greet chosen and found nothing linking the
 * choice to any booking: the booking page, /v2/sitting/manage and the staff Meet & Greet page could not
 * say that this booking came with a Meet & Greet. The customer's request (POST
 * /api/customer-meet-and-greet, the existing governed contract) is now carried by the Sitting booking
 * request and linked server-side, idempotently, without ever blocking the booking.
 *
 * Harness copied from tests/ptja-p0-regressions.test.mjs: real customer session, real sitter
 * reservation, real server quote, real booking route, real SQLite-backed D1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

installWorkersHooks("__SIT_MEET_LINK_DB__", "__SIT_MEET_LINK_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function customerSession(db, customerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${customerId}`,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "sit-01", reason: "SIT-01 executable regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function call(modulePath, method, path, body, cookie) {
  const route = await import(modulePath);
  const request = new Request(`https://uat.pawspace.in${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response = await route[method](request);
  return { status: response.status, body: await response.json() };
}

const istDate = (value) => new Date(Date.parse(value) + 19_800_000).toISOString().slice(0, 10);

// One customer with an owned pet, a reserved 60-minute Home Visit with sit_sana and a server quote.
async function sittingWorld(tag) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__SIT_MEET_LINK_DB__ = db;
  globalThis.__SIT_MEET_LINK_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on", PAWSPACE_MAPS_ENV: "sandbox" };
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=MEMORY;");
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedDefaultZones } = await import("../lib/service-zones.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await seedDefaultZones(db);
  await seedProviderCapacityDefaults(db);

  const customerId = `CUS-SIT01-${tag}`, petId = `SIT01PET${tag}`;
  await seedOwnedPet(db, customerId, petId);
  const cookie = await customerSession(db, customerId);
  const start = new Date(Date.now() + 10 * 86_400_000);
  start.setUTCHours(6, 0, 0, 0);
  const scheduledStart = start.toISOString(), scheduledEnd = new Date(start.getTime() + 3_600_000).toISOString();
  const groupId = `SIT01-${tag}`;
  const scheduled = await call("../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: groupId, customerId, petIds: [petId], serviceCode: "pet_sitting",
    cityId: "blr", zoneId: "blr-east", scheduledStart, scheduledEnd, occurrences: 1, careMode: "visit",
    serviceAddress: "42, Indiranagar Double Road, Stage 2, Bengaluru", servicePincode: "560038",
    preferredProviderId: "sit_sana",
  }, cookie);
  const provider = scheduled.body.data?.provider;
  assert.ok(provider, `sitter assignment failed: ${scheduled.status} ${JSON.stringify(scheduled.body)}`);
  const quoted = await call("../app/api/sitting-commercial/route.ts", "POST", "/api/sitting-commercial", {
    packageCode: "sitting-visit-60", petCount: 1, scheduledStart, scheduledEnd, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east",
  }, cookie);
  const quote = quoted.body.data;
  assert.ok(quote?.quoteId, `sitting quote failed: ${quoted.status} ${JSON.stringify(quoted.body)}`);

  const meetingDay = istDate(new Date(Date.now() + 3 * 86_400_000).toISOString());
  const requestMeeting = (over = {}) => call("../app/api/customer-meet-and-greet/route.ts", "POST", "/api/customer-meet-and-greet", {
    hostProviderId: provider.id, serviceCode: "pet_sitting", format: "house_visit", preferredAt: Date.parse(`${meetingDay}T10:00:00+05:30`),
    intendedStayStart: istDate(scheduledStart), intendedStayEnd: istDate(scheduledEnd), consent: true, idempotencyKey: `SIT01-MEET-${tag}`, ...over,
  }, cookie);
  const bookingBody = (over = {}) => ({
    idempotencyKey: `sitting:${quote.quoteId}:${customerId}`, scheduleGroupId: groupId, sittingQuoteId: quote.quoteId,
    customer: { id: customerId, name: "SIT-01 customer", primaryPhone: "+919800001201" },
    pets: [{ sourceId: petId, name: "Kaju", species: "dog", vaccinationStatus: "verified" }],
    cityId: "blr", zoneId: "blr-east", packageCode: quote.packageCode, packageName: quote.packageName,
    scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd, provider,
    totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "payment_link", mode: "prepaid", detail: "Awaiting verified Razorpay payment" }, ...over,
  });
  const book = (over) => call("../app/api/sitting-bookings/route.ts", "POST", "/api/sitting-bookings", bookingBody(over), cookie);
  return { sqlite, db, cookie, customerId, provider, requestMeeting, book };
}

test("SIT-01: confirming the Sitting booking links exactly the requested Meet & Greet, once, and the customer and staff see it", async () => {
  const w = await sittingWorld("A");
  const meeting = await w.requestMeeting();
  assert.equal(meeting.status, 201, JSON.stringify(meeting.body));
  const requestId = meeting.body.data.request.id;

  const booked = await w.book({ meetGreetRequestId: requestId });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const bookingId = booked.body.data.bookingId;

  const rows = w.sqlite.prepare("SELECT id,format,price_charged,status,booking_id FROM meet_greet_requests").all();
  assert.equal(rows.length, 1, "exactly one Meet & Greet request exists");
  assert.equal(rows[0].id, requestId);
  assert.equal(rows[0].booking_id, bookingId, "the request is linked to the Sitting booking it was made for");
  assert.equal(rows[0].format, "house_visit");
  assert.equal(Number(rows[0].price_charged), 499, "the house visit keeps the governed Rs 499 price");
  assert.equal(rows[0].status, "requested");

  // A retried confirm replays the booking and neither creates nor re-links anything.
  const replay = await w.book({ meetGreetRequestId: requestId });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.bookingId, bookingId);
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) n FROM meet_greet_requests").get().n), 1);
  const events = w.sqlite.prepare("SELECT event_type FROM meet_greet_events WHERE request_id=? ORDER BY created_at,event_type").all(requestId).map((row) => row.event_type);
  assert.deepEqual(events.sort(), ["booking_linked", "requested"], "one request event and one link event, even after a retry");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE event_type='sitting_meet_greet_link_failed'").get().n), 0);

  // The customer's booking page reads the linked request and its live status.
  const view = await call("../app/api/sitting-lifecycle/route.ts", "GET", `/api/sitting-lifecycle?scope=customer&bookingId=${encodeURIComponent(bookingId)}`, null, w.cookie);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const { sittingCustomerView } = await import("../lib/sitting-customer-view.ts");
  assert.deepEqual(sittingCustomerView(view.body.data, bookingId).meetGreet, {
    id: requestId, format: "house_visit", status: "requested", preferredAt: meeting.body.data.request.preferredAt, priceCharged: 499, priceWaived: false,
  });

  // Staff confirm it on their Meet & Greet page (the same list /api/meet-and-greet serves), and the
  // customer's booking page follows the new status.
  const { listMeetGreetRequests, transitionMeetGreetRequest } = await import("../lib/meet-and-greet.ts");
  const staffRows = await listMeetGreetRequests(w.db);
  assert.equal(staffRows.length, 1);
  assert.equal(staffRows[0].bookingId, bookingId, "the staff directory shows which booking the request belongs to");
  await transitionMeetGreetRequest(w.db, { requestId, action: "confirm", actorId: "ops@pawspace.test" });
  const after = await call("../app/api/sitting-lifecycle/route.ts", "GET", `/api/sitting-lifecycle?scope=customer&bookingId=${encodeURIComponent(bookingId)}`, null, w.cookie);
  assert.equal(sittingCustomerView(after.body.data, bookingId).meetGreet.status, "confirmed");
});

test("SIT-01: a Meet & Greet that cannot be linked never blocks the booking and is logged for staff", async () => {
  const w = await sittingWorld("B");
  // Requested for a longer intended stay than the one booked: linking it would misstate the stay the
  // request (and any intended-stay waiver) was priced for.
  const other = await w.requestMeeting({ intendedStayEnd: istDate(new Date(Date.now() + 16 * 86_400_000).toISOString()) });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const requestId = other.body.data.request.id;

  const booked = await w.book({ meetGreetRequestId: requestId });
  assert.equal(booked.status, 201, `the booking must not be blocked by the Meet & Greet: ${JSON.stringify(booked.body)}`);
  const bookingId = booked.body.data.bookingId;
  assert.equal(w.sqlite.prepare("SELECT booking_id FROM meet_greet_requests WHERE id=?").get(requestId).booking_id, null, "the mismatched request stays unlinked");
  const logged = w.sqlite.prepare("SELECT entity_type,entity_id,detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type='sitting_meet_greet_link_failed'").all(bookingId);
  assert.equal(logged.length, 1, "staff can see on the booking that the requested Meet & Greet was not linked");
  assert.equal(logged[0].entity_type, "meet_greet_request");
  assert.equal(logged[0].entity_id, requestId);
  assert.match(JSON.parse(logged[0].detail_json).reason, /not open for this customer, host and stay dates/);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE id=?").get(bookingId).n), 1, "the booking itself is kept");
});

test("SIT-01: a booking without a Meet & Greet links and logs nothing", async () => {
  const w = await sittingWorld("C");
  const booked = await w.book();
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const view = await call("../app/api/sitting-lifecycle/route.ts", "GET", `/api/sitting-lifecycle?scope=customer&bookingId=${encodeURIComponent(booked.body.data.bookingId)}`, null, w.cookie);
  const { sittingCustomerView } = await import("../lib/sitting-customer-view.ts");
  assert.equal(sittingCustomerView(view.body.data, booked.body.data.bookingId).meetGreet, null);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE event_type='sitting_meet_greet_link_failed'").get().n), 0);
});
