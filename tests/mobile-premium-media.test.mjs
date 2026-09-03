import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("UI-MEDIA-01: customer home keeps the approved Premium Design 2 composition", async () => {
  const source = await read("app/mobile-app/premium-discovery-home.tsx");
  const styles = await read("app/mobile-app/premium-discovery-home.module.css");
  assert.match(source, /What does <em>\{pet\?\.name \|\| "your pet"\}<\/em> need today\?/);
  assert.match(source, />Everything they need</);
  assert.match(source, /className=\{styles\.serviceGrid\}/);
  assert.match(source, /className=\{styles\.reminder\}/);
  assert.match(source, /aria-label="PawSpace trust standards"/);
  assert.match(source, /aria-label="Quick service guides"/);
  assert.match(styles, /grid-template-columns:repeat\(3,1fr\)/);
  assert.doesNotMatch(source, /Offers carousel|carouselSlots|goToAd|adSlots/);
});

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

test("UI-MEDIA-03: every non-funeral service owns a guarded silent HD video slot without fabricating footage", async () => {
  const registry = await read("app/mobile-app/service-media.ts");
  const banner = await read("app/mobile-app/service-banner.tsx");
  for (const file of [
    "grooming-doorstep.mp4",
    "training-doorstep.mp4",
    "boarding-home-stay.mp4",
    "pet-sitting-home-visit.mp4",
    "dog-walking-doorstep.mp4",
    "pet-taxi-pickup.mp4",
    "fresh-food-delivery.mp4",
    "pet-relocation-transit.mp4",
  ]) assert.ok(registry.includes(file), `missing video slot: ${file}`);
  assert.match(registry, /NEXT_PUBLIC_PAWSPACE_SERVICE_VIDEO_BASE/);
  assert.match(banner, /<video muted autoPlay loop playsInline/);
  assert.match(banner, /IntersectionObserver/);
  assert.match(banner, /visibilitychange/);
  assert.match(banner, /prefers-reduced-motion: reduce/);
  assert.match(banner, /Premium poster fallback/);
  assert.doesNotMatch(registry, /funeral.*videoFile/i);
});

test("UI-MEDIA-04: approved Premium Design 2 personalises only after customer identity is available", async () => {
  const source = await read("app/mobile-app/premium-discovery-home.tsx");
  assert.match(source, /if \(!customerId\) return/);
  assert.match(source, /\/api\/customer-account\?customerId=/);
  assert.match(source, /pet\?\.profile\?\.photo/);
  assert.match(source, /pet\?\.name \|\| "your pet"/);
});

test("UI-MEDIA-05: service-page curated breed chips change curated PawSpace visuals", async () => {
  const banner = await read("app/mobile-app/service-banner.tsx");
  assert.match(banner, /breedOptions\.map/);
  assert.match(banner, /setVisualSelection\(\{ service, index \}\)/);
  assert.match(banner, /aria-pressed=\{index === safeVisualIndex\}/);
  assert.match(banner, /styles\.breedChipActive/);
});
