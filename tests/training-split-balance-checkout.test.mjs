/*
 * Dog Training 50% split: the customer can pay the remaining balance through checkout.
 *
 * Staging master run 36224833520: after the Starter Plan deposit (₹1,750 of ₹3,500) was captured through
 * Razorpay, the V2 booking page read "Payment: captured" with no way to pay the rest. Customer checkout
 * prices from the split schedule (lib/payment-stage-amount), and only Boarding and Pet Sitting wrote one,
 * so a Training split looked settled after its deposit. The booking now records its balance, due at the
 * final session (which the lifecycle refuses until FULLY_PAID), and the sandbox balance path settles it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const commercial = await import("../lib/training-commercial-governance.ts");
const { paymentStageAmount } = await import("../lib/payment-stage-amount.ts");

const TRAINER = "train_kiran";
const CUSTOMER = { id: "CUST-TRN-SPLIT", name: "Meera Iyer", phone: "+919900000811", pet: "PET-TRN-SPLIT" };
const PACKAGE = "training-2-starter";
const DAY = 24 * 60 * 60_000;

function futureStart(days) {
  const start = new Date(Date.now() + days * DAY);
  start.setUTCHours(5, 30, 0, 0);
  return start;
}

async function bookStarter(t, paymentMode, beforeBooking = async () => {}) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  await seedOwnedPet(ctx.db, CUSTOMER.id, CUSTOMER.pet, "Bruno");
  const cookie = await sessionCookie(ctx.db, "customer", CUSTOMER.id, `customer:${CUSTOMER.id}`);
  const start = futureStart(4);
  const quoted = await routeCall("../../app/api/training-commercial/route.ts", "POST", "/api/training-commercial", { packageCode: PACKAGE, petCount: 1, scheduledStart: start.toISOString(), paymentMode });
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  const quote = quoted.body.data;
  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: `trn-split-${quote.quoteId}`, customerId: CUSTOMER.id, petIds: [CUSTOMER.pet],
    serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east",
    serviceAddress: "14 Indiranagar 100 Feet Road, Bengaluru", servicePincode: "560038",
    scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
    occurrences: quote.sessions, cadenceDays: 7, preferredProviderId: TRAINER,
  }, cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  await beforeBooking(ctx, quote);
  const booked = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", {
    idempotencyKey: `training-split:${quote.quoteId}`, scheduleGroupId: scheduled.body.data.groupId,
    customer: { id: CUSTOMER.id, name: CUSTOMER.name, primaryPhone: CUSTOMER.phone },
    pets: [{ sourceId: CUSTOMER.pet, name: "Bruno", species: "dog", breed: "Indie", vaccinationStatus: "verified" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", packageCode: quote.packageCode, packageName: quote.packageName,
    scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
    provider: scheduled.body.data.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "payment_link", mode: quote.paymentMode, status: "created", detail: "Awaiting a verified payment event" },
    pricing: { discount: 0, trainingQuoteId: quote.quoteId },
  }, cookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  return { ctx, quote, start, bookingId: booked.body.data.bookingId };
}

test("a Training split booking owes its balance to checkout after the deposit, due at the final session", async (t) => {
  const { ctx, quote, start, bookingId } = await bookStarter(t, "split");
  assert.equal(quote.totalAmount, 3500);
  assert.equal(quote.amountDueNow, 1750);

  const schedule = ctx.sqlite.prepare("SELECT * FROM stay_payment_schedules WHERE booking_id=?").get(bookingId);
  assert.ok(schedule, "the split schedule is written with the booking");
  assert.equal(schedule.service_code, "dog_training");
  assert.equal(schedule.paid_now_amount, 1750);
  assert.equal(schedule.balance_amount, 1750);
  assert.equal(schedule.status, "pending_balance");
  assert.equal(schedule.balance_due_at, start.getTime() + 7 * DAY, "the balance is due when the final session starts");

  const deposit = await paymentStageAmount(ctx.db, bookingId);
  assert.equal(deposit.stage, "first_instalment");
  assert.equal(deposit.dueNow, 1750, "checkout opens the deposit, not the whole programme");

  ctx.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run(bookingId);
  const balance = await paymentStageAmount(ctx.db, bookingId);
  assert.equal(balance.stage, "outstanding_balance", "a captured deposit no longer reads as settled");
  assert.equal(balance.dueNow, 1750);
});

test("the sandbox balance attestation settles the checkout schedule, so the balance is never offered twice", async (t) => {
  // The sandbox deposit is attested on the open quote, before the booking consumes it (as the app does).
  const { ctx, quote, bookingId } = await bookStarter(t, "split", (world, open) => commercial.captureTrainingQuoteSandbox(world.db, { quoteId: open.quoteId, amount: 1750, paymentKey: "split-deposit-key" }));
  ctx.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run(bookingId);
  assert.equal((await paymentStageAmount(ctx.db, bookingId)).stage, "outstanding_balance");

  const paid = await commercial.collectTrainingRemainingBalanceSandbox(ctx.db, { quoteId: quote.quoteId, amount: 1750, paymentKey: "split-balance-key" });
  assert.equal(paid.status, "FULLY_PAID");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM stay_payment_schedules WHERE booking_id=?").get(bookingId).status, "paid");
  const settled = await paymentStageAmount(ctx.db, bookingId);
  assert.equal(settled.stage, "settled");
  assert.equal(settled.dueNow, 0);

  const replay = await commercial.collectTrainingRemainingBalanceSandbox(ctx.db, { quoteId: quote.quoteId, amount: 1750, paymentKey: "split-balance-key" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(ctx.sqlite.prepare("SELECT count(*) n FROM stay_payment_schedules WHERE booking_id=?").get(bookingId).n, 1);
});

test("a prepaid Training booking has no split schedule and is settled once captured", async (t) => {
  const { ctx, bookingId } = await bookStarter(t, "prepaid");
  const tableExists = ctx.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='stay_payment_schedules'").get().n === 1;
  assert.equal(tableExists ? ctx.sqlite.prepare("SELECT count(*) n FROM stay_payment_schedules WHERE booking_id=?").get(bookingId).n : 0, 0);
  ctx.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run(bookingId);
  assert.equal((await paymentStageAmount(ctx.db, bookingId)).stage, "settled");
});
