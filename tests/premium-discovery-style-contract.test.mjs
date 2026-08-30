import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const component = fs.readFileSync("app/mobile-app/premium-discovery-home.tsx", "utf8");
const css = fs.readFileSync("app/mobile-app/premium-discovery-home.module.css", "utf8");

const requiredClasses = [
  "home",
  "topShell",
  "brandRow",
  "brandLogo",
  "profile",
  "location",
  "pin",
  "search",
  "hero",
  "heroCopy",
  "heroPaw",
  "servicesSection",
  "sectionHead",
  "serviceGrid",
  "serviceCard",
  "serviceVisual",
  "serviceIcon",
  "empty",
  "reminder",
  "reminderCopy",
  "reminderPaw",
  "trustStrip",
  "moreRail",
  "bookingShortcut",
  "sheetBackdrop",
  "sheet",
  "handle",
  "deviceLocation",
  "saveLocation",
  "locationNote",
];

test("premium discovery stays on the approved rebuilt Home style contract", () => {
  for (const className of requiredClasses) {
    assert.match(component, new RegExp(`styles\\.${className}\\b`), `component should use styles.${className}`);
    assert.match(css, new RegExp(`\\.${className}(?:[,{:.\\s>]|$)`), `CSS should define .${className}`);
  }
  assert.match(component, />Everything they need</);
  assert.match(component, /aria-label="Care services"/);
  assert.match(component, /aria-label="Quick service guides"/);
  assert.doesNotMatch(component, /Care for every kind of day/);
  assert.doesNotMatch(component, /sponsoredOffers/);
});
