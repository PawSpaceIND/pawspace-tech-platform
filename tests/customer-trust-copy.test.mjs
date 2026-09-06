import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const home = fs.readFileSync("app/page.tsx", "utf8");
const banner = fs.readFileSync("app/mobile-app/service-banner.tsx", "utf8");

test("customer home does not publish ungrounded review or customer-count claims", () => {
  assert.doesNotMatch(home, /2,000\+ Google reviews/);
  assert.doesNotMatch(home, /50,000\+ pet parents/);
  assert.doesNotMatch(home, /1,248 services|4 years with PawSpace/);
});

test("shared customer banner avoids universal guarantees that readiness cannot prove", () => {
  for (const claim of [
    "Verified & background-checked",
    "GST invoice on every order",
    "100% refund policy",
    "India's most caring pet app",
    "Background-verified groomers",
    "GPS-logged routes",
    "crate-secured",
    "vet-formulated",
  ]) assert.equal(banner.includes(claim), false, claim);
  assert.match(banner, /Verification status shown explicitly/);
  assert.match(banner, /Cancellation terms shown per service/);
});
