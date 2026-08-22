import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const nextConfig = fs.readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const overrides = fs.readFileSync(new URL("../app/review-overrides.css", import.meta.url), "utf8");
const reviewUx = fs.readFileSync(new URL("../app/components/review-ux-fixes.tsx", import.meta.url), "utf8");

function ruleBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

function groupedRuleBlock(css, selectors) {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(rulePattern)) {
    const selectorList = match[1];
    if (selectors.every((selector) => selectorList.includes(selector))) return match[2];
  }
  assert.fail(`missing grouped CSS rule containing ${selectors.join(", ")}`);
}

function assertRouteToggle(marker, conditionPattern) {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(reviewUx, new RegExp(`classList\\.toggle\\("${escapedMarker}"\\s*,\\s*${conditionPattern}\\)`));
}

test("Worker image delivery bypasses the broken runtime optimizer path", () => {
  assert.match(nextConfig, /images:\s*\{[\s\S]*unoptimized:\s*true/);
});

test("review route families receive responsive shrink guards", () => {
  assertRouteToggle("route-team", "isTeam");
  assertRouteToggle("route-partner", "isPartner");
  assertRouteToggle("route-customer", "isCustomer");
  assertRouteToggle("route-mobile-app", "isMobileApp");
  assert.match(reviewUx, /const isCustomer = !isMobileApp/);

  const routeShrink = groupedRuleBlock(overrides, [".route-team main,", ".route-partner main,", ".route-customer main,"]);
  assert.match(routeShrink, /min-width:\s*0/);
  const phoneGrid = groupedRuleBlock(overrides, [
    '.route-team main [style*="grid-template-columns"],',
    '.route-partner main [style*="grid-template-columns"],',
    '.route-customer main [style*="grid-template-columns"]',
  ]);
  assert.match(phoneGrid, /grid-template-columns:\s*1fr !important/);
  const phoneFlex = groupedRuleBlock(overrides, [
    '.route-team main [style*="display: flex"],',
    '.route-partner main [style*="display: flex"],',
    '.route-customer main [style*="display: flex"]',
  ]);
  assert.match(phoneFlex, /flex-wrap:\s*wrap !important/);
  const teamInlineMin = ruleBlock(overrides, '.route-team main select[style*="min-width"]');
  assert.match(teamInlineMin, /min-width:\s*0 !important/);
  assert.doesNotMatch(overrides, /body:not\(\.route-mobile-app\)\s+main/);
  assert.doesNotMatch(overrides, /\.route-team main table\s*\{[^}]*display:\s*block/ims);
});

test("phone control navigation wraps instead of placing controls outside the viewport", () => {
  const shell = ruleBlock(overrides, '.route-control [class*="control_shell"]');
  assert.match(shell, /grid-template-columns:\s*280px 1fr/);
  const phoneShellMatches = [...overrides.matchAll(/\.route-control \[class\*="control_shell"\]\s*\{([^}]*)\}/g)];
  assert.ok(phoneShellMatches.some((match) => /grid-template-columns:\s*1fr !important/.test(match[1])), "missing phone control shell override");
  const phoneNav = ruleBlock(overrides, '.route-control [class*="control_side"] nav');
  assert.match(phoneNav, /flex-wrap:\s*wrap !important/);
});

test("responsive remediation does not hide page overflow to game the release gate", () => {
  const globalRule = /(?:^|\})(\s*(?:html|body|main)(?:\s*,\s*(?:html|body|main))*)\s*\{([^}]*)\}/gims;
  for (const match of overrides.matchAll(globalRule)) {
    assert.doesNotMatch(match[2], /overflow-x\s*:\s*hidden/i);
    assert.doesNotMatch(match[2], /(?:^|;)\s*overflow\s*:\s*hidden(?:\s|;|$)/i);
  }
});
