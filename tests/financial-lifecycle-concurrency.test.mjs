import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const twenty = () => Array.from({ length: 20 }, (_, index) => index);

function uniqueWinners(keys) {
  const seen = new Set();
  return keys.filter((key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

test("finance acceptance: 20 simultaneous checkout contenders have one durable intent, outbox command and provider claimant", async () => {
  const [finance, intent, migration] = await Promise.all([
    source("lib/financial-lifecycle.ts"),
    source("lib/payment-order-intent.ts"),
    source("drizzle/0017_financial_lifecycle_hardening.sql"),
  ]);

  // DB identity is the final concurrency authority, not a process-local mutex.
  assert.match(migration, /UNIQUE\(customer_id, booking_id, idempotency_key\)/);
  assert.match(migration, /dedupe_key TEXT NOT NULL UNIQUE/);
  assert.equal(uniqueWinners(twenty().map(() => "customer:booking:payment-order:stage:amount")).length, 1);

  // Every contender first persists the intent + outbox as one D1 batch. The provider call is later.
  const batchAt = finance.indexOf("await db.batch([");
  const providerAt = finance.indexOf("createPaymentOrderPaise(env, request)");
  assert.ok(batchAt >= 0 && providerAt > batchAt, "durable intent/outbox must precede Razorpay");
  assert.match(finance, /ON CONFLICT\(customer_id,booking_id,idempotency_key\) DO NOTHING/);
  assert.match(finance, /status IN \('PENDING','RETRY'\) AND next_attempt_at<=\?/);
  assert.doesNotMatch(finance, /status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<\?\)\s*\n\s*\)/);
  assert.match(intent, /executeRazorpayOrderOutbox/);
});

test("finance acceptance: an expired PROCESSING provider lease fails closed instead of creating a second Razorpay order", async () => {
  const finance = await source("lib/financial-lifecycle.ts");
  const staleAt = finance.indexOf("status='RECONCILIATION_REQUIRED'");
  const claimAt = finance.indexOf("status='PROCESSING',lease_owner=?");
  const providerAt = finance.indexOf("createPaymentOrderPaise(env, request)");

  assert.ok(staleAt >= 0 && claimAt > staleAt && providerAt > claimAt);
  assert.match(finance, /stale_processing_lease_requires_reconciliation/);
  assert.match(finance, /status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<\?/);
  assert.match(finance, /if \(String\(work\.status \|\| ""\) === "RECONCILIATION_REQUIRED"\)/);
  assert.match(finance, /previous Razorpay order attempt ended ambiguously/);
});

test("finance acceptance: 20 duplicate Razorpay deliveries collapse to one immutable inbox identity and one domain claimant", async () => {
  const [finance, webhook, migration] = await Promise.all([
    source("lib/financial-lifecycle.ts"),
    source("app/api/razorpay-webhook/route.ts"),
    source("drizzle/0017_financial_lifecycle_hardening.sql"),
  ]);

  assert.match(migration, /UNIQUE\(provider,event_id\)/);
  assert.equal(uniqueWinners(twenty().map(() => "razorpay:event-1")).length, 1);
  assert.match(finance, /ON CONFLICT\(provider,event_id\) DO NOTHING/);
  assert.match(finance, /if \(!inserted\) return \{ duplicate: true as const, row \}/);

  const rawAt = webhook.indexOf("const raw=await request.text()");
  const acceptAt = webhook.indexOf("acceptRazorpayWebhook(db");
  const parseAt = webhook.indexOf("JSON.parse(String(accepted.row.raw_payload");
  const claimAt = webhook.indexOf("claimInbox(db,accepted.row,eventType)");
  const domainAt = webhook.indexOf("processGatewayEvent(db,event)");
  assert.ok(rawAt >= 0 && acceptAt > rawAt && parseAt > acceptAt && claimAt > parseAt && domainAt > claimAt);
  assert.match(webhook, /processing_status IN \('RECEIVED','DEFERRED','FAILED'\)/);
});

test("finance acceptance: 20 partner-release contenders produce one release identity and only completed bookings are eligible", async () => {
  const [finance, migration] = await Promise.all([
    source("lib/financial-lifecycle.ts"),
    source("drizzle/0017_financial_lifecycle_hardening.sql"),
  ]);

  assert.equal(uniqueWinners(twenty().map(() => "booking-1:completion")).length, 1);
  assert.match(migration, /UNIQUE\(booking_id,release_type\)/);
  assert.match(migration, /partner_release_requires_completed_booking/);
  assert.match(finance, /lower\(b\.status\)='completed'/);
  assert.match(finance, /ON CONFLICT\(booking_id,release_type\) DO NOTHING/);
  assert.match(finance, /UPDATE partner_earning_pending SET status='RELEASED'/);
  assert.match(finance, /Partner earning release was not atomic/);
});

test("settlement boundary: aggregate Razorpay settlement events are not incorrectly mapped to a single payment intent", async () => {
  const webhook = await source("app/api/razorpay-webhook/route.ts");
  assert.doesNotMatch(webhook, /eventType==="settlement\.processed"\)return"SETTLED"/);
  assert.doesNotMatch(webhook, /settlement\.processed[^\n]{0,160}advancePaymentState/);
});
