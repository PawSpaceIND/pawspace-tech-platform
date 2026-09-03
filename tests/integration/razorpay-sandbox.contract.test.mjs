import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";
import { preflight } from "./sandbox-preflight.mjs";

// The lib modules import their siblings extensionlessly and some reach for `cloudflare:workers`, so the
// repo's shared resolver is required before any of them is imported. No DB global is ever set: every
// function these suites call takes `env` as a parameter, and none of them touches D1.
installWorkersHooks("__SANDBOX_RAZORPAY_DB__", "__SANDBOX_RAZORPAY_ENV__");

// ---------------------------------------------------------------------------
// Razorpay SANDBOX contract — real HTTP to api.razorpay.com, real credentials.
//
// What this adds over tests/payment-provider-contract.test.mjs, which is NOT a mock either: that suite
// drives the same lib/razorpay-client.ts over real HTTP against a loopback server that speaks
// Razorpay's wire protocol, so it proves OUR half — headers, auth encoding, paise conversion, error
// mapping, timeout and response-size handling, including failure modes a live sandbox will not produce
// on demand. What it cannot prove is that RAZORPAY still behaves the way we assume. That is this file.
//
// One limit, stated rather than implied: Razorpay does not originate a webhook for a bare order. A
// genuine inbound callback requires a payment actually completing in the hosted checkout, which needs a
// browser and a test card. So RZP-05 verifies the inbound contract with REAL key material — the same
// HMAC Razorpay computes, checked by the same verifier the route uses — but the request is originated
// locally. RZP-06 creates a real sandbox payment link and prints its URL, which is the handoff to the
// one step a test process cannot take.
// ---------------------------------------------------------------------------

const KEY_ID = "RAZORPAY_KEY_ID_SANDBOX";
const KEY_SECRET = "RAZORPAY_KEY_SECRET_SANDBOX";
const WEBHOOK_SECRET = "RAZORPAY_WEBHOOK_SECRET_SANDBOX";

const basic = () => Buffer.from(`${process.env[KEY_ID] || ""}:${process.env[KEY_SECRET] || ""}`).toString("base64");

const state = await preflight({
  suite: "Razorpay sandbox",
  required: [
    { name: KEY_ID, hint: "sandbox key id from the Razorpay dashboard (Settings → API Keys, Test Mode)" },
    { name: KEY_SECRET, hint: "the matching sandbox key secret; shown once at generation" },
  ],
  // Only the inbound leg needs this. Gating the whole suite on it skipped the outbound order and
  // payment-link tests in the common partial state where the dashboard API keys exist but the webhook
  // secret has not been configured yet.
  optional: [
    { name: WEBHOOK_SECRET, hint: "the secret configured on the sandbox webhook; needed only by RZP-04/05" },
  ],
  probe: { url: "https://api.razorpay.com/v1/payments?count=1", authenticated: true, headers: { authorization: `Basic ${basic()}` } },
  ownerAction: 'docs/KARTHIK_PENDING_CLOSEOUT.md Batch A — "Razorpay test mode"',
});

const client = await import("../../lib/razorpay-client.ts");
const lifecycle = await import("../../lib/financial-lifecycle.ts");
const gateway = await import("../../lib/payment-webhook-gate.ts");

// PAWSPACE_PAYMENT_ENV must say sandbox for credentials() to read the *_SANDBOX names at all, and the
// contract-test override is deliberately NOT set: that path is loopback-only, and this suite is the one
// that must reach the real host.
const env = () => ({ ...process.env, PAWSPACE_PAYMENT_ENV: "sandbox" });
const ref = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

test("RZP-01: a real sandbox order is created, and our notes survive the round trip", state.gate(), async () => {
  const bookingId = ref("BK-CONTRACT"), paymentId = ref("PAY");
  const result = await client.createPaymentOrder(env(), { bookingId, paymentId, amount: 1349, currency: "INR" });

  assert.equal(result.connected, true, `sandbox order was refused: ${result.connected === false ? result.reason : ""}`);
  assert.equal(result.environment, "sandbox");
  const order = result.order;
  assert.match(String(order.id), /^order_[A-Za-z0-9]+$/, "Razorpay still returns an order_ id");
  assert.equal(Number(order.amount), 134900, "1349 rupees is 134900 paise at the provider, not 1349");
  assert.equal(String(order.currency), "INR");
  assert.equal(String(order.status), "created");
  // The notes are how every downstream reconciliation finds the booking. If Razorpay ever stopped
  // echoing them, reconciliation would silently lose its correlation key.
  assert.equal(String(order.notes?.booking_id), bookingId, "booking_id must come back in notes");
  assert.equal(String(order.notes?.payment_id), paymentId, "payment_id must come back in notes");
  console.log(`RZP-01 order=${order.id} amount_paise=${order.amount} status=${order.status}`);
});

test("RZP-02: a decimal amount converts exactly at the provider, with no floating-point drift", state.gate(), async () => {
  // 1349.50 is the shape that breaks under `amount * 100`. Proven locally against the loopback double;
  // proven here against what the provider actually banks.
  const result = await client.createPaymentOrder(env(), { bookingId: ref("BK-DECIMAL"), paymentId: ref("PAY"), amount: 1349.5, currency: "INR" });
  assert.equal(result.connected, true, `sandbox order was refused: ${result.connected === false ? result.reason : ""}`);
  assert.equal(Number(result.order.amount), 134950, "1349.50 must arrive as exactly 134950 paise");
  console.log(`RZP-02 order=${result.order.id} amount_paise=${result.order.amount}`);
});

test("RZP-03: the provider's real rejection is surfaced as a governed reason, not an exception", state.gate(), async () => {
  // The live error contract, which a local double can only guess at. An unsupported currency is a
  // deterministic 400 from Razorpay and costs nothing.
  const result = await client.createPaymentOrder(env(), { bookingId: ref("BK-REJECT"), paymentId: ref("PAY"), amount: 100, currency: "ZZZ" });
  assert.equal(result.connected, false, "an unsupported currency must not be reported as connected");
  assert.match(result.reason, /order create failed \(4\d\d\)/, `expected a 4xx-shaped governed reason, got: ${result.reason}`);
  console.log(`RZP-03 governed reason: ${result.reason}`);
});

test("RZP-04: the webhook gate resolves sandbox and finds the configured secret", state.gateOn(WEBHOOK_SECRET), async () => {
  const gate = gateway.resolvePaymentWebhookGate(env());
  assert.equal(gate.ok, true, `webhook gate refused: ${gate.ok === false ? gate.reason : ""}`);
  assert.equal(gate.environment, "sandbox", "a sandbox run must never resolve the live webhook secret");
});

test("RZP-05: a payload signed with the real sandbox secret verifies, and any tampering does not", state.gateOn(WEBHOOK_SECRET), async () => {
  const secret = String(process.env[WEBHOOK_SECRET] || "");
  // The exact payload shape lib/financial-lifecycle.ts parses, carrying the notes correlation from RZP-01.
  const payload = JSON.stringify({
    event: "payment.captured",
    created_at: Math.floor(Date.now() / 1000),
    payload: { payment: { entity: { id: `pay_${ref("X").replace(/[^A-Z0-9]/g, "").slice(0, 14)}`, order_id: "order_contract_probe", amount: 134900, currency: "INR", notes: { booking_id: ref("BK-SIG") } } } },
  });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");

  assert.equal(await lifecycle.verifyRazorpayRawBody(payload, signature, secret), true, "a correctly signed body must verify");
  // Three ways it must not: a changed body, a changed signature, a different secret. Each is a distinct
  // real-world failure — a MITM, a replay with edits, and a live/sandbox secret mix-up.
  assert.equal(await lifecycle.verifyRazorpayRawBody(`${payload} `, signature, secret), false, "a tampered body must not verify");
  assert.equal(await lifecycle.verifyRazorpayRawBody(payload, signature.replace(/.$/, "0"), secret), false, "a tampered signature must not verify");
  assert.equal(await lifecycle.verifyRazorpayRawBody(payload, signature, `${secret}x`), false, "the wrong secret must not verify");
  console.log("RZP-05 inbound signature contract holds against the real sandbox secret");
});

test("RZP-06: a real sandbox payment link is issued, for the human step a test cannot take", state.gate(), async () => {
  const result = await client.createSandboxPaymentLink(env(), {
    bookingId: ref("BK-LINK"), paymentId: ref("PAY"), referenceId: ref("REF"), customerId: ref("CUS"),
    amount: 1, currency: "INR", expiresAt: Date.now() + 60 * 60_000,
  });
  assert.equal(result.connected, true, `sandbox payment link was refused: ${result.connected === false ? result.reason : ""}`);
  const link = result.paymentLink;
  assert.match(String(link.id), /^plink_[A-Za-z0-9]+$/, "Razorpay still returns a plink_ id");
  assert.ok(String(link.short_url).startsWith("https://"), "a collectable https URL is required");
  // Completing this link in sandbox is what makes Razorpay originate a genuine inbound webhook, which
  // is the only part of the payment contract no test process can produce for itself.
  console.log(`RZP-06 pay ₹1 in sandbox to originate a real webhook: ${link.short_url}`);
});
