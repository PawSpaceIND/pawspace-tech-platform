import assert from "node:assert/strict";

const keyId = process.env.RAZORPAY_KEY_ID_SANDBOX || "";
const keySecret = process.env.RAZORPAY_KEY_SECRET_SANDBOX || "";
const paymentId = process.env.RAZORPAY_SANDBOX_PAYMENT_ID || "";
const amount = Number(process.env.RAZORPAY_SANDBOX_AMOUNT_PAISE || 100);

if (!keyId || !keySecret) {
  console.log("SKIP Razorpay sandbox: RAZORPAY_KEY_ID_SANDBOX/RAZORPAY_KEY_SECRET_SANDBOX are not configured.");
  process.exit(0);
}
if (!keyId.startsWith("rzp_test_")) {
  throw new Error("Refusing to run: Razorpay sandbox harness requires an rzp_test_ key id.");
}
assert.ok(Number.isInteger(amount) && amount > 0, "RAZORPAY_SANDBOX_AMOUNT_PAISE must be a positive integer");

const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
async function api(path, init = {}) {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Razorpay sandbox ${init.method || "GET"} ${path} failed HTTP ${response.status}: ${body?.error?.description || "provider error"}`);
  return body;
}

const receipt = `pawspace-e2e-${Date.now()}`;
const order = await api("/orders", {
  method: "POST",
  body: JSON.stringify({ amount, currency: "INR", receipt, notes: { purpose: "pawspace_browser_e2e" } }),
});
assert.equal(order.amount, amount);
assert.equal(order.currency, "INR");
assert.ok(order.id?.startsWith("order_"));
console.log(`PASS Razorpay sandbox order creation: ${order.id} (${amount} paise)`);

if (!paymentId) {
  console.log("SKIP Razorpay sandbox refund: set RAZORPAY_SANDBOX_PAYMENT_ID to a captured TEST payment created for this verification lane.");
  process.exit(0);
}

const payment = await api(`/payments/${encodeURIComponent(paymentId)}`);
assert.equal(payment.id, paymentId);
assert.equal(payment.status, "captured", "sandbox refund requires a captured test payment");
const refundAmount = Math.min(amount, Number(payment.amount));
const refund = await api(`/payments/${encodeURIComponent(paymentId)}/refund`, {
  method: "POST",
  body: JSON.stringify({ amount: refundAmount, notes: { purpose: "pawspace_browser_e2e_refund" } }),
});
assert.ok(refund.id?.startsWith("rfnd_"));
assert.equal(refund.payment_id, paymentId);
assert.equal(refund.amount, refundAmount);
console.log(`PASS Razorpay sandbox refund: ${refund.id} (${refundAmount} paise)`);
