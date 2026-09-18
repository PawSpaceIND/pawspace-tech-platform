import { validGpsCoordinates } from "../gps-telemetry-policy";
import { readCustomerCheckoutConfirmation } from "../customer-checkout-server";
import { paymentStageAmount } from "../payment-stage-amount";
import { isV2GroomingConfirmationReady } from "./grooming-confirmation-contract";
import type { CustomerConfirmationProjection } from "../customer-checkout-client";

/** Read-only composition of canonical booking, payment-stage and governed doorstep authorities. */
export async function readV2GroomingCheckoutReadiness(db: D1Database, customerId: string, bookingId: string) {
  const booking = await db.prepare(`SELECT b.id,b.customer_id,b.provider_id,b.status,p.id payment_id,
    p.status payment_status,p.amount_due_now,w.status work_order_status
    FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id AND p.customer_id=b.customer_id
    JOIN provider_work_orders w ON w.booking_id=b.id AND w.provider_id=b.provider_id
    WHERE b.id=? AND b.customer_id=? AND b.service_code='grooming' AND p.mode='prepaid'`)
    .bind(bookingId, customerId).first<Record<string, unknown>>();
  if (!booking) throw new Response("Grooming checkout was not found for your account.", { status: 404 });
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_service_locations'").first();
  const location = table ? await db.prepare(`SELECT latitude,longitude FROM booking_service_locations
    WHERE booking_id=? AND customer_id=? AND provider_id=? AND status='active' AND source='server_geocode'`)
    .bind(bookingId, customerId, booking.provider_id).first<Record<string, unknown>>() : null;
  const locationReady = Boolean(location && location.latitude != null && location.longitude != null &&
    validGpsCoordinates(Number(location.latitude), Number(location.longitude)));
  const canonical = await readCustomerCheckoutConfirmation(db, customerId, bookingId);
  const stage = await paymentStageAmount(db, bookingId);
  const events = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('payment_gateway_events','payment_intents')").all();
  // Both supported capture authorities count, but only for the matching stored customer/order/amount.
  const evidence = events.results.length === 2 ? await db.prepare(`SELECT e.gateway_order_id,e.gateway_payment_id
    FROM payment_gateway_events e JOIN payment_intents i ON i.booking_id=e.booking_id AND i.payment_id=e.payment_id
      AND i.gateway_order_id=e.gateway_order_id AND i.customer_id=? AND i.provider=e.provider AND i.environment=e.environment
      AND i.amount_paise=e.amount_subunits AND i.currency=e.currency
    WHERE e.booking_id=? AND e.payment_id=? AND e.provider='razorpay' AND e.environment='sandbox'
      AND e.processing_status='processed' AND e.event_type IN ('payment.captured','order.paid','payment_link.paid')
      AND (e.signature_verified=1 OR (e.signature_verified=0 AND
        json_extract(CASE WHEN json_valid(e.detail_json) THEN e.detail_json ELSE '{}' END,'$.captureAuthority')='provider_api'))
    ORDER BY e.received_at DESC LIMIT 1`).bind(customerId, bookingId, booking.payment_id).first<Record<string, unknown>>() : null;
  const confirmation: CustomerConfirmationProjection = {
    ready: Boolean(stage && stage.dueNow <= 0 && evidence && locationReady), bookingId,
    serviceCode: "grooming", packageName: canonical.packageName || "", bookingStatus: String(booking.status),
    paymentId: String(booking.payment_id), paymentMode: "prepaid", paymentStatus: String(booking.payment_status),
    transactionId: evidence?.gateway_payment_id ? String(evidence.gateway_payment_id) : null,
    amountDueNow: stage?.dueNow ?? Number(booking.amount_due_now), totalAmount: canonical.totalAmount, currency: canonical.currency,
    providerId: canonical.providerId || "", providerName: canonical.providerName || "", providerModel: canonical.providerModel || "",
    workOrderStatus: String(booking.work_order_status), scheduledStart: canonical.scheduledStart, scheduledEnd: canonical.scheduledEnd,
    updatedAt: Date.now(), gatewayOrderId: evidence?.gateway_order_id ? String(evidence.gateway_order_id) : canonical.gatewayOrderId,
    gatewayPaymentId: evidence?.gateway_payment_id ? String(evidence.gateway_payment_id) : null, pets: canonical.pets,
  };
  confirmation.ready = isV2GroomingConfirmationReady(confirmation, bookingId);
  return { bookingId, customerId, bookingStatus: String(booking.status),
    paymentStatus: String(booking.payment_status), locationReady, confirmation };
}
