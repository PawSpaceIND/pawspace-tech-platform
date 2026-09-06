import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__LEAK3_DB__", "__LEAK3_ENV__");

const SENTINEL = "INTERNAL_SECRET_SCHEMA_SENTINEL";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const FUTURE_START = "2030-01-10T09:00:00.000Z";
const FUTURE_END = "2030-01-10T11:00:00.000Z";

const ROUTES = [
  "address-autocomplete","boarding-commercial","food-commercial","haptik","host-profile","launch-readiness",
  "live-price-quote","pet-passport-public","pricing-quote","provider-public-profile","public-contact","razorpay-webhook",
  "scheduling-rules","service-availability","sitting-commercial","sitting-payment-sandbox","taxi-commercial",
  "training-commercial","training-trainers","walking-commercial","whatsapp-uat-webhook",
];

const EXCLUSIONS = new Map([
  ["address-autocomplete.GET", "No D1 dependency; covered by the runtime-binding fault injection in unauthenticated-error-redaction.test.mjs"],
]);

function failingDb(state) {
  const boom = () => { state.faults += 1; throw new Error(`SQLITE_ERROR: no such column: ${SENTINEL}`); };
  const statement = () => ({ bind: () => statement(), first: async () => boom(), run: async () => boom(), all: async () => boom() });
  return { prepare: () => statement(), batch: async () => boom(), exec: async () => boom() };
}

function jsonInit(method, body, headers = {}) {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

async function hmac(secret, raw, hash="SHA-256") {
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{ name: "HMAC", hash },false,["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixtureFor(label, route, method) {
  let url = `https://pawspace.example/api/${route}`;
  let env = {};
  let init = method === "GET" ? undefined : jsonInit(method, {});

  switch (label) {
    case "boarding-commercial.POST":
      init = jsonInit(method, { packageCode: "BOARD-24H", petCount: 1, scheduledStart: FUTURE_START, scheduledEnd: FUTURE_END, paymentMode: "sandbox_deferred", cityId: "blr", zoneId: "blr-east" });
      break;
    case "food-commercial.POST":
      init = jsonInit(method, { sku: "FOOD-TEST", quantity: 1, zoneId: "blr-east", paymentMode: "sandbox_deferred", customerId: "CUS-LEAK3", petIds: ["PET-LEAK3"] });
      break;
    case "haptik.POST": {
      const secret="test-haptik-key";
      const raw=JSON.stringify({ action: "capture_lead", idempotencyKey: "LEAK3-HAPTIK", phone: "9999999999", name: "Fault Probe" });
      env = { HAPTIK_API_KEY: secret };
      init = {method,headers:{"content-type":"application/json","x-hub-signature":`sha1=${await hmac(secret,raw,"SHA-1")}`},body:raw};
      break;
    }
    case "host-profile.GET":
      url += "?providerId=PROV-LEAK3";
      break;
    case "launch-readiness.GET":
    case "launch-readiness.POST":
      init = method === "GET" ? { headers: { "oai-authenticated-user-email": "founder@pawspace.test" } } : jsonInit(method, { action: "update_gate", code: "LEAK3", status: "in_progress" }, { "oai-authenticated-user-email": "founder@pawspace.test" });
      break;
    case "live-price-quote.POST":
      init = jsonInit(method, { packageCode: "PKG-LEAK3", fallbackPrice: 1000, scheduledStart: FUTURE_START, cityId: "blr", zoneId: "blr-east", quantity: 1 });
      break;
    case "pet-passport-public.GET":
      url += "?token=share_leak3_probe";
      break;
    case "pricing-quote.POST":
      init = jsonInit(method, { packageCode: "PKG-LEAK3", scheduledStart: FUTURE_START, cityId: "blr", zoneId: "blr-east", quantity: 1 });
      break;
    case "provider-public-profile.GET":
      url += "?providerId=PROV-LEAK3";
      break;
    case "public-contact.POST":
      init = jsonInit(method, { name: "Fault Probe", phone: "9999999999", service: "Grooming" }, { "cf-connecting-ip": "203.0.113.10" });
      break;
    case "razorpay-webhook.POST": {
      const secret = "leak3-razorpay-secret";
      const raw = JSON.stringify({ event: "payment.captured", created_at: 1893456000, payload: { payment: { entity: { id: "pay_leak3", order_id: "order_leak3", amount: 10000, currency: "INR", notes: { booking_id: "BK-LEAK3" } } } } });
      env = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: secret };
      init = { method, headers: { "content-type": "application/json", "x-razorpay-signature": await hmac(secret, raw), "x-razorpay-event-id": "EVT-LEAK3" }, body: raw };
      break;
    }
    case "scheduling-rules.POST":
      init = jsonInit(method, { name: "LEAK3 fault probe", conditions: [{ type: "service", value: "grooming" }] });
      break;
    case "scheduling-rules.PATCH":
      init = jsonInit(method, { id: "rule_leak3", active: true });
      break;
    case "scheduling-rules.DELETE":
      url += "?id=rule_leak3";
      init = { method };
      break;
    case "sitting-commercial.POST":
      init = jsonInit(method, { packageCode: "SIT-4H", petCount: 1, scheduledStart: FUTURE_START, scheduledEnd: FUTURE_END, paymentMode: "sandbox_deferred", cityId: "blr", zoneId: "blr-east" });
      break;
    case "sitting-payment-sandbox.POST":
      env = { PAWSPACE_PAYMENT_ENV: "sandbox" };
      init = jsonInit(method, { quoteId: "SQ-LEAK3", amount: 1000 }, { "x-payment-capture-key": "leak3-capture-key" });
      break;
    case "taxi-commercial.POST":
      init = jsonInit(method, { routeCode: "TAXI-LOCAL", originLabel: "Indiranagar", destinationLabel: "Koramangala", petCount: 1, scheduledStart: FUTURE_START, paymentMode: "sandbox_deferred" });
      break;
    case "training-commercial.POST":
      init = jsonInit(method, { packageCode: "TRAIN-8", petCount: 1, scheduledStart: FUTURE_START, paymentMode: "sandbox_deferred" });
      break;
    case "walking-commercial.POST":
      init = jsonInit(method, { packageCode: "WALK-1", mode: "single", petCount: 1, walkCount: 1, scheduledStart: FUTURE_START, scheduledEnd: FUTURE_END, paymentMode: "pay_after_service" });
      break;
    case "whatsapp-uat-webhook.POST": {
      const secret = "leak3-whatsapp-secret";
      const raw = JSON.stringify({ type: "inbound_message", phone: "9999999999", text: "fault probe" });
      env = { PAWSPACE_WHATSAPP_ENV: "uat", PAWSPACE_WHATSAPP_UAT_WEBHOOK_SECRET: secret };
      init = { method, headers: { "content-type": "application/json", "x-pawspace-signature": await hmac(secret, raw), "x-pawspace-event-id": "EVT-LEAK3", "x-pawspace-whatsapp-provider": "sandbox_simulator" }, body: raw };
      break;
    }
  }

  return { url, env, init };
}

async function exportedHandlers() {
  const labels = [];
  for (const route of ROUTES) {
    const routeModule = await import(`../app/api/${route}/route.ts`);
    for (const method of METHODS) if (typeof routeModule[method] === "function") labels.push(`${route}.${method}`);
  }
  return labels.sort();
}

test("every consolidated route handler is covered by a fault fixture or explicit exclusion", async () => {
  const labels = await exportedHandlers();
  const unknown = [];
  for (const label of labels) {
    const [route, method] = label.split(".");
    const hasFixture = !EXCLUSIONS.has(label) && Boolean(await fixtureFor(label, route, method));
    if (!hasFixture && !EXCLUSIONS.has(label)) unknown.push(label);
  }
  assert.deepEqual(unknown, [], `handlers without a fault-path decision: ${unknown.join(", ")}`);
  for (const [label, reason] of EXCLUSIONS) {
    assert.ok(labels.includes(label), `stale exclusion: ${label}`);
    assert.ok(reason.length >= 20, `exclusion ${label} must explain why D1 fault injection is not applicable`);
  }
});

for (const route of ROUTES) {
  const routeModule = await import(`../app/api/${route}/route.ts`);
  for (const method of METHODS) {
    if (typeof routeModule[method] !== "function") continue;
    const label = `${route}.${method}`;
    if (EXCLUSIONS.has(label)) {
      test(`${label}: D1 fault-path exclusion is documented`, () => { assert.match(EXCLUSIONS.get(label), /No D1 dependency/); });
      continue;
    }

    test(`${label}: injected infrastructure fault reaches the governed boundary`, async () => {
      const state = { faults: 0 };
      globalThis.__LEAK3_DB__ = failingDb(state);
      const fixture = await fixtureFor(label, route, method);
      globalThis.__LEAK3_ENV__ = fixture.env;
      const request = new Request(fixture.url, fixture.init);
      const original = console.error;
      console.error = () => {};
      let response;
      try { response = await routeModule[method](request); } finally { console.error = original; }
      assert.ok(response instanceof Response, `${label} must answer with a Response`);
      const body = await response.text();
      assert.ok(state.faults > 0, `${label} did not reach the injected D1 failure; its fixture stopped at validation/auth instead`);
      assert.ok(response.status >= 500, `${label} reached the injected D1 failure but returned ${response.status} instead of a server failure`);
      assert.doesNotMatch(body, new RegExp(SENTINEL, "i"), `${label} leaked the injected internal sentinel`);
    });
  }
}
