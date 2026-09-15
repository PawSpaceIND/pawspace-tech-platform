import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../e2e/visual-uat-sweep.spec.ts", import.meta.url), "utf8");

test("live visual UAT sweep keeps enough budget for the final Razorpay sandbox gate", () => {
  assert.match(source, /test\.setTimeout\(360_000\)/);
  assert.match(source, /razorpay-checkout-frame/);
  assert.match(source, /timeout:\s*30_000/);
});
