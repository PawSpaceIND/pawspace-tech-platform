import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const seed=fs.readFileSync(new URL("../scripts/uat-staging-provider-capacity.sql",import.meta.url),"utf8");

test("UAT Pet Sitting roster is overnight-capable and repairs stale day-only rows",()=>{
  assert.match(seed,/UPDATE scheduling_availability[\s\S]*source='roster'[\s\S]*services_json LIKE '%"pet_sitting"%'/);
  assert.match(seed,/p\.services_json LIKE '%"boarding"%' OR p\.services_json LIKE '%"pet_sitting"%' THEN '\["00:00-23:59"\]'/);
  assert.match(seed,/SET windows_json='\["00:00-23:59"\]'/);
});

test("UAT day-service roster remains bounded instead of becoming all-day",()=>{
  assert.match(seed,/ELSE '\["06:00-22:00"\]'/);
});
