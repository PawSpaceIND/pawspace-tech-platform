import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const client = await import("../lib/razorpay-client.ts");

async function contractServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ path: request.url, headers: request.headers, body });
      const scenario = String(body.receipt || body.reference_id || "");
      if (scenario.includes("TIMEOUT")) return;
      const match = scenario.match(/HTTP_(400|401|429|500|503)/);
      if (match) {
        response.writeHead(Number(match[1]), { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { description: `contract-test-${match[1]}` } }));
        return;
      }
      if (scenario.includes("INVALID")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "invalid_contract_response", short_url: "http://not-collectable.invalid" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/v1/orders") response.end(JSON.stringify({ id: `order_contract_test_${scenario}`, status: "created" }));
      else response.end(JSON.stringify({ id: `plink_contract_test_${scenario}`, short_url: `https://contract-test.invalid/${scenario}`, expire_by: body.expire_by, status: "created" }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
  };
}

const environment = (url, extra = {}) => ({
  PAWSPACE_PAYMENT_ENV: "sandbox",
  PAWSPACE_PAYMENT_CONTRACT_TEST: "true",
  PAWSPACE_RAZORPAY_API_BASE_URL: url,
  PAWSPACE_RAZORPAY_TIMEOUT_MS: "100",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_contract_only",
  RAZORPAY_KEY_SECRET_SANDBOX: "contract-test-secret",
  ...extra,
});

test("external Razorpay contract: accepted order and payment-link responses preserve exact binding", async () => {
  const server = await contractServer();
  try {
    const env = environment(server.url);
    const order = await client.createPaymentOrder(env, { bookingId: "BK-CONTRACT", paymentId: "PAY-ORDER-ACCEPT", amount: 1149, currency: "INR" });
    const link = await client.createSandboxPaymentLink(env, { bookingId: "BK-CONTRACT", paymentId: "PAY-LINK-ACCEPT", referenceId: "PAY-LINK-ACCEPT", customerId: "CUS-CONTRACT", amount: 1149, currency: "INR", expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    assert.equal(order.connected, true, JSON.stringify(order));
    assert.equal(link.connected, true, JSON.stringify(link));
    assert.match(String(order.order.id), /^order_contract_test_/);
    assert.match(String(link.paymentLink.id), /^plink_contract_test_/);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0].path, "/v1/orders");
    assert.equal(server.requests[0].body.amount, 114900);
    assert.deepEqual(server.requests[0].body.notes, { booking_id: "BK-CONTRACT", payment_id: "PAY-ORDER-ACCEPT", pawspace_environment: "sandbox" });
    assert.equal(server.requests[1].body.accept_partial, false);
    assert.ok(Number(server.requests[1].body.expire_by) > Math.floor(Date.now() / 1000));
    assert.deepEqual(server.requests[1].body.notes, { booking_id: "BK-CONTRACT", payment_id: "PAY-LINK-ACCEPT", customer_id: "CUS-CONTRACT", pawspace_environment: "sandbox" });
    assert.match(String(server.requests[0].headers.authorization), /^Basic /);
  } finally { await server.close(); }
});

test("external Razorpay contract: HTTP 400, 401, 429, 500 and 503 fail closed", async () => {
  const server = await contractServer();
  try {
    for (const status of [400, 401, 429, 500, 503]) {
      const result = await client.createPaymentOrder(environment(server.url), { bookingId: "BK-CONTRACT", paymentId: `PAY-HTTP_${status}`, amount: 500, currency: "INR" });
      assert.equal(result.connected, false, String(status));
      assert.match(result.reason, new RegExp(String(status)));
    }
  } finally { await server.close(); }
});

test("external Razorpay contract: timeout and network errors never create provider truth", async () => {
  const server = await contractServer();
  try {
    const timed = await client.createPaymentOrder(environment(server.url, { PAWSPACE_RAZORPAY_TIMEOUT_MS: "50" }), { bookingId: "BK-CONTRACT", paymentId: "PAY-TIMEOUT", amount: 500, currency: "INR" });
    assert.equal(timed.connected, false);
    assert.match(timed.reason, /timed out/i);
    const network = await client.createPaymentOrder(environment("http://127.0.0.1:1"), { bookingId: "BK-CONTRACT", paymentId: "PAY-NETWORK", amount: 500, currency: "INR" });
    assert.equal(network.connected, false);
    assert.match(network.reason, /request failed/i);
  } finally { await server.close(); }
});

test("external Razorpay contract: invalid provider responses are rejected", async () => {
  const server = await contractServer();
  try {
    const order = await client.createPaymentOrder(environment(server.url), { bookingId: "BK-CONTRACT", paymentId: "PAY-INVALID", amount: 500, currency: "INR" });
    const link = await client.createSandboxPaymentLink(environment(server.url), { bookingId: "BK-CONTRACT", paymentId: "LINK-INVALID", referenceId: "LINK-INVALID", customerId: "CUS-CONTRACT", amount: 500, currency: "INR", expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    assert.equal(order.connected, false);
    assert.match(order.reason, /did not return an order id/i);
    assert.equal(link.connected, false);
    assert.match(link.reason, /did not return a collectable payment link/i);
  } finally { await server.close(); }
});

test("external Razorpay contract: override is sandbox contract-test only", async () => {
  const server = await contractServer();
  try {
    const noContractFlag = await client.createPaymentOrder(environment(server.url, { PAWSPACE_PAYMENT_CONTRACT_TEST: "false" }), { bookingId: "BK-CONTRACT", paymentId: "PAY-BLOCKED", amount: 500, currency: "INR" });
    assert.equal(noContractFlag.connected, false);
    assert.match(noContractFlag.reason, /contract-test override/i);
    const live = await client.createPaymentOrder({ ...environment(server.url), PAWSPACE_PAYMENT_ENV: "live", RAZORPAY_KEY_ID: "rzp_live_never_contacted", RAZORPAY_KEY_SECRET: "never-contacted" }, { bookingId: "BK-CONTRACT", paymentId: "PAY-LIVE-BLOCKED", amount: 500, currency: "INR" });
    assert.equal(live.connected, false);
    assert.match(live.reason, /contract-test override/i);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});
