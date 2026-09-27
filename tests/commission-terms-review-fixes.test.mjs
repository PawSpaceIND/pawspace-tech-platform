/*
 * Commission terms review fixes (round 3): a start date may not reach back into, or before, a closed month (terms apply from
 * their start onwards, so a later closed month would change too), and a service default can only be set for a commission
 * service (or a service that already has a default).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__TERMS_FIXES_DB__", "__TERMS_FIXES_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const defaults = await import("../lib/service-commission-defaults.ts");

function closeMonth(sqlite, month) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)");
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','[]',1,'finance',1)").run(month);
}

test("terms cannot start in a closed month, nor before one (they would change its bookings)", async () => {
  const { sqlite, db } = world("__TERMS_FIXES_DB__", "__TERMS_FIXES_ENV__", {});
  assert.equal(await terms.lockedMonthProblem(db, ["2026-07-15"]), null, "no month was ever closed");
  closeMonth(sqlite, "2026-08");
  assert.match(await terms.lockedMonthProblem(db, ["2026-08-10"]), /books for 2026-08 are closed, so commission terms cannot start in that month/);
  assert.match(await terms.lockedMonthProblem(db, ["2026-07-15"]), /books for 2026-08 are closed, and terms starting in 2026-07 would change bookings in it\. Choose a start date after 2026-08/);
  assert.equal(await terms.lockedMonthProblem(db, ["2026-09-01"]), null, "a start after the closed month is fine");
});

test("a default commission can only be proposed for a commission service", async () => {
  const { db } = world("__TERMS_FIXES_DB__", "__TERMS_FIXES_ENV__", {});
  await terms.ensureCommercialTermsTables?.(db);
  const today = new Date().toISOString().slice(0, 10);
  const propose = (serviceCode) => defaults.proposeServiceCommissionDefault(db, { serviceCode, pawspaceCommissionPercent: 25, effectiveFrom: today, reason: "Owner decision: review the default", actorId: "maker@pawspace.in" });
  await assert.rejects(propose("made_up_service"), (error) => /not a commission service/.test(String(error?.message ?? error)));
  const proposed = await propose("grooming");
  assert.ok(proposed, "a commission service is accepted");
});
