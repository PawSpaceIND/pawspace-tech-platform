/*
 * Every vertical PawSpace sells must resolve at its own path.
 *
 * Grooming did not. /boarding, /sitting, /walking, /training, /food and /taxi all had a page;
 * app/grooming held only manage/page.tsx, so the parent segment existed, /grooming/manage resolved,
 * and /grooming itself returned 404. The codebase already treated the path as a customer surface —
 * app/components/review-ux-fixes.tsx lists it among the customer paths whose staff panels get
 * hidden — so the only thing missing was the page.
 *
 * Grooming is also the vertical marketing buys traffic for by name (there is a
 * pet_grooming_bangalore_recommendation action in marketing-control, and a dedicated
 * /locations/bengaluru/hsr-layout/pet-grooming landing page), which makes a 404 at the obvious URL
 * the most expensive one on the list.
 *
 * A missing route is invisible to typecheck, to lint and to every test that exercises a module: the
 * page simply is not there, so nothing fails. Only the filesystem says so, which is what this reads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const app = (path) => new URL(`../app/${path}`, import.meta.url);
const VERTICALS = ["grooming", "boarding", "sitting", "walking", "training", "food", "taxi"];

test("ROUTE-1: every customer vertical resolves at its own path", () => {
  const missing = VERTICALS.filter((v) => !existsSync(app(`${v}/page.tsx`)));
  assert.deepEqual(missing, [],
    `these verticals 404 at /<vertical> with no page.tsx: ${missing.join(", ")}`);
});

test("ROUTE-2: a vertical with sub-pages still has its own index", () => {
  /* The shape that hid the grooming 404: a segment that exists only because a CHILD route lives in
   * it. /grooming/manage resolving made app/grooming look inhabited. */
  for (const vertical of VERTICALS) {
    if (!existsSync(app(`${vertical}/manage/page.tsx`))) continue;
    assert.ok(existsSync(app(`${vertical}/page.tsx`)),
      `app/${vertical} holds a sub-page but no index, so /${vertical} 404s while /${vertical}/manage works`);
  }
});

test("ROUTE-3: every path the app treats as a customer surface exists", () => {
  const source = readFileSync(app("components/review-ux-fixes.tsx"), "utf8");
  const declared = source.match(/const customerPaths = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, "app/components/review-ux-fixes.tsx no longer declares customerPaths");
  const paths = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "/");
  const missing = paths.filter((p) => !existsSync(app(`${p.replace(/^\//, "")}/page.tsx`)));
  assert.deepEqual(missing, [],
    `declared as customer surfaces but 404: ${missing.join(", ")}`);
});
