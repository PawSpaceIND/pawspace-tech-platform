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
  expectResponseRefusal,
  TRAINER_ID,
  GROUP_ID,
} from "./helpers/training-gate-harness.mjs";

// Imported directly as well as through the harness: the two cases at the end treat the commercial
// module as D1 configuration (a package row can be retired) and as the booking-time gate.
const commercial = await import("../lib/training-commercial-governance.ts");

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

  await expectResponseRefusal(() => createTrainingQuote(world.db, {
    packageCode: "training-2-starter",
    petCount: 5,
    scheduledStart: futureTrainingStart(),
    paymentMode: "prepaid",
  }), { status: 409, message: /Training supports 1-4 pets per programme/ });
  await expectResponseRefusal(() => createTrainingQuote(world.db, {
    packageCode: "trainer-meet-greet",
    petCount: 1,
    scheduledStart: futureTrainingStart(),
    paymentMode: "split",
  }), { status: 409, message: /Trainer Meet & Greet must be paid in full/ });
  assert.equal(before(), baseline, "refused quotes leave no partial commercial rows");
});

test("Training catalogue truth is D1 package rows: a retired package disappears and can no longer be quoted", async () => {
  const world = freshTrainingWorld();
  const before = await commercial.listTrainingPackages(world.db);
  const starter = before.find((row) => row.package_code === "training-2-starter");
  assert.deepEqual({ sessions: starter?.sessions, price: starter?.base_price, meet: starter?.meet_and_greet }, { sessions: 2, price: 3500, meet: 0 });
  assert.equal(before[0].package_code, "trainer-meet-greet", "the assessment is listed first, then programmes by size");

  world.sqlite.prepare("UPDATE training_commercial_packages SET active=0 WHERE package_code='training-2-starter'").run();
  const after = await commercial.listTrainingPackages(world.db);
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((row) => row.package_code === "training-2-starter"), "the retired row is not offered");
  await expectResponseRefusal(
    () => createTrainingQuote(world.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: futureTrainingStart(), paymentMode: "prepaid" }),
    { status: 404, message: /Active Training package not found for this date/ },
  );
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_commercial_quotes").get().n, 0);

  const beforeWindow = new Date(Date.parse("2026-08-01T00:00:00.000Z") - 86_400_000).toISOString();
  assert.equal((await commercial.listTrainingPackages(world.db, beforeWindow)).length, 0, "nothing is offered before the packages' effective date");
});

test("Training booking governance binds a canonical booking to exactly the quote the customer accepted", async () => {
  const world = freshTrainingWorld();
  const scheduledStart = futureTrainingStart();
  const quote = await createTrainingQuote(world.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart, paymentMode: "split" });
  const govern = (overrides = {}) => commercial.governTrainingBooking(world.db, {
    quoteId: quote.quoteId, packageCode: "training-2-starter", packageName: quote.packageName, petCount: 1, scheduledStart,
    submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow, paymentMode: "split", paymentStatus: "created", reservationCount: 2, ...overrides,
  });

  await expectResponseRefusal(() => govern({ reservationCount: 1 }), { status: 409, message: /Training programme requires exactly 2 reserved sessions/ });
  await expectResponseRefusal(() => govern({ submittedTotal: quote.totalAmount + 1 }), { status: 409, message: /Training amount does not match the server quote/ });
  await expectResponseRefusal(() => govern({ paymentMode: "prepaid" }), { status: 409, message: /Training payment mode does not match the server quote/ });
  await expectResponseRefusal(() => govern({ petCount: 2 }), { status: 409, message: /Training pet count changed after quote/ });
  await expectResponseRefusal(() => govern({ packageCode: "training-4-puppy", packageName: "Puppy Training Plan" }), { status: 409, message: /Training package does not match the server quote/ });
  await expectResponseRefusal(() => govern({ paymentStatus: "refunded" }), { status: 409, message: /Training payment state is invalid/ });
  await expectResponseRefusal(() => govern({ quoteId: "TQ-NOPE" }), { status: 409, message: /A valid server Training quote is required/ });

  const governed = await govern();
  assert.deepEqual({ sessions: governed.sessions, total: governed.totalAmount, due: governed.amountDueNow, version: governed.catalogueVersion }, { sessions: 2, total: 3500, due: 1750, version: "training-v1" });

  await commercial.consumeTrainingQuote(world.db, quote.quoteId, "BKG-CLOSURE-1");
  await expectResponseRefusal(() => govern(), { status: 409, message: /Training quote has already been used/ }, "a consumed quote cannot govern a second booking");
});
