import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const routes = ["training", "boarding", "sitting", "walking", "taxi", "food", "relocation"];

test("UI-THEME-01: root loads the unified PawSpace customer theme", async () => {
  const layout = await read("app/layout.tsx");
  assert.match(layout, /import "\.\/unified-pawspace-theme\.css";/);
});

test("UI-THEME-02: every standalone customer service route is under the shared presentation scope", async () => {
  for (const route of routes) {
    const layout = await read(`app/${route}/layout.tsx`);
    assert.match(layout, /ps-unified-service/, `${route} must inherit the shared PawSpace visual system`);
    assert.match(layout, new RegExp(`ps-${route}`), `${route} must keep an explicit route presentation marker`);
  }
});

test("UI-THEME-03: the shared theme covers governed Grooming and canonical brand tokens", async () => {
  const theme = await read("app/unified-pawspace-theme.css");
  const tokens = await read("app/pawspace-design-system.css");
  assert.match(tokens, /--paw-primary:#01261f/i);
  assert.match(tokens, /--paw-gold:#e6b34e/i);
  assert.match(tokens, /--psu-ivory:var\(--paw-bg\)/);
  assert.match(theme, /\.app-shell>\.hero/);
  for (const route of routes) assert.match(theme, new RegExp(`\\.ps-${route}`), `theme must explicitly cover ${route}`);
});
