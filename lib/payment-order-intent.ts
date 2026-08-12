/**
 * Verify-first customer payment entry. Instead of a booking self-declaring "captured", the customer
 * app calls this to open a REAL Razorpay order for a still-unpaid booking; the customer then pays via
 * Razorpay/GPay, and only the signature-verified webhook (grooming-payment-reconciliation) marks the
 * payment captured after matching the order id and verifying amount/currency.
 *
 * Fails closed: if Razorpay credentials for the active environment are not configured, it returns
 * {connected:false} so the app can fall back (e.g. pay-after-service) - it never fakes a paid state.
 */

import { createPaymentOrder, publicKeyId, paymentEnvironment } from "./razorpay-client";
import { linkGatewayOrder } from "./grooming-payment-reconciliation";

type Db = D1Database;
type Row = Record<string, unknown>;
const SETTLED = ["captured", "refunded", "partially_refunded"];

export async function createBookingPaymentOrder(db: Db, env: Record<string, unknown>, input: { bookingId: string; customerId: string; actorId: string }) {
  const bookingId = String(input.bookingId || "").trim(), customerId = String(input.customerId || "").trim();
  if (!bookingId || !customerId) throw new Error("A booking and customer are required");
  const row = await db.prepare("SELECT b.customer_id customer_id,p.id payment_id,p.amount amount,p.currency currency,p.status status FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?").bind(bookingId).first<Row>();
  if (!row) throw new Error("Booking or its payment record was not found");
  if (String(row.customer_id) !== customerId) throw new Error("You can only pay for your own booking");
  if (SETTLED.includes(String(row.status))) throw new Error("This booking is already paid");
  const amount = Number(row.amount || 0), currency = String(row.currency || "INR"), paymentId = String(row.payment_id);
  const created = await createPaymentOrder(env, { bookingId, paymentId, amount, currency });
  if (!created.connected) return { connected: false, environment: created.environment, reason: created.reason };
  const orderId = String(created.order.id);
  await linkGatewayOrder(db, { bookingId, gatewayOrderId: orderId, environment: created.environment, actorId: input.actorId });
  // never self-capture here: the payment stays awaiting_payment until the verified webhook arrives
  return { connected: true, environment: created.environment, bookingId, paymentId, orderId, amount, currency, keyId: publicKeyId(env), status: "awaiting_payment" };
}

export { paymentEnvironment };
