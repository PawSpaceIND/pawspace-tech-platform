import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// PTJA-P1-F34 — the harness gap Phase 1 exposed.
//
// Until this change, NO UI render branch on this platform could be tested. `node
// --experimental-strip-types` removes type annotations but has no JSX transform, so importing any
// component failed outright with `Unknown file extension ".tsx"`, and there is no jsdom or
// @testing-library either. Every UI-state defect found in Phase 1 — a raw NO_SCHEDULE_AVAILABLE shown
// as customer copy, a hardcoded fixture pet list, an order page drawn for an order that does not
// exist — had to be found by opening a browser, and none of them could be pinned afterwards.
//
// tests/helpers/module-hooks.mjs now transpiles .tsx with TypeScript's own compiler (already a direct
// devDependency, so no package is added) and stubs CSS-module imports. This file is that capability's
// own regression: if the transform breaks, this goes red rather than the gap silently reopening.
//
// What this buys and what it does not: react-dom/server renders the INITIAL state. Effects do not run,
// so a component's post-fetch states are still out of reach. That is enough to pin what a screen shows
// before its data arrives — which is exactly where "absent drawn as present" lives.
// ---------------------------------------------------------------------------
installWorkersHooks("__TSX_HARNESS_DB__");

async function render(modulePath, props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(modulePath);
  return renderToStaticMarkup(React.createElement(mod.default, props));
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("P1-H01 a client .tsx component can be imported and rendered", async () => {
  const html = await render("../app/food/manage/food-customer-management.tsx", { orderId: "PS-UAT-FOOD-HARNESS" });
  assert.ok(html.length > 0, "the transform produced markup");
  assert.match(html, /<main/, "and it is real DOM, not a stringified element");
});

test("P1-H02 the no-argument branch renders, so branches really are reachable", async () => {
  // Two different props must produce two different screens: if the transform were returning something
  // inert, both would look the same and every assertion in this file would be worthless.
  const withId = text(await render("../app/food/manage/food-customer-management.tsx", { orderId: "PS-UAT-FOOD-HARNESS" }));
  const withoutId = text(await render("../app/food/manage/food-customer-management.tsx", { orderId: "" }));
  assert.notEqual(withId, withoutId, "the orderId branch is genuinely being taken");
  assert.match(withoutId, /Manage Food order/);
});

test("P1-H03 a CSS-module import resolves to class names rather than exploding", async () => {
  // Most components import a .module.css. Without the stub the import fails and the whole file is
  // untestable; with a bare {} every className renders as "undefined", which reads like a render bug.
  const styles = (await import("../app/mobile-app/mobile.module.css")).default;
  assert.equal(styles.anyClassName, "anyClassName", "a style lookup yields a usable class name");
});
