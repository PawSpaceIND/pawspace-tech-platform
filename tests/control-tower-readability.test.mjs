/**
 * The Control tower was reported as unreadable, and it was: its stylesheets carried 6px, 7px and 8px
 * type - 245 declarations of it - and app/review-overrides.css shrank the surface further with
 * `!important`. Nothing about that is a judgement call; text that small cannot be read at a normal
 * viewing distance on the screens this is operated from.
 *
 * These tests hold a readable floor across every control stylesheet, and keep the rail matching the
 * approved Operations chrome so the two surfaces stay one product.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

const MINIMUM_PX = 12;

async function controlStylesheets() {
  const dir = new URL("../app/control/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".css"));
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(new URL(name, dir), "utf8") })));
}

const sizes = (source) => [...source.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));

test("no control stylesheet asks anyone to read type below the floor", async () => {
  const offenders = [];
  for (const { name, source } of await controlStylesheets()) {
    for (const size of sizes(source)) if (size < MINIMUM_PX) offenders.push(`${name}: ${size}px`);
  }
  assert.deepEqual(offenders, [], `these declarations are smaller than ${MINIMUM_PX}px`);
});

test("the review overrides no longer shrink the control surface", async () => {
  const source = await readFile(new URL("../app/review-overrides.css", import.meta.url), "utf8");
  for (const size of sizes(source)) assert.ok(size >= MINIMUM_PX, `review override sets ${size}px`);
  // The two rules that did the shrinking, pinned at their new readable values.
  assert.match(source, /nav button \{ min-height: 44px; font-size: 14px !important; \}/);
  assert.match(source, /font-size: 13px !important/);
  assert.match(source, /font-size: max\(13px, 0\.85rem\)/);
  assert.doesNotMatch(source, /font-size: max\(11px/);
});

test("the control rail wears the same chrome as the Operations shell", async () => {
  const [control, ops] = await Promise.all([
    readFile(new URL("../app/control/control.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ops-shell/ops-shell.module.css", import.meta.url), "utf8").catch(() => ""),
  ]);
  // Same rail width, colour and hover treatment as the approved shell.
  assert.match(control, /grid-template-columns:238px 1fr/);
  assert.match(control, /\.side\{[^}]*background:#2d0a5d/);
  assert.match(control, /background:rgba\(255,255,255,\.12\)/);
  assert.match(control, /\.side nav button:focus-visible\{outline:2px solid #f5a21a/, "the rail must be reachable by keyboard");
  assert.match(control, /\.main\{min-width:0;padding:28px 30px 60px\}/, "the workspace uses the shell's padding");
  if (ops) {
    assert.match(ops, /background: #2d0a5d/);
    assert.match(ops, /grid-template-columns: 238px 1fr/);
  }
});

test("raising the type scale kept the hierarchy rather than flattening it", async () => {
  const source = await readFile(new URL("../app/control/control.module.css", import.meta.url), "utf8");
  const all = sizes(source);
  assert.ok(all.length > 20, "the control stylesheet still sets its own type scale");
  const distinct = new Set(all);
  assert.ok(distinct.size >= 5, "several distinct sizes remain, so headings still outrank body copy");
  assert.ok(Math.max(...all) >= 24, "the page title is still a page title");
});
