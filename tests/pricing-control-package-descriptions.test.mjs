/** Owner decision 7 (H4): V2 showed internal seed text ("Canonical Grooming price for Bath & Basic") as the package description. */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";
installWorkersHooks("__PRICING_DESC_DB__", "__PRICING_DESC_ENV__");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
const description = (sqlite, code) => sqlite.prepare("SELECT description FROM service_packages WHERE package_code=?").get(code).description;

test("grooming packages describe what is included, from the commercial catalogue", async () => {
  const sqlite = new DatabaseSync(":memory:");
  await ensurePricingControlRuntime(d1(sqlite));
  assert.match(description(sqlite, "dog-basic"), /^Includes Bath, Shampoo & Conditioning/);
  assert.match(description(sqlite, "cat-routine__2_pets"), /^For 2 pets, each groomed in full\. Includes Nail Clipping/);
  assert.doesNotMatch(description(sqlite, "dog-makeover"), /Canonical/);
});

test("old seeded text is replaced once with an audit event; staff-written copy is kept", async () => {
  const sqlite = new DatabaseSync(":memory:");
  await ensurePricingControlRuntime(d1(sqlite));
  sqlite.exec("UPDATE service_packages SET description='Canonical Grooming price for Bath & Basic' WHERE package_code='dog-basic'");
  sqlite.exec("UPDATE service_packages SET description='Our signature spa day' WHERE package_code='dog-makeover'");
  await ensurePricingControlRuntime(d1(sqlite));
  assert.match(description(sqlite, "dog-basic"), /^Includes /);
  assert.equal(description(sqlite, "dog-makeover"), "Our signature spa day");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM pricing_audit_events WHERE entity_id='canonical_groom_dog-basic' AND action='seed_repair'").get().n, 1);
});
