import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

const SEED = fs.readFileSync(new URL("../scripts/grooming-blr-pricing-seed.sql", import.meta.url), "utf8");
const AT = Date.parse("2026-09-06T12:00:00.000Z");

test("BLR grooming catalogue override wins over the standard catalogue row", async () => {
  const { sqlite, db } = freshCountingD1();
  sqlite.exec(SEED);
  const { resolveCataloguePrice } = await import("../lib/catalogue-governance.ts");

  const blr = await resolveCataloguePrice(db, {
    serviceCode: "grooming",
    packageCode: "qa-blr-price-probe",
    cityId: "blr",
    at: AT,
  });
  assert.ok(blr, "BLR catalogue row must resolve");
  assert.equal(blr.cityId, "blr");
  assert.equal(blr.basePrice, 1150);

  const otherCity = await resolveCataloguePrice(db, {
    serviceCode: "grooming",
    packageCode: "qa-blr-price-probe",
    cityId: "maa",
    at: AT,
  });
  assert.ok(otherCity, "standard catalogue row must remain available outside BLR");
  assert.equal(otherCity.cityId, "ALL");
  assert.equal(otherCity.basePrice, 1000);
});

test("BLR pricing seed is idempotent and does not seed live Grooming package codes", () => {
  const { sqlite } = freshCountingD1();
  sqlite.exec(SEED);
  sqlite.exec(SEED);

  const probeRows = sqlite.prepare("SELECT city_id,base_price FROM catalogue_packages WHERE service_code='grooming' AND package_code='qa-blr-price-probe' ORDER BY city_id").all();
  assert.deepEqual(probeRows.map(row => ({ ...row })), [
    { city_id: "ALL", base_price: 1000 },
    { city_id: "blr", base_price: 1150 },
  ]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM catalogue_audit WHERE package_id IN ('uat_grooming_price_probe_all','uat_grooming_price_probe_blr')").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM catalogue_packages WHERE package_code IN ('dog-bath','dog-basic','dog-makeover','dog-trim','cat-routine','cat-basic','cat-makeover','cat-trim','young-basic','young-makeover')").get().count, 0);
});
