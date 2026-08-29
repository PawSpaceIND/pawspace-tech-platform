import test from "node:test";
import assert from "node:assert/strict";
import { resolveRazorpayRuntime } from "../lib/payments/razorpay-runtime.ts";
import { verifyRazorpayCheckout } from "../lib/payments/razorpay-checkout-verification.ts";

async function signature(secret, orderId, paymentId) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${orderId}|${paymentId}`)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

test("Mission 2 payment runtime is sandbox-first and live fail-closed", () => {
  assert.equal(resolveRazorpayRuntime({}).environment, "sandbox");
  assert.equal(resolveRazorpayRuntime({ PAWSPACE_PAYMENT_ENV: "sandbox" }).environment, "sandbox");
  assert.throws(() => resolveRazorpayRuntime({ PAWSPACE_PAYMENT_ENV: "live" }), /live mode is disabled/i);
  assert.throws(() => resolveRazorpayRuntime({ PAWSPACE_PAYMENT_ENV: "production" }), /live mode is disabled/i);
  assert.equal(resolveRazorpayRuntime({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_ENABLE_LIVE_PAYMENTS: "true" }).environment, "live");
  assert.throws(() => resolveRazorpayRuntime({ RAZORPAY_KEY_ID_SANDBOX: "rzp_live_wrong", RAZORPAY_KEY_SECRET_SANDBOX: "secret" }), /rzp_test_/);
});

test("Mission 2 accepts checkout only after HMAC and captured gateway truth match", async () => {
  const env = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_KEY_ID_SANDBOX: "rzp_test_contract", RAZORPAY_KEY_SECRET_SANDBOX: "sandbox_secret" };
  const orderId = "order_contract_123", paymentId = "pay_contract_456", amountSubunits = 189900, currency = "INR";
  const proof = await signature(env.RAZORPAY_KEY_SECRET_SANDBOX, orderId, paymentId), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: paymentId, order_id: orderId, status: "captured", amount: amountSubunits, currency });
  try {
    const verified = await verifyRazorpayCheckout(env, { orderId, paymentId, signature: proof, amountSubunits, currency });
    assert.equal(verified.environment, "sandbox");
    await assert.rejects(() => verifyRazorpayCheckout(env, { orderId, paymentId, signature: "0".repeat(64), amountSubunits, currency }), /signature verification failed/i);
  } finally { globalThis.fetch = originalFetch; }
});
