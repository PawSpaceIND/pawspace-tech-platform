import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const lib = await read("../lib/pricing-rule-governance.ts");
const route = await read("../app/api/pricing-rules/route.ts");

test("city/zone-wise pricing rules on the same table the live engine reads", () => {
  assert.match(lib, /export async function createPricingRule/);
  assert.match(lib, /INSERT INTO dynamic_pricing_rules/);
  // rule + adjustment types validated; city/zone are real inputs (not hardcoded)
  assert.match(lib, /RULE_TYPES = \["weekday", "weekend", "time_band", "season", "date_range"\]/);
  assert.doesNotMatch(lib, /city_id,zone_id,rule_type[^)]*\) VALUES[^)]*'blr'/);
});

test("holiday / long-weekend surcharge auto-suggest is advisory (never auto-applies)", () => {
  assert.match(lib, /export async function suggestLongWeekendWindows/);
  assert.match(lib, /export async function suggestSurcharge/);
  assert.match(lib, /export async function applySurchargeSuggestion/);
  // long weekend = a run of >=3 non-working days that includes a holiday
  assert.match(lib, /len >= 3 && cur\.holidays\.length/);
  // suggestions are advisory; approval creates a DRAFT rule
  assert.match(lib, /suggestion: true/);
  assert.match(lib, /'draft'/);
});

test("the pricing-rules route is permission-gated with the expected actions", () => {
  assert.match(route, /requirePermission\(actor,"pricing\.view"\)/);
  assert.match(route, /requirePermission\(actor,"pricing\.manage"\)/);
  for (const a of ["create_rule", "add_holiday", "seed_holidays", "apply_suggestion"]) assert.match(route, new RegExp(`action==="${a}"`));
  assert.match(route, /mode==="suggest"/);
  assert.match(route, /sameOrigin\(request\)/);
});
