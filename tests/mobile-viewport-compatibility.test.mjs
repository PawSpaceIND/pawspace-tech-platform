import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const layout = read("app/layout.tsx");
const globals = read("app/globals.css");
const overrides = read("app/review-overrides.css");
const grooming = read("app/mobile-app/grooming-flow.module.css");
const finance = read("app/team/finance/finance.module.css");
const financePage = read("app/team/finance/page.tsx");

test("root layout owns a device-width mobile viewport with safe-area support", () => {
  assert.match(layout, /export const viewport:\s*Viewport\s*=\s*\{/);
  assert.match(layout, /width:\s*["']device-width["']/);
  assert.match(layout, /initialScale:\s*1/);
  assert.match(layout, /viewportFit:\s*["']cover["']/);
});

test("Tailwind 4 remains globally enabled and shared phone rules shrink content instead of clipping controls", () => {
  assert.match(globals, /@import\s+["']tailwindcss["']/);
  assert.match(overrides, /@media \(max-width: 760px\)/);
  assert.match(overrides, /main \[style\*="grid-template-columns"\] \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
  assert.match(overrides, /main \[style\*="display: flex"\] \{ flex-wrap: wrap !important; \}/);
});

test("canonical grooming booking and payment controls keep 44px touch targets and shrink-safe grids", () => {
  assert.match(grooming, /\.field select\s*\{[^}]*min-height:\s*44px/s);
  assert.match(grooming, /\.add,[\s\S]*?\.back\s*\{[^}]*min-height:\s*44px/s);
  for (const selector of ["subs", "addons", "dates", "pay", "tabs"]) {
    assert.match(grooming, new RegExp(`\\.${selector} button\\s*\\{[^}]*min-height:\\s*44px`, "s"), `${selector} controls need a 44px touch target`);
  }
  assert.match(grooming, /\.pay\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(grooming, /\.slots\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
});

test("grooming finance stacks mobile chrome but keeps the wide ledger in an intentional local scroller", () => {
  assert.match(financePage, /className=\{styles\.actions\}/);
  assert.match(financePage, /className=\{styles\.summaryGrid\}/);
  assert.match(financePage, /className=\{styles\.moneyGrid\}/);
  assert.match(financePage, /className=\{styles\.tableScroller\}/);
  assert.match(financePage, /className=\{styles\.ledgerTable\}/);
  assert.match(finance, /\.tableScroller\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(finance, /\.tableScroller \.ledgerTable\s*\{[^}]*min-width:\s*980px !important;[^}]*max-width:\s*none !important;[^}]*table-layout:\s*auto !important/s);
  assert.match(finance, /@media \(max-width: 600px\)[\s\S]*?\.actions > \*\s*\{[^}]*min-height:\s*44px/s);
  assert.match(finance, /@media \(max-width: 600px\)[\s\S]*?\.summaryGrid,[\s\S]*?\.moneyGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});
