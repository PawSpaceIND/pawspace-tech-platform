import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("V2 grooming stays isolated from the legacy customer flow", async () => {
  const page = await read("app/v2/grooming/page.tsx");
  assert.doesNotMatch(page, /mobile-app\/grooming-flow/);
  assert.doesNotMatch(page, /grooming-flow\.module\.css/);
  assert.match(page, /loadV2GroomingCatalogue/);
  assert.match(page, /resolveV2GroomingCoverage/);
  assert.match(page, /quoteV2Grooming/);
  assert.match(page, /previewV2Groomers/);
  assert.match(page, /Nothing reserved yet/);
});

test("V2 grooming catalogue is server-owned and fail-closed", async () => {
  const route = await read("app/api/v2/grooming-catalogue/route.ts");
  assert.match(route, /service_code='grooming' AND active=1/);
  assert.match(route, /ensurePricingControlRuntime/);
  assert.doesNotMatch(route, /fallbackPrice/);
  assert.match(route, /customer cannot select it here/i);
});

test("V2 grooming client keeps pricing and scheduling behind governed APIs", async () => {
  const client = await read("lib/v2/grooming-client.ts");
  assert.match(client, /\/api\/v2\/grooming-catalogue/);
  assert.match(client, /\/api\/live-price-quote/);
  assert.match(client, /resolveServiceCoverage/);
  assert.match(client, /previewUatProviders/);
  assert.doesNotMatch(client, /canonical-bookings/);
  assert.doesNotMatch(client, /razorpay/i);
});
