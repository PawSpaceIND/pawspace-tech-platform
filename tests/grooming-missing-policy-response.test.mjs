import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const policy = fs.readFileSync(new URL("../lib/grooming-policy-governance.ts", import.meta.url), "utf8");
const canonical = fs.readFileSync(new URL("../app/api/canonical-bookings/route.ts", import.meta.url), "utf8");

test("missing Grooming city/zone policy fails closed as a governed conflict", () => {
  assert.match(policy, /if\(!row\)throw Response\.json\(\{error:"Grooming is not commercially configured for this city\/zone",code:"grooming_policy_configuration_required",cityId,zoneId:zoneId\?\?null\},\{status:409\}\)/);
  assert.doesNotMatch(policy, /if\(!row\)throw new Error\("No active Grooming commercial policy is configured for this city\/zone"\)/);
});

test("canonical booking preserves thrown governed response status instead of converting it to 500", () => {
  assert.match(canonical, /if\(error instanceof Response\)\{const message=await error\.text\(\)\.catch\(\(\)=>""\);return json\(\{error:message\|\|"Canonical booking validation failed"\},error\.status\|\|409\);\}/);
});
