import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
const source=path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Grooming payment integration is sandbox-locked signed idempotent and reconciled",async()=>{
  const[engine,webhook,sandbox,client,finance,financeUi,gateway]=await Promise.all([
    source("lib/grooming-payment-reconciliation.ts"),source("app/api/razorpay-webhook/route.ts"),source("app/api/grooming-payment-sandbox/route.ts"),source("lib/razorpay-sandbox-client.ts"),source("app/api/grooming-finance/route.ts"),source("app/team/finance/page.tsx"),source("lib/api-gateway.ts"),
  ]);
  for(const table of ["payment_gateway_links","payment_gateway_events","payment_reconciliation_records","payment_reconciliation_exceptions"])assert.match(engine,new RegExp(table));
  assert.match(engine,/UNIQUE\(provider,event_id\)/);
  assert.match(engine,/duplicate:true/);
  assert.match(engine,/capture_amount_mismatch/);
  assert.match(engine,/currency_mismatch/);
  assert.match(engine,/unmatched_gateway_event/);
  assert.match(engine,/orphan_gateway_refund/);
  assert.match(engine,/refund_amount_mismatch/);
  assert.match(engine,/refund_overage/);
  assert.match(engine,/out_of_order_failed/);
  assert.match(engine,/refund_already_processed/);
  assert.match(webhook,/request\.text\(\)/);
  assert.match(webhook,/x-razorpay-signature/);
  assert.match(webhook,/x-razorpay-event-id/);
  assert.match(webhook,/HMAC/);
  assert.match(webhook,/SHA-256/);
  assert.match(webhook,/RAZORPAY_WEBHOOK_SECRET_SANDBOX/);
  assert.match(webhook,/locked to sandbox/);
  assert.match(sandbox,/authorize\(request,"payments\.manage"\)/);
  assert.match(sandbox,/"create_order"\|"initiate_refund"\|"link_order"\|"simulate_event"/);
  assert.match(sandbox,/configuration_required/);
  assert.match(sandbox,/duplicatePrevented:true/);
  assert.match(client,/\/v1\/orders/);
  assert.match(client,/\/v1\/payments\/\$\{encodeURIComponent\(input\.gatewayPaymentId\)\}\/refund/);
  assert.match(client,/X-Refund-Idempotency/);
  assert.match(client,/RAZORPAY_KEY_ID_SANDBOX/);
  assert.match(client,/RAZORPAY_KEY_SECRET_SANDBOX/);
  assert.match(finance,/payment_reconciliation_records/);
  assert.match(finance,/payment_reconciliation_exceptions/);
  assert.match(finance,/open_reconciliation_exceptions/);
  assert.match(financeUi,/Reconciled/);
  assert.match(financeUi,/Unreconciled/);
  assert.match(financeUi,/Open exceptions/);
  assert.match(financeUi,/Variance/);
  assert.match(gateway,/url\.pathname==="\/api\/pricing-quote"/);
  assert.match(gateway,/url\.pathname==="\/api\/razorpay-webhook"/);
  assert.match(gateway,/\/api\/grooming-payment-sandbox/);
  assert.match(gateway,/payments\.manage/);
});

test("Grooming payment code does not embed production secrets or enable live payment mode",async()=>{
  const files=await Promise.all(["app/api/razorpay-webhook/route.ts","app/api/grooming-payment-sandbox/route.ts","lib/razorpay-sandbox-client.ts"].map(source));
  for(const text of files){assert.doesNotMatch(text,/rzp_live_[A-Za-z0-9]+/);assert.doesNotMatch(text,/RAZORPAY_KEY_SECRET_LIVE/);}
  assert.match(files[0],/PAWSPACE_PAYMENT_ENV/);assert.match(files[1],/PAWSPACE_PAYMENT_ENV/);assert.match(files[2],/locked to sandbox until production launch approval/);
});
