/**
 * Razorpay Checkout `callback_url` receiver.
 *
 * When Checkout.js cannot run its in-page modal (in-app browsers, WebViews, some bank/UPI flows) it
 * switches to redirect mode and POSTs the receipt fields as a form to `callback_url`. Without this
 * route the customer finishes the payment on a Razorpay-hosted JSON page and never returns.
 *
 * This route is a pure, stateless redirect adapter:
 *   - it accepts the cross-site form POST (no session cookie is sent with a cross-site POST, and the
 *     Origin header is api.razorpay.com, so it deliberately has no same-origin or session gate);
 *   - it validates only the SHAPE of the receipt and forwards it, via 303, to the same-origin
 *     booking confirmation page as query parameters;
 *   - it never writes to the database and never treats the receipt as proof of capture. The page
 *     verifies the receipt through POST /api/customer-checkout {action:"confirm"} with the
 *     customer's own session, the stored order and the Razorpay key secret, and capture remains
 *     provider/webhook authoritative.
 */
import { authError } from "../../../lib/server-auth";

const MAX_CALLBACK_BYTES = 16_384;
const BOOKING_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ORDER_ID = /^order_[a-zA-Z0-9_]{1,100}$/;
const PAYMENT_ID = /^pay_[a-zA-Z0-9_]{1,100}$/;
const SIGNATURE = /^[a-fA-F0-9]{64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
export const BOOKING_CONFIRMATION_PATH = "/mobile-app/booking-confirmation";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function readFields(request: Request): Promise<Record<string, string>> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_CALLBACK_BYTES) return {};
  const reader = request.body?.getReader();
  if (!reader) return {};
  let bytes = 0, raw = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CALLBACK_BYTES) {
        // The edge gateway may retain an inspection clone. A tee's cancel promise waits for
        // BOTH branches, so awaiting it can hang an oversized callback indefinitely.
        // Request cancellation but return the same empty, untrusted receipt immediately.
        void reader.cancel().catch(() => {});
        return {};
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } finally { reader.releaseLock(); }
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const fields: Record<string, string> = {};
  if (type === "application/json") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) fields[key] = typeof value === "string" ? value : JSON.stringify(value ?? "");
      }
    } catch { /* Treated as an empty callback. */ }
    return fields;
  }
  // Razorpay posts application/x-www-form-urlencoded. Nested failure fields arrive as error[code]=...
  for (const [key, value] of new URLSearchParams(raw)) fields[key] = value;
  return fields;
}

function errorCode(fields: Record<string, string>) {
  const direct = text(fields["error[code]"]);
  if (ERROR_CODE.test(direct)) return direct;
  try {
    const parsed = JSON.parse(text(fields.error) || "{}") as { code?: unknown };
    const nested = text(parsed?.code);
    return ERROR_CODE.test(nested) ? nested : "PAYMENT_FAILED";
  } catch { return "PAYMENT_FAILED"; }
}

function redirectTo(request: Request, params: Record<string, string>) {
  // A fixed enum preserves the originating app without accepting a redirect URL.
  const path = new URL(request.url).searchParams.get("scope") === "v2" ? "/v2/booking-confirmation" : BOOKING_CONFIRMATION_PATH;
  const target = new URL(path, request.url);
  for (const [key, value] of Object.entries(params)) if (value) target.searchParams.set(key, value);
  return new Response(null, { status: 303, headers: { location: target.toString(), "cache-control": "no-store" } });
}

export function resolveCheckoutReturn(bookingId: string, fields: Record<string, string>) {
  const params: Record<string, string> = {};
  if (BOOKING_ID.test(bookingId)) params.bookingId = bookingId;
  const orderId = text(fields.razorpay_order_id), paymentId = text(fields.razorpay_payment_id), signature = text(fields.razorpay_signature);
  if (ORDER_ID.test(orderId) && PAYMENT_ID.test(paymentId) && SIGNATURE.test(signature)) {
    return { ...params, orderId, paymentId, signature, payment: "returned" };
  }
  if ("error[code]" in fields || "error" in fields || "error[description]" in fields) return { ...params, payment: "failed", code: errorCode(fields) };
  return params;
}

export async function POST(request: Request) {
  try {
    const bookingId = text(new URL(request.url).searchParams.get("bookingId"));
    let fields: Record<string, string> = {};
    try { fields = await readFields(request); } catch { fields = {}; }
    return redirectTo(request, resolveCheckoutReturn(bookingId, fields));
  } catch (error) { return authError(error, "Unable to return from Razorpay checkout. Open your booking from Activity to check its payment status."); }
}

/** A customer who lands here by navigation is sent to the confirmation page to read the server status. */
export async function GET(request: Request) {
  try {
    const bookingId = text(new URL(request.url).searchParams.get("bookingId"));
    return redirectTo(request, resolveCheckoutReturn(bookingId, {}));
  } catch (error) { return authError(error, "Unable to return from Razorpay checkout. Open your booking from Activity to check its payment status."); }
}
