import { ensurePaymentReconciliationTables } from "../grooming-payment-reconciliation";

type Db = D1Database;
type Row = Record<string, unknown>;

/** Links the real gateway order to the one canonical booking/payment before Checkout opens. */
export async function linkGatewayOrder(db: Db, input: { bookingId: string; gatewayOrderId: string; environment: "sandbox" | "live"; expectedAmount: number }) {
  await ensurePaymentReconciliationTables(db);
  const payment = await db.prepare("SELECT id,currency FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if (!payment) throw new Error("Canonical payment record not found");
  if (!input.gatewayOrderId.startsWith("order_")) throw new Error("Razorpay order id is invalid");
  if (!(input.expectedAmount > 0)) throw new Error("A positive expected gateway amount is required");
  const now = Date.now(), paymentId = String(payment.id), currency = String(payment.currency || "INR");
  await db.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,gateway_order_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT(booking_id) DO UPDATE SET gateway_order_id=excluded.gateway_order_id,provider=excluded.provider,environment=excluded.environment,status='active',updated_at=excluded.updated_at")
    .bind(`PAYLINK-${crypto.randomUUID().slice(0,10).toUpperCase()}`, input.bookingId, paymentId, "razorpay", input.environment, input.gatewayOrderId, now, now).run();
  await db.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,?,?,?,0,0,?,'order_linked','pending',0,NULL,?) ON CONFLICT(payment_id) DO UPDATE SET gateway=excluded.gateway,environment=excluded.environment,expected_amount=excluded.expected_amount,currency=excluded.currency,gateway_status=CASE WHEN payment_reconciliation_records.gateway_status IN ('captured','refunded','partially_refunded') THEN payment_reconciliation_records.gateway_status ELSE 'order_linked' END,updated_at=excluded.updated_at")
    .bind(paymentId, input.bookingId, "razorpay", input.environment, input.expectedAmount, currency, now).run();
  return { bookingId: input.bookingId, paymentId, gatewayOrderId: input.gatewayOrderId };
}
