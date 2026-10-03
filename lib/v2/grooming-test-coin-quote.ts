import { couponNeedsReapply } from "../coupon-reapply-guard";
import { groomingPaise } from "./grooming-money";

/** Read-only projection of the existing checked basket/coupon; checkout revalidates it server-side. */
export function groomingTestCoinQuote(input: {
  basketTotal: number | null; quoteReady: boolean; couponChecking: boolean;
  coupon: { discount: number; code: string; quoteId: string };
  paymentMode: "prepaid" | "pay_after_service";
}) {
  const unknown = { eligibleAmount: null, actualPayable: null };
  if (!input.quoteReady || input.couponChecking || input.basketTotal === null || couponNeedsReapply(input.coupon.code, input.coupon.quoteId)) return unknown;
  const basket = groomingPaise(input.basketTotal), discount = groomingPaise(input.coupon.discount);
  if (basket === null || discount === null || discount > basket || (discount > 0 && (!input.coupon.code || !input.coupon.quoteId))) return unknown;
  const eligibleAmount = (basket - discount) / 100;
  return { eligibleAmount, actualPayable: input.paymentMode === "prepaid" ? eligibleAmount : 0 };
}
