import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");


test("UI-MEDIA-02: service media registry preserves requested breed and context mapping", async () => {
  const source = await read("app/mobile-app/service-media.ts");
  for (const phrase of [
    "Shih Tzu · Golden Retriever · Persian cat",
    "German Shepherd · Shih Tzu · Golden Retriever puppy",
    "Large dog · Puppy",
    "Big dog · Puppy · Cat-friendly home",
    "Big dog · Puppy · Cat",
    "Dog / cat in vehicle · Transit-ready setup",
    "Vehicle transfer · Transit crate workflow",
  ]) assert.ok(source.includes(phrase), `missing required visual mapping: ${phrase}`);
});


test("UI-MEDIA-04: approved Premium Design 2 personalises only after customer identity is available", async () => {
  const source = await read("app/mobile-app/premium-discovery-home.tsx");
  assert.match(source, /if \(!customerId\) return/);
  assert.match(source, /\/api\/customer-account\?customerId=/);
  assert.match(source, /pet\?\.profile\?\.photo/);
  assert.match(source, /customerName\?\.trim\(\)\.slice\(0, 1\)/);
});

test("UI-MEDIA-05: service-page curated breed chips change curated PawSpace visuals", async () => {
  const banner = await read("app/mobile-app/service-banner.tsx");
  assert.match(banner, /breedOptions\.map/);
  assert.match(banner, /setVisualSelection\(\{ service, index \}\)/);
  assert.match(banner, /aria-pressed=\{index === safeVisualIndex\}/);
  assert.match(banner, /styles\.breedChipActive/);
});
