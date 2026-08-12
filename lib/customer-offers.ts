// Customer-facing "available offers" browsing surface. This EXTENDS lib/coupon-governance.ts,
// it never replaces it: reuses the same coupon_campaigns table, the same ensureCouponTables/
// seedUatCoupons DDL+seed, and the same customerFacts/rowToCampaign helpers (both now exported
// from coupon-governance.ts, unchanged in behaviour - just made reusable here). A real booking's
// actual discount is still only ever decided by the existing quoteCoupon()/consumeCouponQuote()
// flow behind /api/coupon-governance; this module never applies a discount itself, it only lists
// which codes a customer could try before checkout and flags the one that should auto-apply.
//
// /api/coupon-governance is staff-permissioned (requires "pricing.view") because it also exposes
// campaign management. A customer must not need a staff permission just to see which coupon codes
// exist, so this module is read-only and deliberately has no save/quote/consume surface of its own.

import { ensureCouponTables, seedUatCoupons, customerFacts, rowToCampaign, type CouponCampaign } from "./coupon-governance";

type Db = D1Database;
type Row = Record<string, unknown>;
const DAY = 86_400_000;

export const WELCOME_COUPON_CODE = "WELCOME";
const WELCOME_CAMPAIGN_ID = "uat-coupon-welcome";

export type CustomerOffer = {
  code: string;
  name: string;
  discountType: "fixed" | "percent";
  discountValue: number;
  maxDiscount: number | null;
  minOrder: number;
  description: string;
  autoApply: boolean;
};

// Idempotent, same INSERT OR IGNORE pattern as seedUatCoupons - safe to call on every request.
export async function seedWelcomeCoupon(db: Db) {
  await ensureCouponTables(db);
  const now = Date.now(), start = now - DAY, end = now + 365 * DAY;
  await db
    .prepare(
      "INSERT OR IGNORE INTO coupon_campaigns (id,code,name,status,test_only,service_codes_json,city_ids_json,channels_json,customer_kinds_json,package_scope,package_codes_json,cross_sell_from_services_json,first_order_only,min_order,max_order,subscription_eligible,full_payment_only,discount_type,discount_value,max_discount,per_customer_limit,total_limit,valid_from,valid_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(
      WELCOME_CAMPAIGN_ID,
      WELCOME_COUPON_CODE,
      "Welcome to PawSpace",
      "active",
      1, // test_only - governed the same way as every other coupon in this codebase until live coupons are approved
      JSON.stringify(["grooming", "dog_training", "boarding", "pet_sitting"]),
      JSON.stringify(["blr"]),
      JSON.stringify(["customer_app", "website", "assisted_staff", "whatsapp", "partner_app"]),
      JSON.stringify(["new"]),
      "all",
      JSON.stringify([]),
      JSON.stringify([]),
      1, // first_order_only
      300, // min_order
      null, // max_order
      0, // subscription_eligible
      0, // full_payment_only
      "percent",
      15,
      300, // max_discount
      1, // per_customer_limit
      100_000, // total_limit
      start,
      end,
      now,
      now
    )
    .run();
}

function describeCampaign(campaign: CouponCampaign): string {
  const amount = campaign.discountType === "percent" ? `${campaign.discountValue}% off` : `₹${campaign.discountValue} off`;
  const cap = campaign.discountType === "percent" && campaign.maxDiscount != null ? ` (up to ₹${campaign.maxDiscount})` : "";
  const minOrder = campaign.minOrder > 0 ? ` on orders above ₹${campaign.minOrder}` : "";
  const scope = campaign.firstOrderOnly ? " · first booking only" : "";
  return `${amount}${cap}${minOrder}${scope}`;
}

function toOffer(campaign: CouponCampaign, autoApply: boolean): CustomerOffer {
  return {
    code: campaign.code,
    name: campaign.name,
    discountType: campaign.discountType,
    discountValue: campaign.discountValue,
    maxDiscount: campaign.maxDiscount,
    minOrder: campaign.minOrder,
    description: describeCampaign(campaign),
    autoApply,
  };
}

// Real eligibility (service/city/channel/order-value/limits) is only ever fully checked by
// quoteCoupon() at actual checkout. This browse-time list intentionally only filters on what is
// known before a service/package is chosen: customer kind and first-order-only status - both from
// the same real customerFacts() the checkout quote uses, so "new" here means the same thing "new"
// means when the coupon is actually redeemed.
export async function listAvailableCoupons(db: Db, input: { customerId: string }): Promise<{ coupons: CustomerOffer[]; autoApply: CustomerOffer | null }> {
  const customerId = String(input?.customerId || "").trim();
  if (!customerId) throw new Error("customerId is required");
  await ensureCouponTables(db);
  await seedUatCoupons(db);
  await seedWelcomeCoupon(db);

  const facts = await customerFacts(db, customerId);
  const now = Date.now();
  const rows = await db
    .prepare("SELECT * FROM coupon_campaigns WHERE status='active' AND valid_from<=? AND valid_until>=? ORDER BY created_at ASC")
    .bind(now, now)
    .all<Row>();

  const eligible = rows.results
    .map(rowToCampaign)
    .filter((campaign) => campaign.customerKinds.includes(facts.kind))
    .filter((campaign) => !campaign.firstOrderOnly || facts.orderCount === 0);

  const coupons = eligible.map((campaign) => toOffer(campaign, campaign.code === WELCOME_COUPON_CODE && facts.orderCount === 0));
  const autoApply = coupons.find((offer) => offer.autoApply) ?? null;
  return { coupons, autoApply };
}
