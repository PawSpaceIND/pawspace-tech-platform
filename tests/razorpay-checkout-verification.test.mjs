import assert from "node:assert/strict";
import test from "node:test";

const verifier = await import("../lib/razorpay-checkout-verification.ts");
const secret = "rzp_test_checkout_secret";
const orderId = "order_test_checkout_123";
const paymentId = "pay_test_checkout_456";

test("Razorpay checkout verifier accepts a valid sandbox HMAC", async () => {
  const signature = await verifier.signRazorpayCheckout(secret, orderId, paymentId);
  const result = await verifier.verifyRazorpayCheckoutSignature(
    { RAZORPAY_KEY_SECRET_SANDBOX: secret },
    { environment: "sandbox", orderId, paymentId, signature },
  );
  assert.deepEqual(result, { verified: true });
});

test("Razorpay checkout verifier rejects a tampered signature", async () => {
  const signature = await verifier.signRazorpayCheckout(secret, orderId, paymentId);
  const tampered = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
  const result = await verifier.verifyRazorpayCheckoutSignature(
    { RAZORPAY_KEY_SECRET_SANDBOX: secret },
    { environment: "sandbox", orderId, paymentId, signature: tampered },
  );
  assert.equal(result.verified, false);
  assert.match(result.reason, /signature mismatch/i);
});

test("Razorpay checkout verifier binds the signature to the payment id", async () => {
  const signature = await verifier.signRazorpayCheckout(secret, orderId, paymentId);
  const result = await verifier.verifyRazorpayCheckoutSignature(
    { RAZORPAY_KEY_SECRET_SANDBOX: secret },
    { environment: "sandbox", orderId, paymentId: "pay_test_checkout_999", signature },
  );
  assert.equal(result.verified, false);
  assert.match(result.reason, /signature mismatch/i);
});

test("Razorpay checkout verifier fails closed on malformed callbacks", async () => {
  const result = await verifier.verifyRazorpayCheckoutSignature(
    { RAZORPAY_KEY_SECRET_SANDBOX: secret },
    { environment: "sandbox", orderId: "bad-order", paymentId, signature: "not-a-signature" },
  );
  assert.equal(result.verified, false);
  assert.match(result.reason, /malformed/i);
});

test("Razorpay checkout verifier fails closed when the sandbox secret is absent", async () => {
  const signature = await verifier.signRazorpayCheckout(secret, orderId, paymentId);
  const result = await verifier.verifyRazorpayCheckoutSignature(
    {},
    { environment: "sandbox", orderId, paymentId, signature },
  );
  assert.equal(result.verified, false);
  assert.match(result.reason, /not configured/i);
});
