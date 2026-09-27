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

test("payout hold migration: a losing concurrent worker recovers once the table already carries the new constraint", async () => {
  const { sqlite, db } = await floorWorld();
  // Seed the pre-27-Sept-2026 schema directly, as a real prior deploy would have left it.
  sqlite.exec(`
    CREATE TABLE finance_payout_hold_settings (id TEXT PRIMARY KEY,hold_days INTEGER NOT NULL CHECK(hold_days>=1 AND hold_days<=60),counted_from TEXT NOT NULL DEFAULT 'service_completion' CHECK(counted_from='service_completion'),effective_from INTEGER NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER trg_finance_payout_hold_no_update BEFORE UPDATE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END;
    CREATE TRIGGER trg_finance_payout_hold_no_delete BEFORE DELETE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END;
  `);
  const realBatch = db.batch.bind(db);
  let intercepted = false;
  db.batch = async (statements) => {
    if (!intercepted) {
      intercepted = true;
      // A concurrent worker completes the identical migration first; this call then fails naturally
      // against the table that worker already replaced (CodeAnt review finding on PR #1137).
      sqlite.exec(`
        DROP TRIGGER trg_finance_payout_hold_no_update;
        DROP TRIGGER trg_finance_payout_hold_no_delete;
        ALTER TABLE finance_payout_hold_settings RENAME TO finance_payout_hold_settings_pre_floor0;
        CREATE TABLE finance_payout_hold_settings (id TEXT PRIMARY KEY,hold_days INTEGER NOT NULL CHECK(hold_days>=0 AND hold_days<=60),counted_from TEXT NOT NULL DEFAULT 'service_completion' CHECK(counted_from='service_completion'),effective_from INTEGER NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
        INSERT INTO finance_payout_hold_settings SELECT * FROM finance_payout_hold_settings_pre_floor0;
        DROP TABLE finance_payout_hold_settings_pre_floor0;
        CREATE INDEX idx_finance_payout_hold_effective ON finance_payout_hold_settings(effective_from,created_at);
        CREATE TRIGGER trg_finance_payout_hold_no_update BEFORE UPDATE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END;
        CREATE TRIGGER trg_finance_payout_hold_no_delete BEFORE DELETE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END;
      `);
      throw new Error("simulated: another worker already migrated this table");
    }
    return realBatch(statements);
  };
  await assert.doesNotReject(() => hold.ensureProviderPayoutHoldTables(db), "the recovered migration must not surface the loser's error");
  db.batch = realBatch;
  assert.equal(intercepted, true, "the test did not actually exercise the race path");
  const now = Date.now();
  sqlite.prepare("INSERT INTO finance_payout_hold_settings (id,hold_days,counted_from,effective_from,reason,created_by,created_at) VALUES ('PH-RACE',0,'service_completion',?,?,?,?)").run(now, "race recovery test", "system", now);
  assert.throws(() => sqlite.prepare("UPDATE finance_payout_hold_settings SET hold_days=1 WHERE id='PH-RACE'").run(), /payout_hold_settings_append_only/, "append-only trigger must survive the recovered migration");
});
