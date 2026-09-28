import type { CustomerConfirmationProjection } from "../customer-checkout-client";

export function isV2GroomingConfirmationReady(value: CustomerConfirmationProjection | null, bookingId: string): boolean {
  if (!value) return false;
  const start = Date.parse(value.scheduledStart), end = Date.parse(value.scheduledEnd);
  const common = value.ready === true && value.bookingId === bookingId && value.serviceCode === "grooming" &&
    ["confirmed", "assigned", "on_the_way", "arrived", "in_service", "completed"].includes(value.bookingStatus) &&
    ["assigned", "awaiting_acceptance", "accepted", "on_the_way", "arrived", "in_service", "in_progress", "completed"].includes(value.workOrderStatus) &&
    Boolean(value.paymentId && value.providerId && value.providerName && value.packageName) &&
    (value.providerModel === "full_time" || value.providerModel === "commission") &&
    Number.isFinite(start) && Number.isFinite(end) && end > start &&
    Number.isFinite(value.totalAmount) && value.totalAmount > 0 && value.currency === "INR";
  if (!common) return false;
  if (value.paymentMode === "prepaid") return value.paymentStatus === "captured" && Boolean(value.transactionId);
  if (value.paymentMode === "pay_after_service") return value.amountDueNow <= 0 &&
    ["created", "authorised", "captured"].includes(value.paymentStatus);
  return false;
}
