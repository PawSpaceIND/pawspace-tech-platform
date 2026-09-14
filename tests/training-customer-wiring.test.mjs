/*
 * Training customer checkout wiring, executed against the real routes and a real database.
 *
 * This file used to assert that app/training/page.tsx and lib/training-booking-client.ts CONTAINED
 * tokens such as `createCanonicalTrainingBooking`, `liveMoney:false` and `petCount>0?quoteTraining`.
 * That proved the tokens were typed, not that a customer is quoted by the server, booked as
 * themselves, or refused when they try to book somebody else's dog. Every case below executes the
 * client module against a captured fetch, or the governed routes against SQLite through the D1
 * adapter, and reads what was persisted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const commercial = await import("../lib/training-commercial-governance.ts");
const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");

const TRAINER = "train_kiran";
const CUSTOMER = { id: "CUST-TRN-WIRE", name: "Meera Iyer", phone: "+919900000701", pet: "PET-TRN-WIRE" };
const STRANGER = { id: "CUST-TRN-OTHER", name: "Other Person", phone: "+919900000702", pet: "PET-TRN-OTHER" };
const HOUR = 60 * 60_000, DAY = 24 * HOUR;

function futureStart(days = 5) {
  const start = new Date(Date.now() + days * DAY);
  start.setUTCHours(5, 30, 0, 0);
  return start;
}

async function customerWorld(t) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  await seedOwnedPet(ctx.db, CUSTOMER.id, CUSTOMER.pet, "Bruno");
  await seedOwnedPet(ctx.db, STRANGER.id, STRANGER.pet, "Pepper");
  const cookie = await sessionCookie(ctx.db, "customer", CUSTOMER.id, `customer:${CUSTOMER.id}`);
  return { ...ctx, cookie };
}

const schedulePayload = (quote, start, overrides = {}) => ({
  clientRequestId: `trn-wire-${quote.quoteId}`, customerId: CUSTOMER.id, petIds: [CUSTOMER.pet],
  serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east",
  serviceAddress: "14 Indiranagar 100 Feet Road, Bengaluru", servicePincode: "560038",
  scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
  occurrences: quote.sessions, cadenceDays: 7, preferredProviderId: TRAINER,
  ...overrides,
});

const bookingPayload = (quote, scheduled, start, overrides = {}) => ({
  idempotencyKey: `training:${quote.quoteId}:${CUSTOMER.id}`, scheduleGroupId: scheduled.body.data.groupId,
  customer: { id: CUSTOMER.id, name: CUSTOMER.name, primaryPhone: CUSTOMER.phone },
  pets: [{ sourceId: CUSTOMER.pet, name: "Bruno", species: "dog", breed: "Indie", vaccinationStatus: "verified" }],
  cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", packageCode: quote.packageCode, packageName: quote.packageName,
  scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
  provider: scheduled.body.data.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
  payment: { method: "internal_uat", mode: quote.paymentMode, status: "created", detail: "Training checkout awaiting verified provider capture" },
  pricing: { discount: quote.discount, trainingQuoteId: quote.quoteId },
  ...overrides,
});

const schedule = (ctx, quote, start, overrides) => routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", schedulePayload(quote, start, overrides), ctx.cookie);
const book = (ctx, payload, cookie) => routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", payload, cookie ?? ctx.cookie);

// --- lib/training-booking-client.ts ------------------------------------------------------------

test("the Training client books through the canonical lifecycle with a server quote and an unproven payment", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ path: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    if (String(url) === "/api/training-payment-sandbox") throw new Error("customer checkout must never manufacture a Training capture");
    return Response.json({ data: { bookingId: "PS-1", customerId: CUSTOMER.id, petIds: ["PET-1"], scheduleGroupId: "SG-1", workOrderId: "WO-1", paymentId: "PAY-1", status: "payment_pending", duplicatePrevented: false } });
  };
  try {
    const quote = { quoteId: "TQ-CLIENT", packageCode: "training-4-puppy", packageName: "Puppy Training Plan", sessions: 4, validityDays: 31, petCount: 1, minutesPerSession: 60, totalAmount: 6000, amountDueNow: 3000, discount: 0, paymentMode: "split", meetAndGreet: false };
    const result = await createCanonicalTrainingBooking({
      idempotencyKey: "training:TQ-CLIENT:C1", scheduleGroupId: "training:TQ-CLIENT:C1", trainingQuote: quote,
      customer: { id: "C1", name: "Demo", primaryPhone: "9812345678" },
      pets: [{ sourceId: "acct-1", name: "Bruno", species: "cat", breed: "Indie" }],
      cityId: "blr", zoneId: "blr-east", scheduledStart: "2026-11-04T10:00:00+05:30", scheduledEnd: "2026-11-04T11:00:00+05:30",
      provider: { id: TRAINER, name: "Kiran S.", model: "commission" },
    });
    assert.deepEqual(calls.map((call) => call.path), ["/api/canonical-bookings"], "one governed call, never the legacy sandbox capture");
    const sent = calls[0].body;
    assert.equal(sent.serviceCode, "dog_training");
    assert.equal(sent.pricing.trainingQuoteId, "TQ-CLIENT", "the server quote id travels with the booking");
    assert.deepEqual({ total: sent.totalAmount, dueNow: sent.amountDueNow }, { total: 6000, dueNow: 3000 }, "amounts are the quote's, not retyped");
    assert.deepEqual(sent.payment, { method: "internal_uat", mode: "split", status: "created", detail: "Training checkout awaiting verified provider capture" }, "the client declares no capture of its own");
    assert.equal(sent.pets[0].species, "dog", "Training is a dogs-only service whatever the pet record says");
    assert.equal(result.liveMoney, false);
    assert.equal(result.status, "payment_pending");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- the governed server path ------------------------------------------------------------------

test("a Training booking needs a server quote and the reserved window, starts payment-pending and never books a client-declared capture", async (t) => {
  const ctx = await customerWorld(t);
  const start = futureStart();
  const quote = await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: start.toISOString(), paymentMode: "split" });
  assert.equal(quote.sessions, 2);
  const scheduled = await schedule(ctx, quote, start);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  assert.equal(scheduled.body.data.provider.id, TRAINER);
  const reservations = () => ctx.sqlite.prepare("SELECT scheduled_start,scheduled_end,occurrence_number,status FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number").all(scheduled.body.data.groupId);
  assert.equal(reservations().length, 2, "one reservation per quoted session");
  assert.equal(Date.parse(reservations()[1].scheduled_start) - Date.parse(reservations()[0].scheduled_start), 7 * DAY, "sessions run a week apart");

  const bookings = () => ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(CUSTOMER.id).n;
  const noQuote = await book(ctx, bookingPayload(quote, scheduled, start, { pricing: { discount: 0 } }));
  assert.equal(noQuote.status, 409, JSON.stringify(noQuote.body));
  assert.match(noQuote.body.error, /server Training quote is required/);
  const forged = await book(ctx, bookingPayload(quote, scheduled, start, { totalAmount: 1, amountDueNow: 1 }));
  assert.equal(forged.status, 409, "a client-restated price never books");
  const shifted = await book(ctx, bookingPayload(quote, scheduled, start, { scheduledStart: new Date(start.getTime() + HOUR).toISOString(), scheduledEnd: new Date(start.getTime() + 2 * HOUR).toISOString() }));
  assert.equal(shifted.status, 409, JSON.stringify(shifted.body));
  assert.match(shifted.body.error, /booking window does not match the (scheduling reservation|first reserved session)/);
  assert.equal(bookings(), 0, "every refusal left nothing behind");

  // Verify-first: the booking is HELD, not confirmed. No deposit has been attested against this quote,
  // and the client's payload does not claim one; the hold waits for verified provider capture evidence.
  const booked = await book(ctx, bookingPayload(quote, scheduled, start));
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const bookingId = booked.body.data.bookingId;
  assert.equal(booked.body.data.status, "payment_pending");
  const persisted = ctx.sqlite.prepare("SELECT customer_id,service_code,package_code,total_amount,status,provider_id FROM canonical_bookings WHERE id=?").get(bookingId);
  assert.deepEqual({ ...persisted }, { customer_id: CUSTOMER.id, service_code: "dog_training", package_code: "training-2-starter", total_amount: quote.totalAmount, status: "payment_pending", provider_id: TRAINER });
  const payment = ctx.sqlite.prepare("SELECT status,method,mode,amount_due_now FROM booking_payments WHERE booking_id=?").get(bookingId);
  assert.deepEqual({ ...payment }, { status: "created", method: "internal_uat", mode: "split", amount_due_now: quote.amountDueNow });
  assert.equal(ctx.sqlite.prepare("SELECT used_booking_id FROM training_commercial_quotes WHERE id=?").get(quote.quoteId).used_booking_id, bookingId, "the quote is consumed by exactly this booking");
  assert.equal(ctx.sqlite.prepare("SELECT booking_id FROM training_booking_quote_links WHERE quote_id=?").get(quote.quoteId).booking_id, bookingId);
  assert.equal((await commercial.trainingQuotePaymentState(ctx.db, quote.quoteId)).status, "UNPAID", "booking did not manufacture a payment attestation");

  const replay = await book(ctx, bookingPayload(quote, scheduled, start));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(bookings(), 1, "a replay never books twice");
  const reused = await book(ctx, bookingPayload(quote, scheduled, start, { idempotencyKey: `training:${quote.quoteId}:${CUSTOMER.id}:again`, scheduleGroupId: `${scheduled.body.data.groupId}-again` }));
  assert.equal(reused.status, 409, "a consumed quote cannot buy a second programme");

  // A tampered client that DECLARES an online capture is recorded as unproven: the server demotes it.
  const second = await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: futureStart(20).toISOString(), paymentMode: "prepaid" });
  const secondStart = futureStart(20); // clear of the first programme, whose second session sits a week after its first
  const secondSchedule = await schedule(ctx, second, secondStart);
  assert.equal(secondSchedule.status, 200, JSON.stringify(secondSchedule.body));
  const claimed = await book(ctx, bookingPayload(second, secondSchedule, secondStart, { payment: { method: "upi", mode: "prepaid", status: "captured", detail: "caller claim" } }));
  assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
  assert.equal(claimed.body.data.status, "payment_pending");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(claimed.body.data.bookingId).status, "created", "a caller-declared capture is demoted until a gateway proves it");

  // The Training checkout method itself carries no gateway proof, so a "captured" claim on it is
  // demoted the same way. This used to slip through the online-methods filter and confirm the booking.
  const third = await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: futureStart(34).toISOString(), paymentMode: "prepaid" });
  const thirdStart = futureStart(34);
  const thirdSchedule = await schedule(ctx, third, thirdStart);
  assert.equal(thirdSchedule.status, 200, JSON.stringify(thirdSchedule.body));
  const internal = await book(ctx, bookingPayload(third, thirdSchedule, thirdStart, { payment: { method: "internal_uat", mode: "prepaid", status: "captured", detail: "Training UAT sandbox capture marker" } }));
  assert.equal(internal.status, 201, JSON.stringify(internal.body));
  assert.equal(internal.body.data.status, "payment_pending", "no payment method lets a caller confirm their own Training booking");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(internal.body.data.bookingId).status, "created");
});

test("the scheduling gateway books only the signed-in customer's own dogs", async (t) => {
  const ctx = await customerWorld(t);
  const start = futureStart(6);
  const quote = await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: start.toISOString(), paymentMode: "prepaid" });
  // Refusals happen before the first reservation is ever written, so the table may not exist yet.
  const count = () => ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduling_reservations'").get()
    ? ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n : 0;

  const impersonated = await schedule(ctx, quote, start, { customerId: STRANGER.id, petIds: [STRANGER.pet] });
  assert.equal(impersonated.status, 403, JSON.stringify(impersonated.body));
  const strangersDog = await schedule(ctx, quote, start, { petIds: [STRANGER.pet] });
  assert.equal(strangersDog.status, 403, JSON.stringify(strangersDog.body));
  assert.match(strangersDog.body.error, /Pet ownership denied/);
  const unknownDog = await schedule(ctx, quote, start, { petIds: ["PET-NOBODY"] });
  assert.equal(unknownDog.status, 403);
  assert.equal(count(), 0, "no refused request held capacity");

  const own = await schedule(ctx, quote, start);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(count(), quote.sessions);
  assert.equal(ctx.sqlite.prepare("SELECT customer_id FROM scheduling_reservations WHERE group_id=?").get(own.body.data.groupId).customer_id, CUSTOMER.id, "the hold belongs to the session subject");

  // The same request from the stranger's session is refused as theirs, not silently rebound.
  const strangerCookie = await sessionCookie(ctx.db, "customer", STRANGER.id, `customer:${STRANGER.id}`);
  const asStranger = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", schedulePayload(quote, start), strangerCookie);
  assert.equal(asStranger.status, 403);
});

test("the pet count comes from the real selection and drives the server quote", async (t) => {
  const ctx = await customerWorld(t);
  const start = futureStart(7).toISOString();
  const refusal = async (petCount, pattern) => {
    let caught;
    try { await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount, scheduledStart: start, paymentMode: "prepaid" }); } catch (error) { caught = error; }
    assert.ok(caught instanceof Response, `${petCount} pets must be refused with a Response`);
    assert.equal(caught.status, 409);
    assert.match(await caught.text(), pattern);
  };
  await refusal(0, /Training supports 1-4 pets per programme/);
  await refusal(5, /Training supports 1-4 pets per programme/);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes").get().n, 0, "an empty or oversized selection is never quoted");
  const one = await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: start, paymentMode: "prepaid" });
  const two = await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount: 2, scheduledStart: start, paymentMode: "prepaid" });
  assert.equal(one.petCount, 1);
  assert.equal(two.petCount, 2);
  assert.equal(two.minutesPerSession, 2 * one.minutesPerSession, "two dogs double the governed session length");
  assert.equal(one.amountDueNow, one.totalAmount, "prepaid takes the whole plan up front");
});

test("the programme ledger holds exactly the quoted sessions at the quoted length and cadence", async (t) => {
  const ctx = await customerWorld(t);
  const start = futureStart(8);
  const quote = await commercial.createTrainingQuote(ctx.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: start.toISOString(), paymentMode: "split" });
  const scheduled = await schedule(ctx, quote, start);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  await commercial.captureTrainingQuoteSandbox(ctx.db, { quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: `ledger-${quote.quoteId}` });
  const booked = await book(ctx, bookingPayload(quote, scheduled, start));
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const bookingId = booked.body.data.bookingId;

  const programme = await routeCall("../../app/api/training-programmes/route.ts", "POST", "/api/training-programmes", { bookingId }, ctx.cookie);
  assert.equal(programme.status, 201, JSON.stringify(programme.body));
  const sessions = programme.body.data.sessions;
  assert.equal(sessions.length, quote.sessions, "occurrences come from the server quote");
  assert.equal(Number(programme.body.data.programme.total_sessions), quote.sessions);
  for (const session of sessions) {
    assert.equal(Date.parse(session.scheduled_end) - Date.parse(session.scheduled_start), quote.minutesPerSession * 60_000, "each session is the quoted length");
  }
  assert.equal(Date.parse(sessions[1].scheduled_start) - Date.parse(sessions[0].scheduled_start), 7 * DAY, "weekly cadence");
  assert.equal(sessions[0].scheduled_start, start.toISOString());
  assert.deepEqual(sessions.map((s) => s.status), ["scheduled", "locked"]);
  const strangerCookie = await sessionCookie(ctx.db, "customer", STRANGER.id, `customer:${STRANGER.id}`);
  const foreign = await routeCall("../../app/api/training-programmes/route.ts", "GET", `/api/training-programmes?bookingId=${bookingId}`, null, strangerCookie);
  assert.equal(foreign.status, 403, "the ledger is the booking customer's alone");
});

/*
 * One residual source pin. The Training page books for the SIGNED-IN customer; it once hardcoded
 * customer TST-101 and pets TST-PET-BRUNO/TST-PET-PEPPER, so every other customer got a 403 from the
 * session gateway (the refusal proven above). No server call can see what a page hardcodes, so this
 * one invariant stays as text - with comment lines stripped, because the fix's own comment names
 * the ids it removed.
 */
test("the Training page never books a fixture identity on behalf of a real customer", () => {
  const page = readFileSync(new URL("../app/training/page.tsx", import.meta.url), "utf8");
  const code = page.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const fixture of ["TST-101", "TST-PET-BRUNO", "TST-PET-PEPPER", "uat.customer@pawspace.test"]) {
    assert.equal(code.includes(fixture), false, `hardcoded fixture ${fixture} must not be booked for a real customer`);
  }
  assert.equal(code.includes("loadCustomerAccount"), true, "identity and pets come from the platform session");
});
