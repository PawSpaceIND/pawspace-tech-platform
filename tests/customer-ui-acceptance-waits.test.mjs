import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/customer-ui-acceptance-v2.mjs", import.meta.url), "utf8");
const discoverySource = fs.readFileSync(new URL("../app/mobile-app/premium-discovery-home.tsx", import.meta.url), "utf8");

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

test("customer acceptance scopes video-guide counts to their labelled region", () => {
  assert.match(discoverySource, /aria-label="Service video guides"/);
  assert.match(source, /getByRole\("region",\{name:"Service video guides"\}\)/);
  assert.doesNotMatch(source, /filter\(\{hasText:"Watch before you book"\}\)/);
});

test("customer acceptance waits for async controls instead of using fixed quote delays", () => {
  assert.match(source, /async function ready\(page,button,label\)/);
  assert.match(source, /button\.click\(\{trial:true,timeout:TIMEOUT\}\)/);
  assert.doesNotMatch(source, /waitForTimeout\((900|1000)\)/);
});

test("customer acceptance waits for pets and selects a pet button", () => {
  assert.match(source, /async function petsReady\(page\)/);
  assert.match(source, /const petButton=\(page\)=>page\.getByRole\("button"/);
  assert.match(source, /async function selectPet\(page\)/);
  assert.match(source, /getAttribute\("aria-pressed"\)==="true"/);
  assert.doesNotMatch(source, /page\.getByText\(PET,\{exact:true\}\)\.first\(\)\.click\(\)/);
});

test("customer acceptance observes async final mutations for the full timeout", () => {
  assert.match(source, /Promise\.race\(\[observed,page\.waitForTimeout\(TIMEOUT\)\]\)/);
  assert.doesNotMatch(source, /page\.waitForTimeout\(1100\)/);
});

test("customer acceptance allows for isolated Worker cold starts", () => {
  assert.match(source, /readArg\("timeout","45000"\)/);
});

test("food acceptance targets the accessible address label used after UX enhancement", () => {
  assert.match(source, /getByLabel\("Delivery address",\{exact:true\}\)/);
  assert.doesNotMatch(source, /getByPlaceholder\("House, street, area"\)/);
});
