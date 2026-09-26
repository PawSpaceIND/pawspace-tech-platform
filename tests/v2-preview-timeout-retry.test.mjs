/**
 * Staging testers saw "Checking availability is taking longer than usual" on about one check in thirty: the server
 * stops at its 20 s deadline with 503 SCHEDULING_PREVIEW_TIMEOUT and Retry-After, and the page gave up. The client
 * now waits the Retry-After and checks once more inside the same one-minute limit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__V2_PREVIEW_RETRY_DB__", "__V2_PREVIEW_RETRY_ENV__");
const { previewUatProviders } = await import("../lib/uat-scheduling-client.ts");

const request = { clientRequestId: "retry", customerId: "C1", petIds: ["PET-1"], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east",
  scheduledStart: "2026-10-01T05:30:00.000Z", scheduledEnd: "2026-10-01T07:30:00.000Z", serviceAddress: "12, 100 Feet Road, Indiranagar", servicePincode: "560038" };
const TIMEOUT = { error: "Checking availability is taking longer than usual. Please try again in a moment.", code: "SCHEDULING_PREVIEW_TIMEOUT", retryAfterSeconds: 1 };
const GROOMERS = { data: { providers: [{ id: "PRV1", name: "Care Professional", model: "full_time" }] } };

function scripted(...replies) {
  const calls = [];
  const fetch = async (_url, options) => { calls.push(options); const [status, body] = replies[Math.min(calls.length - 1, replies.length - 1)]; return Response.json(body, { status }); };
  return { calls, fetch };
}

test("a server deadline 503 is retried once after Retry-After and returns the groomers", async t => {
  const { calls, fetch } = scripted([503, TIMEOUT], [200, GROOMERS]);
  t.mock.method(globalThis, "fetch", fetch);
  const started = Date.now();
  const preview = await previewUatProviders(request);
  assert.equal(preview.providers.length, 1);
  assert.equal(calls.length, 2, "one automatic retry");
  assert.ok(Date.now() - started >= 900, "the retry waits for Retry-After");
});

test("a second deadline 503 is shown to the customer, not retried again", async t => {
  const { calls, fetch } = scripted([503, TIMEOUT], [503, TIMEOUT]);
  t.mock.method(globalThis, "fetch", fetch);
  await assert.rejects(previewUatProviders(request), /taking longer than usual/);
  assert.equal(calls.length, 2);
});

test("other refusals are not retried", async t => {
  const { calls, fetch } = scripted([503, { error: "Scheduling is unavailable" }], [200, GROOMERS]);
  t.mock.method(globalThis, "fetch", fetch);
  await assert.rejects(previewUatProviders(request), /Scheduling is unavailable/);
  assert.equal(calls.length, 1);
});
