export type PawspaceService = "Grooming" | "Dog Training" | "Boarding" | "Pet Sitting";
export type CustomerKind = "new" | "existing" | "subscriber";
export type PawspaceCity = "Bengaluru" | "Mumbai" | "Delhi NCR" | "Hyderabad" | "Chennai" | "Pune";
export type OfferChannel = "Customer app" | "Website" | "CRM assisted" | "WhatsApp" | "Partner app";

export type CouponRule = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  customerKinds: CustomerKind[];
  services: PawspaceService[];
  cities: PawspaceCity[];
  channels: OfferChannel[];
  packageScope: "all" | "single_session" | "subscription" | "selected";
  packageNames: string[];
  crossSellFromServices: PawspaceService[];
  firstOrderOnly: boolean;
  orderNumberFrom: number | null;
  orderNumberTo: number | null;
  minOrder: number;
  maxOrder: number | null;
  subscriptionEligible: boolean;
  fullPaymentOnly: boolean;
  discountType: "fixed" | "percent";
  discountValue: number;
  maxDiscount: number | null;
  perCustomerLimit: number;
  totalLimit: number;
  used: number;
  validUntil: string;
};

export type ReferralPolicy = {
  programmeName: string;
  active: boolean;
  friendDiscount: number;
  referrerReward: 300 | 400 | 500 | 600;
  rewardChoices: (300 | 400 | 500 | 600)[];
  minFirstOrder: number;
  rewardsPerMonth: number;
  rewardValidityDays: number;
  releaseOn: "completed_first_booking";
  oneRewardPerFriend: boolean;
  stackable: boolean;
  eligibleServices: PawspaceService[];
  eligibleCities: PawspaceCity[];
  referrerKinds: CustomerKind[];
  rewardUseServices: PawspaceService[];
  validFrom: string;
  validUntil: string;
  reversalOnRefund: boolean;
  fraudReviewEnabled: boolean;
};

export type OfferConfig = { version: 1; coupons: CouponRule[]; referral: ReferralPolicy };
export type OfferContext = {
  code: string;
  service: PawspaceService;
  orderValue: number;
  customerKind?: CustomerKind;
  orderCount?: number;
  isSubscription?: boolean;
  paymentMode?: "full" | "partial" | "after_service";
  customerCouponUsage?: number;
  referralRewardsThisMonth?: number;
  wasReferredBefore?: boolean;
  city?: PawspaceCity;
  channel?: OfferChannel;
  packageName?: string;
  previousServices?: PawspaceService[];
};

export const offerStorageKey = "pawspace:offer-config:v1";
export const offerChangeEvent = "pawspace-offer-config-change";
const allServices: PawspaceService[] = ["Grooming", "Dog Training", "Boarding", "Pet Sitting"];
const allCustomers: CustomerKind[] = ["new", "existing", "subscriber"];
const allCities: PawspaceCity[] = ["Bengaluru", "Mumbai", "Delhi NCR", "Hyderabad", "Chennai", "Pune"];
const allChannels: OfferChannel[] = ["Customer app", "Website", "CRM assisted", "WhatsApp", "Partner app"];

const commonCouponRules = {
  cities: allCities,
  channels: allChannels,
  packageScope: "all" as const,
  packageNames: [] as string[],
  crossSellFromServices: [] as PawspaceService[],
  firstOrderOnly: false,
  orderNumberFrom: null,
  orderNumberTo: null,
};

export const defaultOfferConfig: OfferConfig = {
  version: 1,
  coupons: [
    { ...commonCouponRules, id: "paw100", code: "PAW100", name: "Always-on care offer", active: true, customerKinds: allCustomers, services: allServices, minOrder: 999, maxOrder: null, subscriptionEligible: true, fullPaymentOnly: false, discountType: "fixed", discountValue: 100, maxDiscount: 100, perCustomerLimit: 2, totalLimit: 5000, used: 1248, validUntil: "2026-12-31" },
    { ...commonCouponRules, id: "welcome300", code: "WELCOME300", name: "New customer conversion", active: true, customerKinds: ["new"], services: allServices, firstOrderOnly: true, minOrder: 1499, maxOrder: null, subscriptionEligible: false, fullPaymentOnly: true, discountType: "fixed", discountValue: 300, maxDiscount: 300, perCustomerLimit: 1, totalLimit: 2500, used: 486, validUntil: "2026-10-31" },
    { ...commonCouponRules, id: "sub500", code: "SUB500", name: "Subscription retention", active: true, customerKinds: ["subscriber"], services: allServices, packageScope: "subscription", minOrder: 2999, maxOrder: null, subscriptionEligible: true, fullPaymentOnly: true, discountType: "fixed", discountValue: 500, maxDiscount: 500, perCustomerLimit: 1, totalLimit: 1000, used: 214, validUntil: "2026-11-30" },
    { ...commonCouponRules, id: "groom2train", code: "TRAINNEXT", name: "Grooming to training cross-sell", active: true, customerKinds: ["existing", "subscriber"], services: ["Dog Training"], crossSellFromServices: ["Grooming"], cities: ["Bengaluru"], minOrder: 3500, maxOrder: null, subscriptionEligible: false, fullPaymentOnly: true, discountType: "fixed", discountValue: 400, maxDiscount: 400, perCustomerLimit: 1, totalLimit: 1200, used: 318, validUntil: "2026-09-30" },
  ],
  referral: { programmeName: "Refer a Pet Parent", active: true, friendDiscount: 300, referrerReward: 500, rewardChoices: [300, 400, 500, 600], minFirstOrder: 999, rewardsPerMonth: 5, rewardValidityDays: 60, releaseOn: "completed_first_booking", oneRewardPerFriend: true, stackable: false, eligibleServices: allServices, eligibleCities: allCities, referrerKinds: ["existing", "subscriber"], rewardUseServices: allServices, validFrom: "2026-08-01", validUntil: "2027-03-31", reversalOnRefund: true, fraudReviewEnabled: true },
};

export function readOfferConfig(): OfferConfig {
  if (typeof window === "undefined") return defaultOfferConfig;
  try {
    const raw = window.localStorage.getItem(offerStorageKey);
    if (!raw) return defaultOfferConfig;
    const parsed = JSON.parse(raw) as OfferConfig;
    if (parsed.version !== 1 || !Array.isArray(parsed.coupons)) return defaultOfferConfig;
    return {
      ...defaultOfferConfig,
      ...parsed,
      coupons: parsed.coupons.map((coupon) => ({ ...commonCouponRules, ...coupon })),
      referral: { ...defaultOfferConfig.referral, ...parsed.referral },
    };
  } catch { return defaultOfferConfig; }
}

export function saveOfferConfig(config: OfferConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(offerStorageKey, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent(offerChangeEvent, { detail: config }));
}

export function validateOffer(context: OfferContext, config = readOfferConfig()) {
  const code = context.code.trim().toUpperCase();
  const kind = context.customerKind ?? "existing";
  if (code === "KARTHIK") {
    const policy = config.referral;
    if (!policy.active) return { valid: false, discount: 0, code: "", message: "Referral rewards are currently paused" };
    if ((context.orderCount ?? 0) > 0 || kind !== "new" || context.wasReferredBefore) return { valid: false, discount: 0, code: "", message: "Referral codes are valid on a friend’s first booking only" };
    if ((context.referralRewardsThisMonth ?? 0) >= policy.rewardsPerMonth) return { valid: false, discount: 0, code: "", message: "This referrer has reached the monthly reward limit" };
    if (!policy.eligibleServices.includes(context.service)) return { valid: false, discount: 0, code: "", message: `Referrals are not available for ${context.service}` };
    if (context.city && !policy.eligibleCities.includes(context.city)) return { valid: false, discount: 0, code: "", message: `Referrals are not available in ${context.city}` };
    if (context.orderValue < policy.minFirstOrder) return { valid: false, discount: 0, code: "", message: `Add ₹${policy.minFirstOrder - context.orderValue} more to use this referral` };
    return { valid: true, discount: Math.min(policy.friendDiscount, context.orderValue), code, message: `Referral applied · you save ₹${policy.friendDiscount}; referrer earns ₹${policy.referrerReward} after completion`, referral: true };
  }
  const rule = config.coupons.find((item) => item.code === code);
  if (!rule || !rule.active) return { valid: false, discount: 0, code: "", message: "Enter a valid active PawSpace coupon or referral code" };
  if (new Date(`${rule.validUntil}T23:59:59`).getTime() < Date.now()) return { valid: false, discount: 0, code: "", message: "This coupon has expired" };
  if (!rule.services.includes(context.service)) return { valid: false, discount: 0, code: "", message: `This coupon is not valid for ${context.service}` };
  if (context.city && !rule.cities.includes(context.city)) return { valid: false, discount: 0, code: "", message: `This coupon is not available in ${context.city}` };
  if (context.channel && !rule.channels.includes(context.channel)) return { valid: false, discount: 0, code: "", message: "This coupon is not valid on this booking channel" };
  if (!rule.customerKinds.includes(kind)) return { valid: false, discount: 0, code: "", message: `This offer is not available for ${kind} customers` };
  if (rule.firstOrderOnly && (context.orderCount ?? 0) > 0) return { valid: false, discount: 0, code: "", message: "This coupon is valid on the first order only" };
  if (rule.orderNumberFrom && (context.orderCount ?? 0) + 1 < rule.orderNumberFrom) return { valid: false, discount: 0, code: "", message: `Valid from order ${rule.orderNumberFrom}` };
  if (rule.orderNumberTo && (context.orderCount ?? 0) + 1 > rule.orderNumberTo) return { valid: false, discount: 0, code: "", message: `Valid only through order ${rule.orderNumberTo}` };
  if (rule.packageScope === "subscription" && !context.isSubscription) return { valid: false, discount: 0, code: "", message: "This coupon is only for subscriptions" };
  if (rule.packageScope === "single_session" && context.isSubscription) return { valid: false, discount: 0, code: "", message: "This coupon is only for single-session bookings" };
  if (rule.packageScope === "selected" && context.packageName && !rule.packageNames.includes(context.packageName)) return { valid: false, discount: 0, code: "", message: "This coupon is not valid for the selected package" };
  if (rule.crossSellFromServices.length && !rule.crossSellFromServices.some((service) => context.previousServices?.includes(service))) return { valid: false, discount: 0, code: "", message: "This cross-sell coupon requires an eligible previous service" };
  if (context.isSubscription && !rule.subscriptionEligible) return { valid: false, discount: 0, code: "", message: "This coupon cannot be used on a subscription" };
  if (rule.fullPaymentOnly && context.paymentMode !== "full") return { valid: false, discount: 0, code: "", message: "Choose 100% upfront payment to use this coupon" };
  if (context.orderValue < rule.minOrder) return { valid: false, discount: 0, code: "", message: `Minimum order value is ₹${rule.minOrder}` };
  if (rule.maxOrder && context.orderValue > rule.maxOrder) return { valid: false, discount: 0, code: "", message: `Valid only up to ₹${rule.maxOrder} order value` };
  if (rule.used >= rule.totalLimit) return { valid: false, discount: 0, code: "", message: "This coupon has reached its overall usage limit" };
  if ((context.customerCouponUsage ?? 0) >= rule.perCustomerLimit) return { valid: false, discount: 0, code: "", message: "You have reached the usage limit for this coupon" };
  const raw = rule.discountType === "fixed" ? rule.discountValue : Math.round(context.orderValue * rule.discountValue / 100);
  const discount = Math.min(raw, rule.maxDiscount ?? raw, context.orderValue);
  return { valid: true, discount, code, message: `₹${discount} coupon applied`, referral: false };
}
