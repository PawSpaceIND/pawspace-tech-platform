import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const component = fs.readFileSync("app/mobile-app/premium-discovery-home.tsx", "utf8");
const css = fs.readFileSync("app/mobile-app/premium-discovery-home.module.css", "utf8");

const requiredClasses = [
  "header",
  "location",
  "brandLogo",
  "pin",
  "profile",
  "hero",
  "pawMark",
  "search",
  "adWhisper",
  "sponsored",
  "offerImage",
  "offerShade",
  "offerCopy",
  "offerDots",
  "selectedOffer",
  "quick",
  "sectionHead",
  "grid",
  "serviceCard",
  "imageWash",
  "videoSection",
  "videoRail",
  "videoCard",
  "videoWash",
  "community",
  "communityRail",
  "featured",
  "trust",
  "sheetBackdrop",
  "videoSheet",
  "sheet",
  "handle",
  "deviceLocation",
  "saveLocation",
  "locationNote",
];

test("premium discovery component and CSS module stay on the same style contract", () => {
  for (const className of requiredClasses) {
    assert.match(component, new RegExp(`styles\\.${className}\\b`), `component should use styles.${className}`);
    assert.match(css, new RegExp(`\\.${className}(?:[,{:.\\s>]|$)`), `CSS should define .${className}`);
  }
});
