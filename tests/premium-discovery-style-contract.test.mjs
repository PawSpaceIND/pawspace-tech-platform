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
  "welcomeHero",
  "personalHero",
  "offers",
  "media",
  "upcoming",
  "care",
  "sectionHead",
  "cards",
  "card",
  "cardPhoto",
  "trustRow",
  "empty",
  "bookingShortcut",
  "sheet",
  "saveLocation",
  "locationNote",
];

test("premium discovery stays on the globally assigned prototype-converged contract", () => {
  for (const className of requiredClasses) {
    assert.match(component, new RegExp(`styles\\.${className}\\b`), `component should use styles.${className}`);
    assert.match(css, new RegExp(`\\.${className}(?:[,{:.\\s>]|$)`), `CSS should define .${className}`);
  }
  assert.match(component, /data-home-design="pawspace-prototype-converged"/);
  assert.match(component, />Welcome to your/);
  assert.match(component, />Care for every little need</);
  assert.match(component, /aria-label="Care services"/);
  assert.match(component, /aria-label="Care services"/);
  assert.match(component, /Care guide · PawSpace/);
  assert.doesNotMatch(component, /Care for every kind of day/);
  assert.doesNotMatch(component, /sponsoredOffers/);
  assert.doesNotMatch(component, /Offers carousel|carouselSlots|goToAd|adSlots/);
  assert.doesNotMatch(component, /HomeDesignSwitcher|HOME_DESIGN_STORAGE_KEY|design === "calm"/);
});
