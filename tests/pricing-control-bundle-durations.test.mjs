/**
 * QA (M9): "Complete Makeover · 2 pets" blocked 120 min while one pet takes 150 min, so two-pet makeovers got
 * less groomer time than one. Bundles now never undercut the single-pet slot, and rows seeded before the fix
 * are repaired only while their duration is still exactly as seeded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__PRICING_BUNDLE_DB__", "__PRICING_BUNDLE_ENV__");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
const slot = (sqlite, id) => sqlite.prepare("SELECT slot_minutes s, blocking_minutes b FROM service_packages WHERE id=?").get(id);

test("multi-pet bundles are never shorter than one pet of the same package", async () => {
  const sqlite = new DatabaseSync(":memory:");
  await ensurePricingControlRuntime(d1(sqlite));
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_dog-makeover_2") }, { s: 150, b: 180 });
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_young-makeover_2") }, { s: 150, b: 180 });
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_cat-makeover_3") }, { s: 150, b: 180 });
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_dog-makeover_4") }, { s: 240, b: 270 });
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_dog-basic_2") }, { s: 120, b: 150 }, "basic packages keep their bundle times");
});

test("old seeded bundle rows are repaired once and audited; a duration staff chose is left alone", async () => {
  const sqlite = new DatabaseSync(":memory:");
  await ensurePricingControlRuntime(d1(sqlite));
  // As seeded before the fix, and one row staff deliberately set to 165 minutes.
  sqlite.exec("UPDATE service_packages SET slot_minutes=120, blocking_minutes=150 WHERE id IN ('canonical_groom_dog-makeover_2','canonical_groom_cat-makeover_2')");
  sqlite.exec("UPDATE service_packages SET slot_minutes=165, blocking_minutes=195, active=1 WHERE id='canonical_groom_young-makeover_2'");
  await ensurePricingControlRuntime(d1(sqlite)); // a new worker isolate runs the seed again
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_dog-makeover_2") }, { s: 150, b: 180 });
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_cat-makeover_2") }, { s: 150, b: 180 });
  assert.deepEqual({ ...slot(sqlite, "canonical_groom_young-makeover_2") }, { s: 165, b: 195 });
  const audits = sqlite.prepare("SELECT entity_id FROM pricing_audit_events WHERE action='seed_repair' ORDER BY entity_id").all().map(row => row.entity_id);
  assert.deepEqual(audits, ["canonical_groom_cat-makeover_2", "canonical_groom_dog-makeover_2"]);
  await ensurePricingControlRuntime(d1(sqlite));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM pricing_audit_events WHERE action='seed_repair'").get().n, 2, "re-running repairs nothing");
});
