import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("UI-MEDIA-01: premium home has an accessible auto-scrolling promotion carousel", async () => {
  const source = await read("app/mobile-app/premium-discovery-home.tsx");
  const styles = await read("app/mobile-app/premium-discovery-home.module.css");
  assert.match(source, /window\.setInterval\(\(\) => goToAd\(activeAd \+ 1\), 4800\)/);
  assert.match(styles, /scroll-snap-type:x mandatory/);
  assert.match(source, /aria-label="Previous promotion"/);
  assert.match(source, /aria-label="Next promotion"/);
  assert.match(source, /prefers-reduced-motion: reduce/);
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

test("UI-MEDIA-03: every non-funeral service owns an HD video slot without fabricating footage", async () => {
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
  assert.match(banner, /<video controls autoPlay playsInline/);
  assert.doesNotMatch(registry, /funeral.*videoFile/i);
});
