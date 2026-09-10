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
  "personalHero",
  "welcomeHero",
  "welcomePhoto",
  "trustRow",
  "offers",
  "media",
  "upcoming",
  "care",
  "sectionHead",
  "cards",
  "card",
  "cardPhoto",
  "empty",
  "bookingShortcut",
  "sheet",
  "sheetHead",
];

test("reviewed unified discovery source and CSS use the same presentation contract", () => {
  for (const className of requiredClasses) {
    assert.match(component, new RegExp(`styles\\.${className}\\b`), `component should use styles.${className}`);
    assert.match(css, new RegExp(`\\.${className}(?:[,{:.\\s>]|$)`), `CSS should define .${className}`);
  }
  assert.match(component, /data-home-design="pawspace-prototype-converged"/);
  assert.match(component, /Welcome to your/);
  assert.match(component, /Petter half/);
  assert.doesNotMatch(component, /data-home-design="option-5-premium-visual"/);
  assert.match(component, />Care for every little need</);
  assert.match(component, /aria-label="Care services"/);
  assert.match(component, /SERVICE_ART\[service\.serviceCode\]\?\.image/);
  assert.doesNotMatch(
    component,
    /SERVICE_ART\[service\.serviceCode\]\?\.image[^>]*loading="lazy"/,
    "service art hidden by Professional mode must be preloaded so switching to Cartoon never reveals blank cards",
  );
  assert.match(component, /aria-label="Care with confidence"/);
  assert.match(component, /PawSpace Media slot · service education and clearly labelled approved campaigns/);
  assert.doesNotMatch(component, /Care for every kind of day/);
  assert.doesNotMatch(component, /sponsoredOffers/);
  assert.doesNotMatch(component, /Offers carousel|carouselSlots|goToAd|adSlots/);
  assert.doesNotMatch(component, /HomeDesignSwitcher|HOME_DESIGN_STORAGE_KEY|design === "calm"/);
});
