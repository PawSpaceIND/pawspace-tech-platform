import { reconcileRazorpayCaptureIntent } from "./razorpay-capture-reconciliation";
/** Customer-owned sandbox boundary. No capture, refund, ledger or assignment writes live here. */
type Row = Record<string, unknown>;
export class CustomerCheckoutError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export function customerCheckoutEnvironment(env: Record<string, unknown>) {
  if (String(env.PAWSPACE_PAYMENT_ENV ?? "").toLowerCase() !== "sandbox" ||
      String(env.FORBID_PRODUCTION ?? "").toLowerCase() !== "true" ||
      String(env.PAWSPACE_PAYMENT_LIVE_APPROVED ?? "").toLowerCase() !== "false") {
    throw new CustomerCheckoutError("Customer checkout is not enabled for this environment.", 503);
  }
  const key = String(env.RAZORPAY_KEY_ID_SANDBOX || "").trim();
  if (!/^rzp_test_[a-zA-Z0-9]+$/.test(key) || /placeholder/i.test(key) || !String(env.RAZORPAY_KEY_SECRET_SANDBOX || "").trim()) {
    throw new CustomerCheckoutError("Razorpay test checkout is not configured. Contact billing support.", 503);
  }
  return { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" } as const;
}
export async function assertCustomerCheckoutBooking(db: D1Database, customerId: string, bookingId: string, starting = true) {
  if (!customerId || !bookingId || bookingId.length > 160) throw new CustomerCheckoutError("A customer booking is required.", 400);
  const row = await db.prepare(`SELECT b.status booking_status,p.status payment_status FROM canonical_bookings b
    JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=? AND b.customer_id=? AND p.customer_id=?`)
    .bind(bookingId, customerId, customerId).first<Row>();
  if (!row) throw new CustomerCheckoutError("Booking payment was not found for your account.", 404);
  if (starting && (!new Set(["confirmed", "assigned", "in_progress", "completed"]).has(String(row.booking_status)) ||
      new Set(["cancelled", "refunded", "partially_refunded"]).has(String(row.payment_status)))) {
    throw new CustomerCheckoutError("This booking cannot accept a new payment. Contact billing support.", 409);
  }
}
export type CustomerCheckoutReceipt = { bookingId: string; orderId: string; paymentId: string; signature: string };
export async function verifyCustomerCheckoutReceipt(db: D1Database, env: Record<string, unknown>, customerId: string, receipt: CustomerCheckoutReceipt) {
  customerCheckoutEnvironment(env);
  await assertCustomerCheckoutBooking(db, customerId, receipt.bookingId, false);
  if (!/^order_[a-zA-Z0-9_]{1,100}$/.test(receipt.orderId) || !/^pay_[a-zA-Z0-9_]{1,100}$/.test(receipt.paymentId) ||
      !/^[a-fA-F0-9]{64}$/.test(receipt.signature)) throw new CustomerCheckoutError("Invalid payment receipt.", 400);
  // Scope the stored order by BOTH owners and the canonical payment. Never use a client amount.
  const intent = await db.prepare(`SELECT i.id,i.booking_id,i.gateway_order_id,i.payment_id,i.amount_paise,i.currency,i.environment FROM payment_intents i
    JOIN canonical_bookings b ON b.id=i.booking_id JOIN booking_payments p ON p.id=i.payment_id AND p.booking_id=b.id
    WHERE i.booking_id=? AND i.customer_id=? AND b.customer_id=? AND p.customer_id=?
    AND i.gateway_order_id=? AND i.provider='razorpay' AND i.environment='sandbox'`)
    .bind(receipt.bookingId, customerId, customerId, customerId, receipt.orderId).first<Row>();
  if (!intent) throw new CustomerCheckoutError("Payment order was not found for your account.", 404);
  const secret = String(env.RAZORPAY_KEY_SECRET_SANDBOX).trim();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(receipt.signature.match(/../g)!, pair => parseInt(pair, 16));
  const verified = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(`${String(intent.gateway_order_id)}|${receipt.paymentId}`));
  if (!verified) throw new CustomerCheckoutError("Payment receipt verification failed. Contact billing support.", 400);
  // A valid checkout signature can precede capture. Browser proof never moves money by itself: only
  // persisted provider evidence counts - either a signed webhook or an authenticated provider API read.
  // Match the exact instalment/order/payment so an earlier split capture cannot confirm a new one.
  const capturedEvidence=()=>db.prepare(`SELECT id FROM payment_gateway_events WHERE booking_id=? AND payment_id=?
    AND gateway_order_id=? AND gateway_payment_id=? AND provider='razorpay' AND environment='sandbox'
    AND (signature_verified=1 OR (signature_verified=0 AND json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.captureAuthority')='provider_api'))
    AND processing_status='processed' AND event_type IN ('payment.captured','order.paid')
    AND amount_subunits=? AND currency=? LIMIT 1`)
    .bind(receipt.bookingId, String(intent.payment_id), String(intent.gateway_order_id), receipt.paymentId,
      Number(intent.amount_paise), String(intent.currency)).first<Row>();
  let captured=await capturedEvidence();
  if(!captured){
    // This is a server-to-server read using PawSpace's Razorpay credentials. Failure leaves the receipt
    // pending; the five-minute scheduled reconciliation is the browser-independent recovery path.
    await reconcileRazorpayCaptureIntent(db,env,intent,{asOf:Date.now()}).catch(()=>null);
    captured=await capturedEvidence();
  }
  return { bookingId: receipt.bookingId, orderId: receipt.orderId, receiptVerified: true,
    status: captured ? "captured" as const : "awaiting_confirmation" as const, environment: "sandbox" as const };
}
