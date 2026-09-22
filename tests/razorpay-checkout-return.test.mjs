/**
 * Razorpay redirect-mode return path: callback_url -> /api/razorpay-checkout-return -> booking confirmation.
 *
 * Checkout.js falls back to a full-page redirect in in-app browsers/WebViews and for some bank/UPI flows,
 * and then POSTs the receipt to callback_url. Without it the customer is stranded on a Razorpay-hosted
 * JSON page. These tests execute the real route, the real SDK wrapper payload and the real controller;
 * the receipt is never treated as proof of capture anywhere on this path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RAZORPAY_CHECKOUT_RETURN_DB__", "__RAZORPAY_CHECKOUT_RETURN_ENV__");
const route = await import("../app/api/razorpay-checkout-return/route.ts");
const sdk = await import("../lib/mobile/razorpay.ts");
const { CustomerCheckoutController, checkoutReturnUrl, CHECKOUT_RETURN_PATH, BOOKING_CONFIRMATION_PATH } = await import("../lib/customer-checkout-client.ts");

const origin = "https://pawspace-staging.example.workers.dev";
const locks = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
const signature = "a".repeat(64);
const form = (fields) => new URLSearchParams(fields).toString();

test("booking confirmation renders only the customer-owned canonical server projection", async () => {
  const page = await readFile(new URL("../app/mobile-app/booking-confirmation/booking-confirmation-view.tsx", import.meta.url), "utf8");
  assert.match(page, /loadCustomerConfirmationProjection\(bookingId, abort\.signal\)/);
  assert.doesNotMatch(page, /loadCustomerAccount|localStorage|sessionStorage/, "the success page must not reconstruct pre-payment client state");
  assert.match(page, /const success = verified && canonicalReady/);
  for (const field of ["scheduledStart", "scheduledEnd", "providerName", "providerModel", "paymentStatus", "transactionId"]) assert.match(page, new RegExp(`projection\\.${field}`));
  assert.match(page, /Finalizing your confirmed booking/, "capture alone shows a synchronization state, not success");
});

async function post(fields, { bookingId = "BK-RETURN-1", contentType = "application/x-www-form-urlencoded", body } = {}) {
  const response = await route.POST(new Request(`${origin}${CHECKOUT_RETURN_PATH}?bookingId=${encodeURIComponent(bookingId)}`, {
    method: "POST", headers: { "content-type": contentType, origin: "https://api.razorpay.com", referer: "https://api.razorpay.com/" },
    body: body ?? form(fields),
  }));
  const location = new URL(response.headers.get("location"));
  return { status: response.status, location, params: Object.fromEntries(location.searchParams), cache: response.headers.get("cache-control") };
}

test("a successful redirect-mode payment is forwarded to the booking confirmation page with its receipt", async () => {
  const r = await post({ razorpay_payment_id: "pay_ReturnFixture1", razorpay_order_id: "order_ReturnFixture1", razorpay_signature: signature });
  assert.equal(r.status, 303, "a cross-site POST must become a same-origin GET navigation");
  assert.equal(r.cache, "no-store");
  assert.equal(r.location.origin, origin, "the customer is returned to PawSpace, never to a third-party origin");
  assert.equal(r.location.pathname, BOOKING_CONFIRMATION_PATH);
  assert.deepEqual(r.params, { bookingId: "BK-RETURN-1", orderId: "order_ReturnFixture1", paymentId: "pay_ReturnFixture1", signature, payment: "returned" });
});

test("the route accepts Razorpay's cross-site POST without a session or same-origin gate", async () => {
  const response = await route.POST(new Request(`${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-RETURN-1`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://api.razorpay.com" },
    body: form({ razorpay_payment_id: "pay_ReturnFixture1", razorpay_order_id: "order_ReturnFixture1", razorpay_signature: signature }),
  }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("set-cookie"), null, "the redirect adapter issues no session of its own");
});

test("a failed redirect-mode payment lands on the confirmation page as failed with only a code token", async () => {
  const r = await post({ "error[code]": "BAD_REQUEST_ERROR", "error[description]": "<script>alert(1)</script> Payment failed", "error[metadata]": JSON.stringify({ order_id: "order_ReturnFixture1" }) });
  assert.equal(r.status, 303);
  assert.deepEqual(r.params, { bookingId: "BK-RETURN-1", payment: "failed", code: "BAD_REQUEST_ERROR" });
  assert.doesNotMatch(r.location.toString(), /script|Payment failed/i, "provider text is never reflected into the return URL");
});

test("a malformed or forged receipt shape is dropped so the page reads the persisted status instead", async () => {
  for (const fields of [
    { razorpay_payment_id: "pay_ReturnFixture1", razorpay_order_id: "order_ReturnFixture1", razorpay_signature: "not-a-signature" },
    { razorpay_payment_id: "../../etc", razorpay_order_id: "order_ReturnFixture1", razorpay_signature: signature },
    { razorpay_payment_id: "pay_ReturnFixture1", razorpay_order_id: "javascript:alert(1)", razorpay_signature: signature },
    {},
  ]) {
    const r = await post(fields);
    assert.equal(r.status, 303);
    assert.deepEqual(r.params, { bookingId: "BK-RETURN-1" }, JSON.stringify(fields));
  }
});

test("an invalid booking id is not propagated and an oversized body cannot break the redirect", async () => {
  const bad = await post({ razorpay_payment_id: "pay_ReturnFixture1", razorpay_order_id: "order_ReturnFixture1", razorpay_signature: signature }, { bookingId: "../admin?x=1" });
  assert.equal(bad.status, 303);
  assert.equal("bookingId" in bad.params, false);
  const huge = await post({}, { body: form({ razorpay_signature: "x".repeat(20_000) }) });
  assert.equal(huge.status, 303);
  assert.deepEqual(huge.params, { bookingId: "BK-RETURN-1" });
});

test("JSON callbacks and plain GET navigations both reach the confirmation page", async () => {
  const json = await post({}, { contentType: "application/json", body: JSON.stringify({ razorpay_payment_id: "pay_ReturnFixture2", razorpay_order_id: "order_ReturnFixture2", razorpay_signature: signature }) });
  assert.equal(json.params.paymentId, "pay_ReturnFixture2");
  const response = await route.GET(new Request(`${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-RETURN-1`));
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, BOOKING_CONFIRMATION_PATH);
  assert.deepEqual(Object.fromEntries(location.searchParams), { bookingId: "BK-RETURN-1" });
});

test("checkoutReturnUrl points Razorpay at the same-origin return route and only for http(s) pages", () => {
  assert.equal(checkoutReturnUrl("BK 1/x", origin), `${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK%201%2Fx`);
  assert.equal(checkoutReturnUrl("BK-1", "http://localhost:3000"), `http://localhost:3000${CHECKOUT_RETURN_PATH}?bookingId=BK-1`);
  assert.equal(checkoutReturnUrl("BK-1", ""), undefined);
  assert.equal(checkoutReturnUrl("BK-1", "capacitor://localhost"), undefined);
  assert.equal(checkoutReturnUrl("BK-1", "null"), undefined);
});

function browser(t, win, document) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = win; if (document) globalThis.document = document;
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
}
const opts = { keyId: "rzp_test_rtn1", orderId: "order_ReturnFixture1", amountPaise: 49950, currency: "INR" };

test("Checkout.js receives callback_url alongside the modal handler without forcing redirect mode either way", async t => {
  const constructed = [];
  const win = { location: { origin }, Razorpay: class { constructor(options) { constructed.push(options); this.options = options; } on() {} open() { this.options.handler({ razorpay_order_id: opts.orderId, razorpay_payment_id: "pay_ReturnFixture1", razorpay_signature: signature }); } } };
  browser(t, win);
  const result = await sdk.openMobileRazorpayCheckout({ ...opts, callbackUrl: `${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-RETURN-1` }, locks);
  assert.equal(result.success, true);
  assert.equal(constructed.length, 1);
  assert.equal(constructed[0].callback_url, `${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-RETURN-1`);
  assert.equal("redirect" in constructed[0], false, "neither forced (would reload after every payment) nor explicitly false (must not veto Checkout.js's own redirect/hosted fallback)");
  assert.equal(typeof constructed[0].handler, "function");
  assert.equal(typeof constructed[0].modal?.ondismiss, "function");
});

test("Checkout.js still opens without a callback when the page has no http(s) origin", async t => {
  const constructed = [];
  const win = { Razorpay: class { constructor(options) { constructed.push(options); this.options = options; } on() {} open() { this.options.modal.ondismiss(); } } };
  browser(t, win);
  assert.equal((await sdk.openMobileRazorpayCheckout({ ...opts, callbackUrl: undefined }, locks)).code, "USER_DISMISSED");
  assert.equal("callback_url" in constructed[0], false);
});

for (const [label, callbackUrl] of [["cross-origin", "https://attacker.example/return"], ["plain http", "http://pawspace-staging.example.workers.dev/return"], ["credentialed", `https://user:pw@${new URL(origin).host}/return`], ["relative", "/api/razorpay-checkout-return"]]) {
  test(`Checkout refuses a ${label} callback URL before opening`, async t => {
    let opened = 0;
    browser(t, { location: { origin }, Razorpay: class { constructor() { opened++; } on() {} open() {} } });
    const result = await sdk.openMobileRazorpayCheckout({ ...opts, callbackUrl }, locks);
    assert.equal(result.success, false); assert.equal(result.code, "INVALID_PARAMETERS");
    assert.equal(opened, 0);
  });
}

function client({ status = "awaiting_confirmation" } = {}) {
  const states = [], requests = [], opened = [];
  let confirmationStatus = status;
  const order = { connected: true, environment: "sandbox", bookingId: "BK-RETURN-1", ...opts, locks };
  const controller = new CustomerCheckoutController("BK-RETURN-1", value => states.push(value), {
    fetch: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body);
      if (body.action === "start") return Response.json({ data: order });
      return Response.json({ data: { bookingId: "BK-RETURN-1", orderId: opts.orderId, receiptVerified: true, environment: "sandbox", status: confirmationStatus } });
    },
    open: async (options) => { opened.push(options); return { success: true, environment: "sandbox", orderId: opts.orderId, paymentId: "pay_ReturnFixture1", signature }; },
  });
  return { controller, states, requests, opened, setStatus(value) { confirmationStatus = value; } };
}

test("the checkout controller hands Razorpay the same-origin return address for this booking", async t => {
  browser(t, { location: { origin } });
  const c = client(); await c.controller.start();
  assert.equal(c.opened.length, 1);
  assert.equal(c.opened[0].callbackUrl, `${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-RETURN-1`);
});

test("resume() verifies a receipt carried back by the redirect exactly like the modal handler, then polls the same receipt", async () => {
  const c = client();
  const receipt = { bookingId: "BK-RETURN-1", orderId: opts.orderId, paymentId: "pay_ReturnFixture1", signature };
  await c.controller.resume(receipt);
  assert.equal(c.opened.length, 0, "a returned receipt never opens a second checkout");
  assert.deepEqual(c.requests.at(-1), { action: "confirm", ...receipt });
  assert.equal(c.states.at(-1).phase, "pending"); assert.equal(c.states.at(-1).canCheck, true);
  c.setStatus("captured"); await c.controller.resume();
  assert.deepEqual(c.requests.at(-1), { action: "confirm", ...receipt }, "polling re-confirms the same receipt");
  assert.equal(c.states.at(-1).phase, "captured");
  await c.controller.resume(); assert.equal(c.requests.length, 2, "a verified capture stops further calls");
});

test("resume() without a receipt reads only the persisted status and never charges", async () => {
  const c = client(); await c.controller.resume();
  assert.equal(c.opened.length, 0);
  assert.deepEqual(c.requests, [{ action: "status", bookingId: "BK-RETURN-1" }]);
  assert.equal(c.states.at(-1).phase, "pending");
  assert.match(c.states.at(-1).message, /Waiting for signed Razorpay confirmation/);
});

test("resume() rejects a receipt for another booking or a malformed one", async () => {
  const c = client();
  await c.controller.resume({ bookingId: "BK-OTHER", orderId: opts.orderId, paymentId: "pay_ReturnFixture1", signature });
  assert.equal(c.requests.length, 0); assert.equal(c.states.at(-1).phase, "error");
  await c.controller.resume({ bookingId: "BK-RETURN-1", orderId: opts.orderId, paymentId: "pay_ReturnFixture1", signature: "short" });
  assert.equal(c.requests.length, 0); assert.equal(c.states.at(-1).phase, "error");
});

test("probeStatus() after a failed return publishes only a verified capture and never charges", async () => {
  const c = client();
  assert.equal(await c.controller.probeStatus(), "awaiting_confirmation");
  assert.deepEqual(c.requests, [{ action: "status", bookingId: "BK-RETURN-1" }]);
  assert.equal(c.states.length, 0, "an unverified status leaves the failed-return UI (and its retry) untouched");
  assert.equal(c.opened.length, 0);
  c.setStatus("captured");
  assert.equal(await c.controller.probeStatus(), "captured");
  assert.equal(c.states.at(-1).phase, "captured", "money Razorpay already took is surfaced instead of a second payment");
  assert.equal(await c.controller.probeStatus(), "captured");
  assert.equal(c.requests.length, 2, "a verified capture stops further calls");
  await c.controller.start(); assert.equal(c.opened.length, 0, "a verified booking cannot open another checkout");
});


test("V2 checkout keeps success, failure and status returns in V2 without allowing open redirects", async () => {
  assert.equal(checkoutReturnUrl("BK-1", origin, "/v2/booking"), `${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-1&scope=v2`);
  assert.equal(checkoutReturnUrl("BK-1", origin, "/v20/booking"), `${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-1`);
  for (const fields of [{razorpay_payment_id:"pay_v2",razorpay_order_id:"order_v2",razorpay_signature:signature},{"error[code]":"BAD_REQUEST_ERROR"},{}]) {
    const response = await route.POST(new Request(`${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-1&scope=v2`, {method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},body:form(fields)}));
    const location = new URL(response.headers.get("location"));
    assert.equal(response.status,303);assert.equal(location.origin,origin);assert.equal(location.pathname,"/v2/booking-confirmation");assert.equal(location.searchParams.get("bookingId"),"BK-1");
    assert.equal(location.searchParams.get("payment"),fields.razorpay_payment_id?"returned":fields["error[code]"]?"failed":null);
  }
  for (const scope of ["https://attacker.example", "//attacker.example", "/v2/../../team", "v2evil"]) {
    const response=await route.GET(new Request(`${origin}${CHECKOUT_RETURN_PATH}?bookingId=BK-1&scope=${encodeURIComponent(scope)}`));
    const location=new URL(response.headers.get("location"));assert.equal(location.origin,origin);assert.equal(location.pathname,BOOKING_CONFIRMATION_PATH);
  }
});
