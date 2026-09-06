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

test("approved premium Home exposes stable labelled discovery regions", () => {
  assert.match(discoverySource, /aria-label="Care services"/);
  assert.match(discoverySource, /aria-label="Quick service guides"/);
  assert.match(discoverySource, />Everything they need</);
  assert.match(discoverySource, /data-home-design="option-5-premium-visual"/);
  assert.match(discoverySource, />Premium care for your loved ones</);
  assert.doesNotMatch(discoverySource, /Care for every kind of day/);
  assert.doesNotMatch(discoverySource, /Offers carousel/);
});

test("customer acceptance uses a longer server timeout for provider and quote readiness", () => {
  assert.match(source, /const SERVER_TIMEOUT=Number\(readArg\("server-timeout","60000"\)\)/);
  assert.match(source, /async function ready\(page,button,label,timeout=TIMEOUT\)/);
  assert.match(source, /button\.click\(\{trial:true,timeout\}\)/);
  assert.doesNotMatch(source, /waitForTimeout\((900|1000|1100)\)/);
});

test("customer acceptance preserves auto-selected pets before toggling selection", () => {
  assert.match(source, /async function ensurePetProgress\(page,continueButton,label\)/);
  assert.match(source, /continueButton\.click\(\{trial:true,timeout:1200\}\)/);
  assert.match(source, /const petButton=\(page\)=>page\.getByRole\("button"/);
  assert.doesNotMatch(source, /page\.getByText\(PET,\{exact:true\}\)\.first\(\)\.click\(\)/);
});

test("customer acceptance observes async final mutations through the server timeout", () => {
  assert.match(source, /async function observeFinal\(page,button,target,safePosts=\[\],timeout=SERVER_TIMEOUT\)/);
  assert.match(source, /const deadline=Date\.now\(\)\+timeout/);
  assert.match(source, /while\(!seen\.length&&!unexpected\.length&&Date\.now\(\)<deadline\)await page\.waitForTimeout\(100\)/);
});

test("customer acceptance uses the governed east-zone UAT location for Training", () => {
  assert.match(source, /PIN="560038"/);
  assert.match(source, /ADDRESS="12 Acceptance Road, Indiranagar, Bengaluru"/);
  assert.doesNotMatch(source, /PIN="560034"/);
});

test("customer acceptance accepts the current Boarding empty-selection CTA", () => {
  assert.match(source, /name:\/Continue with\|Choose an available host\/i/);
});

test("customer acceptance allows the governed Boarding/Sitting re-quote before the final scheduling mutation", () => {
  // The Boarding confirm handler re-quotes POST /api/boarding-commercial for price
  // integrity immediately before POST /api/uat-scheduling. observeFinal must classify
  // that governed re-quote as a permitted precursor (as it already does for
  // training/walking/taxi -commercial quotes) rather than an unexpected commit, while
  // still requiring the final scheduling mutation to be attempted.
  assert.match(source, /safePosts=\[\]/); // observeFinal still defaults to no allowance
  assert.match(source, /\[\/POST \\\/api\\\/\(boarding\|sitting\)-commercial\//);
  // The final scheduling mutation remains the required target for both stays.
  assert.match(source, /request final partner approval/);
  assert.match(source, /POST \\\/api\\\/uat-scheduling/);
});

test("customer acceptance follows current Fresh Food stages and delivery field", () => {
  assert.match(source, /"One-time or repeat\?"/);
  assert.match(source, /"Where and when\?"/);
  assert.match(source, /getByLabel\("Delivery address"\)/);
  assert.match(source, /async function transition\(page,button,marker,label,timeout=TIMEOUT\)/);
});
