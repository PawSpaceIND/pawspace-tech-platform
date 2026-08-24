import test from "node:test";
import assert from "node:assert/strict";

const client = await import("../lib/razorpay-client.ts");
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

const input = { bookingId: "BK-900", paymentId: "PAY-900", customerId: "CUS-900", amount: 1149, currency: "INR" };
const env = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_KEY_ID_SANDBOX: "rzp_test_lane3", RAZORPAY_KEY_SECRET_SANDBOX: "sandbox-secret" };

test("post-service collection refuses missing credentials and every live environment", async () => {
  assert.equal((await client.createSandboxPaymentLink({}, input)).connected, false);
  const live = await client.createSandboxPaymentLink({ PAWSPACE_PAYMENT_ENV: "live", RAZORPAY_KEY_ID: "rzp_live_never_used", RAZORPAY_KEY_SECRET: "never-used" }, input);
  assert.deepEqual(live, { connected: false, environment: "live", reason: "Post-service payment links are locked to Razorpay sandbox" });
});

test("post-service collection creates a bound, non-partial Razorpay sandbox link", async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ id: "plink_lane3_900", short_url: "https://rzp.io/i/lane3900", status: "created" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, true);
  assert.equal(request.url, "https://api.razorpay.com/v1/payment_links");
  assert.equal(request.body.amount, 114900);
  assert.equal(request.body.accept_partial, false);
  assert.deepEqual(request.body.notes, { booking_id: "BK-900", payment_id: "PAY-900", customer_id: "CUS-900", pawspace_environment: "sandbox" });
  assert.match(request.init.headers.authorization, /^Basic /);
});

for (const status of [400, 429, 500, 503]) test(`post-service collection preserves Razorpay ${status} as not connected`, async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { description: `provider-${status}` } }), { status, headers: { "content-type": "application/json" } });
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, false);
  assert.match(result.reason, new RegExp(String(status)));
});

test("post-service collection preserves network failure as not connected", async () => {
  globalThis.fetch = async () => { throw new TypeError("network unavailable"); };
  const result = await client.createSandboxPaymentLink(env, input);
  assert.equal(result.connected, false);
  assert.match(result.reason, /network unavailable/);
});
