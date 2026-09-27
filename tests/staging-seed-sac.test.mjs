/*
 * The staging seed gives each seeded service the SAC and place-of-supply rule of the one SAC table (lib/service-sac-defaults.ts),
 * so an invoice Finance issues by hand on staging prints a real SAC. An older placeholder ("SAC-9985-<n>") is corrected only
 * where it is still exactly that placeholder: a code Finance set is never overwritten.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { SERVICE_SAC_DEFAULTS } = await import("../lib/service-sac-defaults.ts");
const seed = readFileSync(new URL("../scripts/employee-seed.sql", import.meta.url), "utf8");

test("every seeded service classification carries the SAC table's code and rule", () => {
  const inserts = [...seed.matchAll(/INSERT OR IGNORE INTO tax_classifications \(id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at\) VALUES \('SEEDTC-([a-z_]+)','[^']+','([a-z_]+)','([^']+)','[^']*','([a-z_]+)'/g)];
  assert.equal(inserts.length, 6);
  for (const [, id, service, sac, rule] of inserts) {
    assert.equal(id, service);
    assert.deepEqual([sac, rule], [SERVICE_SAC_DEFAULTS[service].sac, SERVICE_SAC_DEFAULTS[service].placeOfSupplyRule], service);
  }
});

test("an old placeholder is corrected only where it is still exactly the placeholder", () => {
  const updates = [...seed.matchAll(/UPDATE tax_classifications SET classification_code='(\d+)',place_of_supply_rule='([a-z_]+)' WHERE id='SEEDTC-([a-z_]+)' AND policy_id='[^']+' AND classification_code='SAC-9985-\d'/g)];
  const byService = new Map(updates.map(([, sac, rule, service]) => [service, [sac, rule]]));
  assert.equal(updates.length, byService.size, "one correction per service");
  assert.deepEqual([...byService.keys()].sort(), ["boarding", "dog_training", "dog_walking", "grooming", "pet_sitting", "pet_taxi"]);
  for (const [service, codes] of byService) assert.deepEqual(codes, [SERVICE_SAC_DEFAULTS[service].sac, SERVICE_SAC_DEFAULTS[service].placeOfSupplyRule], service);
  assert.doesNotMatch(seed, /DELETE FROM tax_classifications/);
});
