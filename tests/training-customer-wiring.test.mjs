/*
 * Training customer wiring, EXECUTED.
 *
 * This file used to read app/training/page.tsx and the client modules as strings and check that
 * identifiers such as `quoteTraining` and `occurrences:quote.meetAndGreet?1:quote.sessions` appeared
 * in them. A source-text pin can only prove that a string is present; it cannot tell whether the
 * string is a fact (PTJA-P1-F32 was exactly that: the client declared a capture it never obtained,
 * and the pin required it to).
 *
 * Every case below runs the SAME client functions the Training page imports - catalogue, quote,
 * trainers, account, schedule reservation, canonical booking, programme - with `fetch` routed into the
 * real route handlers against a real SQLite-backed D1, as a signed-in customer's platform session. What
 * the page wires together is therefore proven end to end: the server refuses the shapes the page must
 * not send, and persists exactly what it does send.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const ORIGIN = "https://uat.pawspace.in";
const CUSTOMER_ID = "CUST-TRAIN-WIRE";
const ROUTES = {
  "/api/training-commercial": "../app/api/training-commercial/route.ts",
  "/api/training-trainers": "../app/api/training-trainers/route.ts",
  "/api/uat-scheduling": "../app/api/uat-scheduling/route.ts",
  "/api/canonical-bookings": "../app/api/canonical-bookings/route.ts",
  "/api/training-programmes": "../app/api/training-programmes/route.ts",
  "/api/customer-account": "../app/api/customer-account/route.ts",
  "/api/training-payment-sandbox": "../app/api/training-payment-sandbox/route.ts",
};

/** Route the client modules' `fetch` into the real handlers as the given platform session. */
function bridgeFetch(cookie) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(String(input), ORIGIN);
    const modulePath = ROUTES[target.pathname];
    if (!modulePath) throw new Error(`the Training client reached an endpoint outside its canonical wiring: ${target.pathname}`);
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, path: target.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
    const handler = (await import(modulePath))[method];
    return handler(new Request(target.href, { method, headers: { ...(init.headers || {}), cookie }, ...(init.body ? { body: init.body } : {}) }));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const clients = {
  commercial: await import("../lib/training-commercial-client.ts"),
  scheduling: await import("../lib/uat-scheduling-client.ts"),
  booking: await import("../lib/training-booking-client.ts"),
  programme: await import("../lib/training-programme-client.ts"),
  account: await import("../lib/customer-account-client.ts"),
  guards: await import("../lib/training-booking-guards.ts"),
};

function futureWindow(daysAhead = 5) {
  const start = new Date(Date.now() + daysAhead * 86_400_000);
  start.setUTCHours(5, 30, 0, 0);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 3_600_000).toISOString() };
}

/** A signed-in Bengaluru customer with one dog, as the platform session would present them. */
async function signedInCustomer(t, { customerId = CUSTOMER_ID, petId = "PET-TRAIN-WIRE" } = {}) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  await seedOwnedPet(ctx.db, customerId, petId, "Bruno");
  ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(customerId, "blr", "Mira Wire", "+919900000515", Date.now(), Date.now());
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const bridge = bridgeFetch(cookie);
  t.after(bridge.restore);
  return { ...ctx, customerId, cookie, calls: bridge.calls };
}

/** The exact sequence the Training page runs to hold a quote and a trainer for the whole programme. */
async function holdProgramme(f, { packageCode = "training-2-starter", paymentMode = "split", occurrences, daysAhead = 5 } = {}) {
  const account = await clients.account.loadCustomerAccount();
  const window = futureWindow(daysAhead);
  const quote = await clients.commercial.quoteTraining({ packageCode, petCount: 1, scheduledStart: window.scheduledStart, paymentMode });
  const trainers = await clients.commercial.loadTrainingTrainers({ cityId: "blr", zoneId: "blr-east", at: window.scheduledStart });
  const requestId = `training:${quote.quoteId}:${account.customerId}`;
  const schedule = await clients.scheduling.reserveUatSchedule({
    clientRequestId: requestId, customerId: account.customerId, petIds: account.pets.map((pet) => pet.id), serviceCode: "dog_training",
    zoneId: "blr-east", ...window, occurrences: occurrences ?? (quote.meetAndGreet ? 1 : quote.sessions), cadenceDays: 7, preferredProviderId: trainers.providers[0].id,
  });
  return { account, window, quote, trainers, requestId, schedule };
}

const bookingInput = ({ account, window, quote, requestId, schedule }) => ({
  idempotencyKey: requestId, scheduleGroupId: schedule.groupId, trainingQuote: quote,
  customer: { id: account.customerId, name: account.name, primaryPhone: account.primaryPhone },
  pets: account.pets.map((pet) => ({ sourceId: pet.sourceId ?? pet.id, name: pet.name, species: "dog" })),
  cityId: "blr", zoneId: "blr-east", ...window, provider: schedule.provider,
});

test("Training customer route reads its catalogue, quote and trainers from the canonical commercial and capacity ledgers", async (t) => {
  const f = await signedInCustomer(t);
  const catalogue = await clients.commercial.loadTrainingPackages();
  assert.equal(catalogue.source, "canonical_training_commercial");
  assert.equal(catalogue.liveMoney, false);
  const starter = catalogue.packages.find((item) => item.package_code === "training-2-starter");
  assert.deepEqual({ sessions: starter?.sessions, price: starter?.base_price }, { sessions: 2, price: 3500 });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_packages WHERE active=1").get().n, catalogue.packages.length, "the catalogue is the D1 package table, not a client constant");

  const { scheduledStart } = futureWindow();
  const quote = await clients.commercial.quoteTraining({ packageCode: "training-2-starter", petCount: 1, scheduledStart, paymentMode: "split" });
  assert.deepEqual({ sessions: quote.sessions, total: quote.totalAmount, due: quote.amountDueNow, mode: quote.paymentMode, live: quote.liveMoney }, { sessions: 2, total: 3500, due: 1750, mode: "split", live: false });
  const stored = f.sqlite.prepare("SELECT status,total_amount,amount_due_now,sessions FROM training_commercial_quotes WHERE id=?").get(quote.quoteId);
  assert.deepEqual({ ...stored }, { status: "open", total_amount: 3500, amount_due_now: 1750, sessions: 2 }, "the quote the page prices from is a persisted server quote");

  const trainers = await clients.commercial.loadTrainingTrainers({ cityId: "blr", zoneId: "blr-east", at: scheduledStart });
  assert.equal(trainers.source, "canonical_provider_capacity");
  assert.equal(trainers.liveAvailability, false);
  const governed = f.sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE services_json LIKE '%dog_training%' AND live=1 AND city_id='blr'").all().map((row) => row.id).sort();
  assert.deepEqual(trainers.providers.map((provider) => provider.id).sort(), governed, "every offered trainer is a live governed dog_training provider");
  assert.ok(!trainers.providers.some((provider) => provider.id === "groom_arun"), "groomers are never offered as trainers");
  assert.deepEqual(f.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/training-commercial", "POST /api/training-commercial", "GET /api/training-trainers"]);
});

test("Training customer route books the signed-in customer's own dogs, never a fixture identity", async (t) => {
  const f = await signedInCustomer(t);
  const account = await clients.account.loadCustomerAccount();
  assert.equal(account.customerId, f.customerId, "the account is derived from the session, not an id the page chose");
  assert.deepEqual(account.pets.map((pet) => ({ id: pet.id, species: pet.species })), [{ id: "PET-TRAIN-WIRE", species: "dog" }]);
  assert.equal(f.calls[0].path, "/api/customer-account");

  await assert.rejects(clients.account.loadCustomerAccount("TST-101"), /Customer ownership denied|Unable to load your account/, "the retired fixture customer cannot be loaded by a real session");

  const window = futureWindow();
  await assert.rejects(
    clients.scheduling.reserveUatSchedule({ clientRequestId: "fixture-attempt", customerId: "TST-101", petIds: ["TST-PET-BRUNO"], serviceCode: "dog_training", zoneId: "blr-east", ...window, occurrences: 2, cadenceDays: 7 }),
    (error) => error.name === "SchedulingRefusal",
    "a reservation for a customer the session does not own is refused",
  );
  const reserved = f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduling_reservations'").get();
  assert.equal(reserved ? f.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n : 0, 0, "and nothing was reserved for the fixture");
});

test("Training customer programme reserves exactly the server-governed number of sessions, a week apart", async (t) => {
  const f = await signedInCustomer(t);
  const held = await holdProgramme(f);
  assert.equal(held.schedule.occurrences.length, held.quote.sessions);
  const reservations = f.sqlite.prepare("SELECT occurrence_number,scheduled_start,provider_id FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number").all(held.schedule.groupId);
  assert.deepEqual(reservations.map((row) => row.occurrence_number), [1, 2]);
  assert.equal(Date.parse(reservations[1].scheduled_start) - Date.parse(reservations[0].scheduled_start), 7 * 86_400_000, "sessions follow the weekly cadence the page requests");
  assert.ok(reservations.every((row) => row.provider_id === held.schedule.provider.id), "one trainer covers the whole programme");
  assert.equal(held.schedule.provider.id, held.trainers.providers[0].id, "the preferred trainer the page passes is the one reserved");

  // The server side of the same contract: a programme reserved for fewer sessions than its quote
  // cannot be booked, so the page's `occurrences: quote.sessions` is enforced, not trusted.
  const short = await holdProgramme(f, { occurrences: 1, daysAhead: 20 });
  await assert.rejects(clients.booking.createCanonicalTrainingBooking(bookingInput(short)), /Training programme requires exactly 2 reserved sessions/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 0);
});

test("Training customer booking consumes a server quote and records only UAT sandbox payment truth", async (t) => {
  const f = await signedInCustomer(t);
  const held = await holdProgramme(f);
  const result = await clients.booking.createCanonicalTrainingBooking(bookingInput(held));
  assert.deepEqual({ status: result.status, liveMoney: result.liveMoney, duplicatePrevented: result.duplicatePrevented, customerId: result.customerId }, { status: "payment_pending", liveMoney: false, duplicatePrevented: false, customerId: f.customerId });

  const booking = f.sqlite.prepare("SELECT status,service_code,package_code,total_amount,pricing_json FROM canonical_bookings WHERE id=?").get(result.bookingId);
  assert.deepEqual({ status: booking.status, service: booking.service_code, pkg: booking.package_code, total: booking.total_amount }, { status: "payment_pending", service: "dog_training", pkg: "training-2-starter", total: 3500 });
  assert.equal(JSON.parse(booking.pricing_json).trainingQuoteId, held.quote.quoteId, "the booking is bound to the server quote it consumed");
  assert.deepEqual({ ...f.sqlite.prepare("SELECT status,used_booking_id FROM training_commercial_quotes WHERE id=?").get(held.quote.quoteId) }, { status: "used", used_booking_id: result.bookingId });

  const payment = f.sqlite.prepare("SELECT method,mode,status,amount_due_now FROM booking_payments WHERE booking_id=?").get(result.bookingId);
  assert.deepEqual({ ...payment }, { method: "internal_uat", mode: "split", status: "created", amount_due_now: 1750 }, "the client sends an unproven payment as created; nothing promotes it");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM training_quote_payment_attestations").get().n, 0, "no capture was manufactured for the quote");
  assert.ok(!f.calls.some((call) => call.path === "/api/training-payment-sandbox"), "booking creation never touches the legacy sandbox-capture endpoint");
  const sent = f.calls.find((call) => call.method === "POST" && call.path === "/api/canonical-bookings").body;
  assert.deepEqual({ service: sent.serviceCode, quote: sent.pricing.trainingQuoteId, payment: sent.payment }, { service: "dog_training", quote: held.quote.quoteId, payment: { method: "internal_uat", mode: "split", status: "created", detail: "Training checkout awaiting verified provider capture" } });

  const replay = await clients.booking.createCanonicalTrainingBooking(bookingInput(held));
  assert.deepEqual({ bookingId: replay.bookingId, duplicatePrevented: replay.duplicatePrevented }, { bookingId: result.bookingId, duplicatePrevented: true });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 1, "a double submit with the same key does not create a second booking");
});

test("a payment-pending Training booking holds the trainer without dispatching them until the shared payment page verifies", async (t) => {
  const f = await signedInCustomer(t);
  const held = await holdProgramme(f, { packageCode: "training-4-puppy", paymentMode: "prepaid" });
  const result = await clients.booking.createCanonicalTrainingBooking(bookingInput(held));
  assert.equal(result.status, "payment_pending", "the customer is sent to the payment page rather than shown a confirmation");
  assert.equal(f.sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(result.bookingId).status, "payment_pending", "the trainer is not dispatched on an unverified payment");
  assert.deepEqual(
    f.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number").all(held.schedule.groupId).map((row) => row.status),
    ["assigned", "assigned", "assigned", "assigned"],
    "every programme slot stays held for the customer while verification completes",
  );
  assert.deepEqual({ ...f.sqlite.prepare("SELECT mode,status,amount_due_now FROM booking_payments WHERE booking_id=?").get(result.bookingId) }, { mode: "prepaid", status: "created", amount_due_now: 6000 });
  const account = await clients.account.loadCustomerAccount();
  assert.deepEqual(account.bookings.map((booking) => ({ id: booking.id, status: booking.status })), [{ id: result.bookingId, status: "payment_pending" }], "the customer's own account shows the hold as unpaid, not confirmed");
});

test("Training customer confirmation materializes one programme session per reserved slot through the route", async (t) => {
  const f = await signedInCustomer(t);
  const held = await holdProgramme(f);
  const booked = await clients.booking.createCanonicalTrainingBooking(bookingInput(held));
  const programme = await clients.programme.materializeTrainingProgramme({ bookingId: booked.bookingId });
  assert.equal(programme.duplicatePrevented, false);
  assert.equal(programme.sessions.length, held.quote.sessions);
  const reservationIds = f.sqlite.prepare("SELECT id FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number").all(held.schedule.groupId).map((row) => row.id);
  assert.deepEqual(programme.sessions.map((session) => session.schedule_reservation_id), reservationIds, "each programme session is the reservation the customer held");
  assert.equal(programme.programme.provider_id, held.schedule.provider.id);
  assert.equal(f.calls.at(-1).path, "/api/training-programmes");
});

test("a held quote is spendable only while it still matches what is on screen, and location refusals fail closed", () => {
  const { trainingQuoteKey, trainingQuoteSpendable, trainingLocationPincode, trainingLocationZone } = clients.guards;
  const base = { scheduledStart: "2026-11-04T05:30:00.000Z", packageCode: "training-2-starter", paymentMode: "split", petIds: ["PET-B", "PET-A"] };
  const key = trainingQuoteKey(base);
  assert.equal(trainingQuoteKey({ ...base, petIds: ["PET-A", "PET-B"] }), key, "selecting the same dogs in another order is the same quote");
  for (const change of [{ petIds: ["PET-A"] }, { paymentMode: "prepaid" }, { packageCode: "training-4-puppy" }, { scheduledStart: "2026-11-05T05:30:00.000Z" }]) {
    assert.notEqual(trainingQuoteKey({ ...base, ...change }), key, `${JSON.stringify(change)} is a different quote`);
  }
  assert.equal(trainingQuoteSpendable({ hasQuote: true, quotedKey: key, currentKey: key }), true);
  assert.equal(trainingQuoteSpendable({ hasQuote: true, quotedKey: key, currentKey: trainingQuoteKey({ ...base, paymentMode: "prepaid" }) }), false, "a stale price is not spendable against new selections");
  assert.equal(trainingQuoteSpendable({ hasQuote: true, quotedKey: "", currentKey: key }), false);
  assert.equal(trainingQuoteSpendable({ hasQuote: false, quotedKey: key, currentKey: key }), false);

  assert.equal(trainingLocationPincode({ cityId: "maa", addresses: [{ postalCode: "600001", isDefault: true }] }).ok, false, "Dog Training is Bengaluru-only");
  assert.equal(trainingLocationPincode({ cityId: "blr", addresses: [] }).ok, false);
  assert.deepEqual(trainingLocationPincode({ cityId: "blr", addresses: [{ postalCode: "560 038", isDefault: false }, { postalCode: "560001", isDefault: true }] }), { ok: true, pincode: "560001" });
  assert.equal(trainingLocationZone(null, "560001").ok, false, "an unknown zone refuses rather than defaulting");
  assert.equal(trainingLocationZone({ zoneId: "blr-north", zoneName: "North", serviceAvailable: false }, "560001").ok, false);
  assert.deepEqual(trainingLocationZone({ zoneId: "blr-east", zoneName: "East", serviceAvailable: true }, "560038"), { ok: true, zoneId: "blr-east", zoneName: "East" });
});

test("Training customer route never quotes an empty selection, and explains the dead ends it skips", async (t) => {
  const f = await signedInCustomer(t);
  await assert.rejects(clients.commercial.quoteTraining({ packageCode: "training-2-starter", petCount: 0, scheduledStart: futureWindow().scheduledStart, paymentMode: "split" }), /Training supports 1-4 pets per programme/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes").get().n, 0, "a 0-pet quote is never persisted, which is why the page must not request one");
  /*
   * The ONE source-text assertion this file keeps: the copy shown instead of a dead confirm button
   * lives in JSX rendered after the account loads, which react-dom/server (initial state only) cannot
   * reach. The refusal it explains is proven above.
   */
  const page = readFileSync(new URL("../app/training/page.tsx", import.meta.url), "utf8");
  for (const copy of ["No dogs on your profile yet", "Select at least one of your dogs to continue"]) assert.ok(page.includes(copy), copy);
});
