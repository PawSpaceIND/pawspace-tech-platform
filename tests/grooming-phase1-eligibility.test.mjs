import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__PHASE1_DB__");
const { youngGroomingEligibility } = await import("../lib/grooming-package-eligibility.ts");
const { groomingSlotAvailable } = await import("../lib/grooming-booking-calendar.ts");
const { groomingAddOnsForSpecies, groomingAddOnsValid } = await import("../lib/grooming-add-ons.ts");

test("same-day slots block at start, during the slot and after end; future slots stay available", () => {
  for(const now of ["2026-09-14T09:00:00+05:30","2026-09-14T10:00:00+05:30","2026-09-14T11:01:00+05:30"])
    assert.equal(groomingSlotAvailable("2026-09-14",0,120,Date.parse(now)),false);
  assert.equal(groomingSlotAvailable("2026-09-14",0,120,Date.parse("2026-09-14T08:59:59+05:30")),true);
  assert.equal(groomingSlotAvailable("2026-09-15",0,120,Date.parse("2026-09-14T23:59:59+05:30")),true);
  assert.equal(groomingSlotAvailable("2026-09-14",0,120,Date.parse("2026-09-14T03:30:00Z")),false);
  for(const [date,index,duration] of [["invalid",0,120],["2026-02-30",0,120],["2026-09-15",3,300],["2026-09-15",NaN,120]])
    assert.equal(groomingSlotAvailable(date,index,duration,0),false);
});

for(const species of ["dog","cat"]){
  test(`${species}: six calendar months inclusive; older pets and unknown ages refused`,()=>{
    const pet={name:"Milo",species,profile:{dateOfBirth:"2026-03-14",ageBand:"< 6 months"}};
    assert.equal(youngGroomingEligibility(pet,"2026-09-14"),null);
    assert.match(youngGroomingEligibility(pet,"2026-09-15"),/Adult/);
    assert.match(youngGroomingEligibility({species,profile:{ageBand:"6–12 months"}},"2026-09-14"),/date of birth/);
    assert.match(youngGroomingEligibility({species},"2026-09-14"),/date of birth/);
    assert.equal(youngGroomingEligibility({species,ageYears:0.5},"2026-09-14"),null);
    assert.match(youngGroomingEligibility({species,ageYears:0.51},"2026-09-14"),/6 months/);
  });
}
test("six-month boundary clamps month ends and rejects impossible/future birth dates",()=>{
  const pet={species:"cat",profile:{dateOfBirth:"2025-08-31"}};
  assert.equal(youngGroomingEligibility(pet,"2026-02-28"),null);
  assert.match(youngGroomingEligibility(pet,"2026-03-01"),/6 months/);
  for(const dateOfBirth of ["2026-02-30","2027-01-01","not a date"])
    assert.match(youngGroomingEligibility({species:"dog",profile:{dateOfBirth}},"2026-09-14"),/date of birth/);
});
test("tick treatment is canine-only; cats retain eligible massage and duplicate items are rejected",()=>{
  assert.deepEqual(groomingAddOnsForSpecies("cat").map(a=>a.label),["Full-body oil massage"]);
  assert.equal(groomingAddOnsValid(["Tick & flea treatment"],"cat"),false);
  assert.equal(groomingAddOnsValid(["Tick & flea treatment"],"dog"),true);
  assert.equal(groomingAddOnsValid(["Full-body oil massage","Full-body oil massage"],"dog"),false);
});
