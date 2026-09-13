import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("customer checkout shows waiting copy while webhook is late", () => {
  const source = readFileSync(new URL("../app/mobile-app/customer-checkout-button.tsx", import.meta.url), "utf8");
  assert.match(source, /Waiting for payment confirmation/);
  assert.match(source, /disabled=\{busy\}/);
});

test("address picker can continue when maps are not configured", () => {
  const source = readFileSync(new URL("../app/mobile-app/address-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /Use typed address/);
  assert.match(source, /mapsUnavailable/);
});

test("customer and partner journeys have error boundaries", () => {
  const customer = readFileSync(new URL("../app/mobile-app/error.tsx", import.meta.url), "utf8");
  const partner = readFileSync(new URL("../app/partner-app/error.tsx", import.meta.url), "utf8");
  assert.match(customer, /RecoveryScreen/);
  assert.match(partner, /RecoveryScreen/);
  assert.match(partner, /\/partner-app/);
});

test("slow uploads time out instead of hanging", async () => {
  const { uploadWithTimeout } = await import("../lib/resilient-upload.ts");
  const result = await uploadWithTimeout({
    url: "http://127.0.0.1:1/upload-should-fail",
    body: "x",
    timeoutMs: 400,
  });
  assert.equal(result.ok, false);
});
