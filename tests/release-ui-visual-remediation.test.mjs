import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const nextConfig = fs.readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const overrides = fs.readFileSync(new URL("../app/review-overrides.css", import.meta.url), "utf8");
const reviewUx = fs.readFileSync(new URL("../app/components/review-ux-fixes.tsx", import.meta.url), "utf8");

test("Worker image delivery bypasses the broken runtime optimizer path", () => {
  assert.match(nextConfig, /images:\s*\{[\s\S]*unoptimized:\s*true/);
});

test("review route families receive responsive shrink guards", () => {
  for (const marker of ["route-team", "route-partner", "route-customer"]) assert.match(reviewUx, new RegExp(marker));
  assert.match(overrides, /min-width:\s*0/);
  assert.match(overrides, /grid-template-columns:\s*1fr !important/);
  assert.match(overrides, /flex-wrap:\s*wrap !important/);
});

test("phone control navigation wraps instead of placing controls outside the viewport", () => {
  assert.match(overrides, /route-control[\s\S]*control_shell[\s\S]*grid-template-columns:\s*1fr !important/);
  assert.match(overrides, /control_side[\s\S]*nav[\s\S]*flex-wrap:\s*wrap !important/);
});

test("responsive remediation does not hide page overflow to game the release gate", () => {
  assert.doesNotMatch(overrides, /body[^\n{]*\{[^}]*overflow-x:\s*hidden/i);
  assert.doesNotMatch(overrides, /main[^\n{]*\{[^}]*overflow-x:\s*hidden/i);
});
