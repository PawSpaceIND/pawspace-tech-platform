/*
 * The complimentary Bath & Basic grooming on 8+ session Training plans (founder decision 26 Sep 2026).
 *
 * The audit found the bonus advertised on every 8+ session plan while nothing recorded it, so no customer
 * could ever redeem it. It is now issued once the programme is fully paid, as a one-time governed coupon
 * bound to that customer, for the Bath & Basic dog grooming package, valid for 90 days.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const commercial = await import("../lib/training-commercial-governance.ts");
const { ensureTrainingGroomingBonus } = await import("../lib/training-grooming-bonus.ts");
const { quoteCoupon } = await import("../lib/coupon-governance.ts");

const TRAINER = "train_kiran";
const CUSTOMER = { id: "CUST-TRN-BONUS", name: "Ravi Menon", phone: "+919900000821", pet: "PET-TRN-BONUS" };
const DAY = 24 * 60 * 60_000;

async function bookTraining(t, packageCode, { paid }) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  await seedOwnedPet(ctx.db, CUSTOMER.id, CUSTOMER.pet, "Bruno");
  const cookie = await sessionCookie(ctx.db, "customer", CUSTOMER.id, `customer:${CUSTOMER.id}`);
  const start = new Date(Date.now() + 4 * DAY);
  start.setUTCHours(5, 30, 0, 0);
  const quoted = await routeCall("../../app/api/training-commercial/route.ts", "POST", "/api/training-commercial", { packageCode, petCount: 1, scheduledStart: start.toISOString(), paymentMode: "prepaid" });
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  const quote = quoted.body.data;
  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: `trn-bonus-${quote.quoteId}`, customerId: CUSTOMER.id, petIds: [CUSTOMER.pet],
    serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east",
    serviceAddress: "14 Indiranagar 100 Feet Road, Bengaluru", servicePincode: "560038",
    scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
    occurrences: quote.sessions, cadenceDays: 7, preferredProviderId: TRAINER,
  }, cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  if (paid) await commercial.captureTrainingQuoteSandbox(ctx.db, { quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: `bonus-${quote.quoteId}` });
  const booked = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", {
    idempotencyKey: `training-bonus:${quote.quoteId}`, scheduleGroupId: scheduled.body.data.groupId,
    customer: { id: CUSTOMER.id, name: CUSTOMER.name, primaryPhone: CUSTOMER.phone },
    pets: [{ sourceId: CUSTOMER.pet, name: "Bruno", species: "dog", breed: "Indie", vaccinationStatus: "verified" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", packageCode: quote.packageCode, packageName: quote.packageName,
    scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
    provider: scheduled.body.data.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "payment_link", mode: "prepaid", status: paid ? "captured" : "created", detail: paid ? "Sandbox capture attested" : "Awaiting a verified payment event" },
    pricing: { discount: 0, trainingQuoteId: quote.quoteId },
  }, cookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  return { ctx, bookingId: booked.body.data.bookingId };
}

const groomingQuote = (ctx, code, customerId = CUSTOMER.id, packageCode = "dog-basic") => quoteCoupon(ctx.db, {
  code, customerId, serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode, orderValue: 1899, paymentMode: "full", isSubscription: false,
}, { liveApproved: false });

test("an 8-session plan's Bath & Basic voucher waits for full payment", async (t) => {
  const { ctx, bookingId } = await bookTraining(t, "training-8-basic", { paid: false });
  const bonus = await ensureTrainingGroomingBonus(ctx.db, { bookingId, liveCoupons: false });
  assert.equal(bonus.status, "awaiting_full_payment");
  assert.equal(bonus.code, null);
  assert.equal(bonus.value, 1899);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM coupon_campaigns WHERE id LIKE 'CPN-TRNBONUS-%'").get().n, 0, "no voucher exists before the programme is paid");
});

test("a fully paid 8-session plan issues one customer-bound Bath & Basic voucher for 90 days", async (t) => {
  const { ctx, bookingId } = await bookTraining(t, "training-8-basic", { paid: true });
  const now = Date.now();
  const bonus = await ensureTrainingGroomingBonus(ctx.db, { bookingId, now, liveCoupons: false });
  assert.equal(bonus.status, "issued");
  assert.match(bonus.code, /^BATH-[0-9A-F]{8}$/);
  assert.equal(bonus.validUntil, now + 90 * DAY);
  const again = await ensureTrainingGroomingBonus(ctx.db, { bookingId, liveCoupons: false });
  assert.equal(again.code, bonus.code, "issuing is idempotent per Training booking");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM coupon_campaigns WHERE id LIKE 'CPN-TRNBONUS-%'").get().n, 1);

  const own = await groomingQuote(ctx, bonus.code);
  assert.equal(own.valid, true, JSON.stringify(own));
  assert.equal(own.discount, 1899, "the Bath & Basic grooming is free");
  const stranger = await groomingQuote(ctx, bonus.code, "CUST-SOMEONE-ELSE");
  assert.equal(stranger.valid, false);
  assert.match(stranger.error, /belongs to another account/);
  const otherPackage = await groomingQuote(ctx, bonus.code, CUSTOMER.id, "dog-makeover");
  assert.equal(otherPackage.valid, false, "only the Bath & Basic package");
});

test("plans under 8 sessions carry no grooming voucher", async (t) => {
  const { ctx, bookingId } = await bookTraining(t, "training-2-starter", { paid: true });
  assert.equal(await ensureTrainingGroomingBonus(ctx.db, { bookingId, liveCoupons: false }), null);
});

test("an unused voucher is withdrawn when its programme is refunded or cancelled", async (t) => {
  const { ctx, bookingId } = await bookTraining(t, "training-8-basic", { paid: true });
  const issued = await ensureTrainingGroomingBonus(ctx.db, { bookingId, liveCoupons: false });
  assert.equal(issued.status, "issued");

  ctx.sqlite.prepare("UPDATE booking_payments SET status='refunded' WHERE booking_id=?").run(bookingId);
  const refunded = await ensureTrainingGroomingBonus(ctx.db, { bookingId, liveCoupons: false });
  assert.equal(refunded.status, "withdrawn", "a refunded programme no longer carries a free grooming");
  const refused = await groomingQuote(ctx, issued.code);
  assert.equal(refused.valid, false);

  ctx.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id=?").run(bookingId);
  assert.equal(await ensureTrainingGroomingBonus(ctx.db, { bookingId, liveCoupons: false }), null, "a cancelled programme shows no voucher");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM coupon_campaigns WHERE id=?").get(`CPN-TRNBONUS-${bookingId}`).status, "paused");
});
