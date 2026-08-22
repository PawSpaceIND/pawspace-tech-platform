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
  for (const selector of selectors) {
    const index = css.indexOf(selector);
    if (index < 0) continue;
    const open = css.indexOf("{", index);
    const close = css.indexOf("}", open + 1);
    if (open >= 0 && close > open) return css.slice(open + 1, close);
  }
  assert.fail(`missing grouped CSS rule containing ${selectors.join(", ")}`);
}

test("Worker image delivery bypasses the broken runtime optimizer path", () => {
  assert.match(nextConfig, /images:\s*\{[\s\S]*unoptimized:\s*true/);
});

test("review route families receive responsive shrink guards", () => {
  for (const marker of ["route-team", "route-partner", "route-customer"]) assert.match(reviewUx, new RegExp(marker));
  const routeShrink = groupedRuleBlock(overrides, [".route-team main,", ".route-partner main,", ".route-customer main,"]);
  assert.match(routeShrink, /min-width:\s*0/);
  const phoneGrid = ruleBlock(overrides, 'body:not(.route-mobile-app) main [style*="grid-template-columns"]');
  assert.match(phoneGrid, /grid-template-columns:\s*1fr !important/);
  const phoneFlex = ruleBlock(overrides, 'body:not(.route-mobile-app) main [style*="display: flex"]');
  assert.match(phoneFlex, /flex-wrap:\s*wrap !important/);
  const teamInlineMin = ruleBlock(overrides, '.route-team main select[style*="min-width"]');
  assert.match(teamInlineMin, /min-width:\s*0 !important/);
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
  assert.doesNotMatch(overrides, /(?:^|[},\n]\s*)(?:html|body|main)(?:\s*,\s*(?:html|body|main))*\s*\{[^}]*overflow-x:\s*hidden/ims);
});
