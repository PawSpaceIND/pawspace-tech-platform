import test from "node:test";
import assert from "node:assert/strict";
import {
  freshGroomingWorld,
  futureSlot,
  seedCanonicalGroomingBooking,
  seedGroomingReservation,
  seedOverlappingUnavailability,
  ensureProviderCapacityTables,
  ensureProviderBookingGuard,
  providerUnavailableForWindow,
  resolveGroomingPolicy,
  evaluateBookingChange,
  policyVersion,
  governGroomingBooking,
  resolveGroomingSubscriptionPlan,
  ensureCommercialTermsTables,
  activateGroomingCommercialTerm,
  computeOrderPayout,
  CommercialTermConfigurationRequired,
  GROOMER_ID,
  GROUP_ID,
} from "./helpers/grooming-harness.mjs";

test("Grooming booking truth is server-governed and subscription-configured in D1", async () => {
  const world = freshGroomingWorld();
  const single = await governGroomingBooking(world.db, {
    packageCode: "dog-basic",
    pets: [{ species: "dog" }],
    submittedTotal: 1899,
    submittedAmountDueNow: 0,
    paymentMode: "pay_after_service",
    cityId: "blr",
    zoneId: "blr-east",
  });
  assert.deepEqual(
    { packageCode: single.packageCode, petCount: single.petCount, totalAmount: single.totalAmount, amountDueNow: single.amountDueNow },
    { packageCode: "dog-basic", petCount: 1, totalAmount: 1899, amountDueNow: 0 },
  );

  const plan = await resolveGroomingSubscriptionPlan(world.db, "sub-6", "blr", "blr-east");
  assert.equal(plan?.sessions, 6);
  assert.equal(plan?.singlePrice, 6594);

  const subscription = await governGroomingBooking(world.db, {
    packageCode: "sub-6",
    pets: [{ species: "dog" }],
    submittedTotal: 6594,
    submittedAmountDueNow: 6594,
    paymentMode: "prepaid",
    cityId: "blr",
    zoneId: "blr-east",
  });
  assert.equal(subscription.offerType, "subscription");
  assert.equal(subscription.subscriptionPlan?.reserveSessions, 1);
});

test("Grooming capacity sabotage: an overlapping unavailable provider cannot pass booking confirmation", async () => {
  const world = freshGroomingWorld();
  await ensureProviderCapacityTables(world.db);
  await ensureProviderBookingGuard(world.db);
  const slot = futureSlot();
  const reservation = seedGroomingReservation(world, { groupId: GROUP_ID, providerId: GROOMER_ID, start: slot.start, end: slot.end });
  await seedOverlappingUnavailability(world, reservation);

  assert.equal(await providerUnavailableForWindow(world.db, {
    providerId: GROOMER_ID,
    scheduledStart: slot.start,
    scheduledEnd: slot.end,
  }), true);

  assert.throws(
    () => world.sqlite.prepare("INSERT INTO provider_booking_confirmation_guards (group_id,created_at) VALUES (?,?)").run(GROUP_ID, Date.now()),
    /provider_unavailable_before_booking/,
    "the database trigger must fail closed even if an application caller tries to confirm anyway",
  );
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM provider_booking_confirmation_guards WHERE group_id=?").get(GROUP_ID).n, 0);
});

test("Grooming policy sabotage: locked or late changes are refused in enforce mode", async () => {
  const world = freshGroomingWorld();
  const policy = await resolveGroomingPolicy(world.db, "blr", "blr-east");
  assert.match(policyVersion(policy), /^blr:/);

  const enforced = {
    ...policy,
    enforcementMode: "enforce",
    cancellationCutoffMinutes: 1440,
    refundPercentBeforeCutoff: 100,
    refundPercentAfterCutoff: 0,
    rescheduleCutoffMinutes: 1440,
    rescheduleAllowedAfterCutoff: false,
    maxReschedules: 1,
    changeLockStatuses: ["completed", "cancelled"],
  };
  const soon = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const cancel = evaluateBookingChange(enforced, { action: "cancel", scheduledStart: soon, status: "confirmed", bookingAmount: 1899 });
  assert.equal(cancel.refundPercent, 0, "late cancellation cannot invent a refund");
  const reschedule = evaluateBookingChange(enforced, { action: "reschedule", scheduledStart: soon, status: "confirmed", bookingAmount: 1899, rescheduleCount: 0 });
  assert.equal(reschedule.allowed, false, "late reschedule fails closed when policy disables it");
  const locked = evaluateBookingChange(enforced, { action: "cancel", scheduledStart: soon, status: "completed", bookingAmount: 1899 });
  assert.equal(locked.allowed, false, "completed bookings remain immutable");
});

test("Grooming finance sabotage: payout cannot be computed without an active commercial term", async () => {
  const world = freshGroomingWorld({ production: true });
  await ensureCommercialTermsTables(world.db);
  seedCanonicalGroomingBooking(world, { amount: 1899, providerId: GROOMER_ID });

  await assert.rejects(
    () => computeOrderPayout(world.db, { bookingId: "BKG-GROOM-PHASE2", actorId: "finance@example.in", persist: true }),
    (error) => error instanceof CommercialTermConfigurationRequired,
  );
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations").get().n, 0, "refused finance leaves no phantom payout row");

  await activateGroomingCommercialTerm(world);
  const payout = await computeOrderPayout(world.db, { bookingId: "BKG-GROOM-PHASE2", actorId: "finance@example.in", persist: true });
  assert.equal(payout.serviceCode, "grooming");
  assert.equal(payout.orderValue, 1899);
  assert.equal(payout.engagementModel, "commission_groomer");
  assert.equal(payout.providerSharePct, 0.7);
  assert.ok(payout.providerNetPayout > 0);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id='BKG-GROOM-PHASE2'").get().n, 1);
});
