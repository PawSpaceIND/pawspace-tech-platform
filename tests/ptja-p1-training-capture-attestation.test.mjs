import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// PTJA-P1-F32 — the Training programme booking never obtained the server capture it declared.
//
// MEASURED in a browser, driving app/training/page.tsx end to end with a real customer, pet, address
// and published trainer roster, on the 4-session "Puppy Training Plan":
//
//   POST /api/uat-scheduling     -> 200  {"status":"assigned","provider":{"id":"train_kiran"}}
//   POST /api/canonical-bookings -> 409  {"error":"Training quote requires server-confirmed sandbox
//                                          capture before programme booking"}
//   ...with the body it sent carrying
//     "payment":{"status":"captured","detail":"Training UAT sandbox capture marker; live money disabled"}
//
// No request to /api/training-payment-sandbox was made at any point. The server is RIGHT to refuse —
// lib/training-commercial-governance.ts requires a real attestation row and will not take the client's
// word for it. The client is what is broken, and it is broken for every non-Meet-&-Greet Training
// booking a customer can make: the journey cannot complete at all.
//
// Two causes, one class — a self-declared value being read as evidence:
//
//  1. lib/training-booking-client.ts POSTs /api/canonical-bookings itself, with a hardcoded
//     status:"captured" marker, never passing through the attestation step at all.
//  2. lib/canonical-lifecycle-client.ts DOES have that step, but gated on
//     `input.payment.status!=="captured"` — so any caller that pre-labels its own payment "captured"
//     silently skips the capture that label is supposed to stand for. The client's claim about itself
//     decided whether the claim would be checked.
//
// These drive the REAL exported client functions with a stubbed fetch and assert the request sequence.
// ---------------------------------------------------------------------------
installWorkersHooks("__TRAINING_CAPTURE_DB__");

const CAPTURE_URL = "/api/training-payment-sandbox";
const BOOKING_URL = "/api/canonical-bookings";

/** Records every request in order and answers each endpoint with its real success envelope. */
function stubFetch({ captureStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, headers: init.headers ?? {} });
    if (path === CAPTURE_URL) {
      if (captureStatus !== 200) return new Response(JSON.stringify({ error: "Training quote expired before sandbox capture" }), { status: captureStatus, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: { quoteId: body.quoteId, status: "captured", amount: body.amount, currency: "INR", environment: "sandbox", reference: "TRN-UAT-PAY-DEADBEEF", duplicatePrevented: false, liveMoney: false, synthetic: true } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { bookingId: "PS-UAT-TEST", customerId: "CUS-1", petIds: ["PET-1"], scheduleGroupId: "SG-1", workOrderId: "WO-1", paymentId: "PAY-1", status: "confirmed", duplicatePrevented: false } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

const trainingQuote = (overrides = {}) => ({
  quoteId: "TQ-CAPTURE-1", packageCode: "training-4-puppy", packageName: "Puppy Training Plan",
  sessions: 4, validityDays: 31, petCount: 1, minutesPerSession: 60,
  totalAmount: 6000, amountDueNow: 3000, discount: 0, paymentMode: "split", meetAndGreet: false,
  ...overrides,
});

const bookingArgs = (quote) => ({
  idempotencyKey: "training:TQ-CAPTURE-1:CUS-1", scheduleGroupId: "training:TQ-CAPTURE-1:CUS-1",
  trainingQuote: quote,
  customer: { id: "CUS-1", name: "Demo Customer", primaryPhone: "9812345678" },
  pets: [{ sourceId: "account-1", name: "Bruno", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "verified" }],
  cityId: "blr", zoneId: "blr-east",
  scheduledStart: "2026-11-04T10:00:00+05:30", scheduledEnd: "2026-11-04T11:00:00+05:30",
  provider: { id: "train_kiran", name: "Kiran S.", model: "commission" },
});

// --- the customer-facing Training path ---------------------------------------------------------

test("P1-C01 a Training programme booking obtains the server sandbox capture before booking", async () => {
  const calls = stubFetch();
  const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");
  await createCanonicalTrainingBooking(bookingArgs(trainingQuote()));

  const paths = calls.map((call) => call.path);
  assert.deepEqual(paths, [CAPTURE_URL, BOOKING_URL],
    `the capture must happen, and happen first: ${JSON.stringify(paths)}`);

  const capture = calls[0];
  assert.equal(capture.body.quoteId, "TQ-CAPTURE-1", "the capture is bound to the quote being spent");
  assert.equal(capture.body.amount, 3000, "for the amount the quote says is due now, not the total");
  assert.ok(String(capture.headers["x-payment-capture-key"] || "").length > 0,
    "the capture carries a payment key, so a replay cannot be mistaken for a second payment");
});

test("P1-C02 the booking reports the payment the SERVER attested, not a marker the client wrote", async () => {
  const calls = stubFetch();
  const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");
  await createCanonicalTrainingBooking(bookingArgs(trainingQuote()));

  const booking = calls.find((call) => call.path === BOOKING_URL);
  assert.equal(booking.body.payment.status, "captured");
  assert.match(booking.body.payment.detail, /TRN-UAT-PAY-DEADBEEF/,
    "the detail carries the server's own capture reference");
  assert.doesNotMatch(booking.body.payment.detail, /^Training UAT sandbox capture marker/,
    "and is not the self-declared marker the server refused");
});

test("P1-C03 nothing is booked when the capture fails", async () => {
  const calls = stubFetch({ captureStatus: 409 });
  const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");
  await assert.rejects(() => createCanonicalTrainingBooking(bookingArgs(trainingQuote())),
    /expired before sandbox capture/, "the customer sees why, in the server's own words");
  assert.deepEqual(calls.map((call) => call.path), [CAPTURE_URL],
    "an unproven payment must never reach the booking endpoint");
});

test("P1-C04 Trainer Meet & Greet is not sandbox-captured", async () => {
  // The server refuses to capture a Meet & Greet quote at all — it stays pending until a verified
  // payment event — so attempting one would replace a working flow with a 409.
  const calls = stubFetch();
  const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");
  await createCanonicalTrainingBooking(bookingArgs(trainingQuote({
    quoteId: "TQ-MEET-1", packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet",
    sessions: 1, totalAmount: 500, amountDueNow: 500, paymentMode: "prepaid", meetAndGreet: true,
  })));
  assert.deepEqual(calls.map((call) => call.path), [BOOKING_URL], "Meet & Greet books without a capture");
});

// --- the shared lifecycle client, which made the above possible ---------------------------------

const lifecycleInput = (overrides = {}) => ({
  idempotencyKey: "lc-1", scheduleGroupId: "SG-LC-1",
  customer: { id: "CUS-1", name: "Demo Customer", primaryPhone: "9812345678" },
  pets: [{ sourceId: "account-1", name: "Bruno", species: "dog" }],
  cityId: "blr", zoneId: "blr-east",
  serviceCode: "dog_training", packageCode: "training-4-puppy", packageName: "Puppy Training Plan",
  scheduledStart: "2026-11-04T10:00:00+05:30", scheduledEnd: "2026-11-04T11:00:00+05:30",
  provider: { id: "train_kiran", name: "Kiran S.", model: "commission" },
  totalAmount: 6000, amountDueNow: 3000,
  payment: { method: "upi", mode: "split", status: "created", detail: "customer app" },
  pricing: { discount: 0, trainingQuoteId: "TQ-CAPTURE-1" },
  ...overrides,
});

test("P1-C05 a caller that already declared its own payment captured is still made to prove it", async () => {
  const calls = stubFetch();
  const { createCanonicalLifecycle } = await import("../lib/canonical-lifecycle-client.ts");
  await createCanonicalLifecycle(lifecycleInput({
    payment: { method: "internal_uat", mode: "split", status: "captured", detail: "Training UAT sandbox capture marker; live money disabled" },
  }));
  assert.deepEqual(calls.map((call) => call.path), [CAPTURE_URL, BOOKING_URL],
    "a client-declared 'captured' is not evidence and must not skip the capture");
});

test("P1-C06 a Training programme with no server quote is not sent to the capture endpoint", async () => {
  // Without a quote id there is nothing to capture against; the server refuses the booking for that
  // reason instead, and it must be allowed to.
  const calls = stubFetch();
  const { createCanonicalLifecycle } = await import("../lib/canonical-lifecycle-client.ts");
  await createCanonicalLifecycle(lifecycleInput({ pricing: { discount: 0 } }));
  assert.deepEqual(calls.map((call) => call.path), [BOOKING_URL]);
});

test("P1-C07 other services are never sent to the Training capture endpoint", async () => {
  const { createCanonicalLifecycle } = await import("../lib/canonical-lifecycle-client.ts");
  for (const serviceCode of ["grooming", "boarding", "pet_sitting"]) {
    const calls = stubFetch();
    await createCanonicalLifecycle(lifecycleInput({ serviceCode, pricing: { discount: 0, trainingQuoteId: "TQ-CAPTURE-1" } }));
    assert.deepEqual(calls.map((call) => call.path), [BOOKING_URL], `${serviceCode} must not capture a Training quote`);
  }
});
