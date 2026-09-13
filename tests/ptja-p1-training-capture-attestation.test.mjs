import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// Verify-first regression contract: customer Training checkout may create the canonical booking hold,
// but must never synthesize a capture. The booking starts payment_pending and only signed provider
// capture evidence may advance it to confirmed.
installWorkersHooks("__TRAINING_CAPTURE_DB__");

const BOOKING_URL = "/api/canonical-bookings";
const CAPTURE_URL = "/api/training-payment-sandbox";

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, headers: init.headers ?? {} });
    if (path === CAPTURE_URL) throw new Error("customer checkout must not invoke the legacy Training sandbox capture endpoint");
    return new Response(JSON.stringify({ data: { bookingId: "PS-UAT-TEST", customerId: "CUS-1", petIds: ["PET-1"], scheduleGroupId: "SG-1", workOrderId: "WO-1", paymentId: "PAY-1", status: "payment_pending", duplicatePrevented: false } }), { status: 200, headers: { "content-type": "application/json" } });
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

test("P1-C01 Training creates a payment-pending booking without synthetic capture", async () => {
  const calls = stubFetch();
  const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");
  const result = await createCanonicalTrainingBooking(bookingArgs(trainingQuote()));
  assert.deepEqual(calls.map((call) => call.path), [BOOKING_URL]);
  assert.equal(result.status, "payment_pending");
});

test("P1-C02 Training submits only an unproven created payment to canonical booking", async () => {
  const calls = stubFetch();
  const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");
  await createCanonicalTrainingBooking(bookingArgs(trainingQuote()));
  const booking = calls[0];
  assert.equal(booking.body.payment.status, "created");
  assert.equal(booking.body.payment.mode, "split");
  assert.doesNotMatch(booking.body.payment.detail, /captured/i);
});

test("P1-C03 shared lifecycle never turns a caller-declared capture into proof", async () => {
  const calls = stubFetch();
  const { createCanonicalLifecycle } = await import("../lib/canonical-lifecycle-client.ts");
  await createCanonicalLifecycle({
    idempotencyKey: "lc-1", scheduleGroupId: "SG-LC-1",
    customer: { id: "CUS-1", name: "Demo Customer", primaryPhone: "9812345678" },
    pets: [{ sourceId: "account-1", name: "Bruno", species: "dog" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training",
    packageCode: "training-4-puppy", packageName: "Puppy Training Plan",
    scheduledStart: "2026-11-04T10:00:00+05:30", scheduledEnd: "2026-11-04T11:00:00+05:30",
    provider: { id: "train_kiran", name: "Kiran S.", model: "commission" },
    totalAmount: 6000, amountDueNow: 3000,
    payment: { method: "internal_uat", mode: "split", status: "captured", detail: "caller claim" },
    pricing: { discount: 0, trainingQuoteId: "TQ-CAPTURE-1" },
  });
  assert.deepEqual(calls.map((call) => call.path), [BOOKING_URL]);
  assert.equal(calls[0].body.payment.status, "captured", "transport preserves input; the server demotes unverified customer claims");
});

test("P1-C04 all Training packages use the same verify-first booking path", async () => {
  for (const quote of [trainingQuote(), trainingQuote({ quoteId: "TQ-MEET-1", packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet", sessions: 1, totalAmount: 500, amountDueNow: 500, paymentMode: "prepaid", meetAndGreet: true })]) {
    const calls = stubFetch();
    const { createCanonicalTrainingBooking } = await import("../lib/training-booking-client.ts");
    await createCanonicalTrainingBooking(bookingArgs(quote));
    assert.deepEqual(calls.map((call) => call.path), [BOOKING_URL]);
  }
});
