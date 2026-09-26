/**
 * On staging, a grooming availability check took 16-30 s and verifying a real Razorpay capture took over
 * 15 s. The browser gave up at 15 s in both places, so no V2 grooming booking could reach checkout and a
 * paid customer could be told verification was "delayed". These cases hold a real request open past the
 * old limit with mocked timers and require the client to keep waiting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__V2_LATENCY_DB__", "__V2_LATENCY_ENV__");
const { previewUatProviders } = await import("../lib/uat-scheduling-client.ts");
const { CustomerCheckoutController } = await import("../lib/customer-checkout-client.ts");

const request = { clientRequestId: "latency", customerId: "C1", petIds: ["PET-1"], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east",
  scheduledStart: "2026-10-01T05:30:00.000Z", scheduledEnd: "2026-10-01T07:30:00.000Z", serviceAddress: "12, 100 Feet Road, Indiranagar", servicePincode: "560038" };

function heldFetch() {
  const held = {};
  const fetch = (_url, options) => new Promise((resolve, reject) => {
    held.signal = options.signal;
    held.resolve = body => resolve(Response.json(body));
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  return { held, fetch };
}

test("a 20 s availability check on staging still returns groomers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { held, fetch } = heldFetch();
  t.mock.method(globalThis, "fetch", fetch);
  const pending = previewUatProviders(request);
  t.mock.timers.tick(20_000);
  assert.equal(held.signal.aborted, false, "the search must not be cut off at the old 15 s limit");
  held.resolve({ data: { providers: [{ id: "PRV1", name: "Care Professional", model: "full_time" }] } });
  assert.equal((await pending).providers.length, 1);
});

test("an availability check still gives up after a minute", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { fetch } = heldFetch();
  t.mock.method(globalThis, "fetch", fetch);
  const pending = previewUatProviders(request);
  t.mock.timers.tick(60_001);
  await assert.rejects(pending, /timed out/);
});

test("a payment status check that takes 20 s is waited for, not reported as delayed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { held, fetch } = heldFetch();
  const states = [];
  const controller = new CustomerCheckoutController("B1", state => states.push(state), { fetch, open: async () => { throw new Error("checkout must not open"); } });
  const probe = controller.probeStatus();
  t.mock.timers.tick(20_000);
  assert.equal(held.signal.aborted, false, "status verification must outlast the old 15 s limit");
  held.resolve({ data: { bookingId: "B1", environment: "sandbox", status: "created" } });
  await probe;
  assert.ok(!states.some(state => /delayed/i.test(String(state.message || ""))));
});
