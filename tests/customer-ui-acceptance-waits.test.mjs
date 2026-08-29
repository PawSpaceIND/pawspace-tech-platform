import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/customer-ui-acceptance-v2.mjs", import.meta.url), "utf8");

test("customer acceptance waits for the asynchronous mobile shell before probing navigation", () => {
  assert.match(source, /async function bottomNav\(page\)/);
  assert.match(source, /await nav\.waitFor\(\{state:"visible",timeout:TIMEOUT\}\)/);
  assert.match(source, /page\.locator\("nav"\)/);
});

test("customer acceptance waits for OTP verification to replace the login UI", () => {
  assert.match(source, /codeInput\.waitFor\(\{state:"hidden",timeout:TIMEOUT\}\)/);
  assert.doesNotMatch(source, /Verify & continue"\}\)\.click\(\);await wait\(page,550\)/);
});

test("customer acceptance scopes service-card checks to the labelled discovery region", () => {
  assert.match(source, /page\.getByRole\("region",\{name:"Care services"\}\)/);
  assert.doesNotMatch(source, /filter\(\{hasText:"Care for every kind of day"\}\)/);
});
