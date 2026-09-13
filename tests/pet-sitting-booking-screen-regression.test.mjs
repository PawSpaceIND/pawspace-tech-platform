import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Pet Sitting page keeps selected mode and booking mode synchronized", async () => {
  const page = await read("app/mobile-app/stay-booking-page.tsx");
  assert.match(page, /key=\{`\$\{selectedMode\}:\$\{account\.customerId\}`\}/);
  assert.match(page, /mode=\{selectedMode\}/);
  assert.doesNotMatch(page, /key=\{`\$\{mode\}:\$\{account\.customerId\}`\} mode=\{mode\}/);
});

test("Pet Sitting exposes all four booking stages and guarded transitions", async () => {
  const flow = await read("app/mobile-app/stay-flow.tsx");
  for (const stage of [1, 2, 3, 4]) assert.match(flow, new RegExp(`stage === ${stage}`));
  assert.match(flow, /canPlanStay\(\{datesValid,petCount:selectedPets\.length,serviceAvailable:serviceLocation\?\.zone\.serviceAvailable\}\)/);
  assert.match(flow, /disabled=\{!showCaregiver\}/);
  assert.match(flow, /Review protected booking/);
  assert.match(flow, /disabled=\{!agreed \|\| !datesValid \|\| scheduling \|\| selectedPets\.length === 0 \|\| !serviceLocation \|\| \(mode === "sitting" && !sittingQuote\)\}/);
});

test("Pet Sitting uses live sitter availability and a canonical quote before booking", async () => {
  const flow = await read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /previewSitters\(/);
  assert.match(flow, /serviceCode:"pet_sitting"/);
  assert.match(flow, /createSittingQuote\(/);
  assert.match(flow, /createCanonicalSittingBooking\(/);
  assert.match(flow, /preferredProviderId:mode==="boarding"\?governedHost\?\.providerId:selectedSitter\?\.providerId/);
});
