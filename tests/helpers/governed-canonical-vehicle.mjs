/**
 * A GOVERNED vehicle for the suites whose subject is not commercial governance.
 *
 * Several suites here - canonical pet identity, booking replay scoping, canonical city/zone integrity -
 * need /api/canonical-bookings to reach 201 so they can assert something else entirely: which pet row a
 * booking binds, which replay wins a race, whether a city/zone mismatch writes anything. They all used
 * `pet_sitting` for that, because it was the one service on that route that reached 201 without a server
 * quote - it had no commercial governance at all. That was PTJA-P0-02: the client priced its own Sitting
 * booking. Sitting is now refused on this route (the governed Sitting path is /api/sitting-bookings),
 * so those suites need a vehicle that is cheap AND governed.
 *
 * Trainer Meet & Greet is that vehicle: one session, one reservation, prepaid, and - uniquely among the
 * Training packages - no sandbox capture attestation required before confirmation. The quote is created
 * through the real createTrainingQuote, so the amounts these suites submit are the SERVER's, not
 * numbers a test invented. Nothing about the invariants under test changes; only the door they enter by.
 */
export const VEHICLE_SERVICE_CODE = "dog_training";
export const VEHICLE_PACKAGE_CODE = "trainer-meet-greet";

/** Returns the real server quote: {quoteId, packageCode, packageName, totalAmount, amountDueNow, ...}. */
export async function governedVehicleQuote(db, { scheduledStart, petCount = 1 }) {
  const { createTrainingQuote } = await import("../../lib/training-commercial-governance.ts");
  return createTrainingQuote(db, {
    packageCode: VEHICLE_PACKAGE_CODE,
    petCount: Math.max(1, Math.min(4, Number(petCount) || 1)),
    scheduledStart,
    paymentMode: "prepaid",
  });
}
