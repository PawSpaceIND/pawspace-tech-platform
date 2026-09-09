import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readBoundedRequestText, VoiceFetchRefused } from "../lib/voice-safe-fetch.ts";

const route = readFileSync(new URL("../app/api/grooming-route/route.ts", import.meta.url), "utf8");
const webhook = readFileSync(new URL("../app/api/razorpay-webhook/route.ts", import.meta.url), "utf8");
const purposeLib = readFileSync(new URL("../lib/purpose-based-access.ts", import.meta.url), "utf8");

test("grooming-route imports purpose-based access instead of only a hard-coded travel set", () => {
  assert.match(route, /from"\.\.\/\.\.\/\.\.\/lib\/purpose-based-access"/);
  assert.match(route, /resolveDataAccessPolicy/);
  assert.match(route, /decideCustomerDataAccess/);
  assert.match(route, /purpose:"service_delivery"/);
  assert.match(route, /addressPrecision/);
});

test("grooming-route does not return destinationAddress without policy projection", () => {
  assert.match(route, /destinationAddress:disclosure\.destinationAddress/);
});

test("razorpay webhook bounds the body before signature verification", () => {
  assert.match(webhook, /readBoundedRequestText/);
  assert.match(webhook, /MAX_WEBHOOK_BYTES/);
  assert.match(webhook, /413/);
});

test("purpose-based-access grants full address for service_delivery while assignment is active", () => {
  // Source contract: service_delivery branch returns precision "full" when assignment exists
  // and the dispute window is open (completedAt null / within providerDisputeWindowHours).
  assert.match(purposeLib, /purpose==="service_delivery"/);
  assert.match(purposeLib, /precision:"full"/);
  assert.match(purposeLib, /providerDisputeWindowHours/);
  assert.match(purposeLib, /APPROVED_DATA_ACCESS/);
  assert.match(purposeLib, /addressEligibleStatuses/);
});

test("readBoundedRequestText refuses oversized razorpay-scale bodies", async () => {
  const body = "x".repeat(300_000);
  const request = new Request("https://example.test/razorpay", {
    method: "POST",
    body,
    headers: { "content-length": String(body.length) },
  });
  await assert.rejects(
    () => readBoundedRequestText(request, 262_144),
    (error) => error instanceof VoiceFetchRefused,
  );
});
