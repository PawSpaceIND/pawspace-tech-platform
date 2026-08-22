import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const marketing = read("app/components/marketing/premium-marketing.tsx");
const about = read("app/about/page.tsx");
const service = read("app/services/[slug]/page.tsx");
const breed = read("app/dog-breeds/[breed]/page.tsx");
const overrides = read("app/review-overrides.css");

test("release marketing images bypass Vinext runtime image optimization", () => {
  assert.match(marketing, /export function StaticImage/);
  assert.match(marketing, /<img\s+src=\{src\}/);
  for (const [name, source] of [["marketing", marketing], ["about", about], ["service", service], ["breed", breed]]) {
    assert.doesNotMatch(source, /from["']next\/image["']/, `${name} still imports next/image`);
    assert.doesNotMatch(source, /\/_vinext\/image/, `${name} depends on Vinext image optimization`);
  }
  assert.match(about, /StaticImage as Image/);
  assert.match(service, /StaticImage as Image/);
  assert.match(breed, /StaticImage as Image/);
});

test("phone date row fits four dates inside the viewport", () => {
  assert.match(overrides, /\.date-row\s*\{[^}]*overflow-x:\s*visible !important;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\) !important;/s);
  assert.match(overrides, /\.date-row button\s*\{[^}]*min-width:\s*0 !important;/s);
});

test("admin phone navigation no longer requires a 650px rail", () => {
  assert.match(overrides, /\.route-admin aside nav\s*\{[^}]*min-width:\s*0 !important;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\) !important;/s);
  assert.match(overrides, /\.route-admin aside nav button\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});

test("assisted booking navigation uses shrinkable phone columns", () => {
  assert.match(overrides, /\[class\*=["']assisted_shell["']\] nav\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\) !important;/s);
  assert.match(overrides, /\[class\*=["']assisted_shell["']\] nav a\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});

test("targeted remediation never hides page overflow", () => {
  assert.doesNotMatch(overrides, /overflow-x\s*:\s*hidden/i);
});
