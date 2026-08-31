import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const bridge=fs.readFileSync("app/components/grooming-razorpay-bridge.tsx","utf8");
const client=fs.readFileSync("lib/razorpay-checkout-client.ts","utf8");
const route=fs.readFileSync("app/api/payment-order/route.ts","utf8");
const intent=fs.readFileSync("lib/payment-order-intent.ts","utf8");
const webhook=fs.readFileSync("app/api/razorpay-webhook/route.ts","utf8");
const reconciliation=fs.readFileSync("lib/grooming-payment-reconciliation.ts","utf8");
const layout=fs.readFileSync("app/layout.tsx","utf8");

test("Grooming customer checkout creates a server-owned payment order without a client amount",()=>{
  assert.match(client,/fetch\("\/api\/payment-order"/);
  assert.match(client,/JSON\.stringify\(\{ action: "create", bookingId \}\)/);
  assert.doesNotMatch(client,/JSON\.stringify\(\{[^}]*amount/);
  assert.match(intent,/paymentStageAmount\(db, bookingId\)/);
  assert.match(intent,/const amount = stage\.dueNow/);
  assert.match(intent,/rupeesToPaiseExact\(amount\)/);
});

test("Grooming certification checkout is sandbox-only and uses the server order",()=>{
  assert.match(client,/data\.environment !== "sandbox"/);
  assert.match(client,/restricted to Razorpay Test Mode/);
  assert.match(client,/order_id: order\.orderId/);
  assert.match(client,/amount: order\.amountPaise/);
  assert.match(client,/key: order\.keyId/);
  assert.match(client,/checkout\.razorpay\.com\/v1\/checkout\.js/);
  assert.match(bridge,/openGroomingRazorpayTestCheckout/);
  assert.match(layout,/GroomingRazorpayBridge/);
});

test("browser callback is verified server-side and still cannot declare capture",()=>{
  assert.match(client,/action: "verify_checkout"/);
  assert.match(client,/razorpayPaymentId: paymentId/);
  assert.match(client,/razorpaySignature: signature/);
  assert.match(client,/waitForWebhookCapture/);
  assert.match(client,/truth\.verifiedCaptured/);
  assert.match(route,/verifyRazorpayCheckoutSignature/);
  assert.match(route,/awaiting_webhook_capture/);
  assert.doesNotMatch(route,/payment_status='captured'/);
});

test("payment status read is customer-owned and non-mutating",()=>{
  assert.match(route,/export async function GET/);
  assert.match(route,/ownedContext\(request\)/);
  assert.match(route,/WHERE b\.id=\? AND b\.customer_id=\?/);
  const getBlock=route.slice(route.indexOf("export async function GET"),route.indexOf("// Verify-first customer payment"));
  assert.doesNotMatch(getBlock,/UPDATE booking_payments/);
  assert.doesNotMatch(getBlock,/INSERT INTO booking_payments/);
});

test("verified webhook remains the canonical capture authority",()=>{
  assert.match(webhook,/request\.text\(\)/);
  assert.match(webhook,/x-razorpay-signature/);
  assert.match(webhook,/x-razorpay-event-id/);
  assert.match(webhook,/acceptRazorpayWebhook/);
  assert.match(reconciliation,/UPDATE booking_payments SET status='captured'/);
  assert.doesNotMatch(client,/simulate_event/);
  assert.doesNotMatch(client,/RAZORPAY_KEY_SECRET/);
});

test("checkout verification polling is bounded and non-capture outcomes stay pending",()=>{
  assert.match(client,/attempts \?\? 12/);
  assert.match(client,/capture_pending/);
  assert.match(client,/cancelled/);
  assert.match(client,/failed/);
  assert.match(bridge,/paymentStatus:"payment_pending"/);
  assert.match(bridge,/waiting for the verified Razorpay webhook capture/);
});
