import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Test-only resolve hook so real libs with extensionless relative imports execute directly
// (same pattern as tests/customer-offers.test.mjs).
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pricingRoute = read("app/api/pricing-control/route.ts");
const marketingRoute = read("app/api/marketing-control/route.ts");
const pricingPanel = read("app/control/pricing-control-panel.tsx");
const marketingPanel = read("app/control/marketing-control-panel.tsx");
const liveQuoteRoute = read("app/api/live-price-quote/route.ts");
const gateway = read("lib/api-gateway.ts");

const statementsOf = (source) => [...source.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)].map((m) => m[2]);
const findStatement = (source, marker) => {
  const hit = statementsOf(source).find((sql) => sql.includes(marker));
  assert.ok(hit, `expected a prepared statement containing: ${marker}`);
  return hit;
};

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

const freshDb = () => makeD1(new DatabaseSync(":memory:"));

// ---------------------------------------------------------------------------
// Task 3 — permission mapping.
// ---------------------------------------------------------------------------
test("pricing-control and marketing-control enforce view/manage permissions in-route", () => {
  const pricingGet = pricingRoute.slice(pricingRoute.indexOf("export async function GET"), pricingRoute.indexOf("export async function PATCH"));
  const pricingWrites = pricingRoute.slice(pricingRoute.indexOf("export async function PATCH"));
  assert.match(pricingGet, /authorize\(request,"pricing\.view"\)/);
  assert.match(pricingWrites, /authorize\(request,"pricing\.manage"\)/);
  assert.match(pricingWrites, /sameOrigin\(request\)/, "pricing writes carry the cross-origin guard");
  const marketingGet = marketingRoute.slice(marketingRoute.indexOf("export async function GET"), marketingRoute.indexOf("export async function POST"));
  const marketingWrites = marketingRoute.slice(marketingRoute.indexOf("export async function POST"));
  assert.match(marketingGet, /authorize\(request,"marketing\.view"\)/);
  assert.match(marketingWrites, /authorize\(request,"marketing\.manage"\)/);
  // Gateway mapping exists (read-only assertion; api-gateway.ts untouched by this change).
  assert.match(gateway, /\/api\/pricing-control"\)return method==="GET"\?"pricing\.view":"pricing\.manage"/);
  assert.match(gateway, /\/api\/marketing-control"\)return method==="GET"\?"marketing\.view":"marketing\.manage"/);
});

// ---------------------------------------------------------------------------
// Task 1 — pricing: control edits genuinely change live customer quotes.
// ---------------------------------------------------------------------------
test("real execution: a package price change through the control API SQL changes the live quote, with version history", async () => {
  const db = freshDb();
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  await ensurePricingControlRuntime(db);

  const start = "2026-08-19T05:00:00.000Z"; // Wednesday 10:30 IST
  const before = await resolveLivePrice(db, { packageCode: "dog-bath", fallbackPrice: 1349, scheduledStart: start, cityId: "blr" });
  assert.deepEqual(before, { price: 1349, source: "fallback_default" }, "inactive canonical row leaves the flow's fallback untouched");

  // The control API's own PATCH statement (extracted, with the operator's identity).
  const patchSql = findStatement(pricingRoute, "SET ${set},version=version+1,updated_by=?").replace("${table}", "service_packages").replace("${set}", "base_price=?,active=?");
  db.prepare(patchSql).bind(1499, 1, "ops@pawspace.test", Date.now(), "canonical_groom_dog-bath");
  await db.prepare(patchSql).bind(1499, 1, "ops@pawspace.test", Date.now(), "canonical_groom_dog-bath").run();

  const after = await resolveLivePrice(db, { packageCode: "dog-bath", fallbackPrice: 1349, scheduledStart: start, cityId: "blr" });
  assert.equal(after.source, "pricing_control", "activated row is now the live source");
  assert.equal(after.price, 1499, "the customer quote is exactly the edited price");

  const row = await db.prepare("SELECT version,updated_by FROM service_packages WHERE package_code='dog-bath'").first();
  assert.equal(row.version, 2, "version history increments on every edit");
  assert.equal(row.updated_by, "ops@pawspace.test", "the real operator identity is recorded, not a hardcoded actor");

  // Audit statement from the route records before/after with the real actor.
  const auditSql = findStatement(pricingRoute, "INSERT INTO pricing_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at)");
  await db.prepare(auditSql).bind("price_audit_test1", "package", "canonical_groom_dog-bath", "updated", JSON.stringify({ base_price: 1349 }), JSON.stringify({ base_price: 1499 }), "ops@pawspace.test", "UAT price revision", Date.now()).run();
  const audit = await db.prepare("SELECT * FROM pricing_audit_events WHERE entity_id='canonical_groom_dog-bath'").first();
  assert.match(String(audit.before_json), /1349/);
  assert.match(String(audit.after_json), /1499/);
  assert.equal(audit.actor_id, "ops@pawspace.test");
});

test("real execution: a rule created and published through the control API SQL changes matching quotes only", async () => {
  const db = freshDb();
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  await ensurePricingControlRuntime(db);
  const patchSql = findStatement(pricingRoute, "SET ${set},version=version+1,updated_by=?");
  await db.prepare(patchSql.replace("${table}", "service_packages").replace("${set}", "base_price=?,active=?")).bind(1000, 1, "ops@pawspace.test", Date.now(), "canonical_groom_dog-bath").run();

  // POST statement (draft) then PATCH to published — the panel's Publish button path.
  const createSql = findStatement(pricingRoute, "INSERT INTO dynamic_pricing_rules");
  await db.prepare(createSql).bind("price_rule_test1", "Weekend morning uplift", "grooming", null, "weekend", "[0,6]", "09:00", "11:00", "2026-08-01", "2026-12-31", "percent", 15, "stackable", 50, "ops@pawspace.test", Date.now()).run();

  const saturdayMorning = "2026-08-15T04:30:00.000Z"; // Saturday 10:00 IST
  const draft = await resolveLivePrice(db, { packageCode: "dog-bath", fallbackPrice: 1000, scheduledStart: saturdayMorning, cityId: "blr" });
  assert.equal(draft.price, 1000, "a draft rule must not change customer prices");

  await db.prepare(patchSql.replace("${table}", "dynamic_pricing_rules").replace("${set}", "status=?")).bind("published", "ops@pawspace.test", Date.now(), "price_rule_test1").run();
  const published = await resolveLivePrice(db, { packageCode: "dog-bath", fallbackPrice: 1000, scheduledStart: saturdayMorning, cityId: "blr" });
  assert.equal(published.price, 1150, "published +15% weekend rule applies to a Saturday-morning quote");

  const wednesday = await resolveLivePrice(db, { packageCode: "dog-bath", fallbackPrice: 1000, scheduledStart: "2026-08-19T05:00:00.000Z", cityId: "blr" });
  assert.equal(wednesday.price, 1000, "the rule does not leak onto non-matching days");
});

test("regression: weekend day matching uses IST like the time band, not the server timezone", async () => {
  const db = freshDb();
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  await ensurePricingControlRuntime(db);
  const patchSql = findStatement(pricingRoute, "SET ${set},version=version+1,updated_by=?");
  await db.prepare(patchSql.replace("${table}", "service_packages").replace("${set}", "base_price=?,active=?")).bind(1000, 1, "ops@pawspace.test", Date.now(), "canonical_groom_dog-bath").run();
  await db.prepare(findStatement(pricingRoute, "INSERT INTO dynamic_pricing_rules")).bind("price_rule_ist", "Weekend all-day", "grooming", null, "weekend", "[0,6]", null, null, "2026-08-01", "2026-12-31", "percent", 10, "stackable", 50, "ops@pawspace.test", Date.now()).run();
  await db.prepare(patchSql.replace("${table}", "dynamic_pricing_rules").replace("${set}", "status=?")).bind("published", "ops@pawspace.test", Date.now(), "price_rule_ist").run();
  // Saturday 02:00 IST = Friday 20:30 UTC — a UTC getDay() would miss the weekend rule.
  const istSaturdayEarly = await resolveLivePrice(db, { packageCode: "dog-bath", fallbackPrice: 1000, scheduledStart: "2026-08-14T20:30:00.000Z", cityId: "blr" });
  assert.equal(istSaturdayEarly.price, 1100, "IST Saturday early morning matches the weekend rule");
});

test("knob trace: every canonical pricing knob has a real consumer; legacy demo codes have none and stay inactive", async () => {
  const runtime = read("lib/pricing-control-runtime.ts");
  const consumers = {
    "app/api/live-price-quote/route.ts (grooming-flow live quotes)": liveQuoteRoute,
    "lib/grooming-governance.ts": read("lib/grooming-governance.ts"),
    "lib/live-grooming-governance.ts": read("lib/live-grooming-governance.ts"),
    "lib/training-commercial-governance.ts": read("lib/training-commercial-governance.ts"),
    "lib/live-commercial-quotes.ts (boarding/sitting)": read("lib/live-commercial-quotes.ts"),
  };
  for (const [name, source] of Object.entries(consumers)) assert.match(source, /resolveLivePrice/, `${name} consumes the pricing-control tables via the live resolver`);
  // Flow-facing package codes exist as canonical knobs.
  for (const code of ["dog-bath", "dog-makeover", "trainer-meet-greet", "training-8-basic", "boarding-24h", "sitting-overnight", "sitting-visit-60__extra_pet"]) {
    assert.match(runtime, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `canonical knob ${code} is seeded for the resolver`);
  }
  // Legacy demo codes are consumed by nothing customer-facing…
  const legacyCodes = ["bath_basic", "complete_makeover", "puppy_foundation_6", "standard_home_stay", "overnight_sitting"];
  for (const [name, source] of Object.entries(consumers)) {
    for (const code of legacyCodes) assert.doesNotMatch(source, new RegExp(`["'\`]${code}`), `${name} must not reference legacy demo code ${code}`);
  }
  assert.doesNotMatch(read("lib/grooming-pricing-code.ts"), /bath_basic|complete_makeover/);
  // …and the route seeds them inactive + demotes previously-active untouched seeds.
  assert.match(pricingRoute, /VALUES \(\?,\?,\?,\?,\?,\?,'INR',1,\?,\?,0,1,\?,NULL,'founder_seed',\?\)/, "legacy demo packages seed as inactive");
  assert.match(pricingRoute, /UPDATE service_packages SET active=0 WHERE active=1 AND updated_by='founder_seed'/, "previously-active untouched legacy seeds are demoted");
  assert.match(pricingRoute, /legacy demo/, "legacy rows are named as such in the panel list");
});

test("pricing panel tells the truth about linkage and derives the simulator default from real data", () => {
  assert.doesNotMatch(pricingPanel, /still use their own separate hardcoded pricing/, "the stale unwired-verticals claim is gone");
  assert.match(pricingPanel, /Connected to live customer quotes/);
  assert.match(pricingPanel, /legacy demo/);
  assert.doesNotMatch(pricingPanel, /useState\("bath_basic"\)/, "simulator no longer defaults to a dead legacy code");
  assert.match(pricingPanel, /setPreviewPackage\(current=>current\|\|/, "simulator default comes from the loaded packages");
});

// ---------------------------------------------------------------------------
// Task 2 — marketing: CRUD, toggles and coupon links hit real consumed tables.
// ---------------------------------------------------------------------------
test("real execution: campaign create/approve through the route SQL lands in the table the GET lists", async () => {
  const db = freshDb();
  const { ensureMarketingGovernance } = await import("../lib/marketing-governance.ts");
  await ensureMarketingGovernance(db);
  const createSql = findStatement(marketingRoute, "INSERT INTO governed_marketing_campaigns");
  await db.prepare(createSql).bind("MKT-TEST1", "Weekday grooming demand", "Bookings", "grooming", "blr", "{}", 25000, 10, null, null, "maker@pawspace.test", Date.now(), Date.now()).run();
  const listed = await db.prepare(findStatement(marketingRoute, "SELECT * FROM governed_marketing_campaigns ORDER BY updated_at")).all();
  assert.equal(listed.results.length, 1);
  assert.equal(listed.results[0].approval_status, "approval_required", "campaigns start requiring human approval");
  const approveSql = findStatement(marketingRoute, "SET approval_status='approved'");
  await db.prepare(approveSql).bind("checker@pawspace.test", Date.now(), Date.now(), "MKT-TEST1").run();
  const approved = await db.prepare("SELECT approval_status,approved_by FROM governed_marketing_campaigns WHERE id='MKT-TEST1'").first();
  assert.equal(approved.approval_status, "approved");
  assert.equal(approved.approved_by, "checker@pawspace.test");
  assert.match(marketingRoute, /the campaign creator cannot approve their own campaign/, "maker/checker stays enforced");
});

test("real execution: an activated promotion becomes a redeemable coupon on the customer surface", async () => {
  const db = freshDb();
  const promotions = await import("../lib/promotion-governance.ts");
  const coupons = await import("../lib/coupon-governance.ts");

  const draft = await promotions.createPromotionDraft(db, { name: "Weekday grooming trial", promotionType: "percent_discount", vertical: "Grooming", audience: "New and dormant", value: 10, budgetCap: 50000, marginFloorPercent: 25, holdoutPercent: 10, startAt: "2026-08-01", endAt: "2026-12-31", actor: "maker@pawspace.test" });
  await promotions.approvePromotion(db, { promotionId: draft.id, actor: "checker@pawspace.test", reason: "Reviewed margin and budget" });
  await promotions.snapshotPromotionAudience(db, { promotionId: draft.id, actor: "checker@pawspace.test" });
  const activated = await promotions.activatePromotion(db, { promotionId: draft.id, actor: "checker@pawspace.test" });

  assert.ok(activated.couponCode, "activation returns the customer-facing coupon code");
  const campaign = await db.prepare("SELECT * FROM coupon_campaigns WHERE id=?").bind(String(activated.couponCampaignId)).first();
  assert.ok(campaign, "the promotion writes into coupon_campaigns — the table quoteCoupon reads");
  assert.equal(campaign.discount_type, "percent");
  assert.equal(campaign.discount_value, 10);
  assert.equal(campaign.per_customer_limit, 1);
  assert.equal(campaign.total_limit, 100, "percent promotions cap at 100 redemptions");
  assert.equal(campaign.max_discount, 500, "per-redemption cap = budgetCap/100, so worst case spends exactly the budget");
  assert.equal(campaign.test_only, 1, "linked coupon stays UAT test-only");

  // The REAL customer surface path: quoteCoupon reads the campaign and prices the discount.
  const quote = await coupons.quoteCoupon(db, { code: String(activated.couponCode), customerId: "cus-promo-1", serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode: "uat-default", orderValue: 2000, paymentMode: "full", isSubscription: false });
  assert.equal(quote.valid, true, "a customer can genuinely redeem the promotion's coupon");
  assert.equal(quote.discount, 200, "10% of a ₹2000 order");

  // Pausing the promotion pauses the coupon immediately.
  await promotions.setPromotionStatus(db, { promotionId: draft.id, status: "paused", actor: "checker@pawspace.test" });
  const paused = await coupons.quoteCoupon(db, { code: String(activated.couponCode), customerId: "cus-promo-2", serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode: "uat-default", orderValue: 2000, paymentMode: "full", isSubscription: false });
  assert.equal(paused.valid, false, "a paused promotion is no longer redeemable");
});

test("real execution: flat promotions derive budget-exact limits; non-discount promotions link no coupon", async () => {
  const db = freshDb();
  const promotions = await import("../lib/promotion-governance.ts");
  assert.deepEqual(promotions.promotionCouponLimits("flat_discount", 250, 5000), { discountType: "fixed", maxDiscount: 250, totalLimit: 20 }, "flat: 20 × ₹250 = exactly the ₹5000 cap");
  assert.deepEqual(promotions.promotionCouponLimits("percent_discount", 10, 50000), { discountType: "percent", maxDiscount: 500, totalLimit: 100 });

  const addon = await promotions.createPromotionDraft(db, { name: "Free addon trial", promotionType: "free_addon", vertical: "Grooming", audience: "Subscribers", value: 1, budgetCap: 1000, marginFloorPercent: 25, holdoutPercent: 10, actor: "maker@pawspace.test" });
  await promotions.approvePromotion(db, { promotionId: addon.id, actor: "checker@pawspace.test", reason: "Reviewed addon budget" });
  await promotions.snapshotPromotionAudience(db, { promotionId: addon.id, actor: "checker@pawspace.test" });
  const activated = await promotions.activatePromotion(db, { promotionId: addon.id, actor: "checker@pawspace.test" });
  assert.equal(activated.couponCampaignId, null, "free_addon has no coupon analog and links nothing");
});

test("real execution: automation-rule channel toggles persist as audited state changes", async () => {
  const db = freshDb();
  const rules = await import("../lib/marketing-automation-rules.ts");
  const created = await rules.createAutomationRule(db, { name: "Pause on spend anomaly", triggerCode: "spend_anomaly", condition: { threshold: 0.2 }, action: { type: "pause_campaign" }, actor: "maker@pawspace.test" });
  const enabled = await rules.setAutomationRuleEnabled(db, { ruleId: created.id, enabled: true, reason: "Enabling after UAT review", actor: "checker@pawspace.test" });
  assert.equal(Boolean(enabled.enabled ?? true), true);
  const row = await db.prepare("SELECT enabled FROM marketing_automation_rules WHERE id=?").bind(created.id).first();
  assert.equal(row.enabled, 1, "the toggle hits the real governed table");
  const events = await db.prepare("SELECT COUNT(*) c FROM marketing_automation_rule_events WHERE rule_id=?").bind(created.id).first();
  assert.ok(Number(events.c) >= 1, "toggles are audited");
});

// ---------------------------------------------------------------------------
// Task 4 — panel truthfulness regressions.
// ---------------------------------------------------------------------------
test("marketing panel no longer makes false claims about its data or backends", () => {
  assert.doesNotMatch(marketingPanel, /Finance-verified cost/, "fabricated tiles cannot claim finance verification");
  assert.doesNotMatch(marketingPanel, /NOT YET BUILT/, "the automation backend exists and is wired — the stale claim is gone");
  assert.doesNotMatch(marketingPanel, /No automation-rule governance backend exists yet/);
  assert.match(marketingPanel, /ILLUSTRATIVE SAMPLE DATA/, "fabricated scorecard/funnel are labeled illustrative");
  assert.match(marketingPanel, /Illustrative sample/, "metric tiles carry the illustrative label");
  assert.match(marketingPanel, /Customer coupon: \{p\.coupon_code\}/, "the promotion's live coupon linkage is visible to ops");
});
