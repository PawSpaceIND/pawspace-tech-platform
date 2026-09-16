import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("V2 grooming checkout composes existing governed booking and payment authorities", async () => {
  const client = await read("lib/v2/grooming-checkout-client.ts");
  assert.match(client, /stableBookingInputKey/);
  assert.match(client, /reserveUatSchedule/);
  assert.match(client, /createCanonicalLifecycle/);
  assert.match(client, /CustomerCheckoutController/);
  assert.match(client, /\/api\/grooming-service-location/);
  assert.doesNotMatch(client, /fetch\([^\n]*razorpay/i);
});

test("V2 grooming creates a payment-pending canonical booking before checkout", async () => {
  const client = await read("lib/v2/grooming-checkout-client.ts");
  const reserve = client.indexOf("await reserveUatSchedule");
  const canonical = client.indexOf("await createCanonicalLifecycle");
  const location = client.indexOf("/api/grooming-service-location");
  assert.ok(reserve >= 0 && canonical > reserve, "schedule reservation must precede canonical booking creation");
  assert.ok(location > canonical, "governed service location must be persisted after the canonical booking exists");
  assert.match(client, /mode:\s*"prepaid"/);
  assert.match(client, /status:\s*"created"/);
  assert.match(client, /canonical\.status !== "payment_pending"/);
});

test("V2 grooming UI shows success only from CustomerCheckoutController confirmation", async () => {
  const page = await read("app/v2/grooming/page.tsx");
  assert.match(page, /checkoutState\.phase === "captured" && checkoutState\.confirmation/);
  assert.match(page, /Verify-first payment/);
  assert.match(page, /createV2GroomingCheckoutController/);
  assert.doesNotMatch(page, /razorpay_payment_id/);
  assert.doesNotMatch(page, /status:\s*["']captured["']/);
});
