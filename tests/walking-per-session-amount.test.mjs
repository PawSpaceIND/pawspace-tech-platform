import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Walking completion uses canonical configured per-walk pricing", async () => {
  const source = await readFile(new URL("../lib/walking-lifecycle.ts", import.meta.url), "utf8");
  assert.match(source, /walkingPerSessionAmount\(pricing,booking\.total_amount,sessionCount\?\.count\)/);
  assert.match(source, /if\(pricing\.demoSeed===true\)/);
});

test("Walking clients preserve plain-text server errors", async () => {
  const source = await readFile(new URL("../lib/walking-lifecycle-client.ts", import.meta.url), "utf8");
  assert.match(source, /response\.text\(\)/);
  assert.match(source, /error:text\.trim\(\)\|\|undefined/);
});
