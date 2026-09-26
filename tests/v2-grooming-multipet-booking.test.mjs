/**
 * V2 multi-pet grooming reached "Reserve & review payment", reserved a groomer, then failed with
 * "Grooming package is not active for this city/zone": V2 sent the Pricing Control bundle code
 * (dog-basic__2_pets) while the booking governance only knows base codes and prices 2-4 pets itself.
 * These cases execute the real governance against real SQL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__V2_MULTIPET_DB__", "__V2_MULTIPET_ENV__");
const { quoteGroomingBookingWithLiveMultiPet } = await import("../lib/live-grooming-governance.ts");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");

// Next Wednesday at 11:00 IST: the published weekday rule (-8%) applies, as it did in the browser run.
function nextWednesdayStart() {
  const day = new Date(Date.now() + 86400000);
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return `${day.toISOString().slice(0, 10)}T05:30:00.000Z`;
}

async function world() {
  const sqlite = new DatabaseSync(":memory:"), db = d1(sqlite);
  await ensurePricingControlRuntime(db);
  sqlite.exec("UPDATE service_packages SET active=1 WHERE service_code='grooming'");
  sqlite.prepare(`INSERT INTO dynamic_pricing_rules (id,name,service_code,package_code,city_id,zone_id,rule_type,days_json,start_time,end_time,effective_from,effective_to,adjustment_type,adjustment_value,coupon_policy,priority,status,version,updated_by,updated_at)
    VALUES ('rule_weekday_value','Weekday value pricing','grooming',NULL,'blr',NULL,'weekday','[1,2,3,4,5]',NULL,NULL,'2026-01-01',NULL,'percent',-8,'stackable',30,'published',1,'test',0)`).run();
  return { sqlite, db };
}

const quote = (db, packageCode, pets) => quoteGroomingBookingWithLiveMultiPet(db, {
  packageCode, pets, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east", scheduledStart: nextWednesdayStart(),
});

test("two dogs on the base code are governed at the published 2-pet weekday price V2 quotes", async () => {
  const { db } = await world();
  const governed = await quote(db, "dog-basic", [{ species: "dog" }, { species: "dog" }]);
  assert.equal(governed.packageCode, "dog-basic");
  assert.equal(governed.petCount, 2);
  assert.equal(governed.totalAmount, 3034); // Rs 3,298 bundle row - 8% weekday, as shown by V2
  assert.equal(governed.amountDueNow, 3034);
});

test("three and four pets price from their own Pricing Control rows", async () => {
  const { db } = await world();
  assert.equal((await quote(db, "dog-makeover", [{ species: "dog" }, { species: "dog" }, { species: "dog" }])).totalAmount, 5931);
  assert.equal((await quote(db, "cat-routine", Array.from({ length: 4 }, () => ({ species: "cat" })))).totalAmount, 3676);
});

test("the bundle code V2 used to send has no governed catalogue entry", async () => {
  const { db } = await world();
  await assert.rejects(quote(db, "dog-basic__2_pets", [{ species: "dog" }, { species: "dog" }]), /not active for this city\/zone/);
});
