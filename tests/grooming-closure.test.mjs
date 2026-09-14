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

// The harness re-exports these modules; they are imported here directly as well because the two
// cases at the end exercise them as D1 configuration, not just as functions.
const policyGovernance = await import("../lib/grooming-policy-governance.ts");
const groomingGovernance = await import("../lib/grooming-governance.ts");

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
  assert.equal(cancel.refundPercent, 100, "No cancellation fee overrides the legacy late penalty");
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

test("Grooming policy truth is D1 configuration: switching the row to enforce changes the verdict", async () => {
  const world = freshGroomingWorld();
  await policyGovernance.seedDefaultGroomingPolicy(world.db);
  const soon = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const lateReschedule = { action: "reschedule", scheduledStart: soon, status: "confirmed", bookingAmount: 1899, rescheduleCount: 0 };

  const observed = await policyGovernance.resolveGroomingPolicy(world.db, "blr", "blr-east");
  assert.equal(observed.enforcementMode, "observe");
  assert.equal(policyVersion(observed), "blr:all:grooming-default:v1");

  world.sqlite.prepare("UPDATE grooming_commercial_policies SET enforcement_mode='enforce',reschedule_cutoff_minutes=1440,reschedule_allowed_after_cutoff=0,max_reschedules=1,version=2 WHERE id='gpolicy_blr_default'").run();
  const enforced = await policyGovernance.resolveGroomingPolicy(world.db, "blr", "blr-east");
  assert.deepEqual({ mode: enforced.enforcementMode, cutoff: enforced.rescheduleCutoffMinutes, lateAllowed: enforced.rescheduleAllowedAfterCutoff, version: policyVersion(enforced) }, { mode: "enforce", cutoff: 1440, lateAllowed: false, version: "blr:all:grooming-default:v2" }, "the resolved policy is the row, not a constant");

  const refused = policyGovernance.evaluateBookingChange(enforced, lateReschedule);
  assert.equal(refused.allowed, false);
  assert.ok(refused.reasons.includes("Reschedule is inside the cutoff and late reschedule is disabled"));
  const exhausted = policyGovernance.evaluateBookingChange(enforced, { ...lateReschedule, scheduledStart: new Date(Date.now() + 3 * 86_400_000).toISOString(), rescheduleCount: 1 });
  assert.equal(exhausted.allowed, false, "the row's reschedule ceiling is enforced even before the cutoff");
  assert.ok(exhausted.reasons.includes("Maximum reschedule count reached"));

  const preserved = policyGovernance.evaluateBookingChange({ ...enforced, enforcementMode: "observe" }, lateReschedule);
  assert.equal(preserved.allowed, true, "observe mode records the verdict without blocking");
  assert.ok(preserved.reasons.includes("Observe mode: policy would block this change but UAT behavior is preserved"));
  assert.equal(policyGovernance.evaluateBookingChange({ ...enforced, enforcementMode: "observe" }, { ...lateReschedule, status: "completed" }).allowed, false, "a locked status is refused in every mode");
});

test("Grooming subscription plans are D1 rows: repricing the row reprices the governed purchase and its expiry is calendar-clamped", async () => {
  const world = freshGroomingWorld();
  const purchase = (submittedTotal) => groomingGovernance.governGroomingBooking(world.db, { packageCode: "sub-6", pets: [{ species: "dog" }], submittedTotal, submittedAmountDueNow: submittedTotal, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" });
  assert.equal((await purchase(6594)).totalAmount, 6594);

  await groomingGovernance.seedDefaultGroomingSubscriptionPlans(world.db);
  world.sqlite.prepare("UPDATE grooming_subscription_plans SET price=6999,version=2 WHERE plan_code='sub-6' AND city_id='blr'").run();
  await assert.rejects(purchase(6594), /Submitted Grooming total does not match governed catalogue blr:sub-6:v2/, "the old client price is refused once the row changes");
  const repriced = await purchase(6999);
  assert.deepEqual({ total: repriced.totalAmount, version: repriced.catalogueVersion, sessions: repriced.subscriptionPlan?.sessions }, { total: 6999, version: "blr:sub-6:v2", sessions: 6 });

  world.sqlite.prepare("UPDATE grooming_subscription_plans SET active=0 WHERE plan_code='sub-6' AND city_id='blr'").run();
  await assert.rejects(purchase(6999), /Grooming package is not active for this city\/zone/, "a retired plan cannot be purchased at any price");
  assert.equal(await groomingGovernance.resolveGroomingSubscriptionPlan(world.db, "sub-6", "maa", "chennai-core"), null, "plans are city-scoped rows");

  const startedAt = Date.UTC(2026, 7, 31);
  assert.equal(new Date(groomingGovernance.subscriptionExpiry(startedAt, 6, "months")).toISOString().slice(0, 10), "2027-02-28", "a 31 August start expires on the last day of February, not in March");
  assert.equal(new Date(groomingGovernance.subscriptionExpiry(startedAt, 12, "months")).toISOString().slice(0, 10), "2027-08-31");
  assert.equal(new Date(groomingGovernance.subscriptionExpiry(startedAt, 10, "days")).toISOString().slice(0, 10), "2026-09-10");
});
