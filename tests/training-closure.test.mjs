import test from "node:test";
import assert from "node:assert/strict";
import {
  freshTrainingWorld,
  futureTrainingStart,
  seedCanonicalTrainingBooking,
  seedTrainingReservation,
  seedTrainingUnavailability,
  createTrainingQuote,
  captureTrainingQuoteSandbox,
  trainingQuotePaymentState,
  ensureProviderCapacityTables,
  ensureProviderBookingGuard,
  providerUnavailableForWindow,
  ensureCommercialTermsTables,
  activateTrainingCommercialTerm,
  computeOrderPayout,
  CommercialTermConfigurationRequired,
  TRAINER_ID,
  GROUP_ID,
} from "./helpers/training-gate-harness.mjs";

test("Training commercial boundary executes a canonical server quote and payment state", async () => {
  const world = freshTrainingWorld();
  const quote = await createTrainingQuote(world.db, {
    packageCode: "training-2-starter",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "split",
  });
  assert.deepEqual(
    { sessions: quote.sessions, total: quote.totalAmount, due: quote.amountDueNow, mode: quote.paymentMode },
    { sessions: 2, total: 3500, due: 1750, mode: "split" },
  );
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes WHERE id=?").get(quote.quoteId).n, 1);

  const captured = await captureTrainingQuoteSandbox(world.db, { quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: "training-phase2-deposit" });
  assert.equal(captured.status, "PARTIALLY_PAID");
  const state = await trainingQuotePaymentState(world.db, quote.quoteId);
  assert.deepEqual({ status: state.status, amountPaid: state.amountPaid, remainingAmount: state.remainingAmount }, { status: "PARTIALLY_PAID", amountPaid: 1750, remainingAmount: 1750 });
});

test("Training capacity sabotage: unavailable trainer cannot pass booking confirmation", async () => {
  const world = freshTrainingWorld();
  await ensureProviderCapacityTables(world.db);
  await ensureProviderBookingGuard(world.db);
  const reservation = seedTrainingReservation(world, { groupId: GROUP_ID, providerId: TRAINER_ID });
  await seedTrainingUnavailability(world, reservation);

  assert.equal(await providerUnavailableForWindow(world.db, {
    providerId: TRAINER_ID,
    scheduledStart: reservation.start,
    scheduledEnd: reservation.end,
  }), true);
  assert.throws(
    () => world.sqlite.prepare("INSERT INTO provider_booking_confirmation_guards (group_id,created_at) VALUES (?,?)").run(GROUP_ID, Date.now()),
    /provider_unavailable_before_booking/,
  );
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM provider_booking_confirmation_guards WHERE group_id=?").get(GROUP_ID).n, 0);
});

test("Training finance sabotage: no active commercial term means no payout computation", async () => {
  const world = freshTrainingWorld({ production: true });
  await ensureCommercialTermsTables(world.db);
  seedCanonicalTrainingBooking(world, { amount: 3500, providerId: TRAINER_ID });

  await assert.rejects(
    () => computeOrderPayout(world.db, { bookingId: "BKG-TRAIN-PHASE2", actorId: "finance@example.in", persist: true }),
    (error) => error instanceof CommercialTermConfigurationRequired,
  );
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations").get().n, 0);

  await activateTrainingCommercialTerm(world);
  const payout = await computeOrderPayout(world.db, { bookingId: "BKG-TRAIN-PHASE2", actorId: "finance@example.in", persist: true });
  assert.equal(payout.serviceCode, "dog_training");
  assert.equal(payout.orderValue, 3500);
  assert.equal(payout.engagementModel, "commission_standard");
  assert.equal(payout.providerSharePct, 0.7);
  assert.equal(payout.cashAllowed, false);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id='BKG-TRAIN-PHASE2'").get().n, 1);
});

test("Training invalid commercial inputs fail closed instead of creating quotes", async () => {
  const world = freshTrainingWorld();
  const before = () => world.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes").get().n;
  await createTrainingQuote(world.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: futureTrainingStart(), paymentMode: "prepaid" });
  const baseline = before();

  await assert.rejects(() => createTrainingQuote(world.db, {
    packageCode: "training-2-starter",
    petCount: 5,
    scheduledStart: futureTrainingStart(),
    paymentMode: "prepaid",
  }), /Training supports 1-4 pets per programme/);
  await assert.rejects(() => createTrainingQuote(world.db, {
    packageCode: "trainer-meet-greet",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "split",
  }), /Meet & Greet must be paid in full/);
  assert.equal(before(), baseline, "refused quotes leave no partial commercial rows");
});
