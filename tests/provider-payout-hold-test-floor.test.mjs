/*
 * Owner decision, 27 Sept 2026: on staging, for testing, the payout hold floor can drop to 0 days so a UAT payout is
 * releasable immediately. This is gated behind the same five-part UAT sandbox check every other UAT-only relaxation
 * in this codebase uses (uatPayoutBeneficiaryGate) - PAWSPACE_SCHEDULING_ENV=uat, RazorpayX sandbox, live not
 * approved, an rzp_test_ key, and not the production deployment - so the floor never drops in production, and a
 * caller that doesn't pass an env at all (the existing behaviour) keeps the 1-day floor exactly as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors } from "./helpers/execution-harness.mjs";

installWorkersHooks("__PAYOUT_HOLD_FLOOR_DB__", "__PAYOUT_HOLD_FLOOR_ENV__");
const hold = await import("../lib/provider-payout-hold.ts");

const FINANCE = "floor.finance@pawspace.test";
const KEY = "rzp_test_floor";
const SANDBOX = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
const UAT = { ...SANDBOX, PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_RAZORPAYX_ENV: "sandbox", PAWSPACE_RAZORPAYX_LIVE_APPROVED: "false", RAZORPAYX_KEY_ID_SANDBOX: KEY };

async function floorWorld() {
  const { sqlite, db } = world("__PAYOUT_HOLD_FLOOR_DB__", "__PAYOUT_HOLD_FLOOR_ENV__", {});
  await seedActors(sqlite, db, [{ id: "U-FIN", email: FINANCE, role: "finance" }]);
  return { sqlite, db };
}

test("payout hold: 0 days is refused with no env (unchanged default behaviour)", async () => {
  const { db } = await floorWorld();
  await assert.rejects(
    () => hold.setProviderPayoutHoldDays(db, { days: 0, reason: "trying without any environment", actor: FINANCE }),
    (e) => e instanceof Response && e.status === 400,
  );
});

test("payout hold: 0 days is refused outside the full UAT gate (e.g. production deployment)", async () => {
  const { db } = await floorWorld();
  const notGated = { ...UAT, PAWSPACE_DEPLOYMENT_ENV: "production" };
  await assert.rejects(
    () => hold.setProviderPayoutHoldDays(db, { days: 0, reason: "trying on a production-like deployment", actor: FINANCE }, notGated),
    (e) => e instanceof Response && e.status === 400,
  );
});

test("payout hold: 0 days succeeds once every part of the UAT gate holds", async () => {
  const { db } = await floorWorld();
  const data = await hold.setProviderPayoutHoldDays(db, { days: 0, reason: "UAT staging test: release immediately", actor: FINANCE }, UAT);
  assert.equal(data.holdDays, 0);
  assert.equal(await hold.providerPayoutHoldDays(db, data.effectiveFrom + 1000), 0);
});

test("payout hold: the normal 1-60 day range still works under the UAT gate", async () => {
  const { db } = await floorWorld();
  const data = await hold.setProviderPayoutHoldDays(db, { days: 3, reason: "UAT staging test: a short but non-zero hold", actor: FINANCE }, UAT);
  assert.equal(data.holdDays, 3);
});
