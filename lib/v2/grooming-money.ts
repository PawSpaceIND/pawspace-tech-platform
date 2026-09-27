/** Parse non-negative INR amounts without rounding invalid sub-paise input. */
export function groomingPaise(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

/** Sum the same package and add-on basket at display and checkout boundaries. */
export function groomingBasketTotal(...amounts: number[]): number | null {
  let total = 0;
  for (const amount of amounts) {
    const paise = groomingPaise(amount);
    if (paise === null || !Number.isSafeInteger(total + paise)) return null;
    total += paise;
  }
  return total / 100;
}

/** The server discount and final amount must agree with this exact basket. */
export function groomingCouponPayable(orderValue: number, quote: { discount: unknown; finalAmount?: unknown }): number {
  const order = groomingPaise(orderValue), discount = groomingPaise(quote.discount), final = groomingPaise(quote.finalAmount);
  if (order === null || discount === null || final === null || discount > order || final !== order - discount) {
    throw new Error("Reapply the coupon before booking.");
  }
  return final / 100;
}
