import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAY_WEBHOOK_BOUNDARY_DB__", "__PAY_WEBHOOK_BOUNDARY_ENV__");

const { parsePaymentEnvironment, PaymentEnvironmentConfigurationError } = await import("../lib/payment-environment.ts");
const { resolvePaymentWebhookGate } = await import("../lib/payment-webhook-gate.ts");
const { verifyRazorpayRawBody } = await import("../lib/financial-lifecycle.ts");

const SANDBOX_SECRET = "payment-webhook-boundary-sandbox-secret";
const LIVE_SECRET = "payment-webhook-boundary-live-secret";

async function sign(secret, rawBody) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("payment webhook parser accepts only exact sandbox/live declarations", () => {
  assert.equal(parsePaymentEnvironment({ PAWSPACE_PAYMENT_ENV: "sandbox" }), "sandbox");
  assert.equal(parsePaymentEnvironment({ PAWSPACE_PAYMENT_ENV: "live" }), "live");

  for (const env of [
    {},
    { PAWSPACE_PAYMENT_ENV: "" },
    { PAWSPACE_PAYMENT_ENV: "SANDBOX" },
    { PAWSPACE_PAYMENT_ENV: " sandbox " },
    { PAWSPACE_PAYMENT_ENV: "production" },
  ]) {
    assert.throws(
      () => parsePaymentEnvironment(env),
      (error) => error instanceof PaymentEnvironmentConfigurationError,
      `non-canonical payment environment must fail closed: ${JSON.stringify(env)}`,
    );
  }
});

test("payment webhook gate preserves strict environment and credential separation", () => {
  const sandbox = resolvePaymentWebhookGate({
    PAWSPACE_PAYMENT_ENV: "sandbox",
    RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET,
  });
  assert.deepEqual(sandbox, { ok: true, environment: "sandbox", secret: SANDBOX_SECRET });

  for (const env of [
    { RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET },
    { PAWSPACE_PAYMENT_ENV: "SANDBOX", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET },
    { PAWSPACE_PAYMENT_ENV: " sandbox ", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET },
  ]) {
    const blocked = resolvePaymentWebhookGate(env);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 503);
  }

  const unapprovedLive = resolvePaymentWebhookGate({
    PAWSPACE_PAYMENT_ENV: "live",
    RAZORPAY_WEBHOOK_SECRET_LIVE: LIVE_SECRET,
  });
  assert.equal(unapprovedLive.ok, false);
  assert.equal(unapprovedLive.status, 503);

  const noLiveSecret = resolvePaymentWebhookGate({
    PAWSPACE_PAYMENT_ENV: "live",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "true",
    RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET,
  });
  assert.equal(noLiveSecret.ok, false);
  assert.equal(noLiveSecret.status, 503);

  const approvedLive = resolvePaymentWebhookGate({
    PAWSPACE_PAYMENT_ENV: "live",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "true",
    RAZORPAY_WEBHOOK_SECRET_LIVE: LIVE_SECRET,
    RAZORPAY_WEBHOOK_SECRET_SANDBOX: SANDBOX_SECRET,
  });
  assert.deepEqual(approvedLive, { ok: true, environment: "live", secret: LIVE_SECRET });
});

test("Razorpay verification authenticates the exact raw webhook bytes", async () => {
  const payload = {
    event: "payment.captured",
    created_at: 1_800_000_000,
    payload: {
      payment: {
        entity: {
          id: "pay_boundary_1",
          order_id: "order_boundary_1",
          amount: 200000,
          currency: "INR",
          notes: { booking_id: "BKG-BOUNDARY-1" },
        },
      },
    },
  };

  const compact = JSON.stringify(payload);
  const pretty = JSON.stringify(payload, null, 2);
  const signature = await sign(SANDBOX_SECRET, compact);

  assert.equal(await verifyRazorpayRawBody(compact, signature, SANDBOX_SECRET), true);
  assert.equal(await verifyRazorpayRawBody(compact, signature.toUpperCase(), SANDBOX_SECRET), true,
    "hex case normalization must not change signature meaning");
  assert.equal(await verifyRazorpayRawBody(pretty, signature, SANDBOX_SECRET), false,
    "the same JSON value with different raw bytes must not reuse the signature");
  assert.equal(await verifyRazorpayRawBody(compact, signature.slice(0, 32), SANDBOX_SECRET), false,
    "a truncated signature must never prefix-match");
  assert.equal(await verifyRazorpayRawBody(compact, signature, "wrong-secret"), false,
    "a signature from another secret must fail");
});
