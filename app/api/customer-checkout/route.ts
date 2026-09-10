import { authError, database, requireCustomerOwnership, resolveActor } from "../../../lib/server-auth";
import { resolvePlatformSession } from "../../../lib/platform-session";
import { paymentStageAmount } from "../../../lib/payment-stage-amount";
import { createBookingPaymentOrder } from "../../../lib/payment-order-intent";
import { resolvePaymentWebhookGate } from "../../../lib/payment-webhook-gate";
import { assertCustomerCheckoutBooking, customerCheckoutEnvironment, CustomerCheckoutError, verifyCustomerCheckoutReceipt } from "../../../lib/customer-checkout-server";
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
    const locks = customerCheckoutEnvironment(runtime);
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
      return json({ data: { ...data, locks } }, 201);
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
