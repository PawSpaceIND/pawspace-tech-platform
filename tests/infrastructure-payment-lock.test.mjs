import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__INFRA_PAYMENT_LOCK_DB__");
const { parsePaymentEnvironment } = await import("../lib/payment-environment.ts");
const { createPaymentOrderPaise, createSandboxPaymentLink } = await import("../lib/razorpay-client.ts");
const { createSandboxOrder, createSandboxRefund } = await import("../lib/razorpay-sandbox-client.ts");

test("production prohibition overrides live approval before any provider request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network"); });
  for (const forbid of ["true", true]) {
    const env = { PAWSPACE_PAYMENT_ENV: "live", FORBID_PRODUCTION: forbid,
      PAWSPACE_PAYMENT_LIVE_APPROVED: "true", PAWSPACE_PAYMENT_PILOT_BOOKING_IDS: "B1,B2,B3,B4,B5",
      RAZORPAY_KEY_ID: "rzp_live_fixture", RAZORPAY_KEY_SECRET: "fixture" };
    assert.throws(() => parsePaymentEnvironment(env), /forbidden/);
    const result = await createPaymentOrderPaise(env, { bookingId: "B1", paymentId: "P1", amountPaise: 100, currency: "INR" });
    assert.equal(result.connected, false);
    assert.match(result.reason, /FORBID_PRODUCTION/);
  }
  assert.equal(calls, 0);
});

test("live keys mislabeled as sandbox cannot create orders, links or refunds", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network"); });
  const env = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "false", RAZORPAY_KEY_ID_SANDBOX: "rzp_live_fixture",
    RAZORPAY_KEY_SECRET_SANDBOX: "fixture" };
  const input = { bookingId: "B1", paymentId: "P1", amount: 1, amountPaise: 100, currency: "INR",
    referenceId: "R1", customerId: "C1", expiresAt: Date.now() + 60000,
    gatewayPaymentId: "pay_fixture", refundCaseId: "refund_fixture" };
  for (const operation of [createPaymentOrderPaise, createSandboxPaymentLink]) {
    const result = await operation(env, input);
    assert.equal(result.connected, false);
    assert.match(result.reason, /Live Razorpay credentials are forbidden/);
  }
  for (const operation of [createSandboxOrder, createSandboxRefund]) {
    await assert.rejects(operation(env, input), /Live Razorpay credentials are forbidden/);
  }
  assert.equal(calls, 0);
});

test("correcting a rejected key allows a sandbox retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).amount, 100);
    assert.ok(atob(init.headers.authorization.slice(6)).startsWith("rzp_test_fixture:"));
    return Response.json({ id: "order_fixture" });
  });
  const env = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
    RAZORPAY_KEY_ID_SANDBOX: "rzp_live_fixture", RAZORPAY_KEY_SECRET_SANDBOX: "fixture" };
  const input = { bookingId: "B1", paymentId: "P1", amountPaise: 100, currency: "INR" };
  assert.equal((await createPaymentOrderPaise(env, input)).connected, false);
  env.RAZORPAY_KEY_ID_SANDBOX = "rzp_test_fixture";
  assert.equal((await createPaymentOrderPaise(env, input)).connected, true);
  assert.equal(calls, 1);
});

import { assertHumanBetaSandbox } from "../scripts/assert-human-beta-sandbox.mjs";
const locked = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
test("human beta requires every exact safety declaration", () => {
  assert.doesNotThrow(() => assertHumanBetaSandbox(locked));
  for (const name of Object.keys(locked)) {
    for (const value of [undefined, null, "", true, false, "true", "false", "sandbox", "live", "TRUE", "FALSE", " sandbox ", "unknown"]) {
      if (value === locked[name]) continue;
      assert.throws(() => assertHumanBetaSandbox({ ...locked, [name]: value }), new RegExp(name));
    }
  }
});

test("subscription, plan and settlement adapters refuse unsafe environments without network I/O", async (t) => {
  const subscriptions = await import("../lib/razorpay-subscriptions.ts");
  const { verifyRazorpayPlan } = await import("../lib/razorpay-plan-verification.ts");
  const { fetchRazorpaySettlementReconDate } = await import("../lib/razorpay-settlement-reconciliation.ts");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network"); });
  const base = { ...locked, RAZORPAY_KEY_ID_SANDBOX: "rzp_test_fixture", RAZORPAY_KEY_SECRET_SANDBOX: "fixture",
    RAZORPAY_KEY_ID: "rzp_live_fixture", RAZORPAY_KEY_SECRET: "fixture" };
  const operations = [
    env => subscriptions.createRazorpaySubscription(env, { planId: "plan_fixture", totalCount: 12, billingSubscriptionId: "B1", customerId: "C1", sourceBookingId: "BK1" }),
    env => subscriptions.createRazorpaySubscriptionRefund(env, { paymentId: "pay_fixture", amountPaise: 100, refundCaseId: "R1", billingSubscriptionId: "B1", sourceBookingId: "BK1" }),
    env => verifyRazorpayPlan(env, { providerPlanId: "plan_fixture", amountPaise: 100, currency: "INR", period: "monthly", interval: 1 }),
    env => fetchRazorpaySettlementReconDate(env, "2026-09-08"),
  ];
  for (const env of [
    ...[undefined, "", "SANDBOX", "typo"].map(value => ({ ...base, PAWSPACE_PAYMENT_ENV: value })),
    { ...base, PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "true" },
    { ...base, RAZORPAY_KEY_ID_SANDBOX: "rzp_live_fixture" },
  ]) {
    for (const operation of operations) await assert.rejects(operation(env), /must be exactly|forbidden/);
  }
  assert.equal(calls, 0);
});
