import type { CustomerConfirmationProjection } from "./customer-checkout-client";

/** Display evidence only: no amount/booking status grants payment authority. */
export function customerPaymentVerified(projection: CustomerConfirmationProjection | null): boolean {
  if (!projection || projection.paymentStatus !== "captured") return false;
  // Pay-after cash/UPI collection uses the canonical Finance-approved captured record;
  // prepaid gateway capture also requires its trusted server transaction reference.
  return projection.paymentMode === "pay_after_service" || Boolean(projection.transactionId);
}
