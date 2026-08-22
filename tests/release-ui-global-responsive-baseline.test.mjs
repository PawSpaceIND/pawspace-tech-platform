import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../app/review-overrides.css", import.meta.url), "utf8");

test("all app routes get a shrinkable release UI baseline", () => {
  assert.match(css, /main,\nmain \* \{ min-width: 0; box-sizing: border-box; \}/);
  assert.match(css, /main img,\nmain svg,\nmain video,\nmain canvas \{ max-width: 100%; height: auto; \}/);
});

test("phone baseline fits fixed content without hiding overflow", () => {
  const phone = css.match(/@media \(max-width: 760px\) \{[\s\S]*\n\}/)?.[0] || "";
  assert.match(phone, /main \[style\*="min-width"\] \{ min-width: 0 !important; \}/);
  assert.match(phone, /main \[style\*="grid-template-columns"\] \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
  assert.match(phone, /main \[style\*="display: flex"\] \{ flex-wrap: wrap !important; \}/);
  assert.match(phone, /main table \{ width: 100% !important; max-width: 100% !important; table-layout: fixed; \}/);
  assert.match(phone, /main button,[\s\S]*main a \{ max-width: 100%; white-space: normal; overflow-wrap: anywhere; \}/);
  assert.doesNotMatch(css, /(?:html|body|main)[^{]*\{[^}]*overflow-x\s*:\s*hidden/is);
});
