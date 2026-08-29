import { createPaymentOrder, publicKeyId } from "./razorpay-client";
import { paymentStageAmount } from "./payment-stage-amount";
import { processGatewayEvent } from "./grooming-payment-reconciliation";
import { governedJsonError } from "./governed-http-error";
import { linkGatewayOrder } from "./payments/gateway-order-link";
import { resolveRazorpayRuntime } from "./payments/razorpay-runtime";
import { verifyRazorpayCheckout } from "./payments/razorpay-checkout-verification";

type Db = D1Database;
type Row = Record<string, unknown>;

export async function createBookingPaymentOrder(db: Db, env: Record<string, unknown>, input: { bookingId: string; customerId: string; actorId: string }) {
  const bookingId = String(input.bookingId || "").trim(), customerId = String(input.customerId || "").trim();
  if (!bookingId || !customerId) throw new Error("A booking and customer are required");
  const row = await db.prepare("SELECT b.customer_id customer_id,p.id payment_id,p.status status FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").bind(bookingId).first<Row>();
  if (!row) throw new Error("Booking or its payment record was not found");
  if (String(row.customer_id) !== customerId) throw governedJsonError({ error: "You can only pay for your own booking" }, 403);
  const runtime = resolveRazorpayRuntime(env);
  const stage = await paymentStageAmount(db, bookingId);
  if (!stage) throw new Error("Booking or its payment record was not found");
  if (stage.stage === "settled") throw new Error("This booking is already paid");
  if (stage.dueNow <= 0) return { connected: false, paymentRequired: false, environment: runtime.environment, reason: "No online payment is due now", bookingId, paymentId: stage.paymentId, status: "not_due", stage: stage.stage, bookingTotal: stage.bookingTotal, outstandingBalance: stage.outstandingBalance };
  const created = await createPaymentOrder(env, { bookingId, paymentId: stage.paymentId, amount: stage.dueNow, currency: stage.currency });
  if (!created.connected) return { connected: false, paymentRequired: true, environment: runtime.environment, reason: created.reason };
  if (created.environment !== runtime.environment) throw new Error("Razorpay order environment does not match the governed payment runtime");
  const orderId = String(created.order.id);
  await linkGatewayOrder(db, { bookingId, gatewayOrderId: orderId, environment: runtime.environment, expectedAmount: stage.dueNow });
  return { connected: true, paymentRequired: true, environment: runtime.environment, bookingId, paymentId: stage.paymentId, orderId, amount: stage.dueNow, currency: stage.currency, keyId: publicKeyId(env), status: "awaiting_payment", stage: stage.stage, bookingTotal: stage.bookingTotal, outstandingBalance: stage.outstandingBalance };
}

export async function completeBookingPaymentOrder(db: Db, env: Record<string, unknown>, input: { bookingId: string; customerId: string; actorId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) {
  const row = await db.prepare("SELECT b.customer_id customer_id,b.status booking_status,p.id payment_id,p.status payment_status,p.currency,l.gateway_order_id,l.environment,r.expected_amount FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id JOIN payment_gateway_links l ON l.booking_id=b.id JOIN payment_reconciliation_records r ON r.payment_id=p.id WHERE b.id=?").bind(input.bookingId).first<Row>();
  if (!row) throw new Error("Canonical booking payment order was not found");
  if (String(row.customer_id) !== input.customerId) throw governedJsonError({ error: "You can only pay for your own booking" }, 403);
  if (String(row.gateway_order_id) !== input.razorpayOrderId) throw governedJsonError({ error: "Razorpay order does not belong to this booking" }, 409);
  const amount = Number(row.expected_amount || 0), currency = String(row.currency || "INR");
  const verified = await verifyRazorpayCheckout(env, { orderId: input.razorpayOrderId, paymentId: input.razorpayPaymentId, signature: input.razorpaySignature, amountSubunits: Math.round(amount * 100), currency });
  if (verified.environment !== String(row.environment)) throw governedJsonError({ error: "Razorpay environment does not match the canonical order" }, 409);
  const material = `${input.bookingId}|${input.razorpayOrderId}|${input.razorpayPaymentId}|${amount}|${currency}`;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  const reconciled = await processGatewayEvent(db, { provider: "razorpay", environment: verified.environment, eventId: `checkout:${input.razorpayPaymentId}:captured`, eventType: "payment.captured", bookingId: input.bookingId, gatewayOrderId: input.razorpayOrderId, gatewayPaymentId: input.razorpayPaymentId, amountSubunits: Math.round(amount * 100), currency, signatureVerified: true, payloadHash: hash, detail: { source: "standard_checkout_return", actorId: input.actorId } });
  if (String((reconciled as Record<string, unknown>).status || "") !== "processed") throw governedJsonError({ error: "Verified Razorpay payment could not be reconciled", reconciliation: reconciled }, 409);
  const state = await db.prepare("SELECT b.status booking_status,p.status payment_status,p.gateway FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").bind(input.bookingId).first<Row>();
  if (!state || String(state.payment_status) !== "captured") throw governedJsonError({ error: "Payment capture is not recorded on the canonical booking" }, 409);
  return { bookingId: input.bookingId, bookingStatus: String(state.booking_status), paymentStatus: String(state.payment_status), gateway: String(state.gateway), environment: verified.environment, razorpayPaymentId: input.razorpayPaymentId };
}
