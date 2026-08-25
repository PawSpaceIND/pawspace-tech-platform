/**
 * Creates the governed commercial state required by the canonical Pet Sitting path.
 * The caller still drives the real quote and payment-governance modules against its
 * own D1 shim; this helper only removes repeated setup from adjacent regression suites.
 */
export async function createCapturedCanonicalSittingQuote(db, {
  scheduledStart,
  scheduledEnd,
  cityId = "blr",
  zoneId = "blr-east",
  petCount = 1,
  paymentMode = "prepaid",
  paymentKey = crypto.randomUUID(),
} = {}) {
  const { createSittingQuote } = await import("../../lib/sitting-governance.ts");
  const { captureSittingQuoteSandbox } = await import("../../lib/sitting-payment-governance.ts");
  const quote = await createSittingQuote(db, {
    packageCode: "sitting-visit-60",
    petCount,
    cityId,
    zoneId,
    scheduledStart,
    scheduledEnd,
    paymentMode,
  });
  const capture = await captureSittingQuoteSandbox(db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow,
    paymentKey,
  });
  return { quote, capture };
}
