import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__GROOMING_COMMERCIAL_DB__");

const NOW = Date.now();
const START = "2026-08-24T04:30:00.000Z"; // Monday, 10:00 IST.

async function pricingDb() {
  const harness = freshCountingD1();
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensurePricingControlRuntime(harness.db);
  return harness;
}

async function couponDb() {
  const harness = freshCountingD1();
  const { ensureCouponTables } = await import("../lib/coupon-governance.ts");
  await ensureCouponTables(harness.db);
  return harness;
}

async function campaign(db, overrides = {}) {
  const { saveCouponCampaign } = await import("../lib/coupon-governance.ts");
  const id = overrides.id ?? `campaign-${crypto.randomUUID()}`;
  return saveCouponCampaign(db, {
    id,
    code: overrides.code ?? id.toUpperCase(),
    name: overrides.name ?? "Runtime grooming coupon",
    status: overrides.status ?? "active",
    serviceCodes: overrides.serviceCodes ?? ["grooming"],
    cityIds: overrides.cityIds ?? ["blr"],
    channels: ["customer_app"],
    customerKinds: ["new", "existing", "subscriber"],
    packageScope: "all",
    packageCodes: [],
    crossSellFromServices: [],
    firstOrderOnly: false,
    minOrder: overrides.minOrder ?? 500,
    maxOrder: null,
    subscriptionEligible: false,
    fullPaymentOnly: false,
    discountType: overrides.discountType ?? "fixed",
    discountValue: overrides.discountValue ?? 100,
    maxDiscount: overrides.maxDiscount ?? 100,
    perCustomerLimit: overrides.perCustomerLimit ?? 2,
    totalLimit: overrides.totalLimit ?? 10,
    validFrom: overrides.validFrom ?? NOW - 60_000,
    validUntil: overrides.validUntil ?? NOW + 3_600_000,
  });
}

const quoteInput = (code, overrides = {}) => ({
  code,
  customerId: overrides.customerId ?? "CUS-RUNTIME",
  serviceCode: overrides.serviceCode ?? "grooming",
  cityId: overrides.cityId ?? "blr",
  channel: "customer_app",
  packageCode: "dog-basic",
  orderValue: overrides.orderValue ?? 1_000,
  paymentMode: "full",
  isSubscription: false,
});

function seedRedemption(sqlite, { id, campaignId, customerId }) {
  sqlite.prepare("INSERT INTO coupon_redemptions (id,idempotency_key,quote_id,campaign_id,code,customer_id,booking_id,discount_amount,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'consumed',?,?)")
    .run(id, `idem-${id}`, `quote-${id}`, campaignId, "USED", customerId, `booking-${id}`, 100, NOW, NOW);
}

test("real catalogue governance: an active Grooming package resolves, then retirement makes it unavailable", async () => {
  const { sqlite, db } = freshCountingD1();
  const { createCataloguePackage, updateCataloguePackage, resolveCataloguePrice } = await import("../lib/catalogue-governance.ts");
  const created = await createCataloguePackage(db, {
    serviceCode: "grooming",
    packageCode: "runtime-groom",
    cityId: "blr",
    zoneId: "blr-east",
    name: "Runtime Groom",
    basePrice: 1775,
    slotMinutes: 90,
    blockingMinutes: 120,
    effectiveFrom: "2026-08-01",
    actorId: "pricing-runtime-test",
    reason: "Executable catalogue lifecycle proof",
  });
  const active = await resolveCataloguePrice(db, { serviceCode: "grooming", packageCode: "runtime-groom", cityId: "blr", zoneId: "blr-east", at: Date.parse(START) });
  assert.equal(active.id, created.id);
  assert.equal(active.active, true);
  assert.equal(active.basePrice, 1775);

  const retired = await updateCataloguePackage(db, { id: created.id, changes: { active: false }, reason: "Retire runtime package", actorId: "pricing-runtime-test" });
  assert.equal(retired.active, false);
  assert.equal(retired.version, 2);
  assert.equal(await resolveCataloguePrice(db, { serviceCode: "grooming", packageCode: "runtime-groom", cityId: "blr", zoneId: "blr-east", at: Date.parse(START) }), null);
  assert.deepEqual({ ...sqlite.prepare("SELECT active,version FROM catalogue_packages WHERE id=?").get(created.id) }, { active: 0, version: 2 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM catalogue_audit WHERE package_id=?").get(created.id).count, 2);
});

test("real pricing: only an active package and published in-window rule change governed price", async () => {
  const { sqlite, db } = await pricingDb();
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");

  const seeded = sqlite.prepare("SELECT active,base_price FROM service_packages WHERE package_code='dog-basic'").get();
  assert.deepEqual({ ...seeded }, { active: 0, base_price: 1899 });
  const inactive = await resolveLivePrice(db, { packageCode: "dog-basic", fallbackPrice: 1899, scheduledStart: START, cityId: "blr", zoneId: "blr-east" });
  assert.deepEqual(inactive, { price: 1899, source: "fallback_default" });

  sqlite.prepare("UPDATE service_packages SET active=1,base_price=2000 WHERE package_code='dog-basic'").run();
  const active = await resolveLivePrice(db, { packageCode: "dog-basic", fallbackPrice: 1899, scheduledStart: START, cityId: "blr", zoneId: "blr-east" });
  assert.deepEqual(active, { price: 2000, source: "pricing_control" });

  const insertRule = sqlite.prepare("INSERT INTO dynamic_pricing_rules (id,name,service_code,package_code,city_id,zone_id,rule_type,days_json,start_time,end_time,effective_from,effective_to,adjustment_type,adjustment_value,coupon_policy,priority,status,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertRule.run("RULE-DRAFT", "Draft surcharge", "grooming", "dog-basic", "blr", "blr-east", "date_range", "[]", null, null, "2026-08-01", "2026-08-31", "fixed", 900, "stackable", 1, "draft", 1, "test", NOW);
  insertRule.run("RULE-OLD", "Expired surcharge", "grooming", "dog-basic", "blr", "blr-east", "date_range", "[]", null, null, "2026-07-01", "2026-07-31", "fixed", 700, "stackable", 2, "published", 1, "test", NOW);
  insertRule.run("RULE-WRONG-DAY", "Tuesday-only surcharge", "grooming", "dog-basic", "blr", "blr-east", "weekday", "[2]", null, null, "2026-08-01", "2026-08-31", "fixed", 600, "stackable", 2, "published", 1, "test", NOW);
  insertRule.run("RULE-WRONG-TIME", "Later time-band surcharge", "grooming", "dog-basic", "blr", "blr-east", "time_band", "[1]", "11:00", "12:00", "2026-08-01", "2026-08-31", "fixed", 500, "stackable", 2, "published", 1, "test", NOW);
  insertRule.run("RULE-LIVE", "Published surcharge", "grooming", "dog-basic", "blr", "blr-east", "date_range", "[]", null, null, "2026-08-01", "2026-08-31", "fixed", 250, "stackable", 3, "published", 1, "test", NOW);
  const governed = await resolveLivePrice(db, { packageCode: "dog-basic", fallbackPrice: 1899, scheduledStart: START, cityId: "blr", zoneId: "blr-east" });
  assert.deepEqual(governed, { price: 2250, source: "pricing_control" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM dynamic_pricing_rules WHERE status='published'").get().count, 4);
});

test("real coupons: valid quote persists exact bounded discount and final amount", async () => {
  const { sqlite, db } = await couponDb();
  const { quoteCoupon } = await import("../lib/coupon-governance.ts");
  const saved = await campaign(db, { id: "cap", code: "CAP20", discountType: "percent", discountValue: 20, maxDiscount: 150 });
  const result = await quoteCoupon(db, quoteInput(saved.code, { orderValue: 1_000 }));
  assert.equal(result.valid, true);
  assert.equal(result.discount, 150);
  assert.equal(result.finalAmount, 850);
  const persisted = sqlite.prepare("SELECT customer_id,service_code,city_id,order_value,discount_amount,final_amount,status FROM coupon_quotes WHERE id=?").get(result.quoteId);
  assert.deepEqual({ ...persisted }, { customer_id: "CUS-RUNTIME", service_code: "grooming", city_id: "blr", order_value: 1000, discount_amount: 150, final_amount: 850, status: "open" });
});

test("real coupons: validity, scope, threshold and redemption limits fail closed without quote rows", async () => {
  const { sqlite, db } = await couponDb();
  const { quoteCoupon } = await import("../lib/coupon-governance.ts");
  await campaign(db, { id: "expired", code: "EXPIRED", validFrom: NOW - 120_000, validUntil: NOW - 60_000 });
  await campaign(db, { id: "scoped", code: "SCOPED", minOrder: 900 });
  await campaign(db, { id: "total", code: "TOTAL", totalLimit: 1 });
  await campaign(db, { id: "customer", code: "CUSTOMER", perCustomerLimit: 1 });
  seedRedemption(sqlite, { id: "total-used", campaignId: "total", customerId: "CUS-OTHER" });
  seedRedemption(sqlite, { id: "customer-used", campaignId: "customer", customerId: "CUS-RUNTIME" });

  const cases = [
    [quoteInput("EXPIRED"), "Coupon is outside its validity window"],
    [quoteInput("SCOPED", { serviceCode: "boarding" }), "Coupon is not eligible for this service"],
    [quoteInput("SCOPED", { cityId: "maa" }), "Coupon is not eligible in this city"],
    [quoteInput("SCOPED", { orderValue: 899 }), "Minimum order value not met"],
    [quoteInput("TOTAL"), "Coupon has reached its total redemption limit"],
    [quoteInput("CUSTOMER"), "Customer has reached this coupon's usage limit"],
  ];
  for (const [input, error] of cases) {
    const before = sqlite.prepare("SELECT COUNT(*) count FROM coupon_quotes").get().count;
    const result = await quoteCoupon(db, input);
    assert.deepEqual({ valid: result.valid, error: result.error }, { valid: false, error });
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM coupon_quotes").get().count, before, error);
  }
});

test("real coupon booking preparation preserves governed amount and rejects tampered totals", async () => {
  const { sqlite, db } = await couponDb();
  const { quoteCoupon, prepareCouponBooking } = await import("../lib/coupon-governance.ts");
  await campaign(db, { id: "prepare", code: "PREPARE100" });
  const quote = await quoteCoupon(db, quoteInput("PREPARE100", { orderValue: 1_000 }));
  assert.equal(quote.valid, true);

  const input = { quoteId: quote.quoteId, bookingId: "BK-PREPARE", customerId: "CUS-RUNTIME", serviceCode: "grooming", cityId: "blr", packageCode: "dog-basic", submittedTotal: 900, submittedDiscount: 100, idempotencyKey: "prepare-1", now: NOW };
  const prepared = await prepareCouponBooking(db, input);
  assert.deepEqual({ orderValue: prepared.orderValue, discount: prepared.discount, finalAmount: prepared.finalAmount }, { orderValue: 1000, discount: 100, finalAmount: 900 });
  assert.equal(sqlite.prepare("SELECT status,booking_id FROM coupon_quotes WHERE id=?").get(quote.quoteId).status, "open", "preparation validates but does not consume outside the booking batch");

  await assert.rejects(() => prepareCouponBooking(db, { ...input, submittedTotal: 901, idempotencyKey: "prepare-tampered-total" }), /Booking amount does not match the governed coupon quote/);
  await assert.rejects(() => prepareCouponBooking(db, { ...input, submittedDiscount: 99, idempotencyKey: "prepare-tampered-discount" }), /Booking amount does not match the governed coupon quote/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM coupon_redemptions").get().count, 0);
  assert.deepEqual({ ...sqlite.prepare("SELECT status,booking_id FROM coupon_quotes WHERE id=?").get(quote.quoteId) }, { status: "open", booking_id: null });
});
