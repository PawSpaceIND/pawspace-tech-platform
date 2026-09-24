import { authError, database, requireCustomerOwnership, resolveActor } from "../../../lib/server-auth";
import { resolvePlatformSession } from "../../../lib/platform-session";
import { paymentStageAmount } from "../../../lib/payment-stage-amount";
import { createBookingPaymentOrder } from "../../../lib/payment-order-intent";
import { resolvePaymentWebhookGate } from "../../../lib/payment-webhook-gate";
import { assertCustomerCheckoutBooking, customerCheckoutEnvironment, CustomerCheckoutError, readCustomerCheckoutConfirmation, verifyCustomerCheckoutReceipt } from "../../../lib/customer-checkout-server";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export async function POST(request: Request) {
  try {
    // Browser/native-WebView flow uses a same-origin session, never arbitrary customerId or role headers.
    if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "Cross-origin payment request blocked." }, 403);
    const db = await database(), actor = await resolveActor(request), session = await resolvePlatformSession(db, request);
    if (session?.subjectType !== "customer" || !session.subjectId) return json({ error: "Sign in to your customer account to pay." }, 401);
    await requireCustomerOwnership(db, actor, session.subjectId);
    const { env } = await import("cloudflare:workers");
    const runtime = env as unknown as Record<string, unknown>;
    // Stream-limit the JSON body, including requests without Content-Length.
    if ((request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "application/json") return json({ error: "JSON is required." }, 415);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Payment request is required." }, 400);
    let bytes = 0, raw = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) { await reader.cancel(); return json({ error: "Payment request is too large." }, 413); }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    let body: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); body = parsed as Record<string, unknown>; }
    catch { return json({ error: "Invalid payment request." }, 400); }
    const bookingId = typeof body.bookingId === "string" ? body.bookingId : "";
    if (body.action === "start") {
      // The Razorpay sandbox-configuration gate belongs here, not above: it protects only the action
      // that opens a gateway order. "status" is a read of PawSpace's own booking/payment record and
      // "confirm" re-checks this same gate itself (verifyCustomerCheckoutReceipt), so gating every
      // action behind it hid the whole booking record behind a gateway outage (CUST-L-D04/D11): the
      // V2 "View booking & payment" page and the training recovery screen both read this via
      // loadCustomerConfirmationProjection({action:"status"}) and got a 503 instead of the booking.
      const locks = customerCheckoutEnvironment(runtime);
      await assertCustomerCheckoutBooking(db, session.subjectId, bookingId);
      const stage = await paymentStageAmount(db, bookingId);
      if (!stage) return json({ error: "Payment record was not found." }, 404);
      if (stage.stage === "settled" || stage.dueNow <= 0) return json({ data: { connected: false, status: "nothing_due", bookingId, environment: "sandbox", locks } });
      if (stage.currency !== "INR") return json({ error: "This checkout currently supports INR payments only." }, 409);
      // Do not open a payment the receiver cannot verify. This is configuration readiness only,
      // not proof of gateway delivery. Existing receipts and settled balances remain readable.
      const receiver = resolvePaymentWebhookGate(runtime);
      if (!receiver.ok || receiver.environment !== "sandbox") return json({
        error: "Payment confirmation is not configured. Contact billing support before paying.",
        code: "checkout_webhook_unconfigured",
      }, 503);
      const data = await createBookingPaymentOrder(db, runtime, { bookingId, customerId: session.subjectId, actorId: session.subjectId });
      if (!data.connected) return json({ error: "Secure checkout is unavailable or needs reconciliation. Contact billing support before retrying." }, 503);
      await assertCustomerCheckoutBooking(db, session.subjectId, bookingId);
      return json({ data: { ...data, razorpay_order_id: data.orderId, RAZORPAY_KEY_ID: data.keyId, locks } }, 201);
    }
    if (body.action === "status") {
      await assertCustomerCheckoutBooking(db, session.subjectId, bookingId, false);
      const [stage, gatewayEventsTable] = await Promise.all([
        paymentStageAmount(db, bookingId),
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_gateway_events'").first<Record<string,unknown>>(),
      ]);
      const transactionExpression = gatewayEventsTable
        ? `(SELECT MAX(e.gateway_payment_id) FROM payment_gateway_events e
            WHERE e.booking_id=b.id AND e.payment_id=p.id AND (e.signature_verified=1 OR (e.signature_verified=0 AND json_extract(CASE WHEN json_valid(e.detail_json) THEN e.detail_json ELSE '{}' END,'$.captureAuthority')='provider_api')) AND e.processing_status='processed'
              AND e.event_type IN ('payment.captured','order.paid','payment_link.paid'))`
        : "NULL";
      const projection = await db.prepare(`SELECT b.id booking_id,b.service_code,b.package_code,b.package_name,b.status booking_status,b.scheduled_start,b.scheduled_end,b.provider_id,b.total_amount,b.currency,b.updated_at,
          w.provider_name,w.provider_model,w.status work_order_status,p.id payment_id,p.mode payment_mode,p.status payment_status,p.amount_due_now,
          ${transactionExpression} transaction_id
          FROM canonical_bookings b
          JOIN provider_work_orders w ON w.booking_id=b.id
          JOIN booking_payments p ON p.booking_id=b.id
          WHERE b.id=? AND b.customer_id=?`).bind(bookingId, session.subjectId).first<Record<string, unknown>>();
      if (!stage || !projection) return json({ error: "Payment record was not found." }, 404);
      let status = stage.stage === "settled" || stage.dueNow <= 0 ? "captured" : "awaiting_confirmation";
      const bookingStatus = String(projection.booking_status), paymentStatus = String(projection.payment_status), paymentMode = String(projection.payment_mode);
      let transactionId = String(projection.transaction_id || "");
      const bookingReady = ["confirmed", "assigned", "on_the_way", "arrived", "in_service", "in_progress", "completed"].includes(bookingStatus);
      // Capture of this instalment is distinct from settlement of the whole booking.
      // A deposit may confirm the booking while its later balance remains payable.
      const requestedOrder = typeof body.orderId === "string" ? body.orderId : "";
      if (requestedOrder && !/^order_[a-zA-Z0-9_]{1,100}$/.test(requestedOrder)) return json({ error: "Invalid payment order." }, 400);
      if (requestedOrder) {
        const capturedOrder = gatewayEventsTable ? await db.prepare(`SELECT id,gateway_order_id,gateway_payment_id FROM payment_gateway_events
          WHERE booking_id=? AND payment_id=? AND gateway_order_id=? AND provider='razorpay' AND environment='sandbox'
          AND processing_status='processed' AND event_type IN ('payment.captured','order.paid','payment_link.paid')
          AND (signature_verified=1 OR (signature_verified=0 AND json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.captureAuthority')='provider_api'))
          LIMIT 1`).bind(bookingId,projection.payment_id,requestedOrder).first<Record<string,unknown>>() : null;
        transactionId = capturedOrder ? String(capturedOrder.gateway_payment_id || "") : "";
        status = capturedOrder && transactionId ? "captured" : "awaiting_confirmation";
      }
      const paymentReady = paymentMode === "pay_after_service" ? Number(projection.amount_due_now || 0) <= 0 : paymentStatus === "captured" && Boolean(transactionId);
      if (!requestedOrder && paymentReady && bookingReady) status = "captured";
      const canonical = await readCustomerCheckoutConfirmation(db, session.subjectId, bookingId);
      return json({ data: { bookingId, orderId: typeof body.orderId === "string" ? body.orderId : undefined, environment: "sandbox", status, confirmation: {
        ready: bookingReady && paymentReady, bookingId: String(projection.booking_id), serviceCode: String(projection.service_code), packageCode: String(projection.package_code||""), packageName: String(projection.package_name),
        bookingStatus, paymentId: canonical.paymentId || String(projection.payment_id), paymentMode, paymentStatus, transactionId: requestedOrder ? transactionId || null : transactionId || canonical.gatewayPaymentId, amountDueNow: stage.dueNow,
        totalAmount: canonical.totalAmount, currency: canonical.currency, providerId: canonical.providerId || String(projection.provider_id),
        providerName: canonical.providerName || String(projection.provider_name), providerModel: canonical.providerModel || String(projection.provider_model), workOrderStatus: String(projection.work_order_status),
        scheduledStart: canonical.scheduledStart, scheduledEnd: canonical.scheduledEnd, updatedAt: Number(projection.updated_at || 0),
        gatewayOrderId: requestedOrder ? (transactionId ? requestedOrder : null) : canonical.gatewayOrderId, gatewayPaymentId: requestedOrder ? transactionId || null : canonical.gatewayPaymentId || transactionId || null, pets: canonical.pets,
      } } });
    }
    if (body.action === "confirm") {
      if (![body.orderId, body.paymentId, body.signature].every(value => typeof value === "string")) return json({ error: "Invalid payment receipt." }, 400);
      return json({ data: await verifyCustomerCheckoutReceipt(db, runtime, session.subjectId, {
        bookingId, orderId: body.orderId as string, paymentId: body.paymentId as string, signature: body.signature as string,
      }) });
    }
    return json({ error: "Unknown checkout action." }, 400);
  } catch (error) {
    if (error instanceof CustomerCheckoutError) return json({ error: error.message }, error.status);
    return authError(error, "Unable to process checkout. Check payment status before retrying.");
  }
}
