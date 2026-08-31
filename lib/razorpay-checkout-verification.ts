type RazorEnv = Record<string, unknown>;
export type CheckoutEnvironment = "sandbox" | "live";

type VerifyInput = {
  environment: CheckoutEnvironment;
  orderId: string;
  paymentId: string;
  signature: string;
};

function keySecret(env: RazorEnv, environment: CheckoutEnvironment) {
  return String((environment === "sandbox" ? env?.RAZORPAY_KEY_SECRET_SANDBOX : env?.RAZORPAY_KEY_SECRET) || "").trim();
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualHex(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function signRazorpayCheckout(secret: string, orderId: string, paymentId: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${orderId}|${paymentId}`));
  return bytesToHex(new Uint8Array(signed));
}

/**
 * Verify the browser checkout callback without granting capture authority to the browser.
 * The order id must come from PawSpace's durable gateway link, not from the callback payload.
 */
export async function verifyRazorpayCheckoutSignature(env: RazorEnv, input: VerifyInput) {
  const orderId = String(input.orderId || "").trim();
  const paymentId = String(input.paymentId || "").trim();
  const signature = String(input.signature || "").trim().toLowerCase();
  if (!orderId.startsWith("order_") || !paymentId.startsWith("pay_") || !/^[a-f0-9]{64}$/.test(signature)) {
    return { verified: false as const, reason: "Razorpay checkout callback is malformed" };
  }
  const secret = keySecret(env, input.environment);
  if (!secret) return { verified: false as const, reason: `Razorpay ${input.environment} key secret is not configured` };
  const expected = await signRazorpayCheckout(secret, orderId, paymentId);
  if (!constantTimeEqualHex(expected, signature)) return { verified: false as const, reason: "Razorpay checkout signature mismatch" };
  return { verified: true as const };
}
