import assert from "node:assert/strict";
import test from "node:test";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_GATE1_DB__", "__BOARDING_GATE1_ENV__");

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

test("Boarding Gate 1 executes the canonical catalogue, host roster and quote persistence", async () => {
  const { sqlite, db } = freshCountingD1();
  const boarding = await import("../lib/boarding-governance.ts");
  const { start, end } = windowFromNow();

  const packages = await boarding.listBoardingPackages(db, start);
  assert.deepEqual(
    packages.map((row) => [String(row.package_code), Number(row.base_price_per_pet)]),
    [["boarding-4h", 499], ["boarding-10h", 599], ["boarding-24h", 699]],
  );

  const hosts = await boarding.listBoardingHosts(db, { cityId: "blr", zoneId: "blr-east", at: start });
  assert.ok(hosts.length >= 3, "the governed Bengaluru roster must expose seeded eligible hosts");
  assert.ok(hosts.every((host) => host.homeVerified && host.kycStatus === "verified" && host.backgroundCheckStatus === "verified"));

  const quote = await boarding.createBoardingQuote(db, {
    packageCode: "boarding-24h",
    petCount: 1,
    scheduledStart: start,
    scheduledEnd: end,
    paymentMode: "prepaid",
    cityId: "blr",
    zoneId: "blr-east",
  });
  assert.equal(quote.totalAmount, 699);
  assert.equal(quote.amountDueNow, 699);
  assert.equal(quote.stayUnits, 1);

  const stored = sqlite.prepare("SELECT package_code,total_amount,amount_due_now,status FROM boarding_commercial_quotes WHERE id=?").get(quote.quoteId);
  assert.deepEqual({ ...stored }, { package_code: "boarding-24h", total_amount: 699, amount_due_now: 699, status: "open" });
});

test("Boarding Gate 1 fails closed on an unapproved coupon instead of inventing a discount", async () => {
  const { db } = freshCountingD1();
  const boarding = await import("../lib/boarding-governance.ts");
  const { start, end } = windowFromNow(6);
  const failure = await rejectedResponse(() => boarding.createBoardingQuote(db, {
    packageCode: "boarding-24h",
    petCount: 1,
    scheduledStart: start,
    scheduledEnd: end,
    paymentMode: "prepaid",
    couponCode: "UNAPPROVED",
  }));
  assert.equal(failure.status, 409);
  assert.match(await failure.text(), /coupon policy is not enabled/i);
});
