import assert from "node:assert/strict";

const keyId = process.env.RAZORPAY_KEY_ID_SANDBOX || "";
const keySecret = process.env.RAZORPAY_KEY_SECRET_SANDBOX || "";
const paymentId = process.env.RAZORPAY_SANDBOX_PAYMENT_ID || "";
const amount = Number(process.env.RAZORPAY_SANDBOX_AMOUNT_PAISE || 100);

// Prerequisite failures are BLOCKED, never a successful skipped E2E run.
const missing = ["RAZORPAY_KEY_ID_SANDBOX", "RAZORPAY_KEY_SECRET_SANDBOX", "RAZORPAY_WEBHOOK_SECRET_SANDBOX"]
  .filter(name => !String(process.env[name] || "").trim());
function blocked(reason) {
  console.error(`BLOCKED Razorpay sandbox: ${reason}`);
  console.error("No order, capture, refund or webhook verification was executed.");
  process.exit(2);
}
if (missing.length) blocked(`missing ${missing.join(", ")}`);
for (const [name, required] of Object.entries({ PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" })) {
  if (process.env[name] !== required) blocked(`${name} must be explicitly ${required}`);
}
if (!/^rzp_test_[A-Za-z0-9]+$/.test(keyId) || /placeholder/i.test(keyId)) {
  blocked("a configured rzp_test_ key is required; live and placeholder keys are refused");
}
if (!Number.isSafeInteger(amount) || amount <= 0) blocked("RAZORPAY_SANDBOX_AMOUNT_PAISE must be a positive safe integer");
console.log("SCOPE Razorpay order/refund API probe only; inbound webhook delivery and the cross-app journey are NOT verified by this script.");

const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
async function api(path, init = {}) {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
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
