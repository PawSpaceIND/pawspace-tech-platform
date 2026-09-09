import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const component = fs.readFileSync("app/mobile-app/premium-discovery-home.tsx", "utf8");
const css = fs.readFileSync("app/mobile-app/premium-discovery-home.module.css", "utf8");

const requiredClasses = [
  "home",
  "top",
  "topRow",
  "location",
  "avatar",
  "greeting",
  "search",
  "hero",
  "heroCopy",
  "offers",
  "media",
  "quickSection",
  "quickGrid",
  "upcoming",
  "care",
  "sectionHead",
  "cards",
  "card",
  "cardPhoto",
  "assurance",
  "empty",
  "bookingShortcut",
  "sheetBackdrop",
  "sheet",
  "handle",
  "deviceLocation",
  "saveLocation",
  "locationNote",
];

test("premium discovery stays on the globally assigned Option 5 Premium & Visual contract", () => {
  for (const className of requiredClasses) {
    assert.match(component, new RegExp(`styles\\.${className}\\b`), `component should use styles.${className}`);
    assert.match(css, new RegExp(`\\.${className}(?:[,{:.\\s>]|$)`), `CSS should define .${className}`);
  }
  assert.match(component, /data-home-design="option-5-premium-visual"/);
  assert.match(component, />Premium care for your loved ones</);
  assert.match(component, />Everything they need</);
  assert.match(component, /aria-label="Care services"/);
  assert.match(component, /aria-label="Quick service guides"/);
  assert.match(component, /PawSpace Media slot · service education and clearly labelled approved campaigns/);
  assert.doesNotMatch(component, /Care for every kind of day/);
  assert.doesNotMatch(component, /sponsoredOffers/);
  assert.doesNotMatch(component, /Offers carousel|carouselSlots|goToAd|adSlots/);
  assert.doesNotMatch(component, /HomeDesignSwitcher|HOME_DESIGN_STORAGE_KEY|design === "calm"/);
});
