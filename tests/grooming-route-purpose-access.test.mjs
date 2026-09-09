import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../app/api/grooming-route/route.ts", import.meta.url), "utf8");
const webhook = readFileSync(new URL("../app/api/razorpay-webhook/route.ts", import.meta.url), "utf8");

test("grooming-route imports purpose-based access instead of only a hard-coded travel set", () => {
  assert.match(route, /from"\.\.\/\.\.\/\.\.\/lib\/purpose-based-access"/);
  assert.match(route, /resolveDataAccessPolicy/);
  assert.match(route, /decideCustomerDataAccess/);
  assert.match(route, /purpose:"service_delivery"/);
  assert.match(route, /addressPrecision/);
});

test("grooming-route does not return destinationAddress without policy projection", () => {
  assert.match(route, /destinationAddress:disclosure\.destinationAddress/);
  assert.doesNotMatch(route, /destinationAddress:destination,/);
});

test("razorpay webhook bounds the body before signature verification", () => {
  assert.match(webhook, /readBoundedRequestText/);
  assert.match(webhook, /MAX_WEBHOOK_BYTES/);
  assert.match(webhook, /413/);
});
