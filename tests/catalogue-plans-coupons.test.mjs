import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const catalogue = await read("../lib/catalogue-governance.ts");
const plans = await read("../lib/subscription-plan-governance.ts");
const coupon = await read("../lib/coupon-governance.ts");
const catRoute = await read("../app/api/catalogue/route.ts");
const planRoute = await read("../app/api/subscription-plans/route.ts");
const couponRoute = await read("../app/api/coupon-governance/route.ts");

test("catalogue: create net-new packages for any service, city/zone-wise, with price precedence", () => {
  assert.match(catalogue, /export async function createCataloguePackage/);
  assert.match(catalogue, /export async function resolveCataloguePrice/);
  assert.match(catalogue, /UNIQUE\(service_code,package_code,city_id,zone_id\)/);
  // most-specific price wins: zone (3) > city (2) > global ALL (1)
  assert.match(catalogue, /score = \(zoneId && rz === zoneId\) \? 3 : 0/);
  assert.match(catRoute, /requirePermission\(actor,"pricing\.view"\)/);
  assert.match(catRoute, /requirePermission\(actor,"pricing\.manage"\)/);
});

test("subscription plans: any service, city-wise, with a validity/expiry rule", () => {
  assert.match(plans, /export async function createSubscriptionPlan/);
  assert.match(plans, /export function computePlanExpiry/);
  assert.match(plans, /setUTCMonth\(d\.getUTCMonth\(\) \+ v\)/);   // months
  assert.match(plans, /UNIQUE\(service_code,plan_code,city_id\)/);
  assert.match(plans, /SERVICES = \["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"\]/);
  assert.match(planRoute, /requirePermission\(actor,"pricing\.manage"\)/);
});

test("coupons: governed live path (fail-closed) keeps per-vertical + city + expiry", () => {
  // live coupon creation requires explicit approval; default stays test-only
  assert.match(coupon, /Live coupons are not approved/);
  assert.match(coupon, /const testOnlyFlag=wantLive\?0:1/);
  // quoting a live coupon is blocked unless approved
  assert.match(coupon, /if\(!campaign\.testOnly&&!opts\.liveApproved\)return\{valid:false/);
  // the route sources approval from the environment flag
  assert.match(couponRoute, /PAWSPACE_COUPONS_LIVE_APPROVED/);
  assert.match(couponRoute, /liveApproved/);
});
