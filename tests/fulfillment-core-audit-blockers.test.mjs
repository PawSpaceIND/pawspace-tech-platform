import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const { cityOffsetMinutes } = await import("../backend/src/scheduling.ts");

test("all operational Indian city codes use IST and unknown cities fail closed", () => {
  for (const cityId of ["blr", "mum", "pnq", "hyd", "maa"]) assert.equal(cityOffsetMinutes(cityId), 330, `${cityId} must use IST`);
  for (const alias of ["bengaluru", "mumbai", "pune", "hyderabad", "chennai"]) assert.equal(cityOffsetMinutes(alias), 330, `${alias} must use IST`);
  assert.throws(() => cityOffsetMinutes("unknown-city"), /Scheduling timezone is not configured/);
});

test("Grooming reschedule keeps initial-booking buffer, roster, daily cap and provider guards", async () => {
  const source = await read("app/api/grooming-booking-change/route.ts");
  assert.match(source, /listAuthoritativeAvailability\(db,providerId,localStart\.date\)/, "reschedule must use the governed published-roster authority");
  assert.match(source, /travel_buffer_minutes/, "reschedule must read the provider travel buffer");
  assert.match(source, /max_daily_jobs/, "reschedule must read the provider daily-job cap");
  assert.match(source, /bufferedStart/);
  assert.match(source, /bufferedEnd/);
  assert.match(source, /json_each\(a\.windows_json\) w/, "atomic move must re-check the roster window");
  assert.match(source, /substr\(datetime\(other\.scheduled_start,\?\),1,10\)=\?/, "atomic move must re-check the same local-day cap");
  assert.match(source, /provider_unavailability u/, "atomic move must re-check provider unavailability");
  assert.match(source, /Number\(moved\.meta\?\.changes\|\|0\)!==expectedRows/, "a partial/losing guarded move must be rejected");
});

test("Training cancellation calculation only uses an effective published policy", async () => {
  const source = await read("lib/training-cancellation.ts");
  assert.match(source, /status='published' AND effective_from<=\? AND \(effective_to IS NULL OR effective_to>=\?\)/);
  assert.match(source, /\.bind\(row\.city_id,policyDate,policyDate\)/);
  assert.match(source, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/, "policy writes must reject malformed effective dates");
});
