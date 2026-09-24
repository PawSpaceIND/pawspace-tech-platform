import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/food/canonical-food-page.tsx", import.meta.url), "utf8");

test("V2 Food preflights the platform customer session before account bootstrap", () => {
  assert.match(source, /routeScope==="v2"/);
  assert.match(source, /loadV2CustomerSession\(\)/);
  assert.match(source, /if\(!session\)throw new Error\("Sign in to PawSpace before ordering Fresh Food\."\)/);
  assert.match(source, /return loadV2CustomerAccount\(\)/);
  assert.match(source, /return loadCustomerAccount\(\)/, "legacy /food keeps its existing account loader");
});

test("Food cannot present an actionable reserve control after account bootstrap failure", () => {
  assert.match(source, /const bootstrapBlocked=Boolean\(accountError\)/);
  assert.match(source, /disabled=\{bootstrapBlocked\|\|!quote\|\|quoteLoading\|\|Boolean\(quoteError\)\|\|orderLoading\|\|!customer\}/);
  assert.match(source, /quoteLoading\?"Refreshing canonical quote…":accountError\?"":quoteError\?/);
});
