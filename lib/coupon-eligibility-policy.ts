import type { CouponCampaign, CouponQuoteInput, CouponCustomerKind, CouponService } from "./coupon-governance";

export const NORMAL_COUPON_BOOKING_LIMIT = 3;
export const NORMAL_COUPON_LIMIT_MESSAGE = "Normal offers are available for your first three bookings. Use a special code issued to your account.";
export type CouponCustomerFacts = { orderCount: number; kind: CouponCustomerKind; previousServices: CouponService[] };
export function isCustomerSpecificCoupon(campaign: Pick<CouponCampaign, "customerIds">): boolean {
  return Boolean(campaign.customerIds?.length);
}

/** Same gates for browse-time offers and persisted quotes; browsing never creates a quote. */
export function couponEligibilityIssue(campaign: CouponCampaign, input: CouponQuoteInput, facts: CouponCustomerFacts,
  limits: { totalUsed: number; customerUsed: number }, options: { now: number; liveApproved?: boolean }): string | null {
  if(campaign.status!=="active")return "Coupon is paused";
  if(campaign.customerIds?.length&&!campaign.customerIds.includes(input.customerId))return "This coupon belongs to another account";
  if(!campaign.testOnly&&!options.liveApproved)return "Live coupons are not enabled in this environment (PAWSPACE_COUPONS_LIVE_APPROVED not set)";
  if(options.now<campaign.validFrom||options.now>campaign.validUntil)return "Coupon is outside its validity window";
  if(!campaign.serviceCodes.includes(input.serviceCode))return "Coupon is not eligible for this service";
  if(!campaign.cityIds.includes(input.cityId))return "Coupon is not eligible in this city";
  if(!campaign.channels.includes(input.channel))return "Coupon is not eligible on this channel";
  if(!campaign.customerKinds.includes(facts.kind))return "Customer is not eligible for this coupon";
  if(campaign.firstOrderOnly&&facts.orderCount>0)return "Coupon is for the first booking only";
  if(!isCustomerSpecificCoupon(campaign)&&facts.orderCount>=NORMAL_COUPON_BOOKING_LIMIT)return NORMAL_COUPON_LIMIT_MESSAGE;
  if(campaign.crossSellFromServices.length&&!campaign.crossSellFromServices.some(service=>facts.previousServices.includes(service)))return "This cross-sell coupon requires an eligible previous service";
  if(input.isSubscription&&!campaign.subscriptionEligible)return "Coupon is not eligible for subscriptions";
  if(campaign.packageScope==="subscription"&&!input.isSubscription)return "Coupon requires a subscription package";
  if(campaign.packageScope==="single_session"&&input.isSubscription)return "Coupon is limited to single-session packages";
  if(campaign.packageScope==="selected"&&!campaign.packageCodes.includes(input.packageCode))return "Coupon is not eligible for this package";
  if(campaign.fullPaymentOnly&&input.paymentMode!=="full")return "Coupon requires full payment";
  if(input.orderValue<campaign.minOrder)return "Minimum order value not met";
  if(campaign.maxOrder!=null&&input.orderValue>campaign.maxOrder)return "Maximum order value exceeded";
  if(limits.totalUsed>=campaign.totalLimit)return "Coupon has reached its total redemption limit";
  if(limits.customerUsed>=campaign.perCustomerLimit)return "Customer has reached this coupon's usage limit";
  return null;
}
