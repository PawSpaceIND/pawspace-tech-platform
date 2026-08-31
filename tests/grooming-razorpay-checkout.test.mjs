import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const bridge=fs.readFileSync("app/components/grooming-razorpay-bridge.tsx","utf8");
const route=fs.readFileSync("app/api/payment-order/route.ts","utf8");
const intent=fs.readFileSync("lib/payment-order-intent.ts","utf8");
const webhook=fs.readFileSync("app/api/razorpay-webhook/route.ts","utf8");
const reconciliation=fs.readFileSync("lib/grooming-payment-reconciliation.ts","utf8");
const layout=fs.readFileSync("app/layout.tsx","utf8");

test("Grooming customer checkout creates a server-owned payment order without a client amount",()=>{
  assert.match(bridge,/fetch\("\/api\/payment-order"/);
  assert.match(bridge,/JSON\.stringify\(\{bookingId\}\)/);
  assert.doesNotMatch(bridge,/JSON\.stringify\(\{bookingId,amount/);
  assert.match(intent,/paymentStageAmount\(db, bookingId\)/);
  assert.match(intent,/const amount = stage\.dueNow/);
  assert.match(intent,/rupeesToPaiseExact\(amount\)/);
});

test("Grooming certification checkout is sandbox-only and uses the server order",()=>{
  assert.match(bridge,/environment!=="sandbox"/);
  assert.match(bridge,/locked to Razorpay Test Mode/);
  assert.match(bridge,/order_id:order\.orderId/);
  assert.match(bridge,/amount:order\.amountPaise/);
  assert.match(bridge,/key:order\.keyId/);
  assert.match(bridge,/checkout\.razorpay\.com\/v1\/checkout\.js/);
  assert.match(layout,/GroomingRazorpayBridge/);
});

test("browser callback cannot declare payment captured",()=>{
  assert.match(bridge,/handler:\(\)=>\{startPolling\(\);\}/);
  assert.doesNotMatch(bridge,/handler:[^\n]*paymentStatus:"paid"/);
  assert.match(bridge,/if\(status\.verifiedCaptured\)/);
  assert.match(bridge,/paymentStatus:"paid"/);
  assert.match(route,/verifiedCaptured:paymentStatus==="captured"/);
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
  assert.doesNotMatch(bridge,/simulate_event/);
});

test("checkout verification polling is bounded and failures stay pending",()=>{
  assert.match(bridge,/Date\.now\(\)\+120_000/);
  assert.match(bridge,/window\.clearInterval/);
  assert.match(bridge,/paymentStatus:"payment_pending"/);
  assert.match(bridge,/server remains authority/);
});
