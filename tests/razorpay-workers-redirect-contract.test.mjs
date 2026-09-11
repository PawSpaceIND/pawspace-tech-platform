import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RAZORPAY_REDIRECT_CONTRACT_DB__");
const { createPaymentOrderPaise } = await import("../lib/razorpay-client.ts");

const env = {
  PAWSPACE_PAYMENT_ENV: "sandbox",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_workers_redirect",
  RAZORPAY_KEY_SECRET_SANDBOX: "sandbox-secret",
};

test("Razorpay provider requests use Workers-compatible manual redirect and never follow 3xx", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response("", { status: 302, headers: { location: "https://redirect.invalid/" } });
  };
  try {
    const result = await createPaymentOrderPaise(env, {
      bookingId: "B-WORKERS-REDIRECT",
      paymentId: "P-WORKERS-REDIRECT",
      amountPaise: 100,
      currency: "INR",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.razorpay.com/v1/orders");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(result.connected, false);
    assert.match(String(result.reason), /order create failed \(302\)/);
  } finally {
    globalThis.fetch = original;
  }
});
