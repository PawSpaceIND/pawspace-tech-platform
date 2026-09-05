import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SITTING_GATE1_DB__", "__SITTING_GATE1_ENV__");

const windowFromNow = (days = 5, hours = 24) => {
  const start = new Date(Date.now() + days * 86_400_000);
  start.setUTCHours(6, 0, 0, 0);
  return { start: start.toISOString(), end: new Date(start.getTime() + hours * 3_600_000).toISOString() };
};

async function rejectedResponse(work) {
  try {
    await work();
    assert.fail("expected governed request to be rejected");
  } catch (error) {
    assert.ok(error instanceof Response, `expected Response rejection, got ${error}`);
    return error;
  }
}

test("Sitting Gate 1 executes server-owned catalogue, quote and booking governance", async () => {
  const { sqlite, db } = freshCountingD1();
  const sitting = await import("../lib/sitting-governance.ts");
  const { start, end } = windowFromNow();

  const packages = await sitting.listSittingPackages(db, start);
  assert.deepEqual(
    packages.map((row) => [String(row.package_code), Number(row.base_price_per_pet), Number(row.extra_pet_price)]),
    [["sitting-visit-60", 399, 149], ["sitting-overnight", 799, 399]],
  );

  const quote = await sitting.createSittingQuote(db, {
    packageCode: "sitting-overnight",
    petCount: 2,
    scheduledStart: start,
    scheduledEnd: end,
    paymentMode: "prepaid",
    cityId: "blr",
    zoneId: "blr-east",
  });
  assert.equal(quote.totalAmount, 1198);
  assert.equal(quote.amountDueNow, 1198);
  assert.equal(quote.billableUnits, 1);

  const governed = await sitting.governSittingBooking(db, {
    quoteId: quote.quoteId,
    packageCode: quote.packageCode,
    packageName: quote.packageName,
    petCount: quote.petCount,
    cityId: quote.cityId,
    zoneId: quote.zoneId,
    scheduledStart: quote.scheduledStart,
    scheduledEnd: quote.scheduledEnd,
    submittedTotal: quote.totalAmount,
    submittedAmountDueNow: quote.amountDueNow,
    paymentMode: quote.paymentMode,
    paymentStatus: "captured",
    reservationCount: 1,
  });
  assert.equal(governed.totalAmount, 1198);
  assert.equal(governed.basePricePerPet, 799);
  assert.equal(governed.extraPetPrice, 399);

  const stored = sqlite.prepare("SELECT total_amount,amount_due_now,status FROM sitting_commercial_quotes WHERE id=?").get(quote.quoteId);
  assert.deepEqual({ ...stored }, { total_amount: 1198, amount_due_now: 1198, status: "open" });
});

test("Sitting Gate 1 rejects a changed amount instead of trusting the client", async () => {
  const { db } = freshCountingD1();
  const sitting = await import("../lib/sitting-governance.ts");
  const { start, end } = windowFromNow(6);
  const quote = await sitting.createSittingQuote(db, {
    packageCode: "sitting-overnight",
    petCount: 1,
    scheduledStart: start,
    scheduledEnd: end,
    paymentMode: "prepaid",
  });
  const failure = await rejectedResponse(() => sitting.governSittingBooking(db, {
    quoteId: quote.quoteId,
    packageCode: quote.packageCode,
    packageName: quote.packageName,
    petCount: quote.petCount,
    scheduledStart: quote.scheduledStart,
    scheduledEnd: quote.scheduledEnd,
    submittedTotal: quote.totalAmount + 1,
    submittedAmountDueNow: quote.amountDueNow,
    paymentMode: quote.paymentMode,
    paymentStatus: "captured",
    reservationCount: 1,
  }));
  assert.equal(failure.status, 409);
  assert.match(await failure.text(), /amount does not match/i);
});
