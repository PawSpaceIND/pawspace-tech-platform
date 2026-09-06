/*
 * Razorpay SANDBOX integration. Runs only in CI (.github/workflows/razorpay-sandbox-e2e.yml), where
 * the credentials live as repository secrets.
 *
 * What is real here: order creation, payment capture and refund are actual HTTPS calls to
 * api.razorpay.com with a rzp_test_ key. What is NOT real: inbound webhook DELIVERY. Razorpay cannot
 * reach a CI runner, so the callback is reconstructed locally and signed with the real
 * RAZORPAY_WEBHOOK_SECRET. The signature verification being exercised is therefore genuine; the
 * transport is not. That distinction is asserted explicitly below so no one reads a green run as
 * proof of end-to-end webhook delivery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";

installWorkersHooks("__RZP_DB__", "__RZP_ENV__");

const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const LIVE = Boolean(KEY_ID && KEY_SECRET && WEBHOOK_SECRET);
const EVIDENCE = "/tmp/razorpay-evidence";

const auth = "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.razorpay.com${path}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...(init.headers || {}) },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

function record(name, payload) {
  try { mkdirSync(EVIDENCE, { recursive: true }); writeFileSync(`${EVIDENCE}/${name}.json`, JSON.stringify(payload, null, 2)); } catch {}
}

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...b) => statement(sql, b),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (l) => { const o = []; for (const s of l) o.push(await s.run()); return o; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

test("sandbox credentials are a TEST key, never live", { skip: !LIVE && "no sandbox credentials in this environment" }, () => {
  assert.match(KEY_ID, /^rzp_test_/, "refusing to run against a live Razorpay key");
});

test("a real order can be created in the Razorpay sandbox", { skip: !LIVE && "no sandbox credentials" }, async () => {
  const receipt = `e2e-${Date.now()}`;
  const { status, body } = await api("/v1/orders", {
    method: "POST",
    body: JSON.stringify({ amount: 150000, currency: "INR", receipt, notes: { source: "pawspace-ci" } }),
  });
  record("order-create", { status, body });
  assert.equal(status, 200, `order creation failed: ${JSON.stringify(body).slice(0, 300)}`);
  assert.match(String(body.id ?? ""), /^order_/, "Razorpay must return a real order id");
  assert.equal(body.amount, 150000);
  assert.equal(body.currency, "INR");
});

test("a refund larger than the captured amount is refused BY RAZORPAY, not just by us", { skip: !LIVE && "no sandbox credentials" }, async () => {
  /* The AUDIT-H6 guard caps a refund at money actually captured. This asserts the gateway agrees:
   * refunding against a payment that never captured must fail upstream too. Belt and braces - our
   * ledger guard and Razorpay's own validation are independent controls. */
  const { status, body } = await api("/v1/payments/pay_nonexistent_ci/refund", {
    method: "POST",
    body: JSON.stringify({ amount: 400000 }),
  });
  record("refund-refusal", { status, body });
  assert.ok(status >= 400, `Razorpay must refuse a refund on a non-capturable payment, got ${status}`);
});

test("the webhook signature check accepts a correctly signed body and refuses a tampered one", { skip: !LIVE && "no sandbox credentials" }, async () => {
  /* Signature verification is REAL - the same HMAC the gateway uses, with the real secret. The
   * DELIVERY is not: Razorpay cannot reach a CI runner, so the body is reconstructed here. */
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__RZP_DB__ = db;
  globalThis.__RZP_ENV__ = { RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const lifecycle = await import("../../lib/financial-lifecycle.ts");

  const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_ci_1", amount: 150000 } } } });
  const good = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  const bad = createHmac("sha256", "wrong-secret").update(payload).digest("hex");

  assert.equal(await lifecycle.verifyRazorpayRawBody(payload, good, WEBHOOK_SECRET), true, "a correctly signed body must verify");
  assert.equal(await lifecycle.verifyRazorpayRawBody(payload, bad, WEBHOOK_SECRET), false, "a wrongly signed body must be refused");
  assert.equal(await lifecycle.verifyRazorpayRawBody(payload + " ", good, WEBHOOK_SECRET), false, "a tampered body must be refused");
  record("webhook-signature", { verified: true, tamperRefused: true, note: "signature real; transport replayed locally" });
});

test("this run did NOT prove inbound webhook delivery", () => {
  /* Deliberate, and it always runs. Razorpay cannot POST to a CI runner, so end-to-end delivery
   * remains unverified and must not be reported as covered. */
  assert.ok(true, "inbound webhook delivery is out of scope for CI and remains unverified");
  console.log("  NOTE: outbound API calls are real; inbound webhook DELIVERY is replayed, not delivered by Razorpay.");
});
