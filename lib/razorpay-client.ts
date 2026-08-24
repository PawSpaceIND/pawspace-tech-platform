/**
 * Environment-aware, fail-closed Razorpay order/refund adapter for the CUSTOMER verify-first payment
 * path. Mirrors the fail-closed contract of every other external integration in this codebase: it
 * makes a genuine Razorpay API call the moment credentials are configured, and returns a clean
 * `{connected:false}` otherwise - it never fabricates an order or pretends money moved.
 *
 * Credentials are per environment, resolved from PAWSPACE_PAYMENT_ENV:
 *   sandbox -> RAZORPAY_KEY_ID_SANDBOX / RAZORPAY_KEY_SECRET_SANDBOX
 *   live    -> RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET
 * With no keys for the active environment, every call fails closed. Production ("live") keys are set
 * only in the isolated environment that has been approved for it - never bundled here.
 */

type RazorEnv = Record<string, unknown>;
export type PaymentEnvironment = "sandbox" | "live";
export type OrderResult =
  | { connected: true; environment: PaymentEnvironment; order: Record<string, unknown> }
  | { connected: false; environment: PaymentEnvironment; reason: string };
export type PaymentLinkResult =
  | { connected: true; environment: "sandbox"; paymentLink: Record<string, unknown> }
  | { connected: false; environment: PaymentEnvironment; reason: string };

export function paymentEnvironment(env: RazorEnv): PaymentEnvironment {
  return String(env?.PAWSPACE_PAYMENT_ENV || "sandbox").toLowerCase() === "sandbox" ? "sandbox" : "live";
}

function credentials(env: RazorEnv): { environment: PaymentEnvironment; keyId: string; keySecret: string } {
  const environment = paymentEnvironment(env);
  const keyId = String((environment === "sandbox" ? env?.RAZORPAY_KEY_ID_SANDBOX : env?.RAZORPAY_KEY_ID) || "").trim();
  const keySecret = String((environment === "sandbox" ? env?.RAZORPAY_KEY_SECRET_SANDBOX : env?.RAZORPAY_KEY_SECRET) || "").trim();
  return { environment, keyId, keySecret };
}

/** The public key id (safe for the client's Razorpay Checkout), or "" if not configured. */
export function publicKeyId(env: RazorEnv): string {
  return credentials(env).keyId;
}

/** Create a Razorpay order for a booking's payment. Fails closed (connected:false) with no keys. */
export async function createPaymentOrder(env: RazorEnv, input: { bookingId: string; paymentId: string; amount: number; currency: string }): Promise<OrderResult> {
  const { environment, keyId, keySecret } = credentials(env);
  if (!keyId || !keySecret) return { connected: false, environment, reason: `Razorpay ${environment} API credentials are not configured - online payment is not connected yet` };
  if (!(input.amount > 0)) return { connected: false, environment, reason: "A positive payable amount is required to open a payment" };
  try {
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: Math.round(input.amount * 100), currency: input.currency, receipt: input.paymentId.slice(0, 40), notes: { booking_id: input.bookingId, payment_id: input.paymentId, pawspace_environment: environment } }),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { connected: false, environment, reason: `Razorpay ${environment} order create failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.description || "request failed")}` };
    if (!String(body.id || "").startsWith("order_")) return { connected: false, environment, reason: "Razorpay did not return an order id" };
    return { connected: true, environment, order: body };
  } catch (error) {
    return { connected: false, environment, reason: `Razorpay request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Open a collectable post-service checkout. This boundary is deliberately sandbox-only: a provider
 * QR must never become an accidental production charge merely because live keys exist elsewhere.
 */
export async function createSandboxPaymentLink(env: RazorEnv, input: { bookingId: string; paymentId: string; referenceId: string; customerId: string; amount: number; currency: string; expiresAt: number }): Promise<PaymentLinkResult> {
  const { environment, keyId, keySecret } = credentials(env);
  if (environment !== "sandbox") return { connected: false, environment, reason: "Post-service payment links are locked to Razorpay sandbox" };
  if (!keyId || !keySecret) return { connected: false, environment, reason: "Razorpay sandbox API credentials are not configured - payment link was not created" };
  if (!(input.amount > 0)) return { connected: false, environment, reason: "A positive payable amount is required to create a payment link" };
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) return { connected: false, environment, reason: "A future payment-link expiry is required" };
  try {
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, "content-type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(input.amount * 100), currency: input.currency, accept_partial: false,
        expire_by: Math.floor(input.expiresAt / 1000),
        reference_id: input.referenceId.slice(0, 40), description: `PawSpace booking ${input.bookingId}`,
        notes: { booking_id: input.bookingId, payment_id: input.paymentId, customer_id: input.customerId, pawspace_environment: "sandbox" },
      }),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { connected: false, environment, reason: `Razorpay sandbox payment-link create failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.description || "request failed")}` };
    if (!String(body.id || "").startsWith("plink_") || !String(body.short_url || "").startsWith("https://")) return { connected: false, environment, reason: "Razorpay did not return a collectable payment link" };
    return { connected: true, environment, paymentLink: body };
  } catch (error) {
    return { connected: false, environment, reason: `Razorpay sandbox payment-link request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
