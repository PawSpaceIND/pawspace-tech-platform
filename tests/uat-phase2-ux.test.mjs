import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__PHASE2_UX_DB__");
const { stayCareWindow, homeVisitEnd, HOME_VISIT_MINUTES } = await import("../lib/stay-care-window.ts");
const { defaultStayAddress, validateSavedStayAddress } = await import("../lib/stay-saved-address.ts");
const { groomingSelectionForType, groomingPetIssue } = await import("../lib/grooming-pet-selection.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: GroomingPetList } = await import("../app/mobile-app/grooming-pet-list.tsx");
const { default: StayFlow } = await import("../app/mobile-app/stay-flow.tsx");
const { stayWindowProblem, stayDateBounds, boardingVaccinationProblem, boardingPetNote } = await import("../lib/stay-plan-checks.ts");
const { indiaDateOffset } = await import("../lib/customer-booking-safety.ts");
const { stayMoney } = await import("../lib/stay-money.ts");

test("seven-night stay preserves both customer times in IST and the visible duration", () => {
  const window = stayCareWindow("2026-09-15", "2026-09-22", "10:00", "10:00");
  assert.equal(window.valid, true);
  assert.equal(window.hours, 168);
  assert.equal(window.duration, "7 nights");
  assert.equal(window.scheduledStart.toISOString(), "2026-09-15T04:30:00.000Z");
  assert.equal(window.scheduledEnd.toISOString(), "2026-09-22T04:30:00.000Z");
  assert.match(window.summary, /7 nights.*15 Sept.*10:00.*22 Sept.*10:00/);
  const extended = stayCareWindow("2026-09-15", "2026-09-22", "10:00", "12:15");
  assert.equal(extended.hours, 170.25);
  assert.notEqual(extended.key, window.key);
  assert.equal(extended.scheduledEnd.toISOString(), "2026-09-22T06:45:00.000Z");
});
test("duration derives the governed package at the four-hour and ten-hour boundaries", () => {
  for (const [endTime,hours,code] of [["13:00",4,"boarding-4h"],["13:01",4+1/60,"boarding-10h"],["19:00",10,"boarding-10h"],["19:01",10+1/60,"boarding-24h"]]) {
    const window=stayCareWindow("2026-09-15","2026-09-15","09:00",endTime);
    assert.equal(window.hours,hours); assert.equal(window.boardingPackage,code);
    assert.equal(window.sittingPackage,hours>10?"sitting-overnight":null,"SIT-04: longer than one 60-minute visit and not overnight is no Sitting package");
  }
});
test("a Pet Sitting Home Visit is one 60-minute window from the chosen start (SIT-04)", () => {
  assert.equal(HOME_VISIT_MINUTES, 60);
  const end = homeVisitEnd("2026-09-15", "13:00");
  assert.deepEqual(end, { date: "2026-09-15", time: "14:00" });
  const visit = stayCareWindow("2026-09-15", end.date, "13:00", end.time);
  assert.equal(visit.hours, 1); assert.equal(visit.overnight, false); assert.equal(visit.sittingPackage, "sitting-visit-60");
  assert.equal(visit.scheduledStart.toISOString(), "2026-09-15T07:30:00.000Z"); assert.equal(visit.scheduledEnd.toISOString(), "2026-09-15T08:30:00.000Z");
  assert.deepEqual(homeVisitEnd("2026-09-15", "23:30"), { date: "2026-09-16", time: "00:30" }, "a late visit ends after midnight IST");
  assert.equal(homeVisitEnd("2026-09-15", "24:00"), null);
  assert.equal(stayCareWindow("2026-09-15", "2026-09-15", "13:00", "14:01").sittingPackage, null);
});
test("sitting: the plan offers a 60-minute Home Visit or Overnight Pet Sitting, Overnight first selected", () => {
  const html=renderToStaticMarkup(React.createElement(StayFlow,{mode:"sitting",customer:{customerId:"test-customer",customerName:"Test",phone:"9000000000"}}));
  assert.match(html,/<button type="button" aria-pressed="false"[^>]*><i>◷<\/i><b>Home Visit<\/b><span>One 60-minute visit<\/span><\/button>/);
  assert.match(html,/<button type="button" aria-pressed="true"[^>]*><i>☾<\/i><b>Overnight Pet Sitting<\/b>/);
});
test("incomplete, impossible and non-positive windows cannot be quoted", () => {
  for(const args of [["2026-09-15","2026-09-15","10:00","10:00"],["2026-09-15","2026-09-15","10:00","09:00"],["2026-09-15","2026-09-14","10:00","11:00"],["2026-02-30","2026-03-01","10:00","11:00"],["","2026-09-15","10:00","11:00"],["2026-09-15","2026-09-16","24:00","11:00"]]) assert.equal(stayCareWindow(...args).valid,false);
});
const address={id:"home",label:"Home",line1:"42 Test Road",line2:null,area:"Indiranagar",city:"Bengaluru",postalCode:"560038",isDefault:true};
test("saved location prefers the profile default, then first, and handles no address",()=>{
  const other={...address,id:"office",isDefault:false};
  assert.equal(defaultStayAddress([other,address]),address);
  assert.equal(defaultStayAddress([other]),other);
  assert.equal(defaultStayAddress([]),null);
});
test("saved address is checked by PIN without inventing a geographic point",async t=>{
  const calls=[];
  t.mock.method(globalThis,"fetch",async(url,options)=>{calls.push({url,options});return Response.json({data:{assignment:{pincode:"560038",cityId:"blr",city:"Bengaluru",zoneId:"blr-east",area:"Indiranagar"},zone:{zoneId:"blr-east",serviceAvailable:true}}});});
  const signal=new AbortController().signal;
  const resolved=await validateSavedStayAddress(address,signal);
  assert.equal(calls[0].url,"/api/service-zone?pincode=560038");assert.equal(calls[0].options.signal,signal);
  assert.equal(resolved.assignment.pincode,"560038");assert.match(resolved.address,/42 Test Road/);
  assert.equal(resolved.latitude,undefined);assert.equal(resolved.longitude,undefined);
  const malformed={...address,postalCode:"560 038"};
  await assert.rejects(()=>validateSavedStayAddress(malformed,signal),/invalid PIN code/);
  assert.equal(calls.length,1,"malformed saved PIN is refused without a coverage request");
  assert.equal(malformed.postalCode,"560 038","the saved record is not rewritten");
  await validateSavedStayAddress({...address,postalCode:" 560038 "},signal);
  assert.equal(calls[1].url,"/api/service-zone?pincode=560038");
});
test("saved invalid or unsupported addresses do not bypass coverage validation",async t=>{
  let requests=0;t.mock.method(globalThis,"fetch",async()=>{requests++;return Response.json({error:"Outside service area"},{status:422});});
  await assert.rejects(()=>validateSavedStayAddress({...address,postalCode:""}),/PIN code/);assert.equal(requests,0);
  await assert.rejects(()=>validateSavedStayAddress(address),/Outside service area/);assert.equal(requests,1);
});
const pets=[{id:"dog",name:"Buddy",species:"dog",ageYears:2},{id:"cat",name:"Milo",species:"cat",ageYears:2},{id:"kitten",name:"Mini",species:"cat",ageYears:0.3,profile:{dateOfBirth:"2026-06-01"}}];
test("changing Dog to Cat selects a saved cat without editing the profile",()=>{
  assert.deepEqual(groomingSelectionForType(pets,["dog"],"cat","2026-09-15"),["cat"]);
  assert.deepEqual(groomingSelectionForType(pets,["cat"],"dog","2026-09-15"),["dog"]);
  assert.deepEqual(groomingSelectionForType(pets,[],"cat","2026-09-15"),["cat"]);
  assert.deepEqual(groomingSelectionForType(pets,["cat"],"kitten","2026-09-15"),["kitten"]);
  assert.deepEqual(groomingSelectionForType(pets,[],"puppy","2026-09-15"),[]);
  assert.match(groomingPetIssue(pets[1],"kitten","2026-09-15"),/Adult/);
  assert.match(groomingPetIssue(pets[0],"cat","2026-09-15"),/Dog package/);
});
test("pet cards expose readable selection and eligibility instead of ambiguous glyphs",()=>{
  const html=renderToStaticMarkup(React.createElement(GroomingPetList,{pets,selected:["cat"],type:"cat",date:"2026-09-15",onToggle(){}}));
  assert.match(html,/aria-pressed="true"/);assert.match(html,/>Selected</);assert.match(html,/>Not Eligible</);assert.match(html,/>Add</);
  assert.equal((html.match(/<button/g)||[]).length,3);
});
for(const mode of ["boarding","sitting"])test(`${mode}: rendered plan exposes only explicit check-in and check-out controls`,()=>{
  const html=renderToStaticMarkup(React.createElement(StayFlow,{mode,customer:{customerId:"test-customer",customerName:"Test",phone:"9000000000"}}));
  for(const label of ["Check-in date","Check-in time","Check-out date","Check-out time"])assert.match(html,new RegExp(`<label[^>]*>${label}<input`));
  assert.equal((html.match(/type="time"/g)||[]).length,2);
  assert.doesNotMatch(html,/>4 hours<|>10 hours<|>24 hours<|eligible commission partners/);
  assert.match(html,/Change Address/);
});

// Round-2 staging (Boarding B4c/B4d/B4e, Pet Sitting SIT-12): a start ~20 hours away, a start 185 days out and a pet
// without verified vaccination got hosts, a price, a Care Card and a Review, and were refused only at the final click.
test("the stay Plan step refuses short notice, a start past the 180-day horizon and unverified Boarding pets", () => {
  const HOUR = 3_600_000, DAY = 24 * HOUR, now = Date.parse("2026-09-27T04:30:00.000Z"); // 10:00 IST
  assert.deepEqual(stayWindowProblem(now + 20 * HOUR, now), { code: "below_minimum_lead_time", message: "Book at least 24 hours ahead." });
  assert.deepEqual(stayWindowProblem(now + 185 * DAY, now), { code: "beyond_booking_horizon", message: "You can book up to 180 days ahead." });
  assert.equal(stayWindowProblem(now + 24 * HOUR, now), null, "exactly 24 hours' notice is enough, as the reservation measures it");
  assert.equal(stayWindowProblem(now + 180 * DAY, now), null, "and the 180th day is still bookable");
  assert.equal(stayWindowProblem(new Date(Number.NaN), now), null, "an incomplete window is left to the dates check");
  assert.deepEqual(stayDateBounds(now), { min: "2026-09-28", max: "2027-03-26" }, "the picker's range is IST calendar days");
  assert.equal(boardingVaccinationProblem([{ name: "BrdDog", vaccinationStatus: "verified" }]), null);
  assert.deepEqual(boardingVaccinationProblem([{ name: "BrdDog", vaccinationStatus: "verified" }, { name: "BrdPup", vaccinationStatus: "not_provided" }]),
    { code: "vaccination_required", message: "Boarding needs verified vaccination for every pet. BrdPup isn't verified yet - add the vaccination record in the pet details, or choose another pet." });
  assert.match(boardingVaccinationProblem([{ name: "Kiwi", vaccinationStatus: "pending" }, { name: "Momo" }]).message, /Kiwi and Momo aren't verified yet/);
  assert.equal(boardingPetNote({ vaccinationStatus: "not_provided" }), "Vaccination not verified - Boarding needs it");
  assert.equal(boardingPetNote({ vaccinationStatus: "pending" }), "Vaccination record pending - Boarding needs it verified");
  assert.equal(boardingPetNote({ vaccinationStatus: "verified" }), null);
});
for (const mode of ["boarding", "sitting"]) test(`${mode}: the check-in picker stops at the 180-day horizon (IST) and the Plan step states the booking window`, () => {
  const before = [indiaDateOffset(1), indiaDateOffset(180)];
  const html = renderToStaticMarkup(React.createElement(StayFlow, { mode, customer: { customerId: "test-customer", customerName: "Test", phone: "9000000000" } }));
  const after = [indiaDateOffset(1), indiaDateOffset(180)];
  const input = html.match(/<label[^>]*>Check-in date<input[^>]*>/)?.[0] ?? "";
  const bounds = [input.match(/ min="([^"]+)"/)?.[1], input.match(/ max="([^"]+)"/)?.[1]];
  assert.ok([before, after].some((expected) => expected[0] === bounds[0] && expected[1] === bounds[1]), `check-in ${input}`);
  assert.match(html, /Book at least 24 hours ahead\. You can book up to 180 days ahead\./);
});

// Round-2 staging (BRD-05): the Review of a 5-night split stay read "₹1,747.5 now · ₹1,747.5 due 24 hours before
// check-in" and "₹1,747.5 will be collected".
test("stay amounts show paise to the paisa and whole rupees without them", () => {
  assert.equal(stayMoney(1747.5), "₹1,747.50");
  assert.equal(stayMoney(3495), "₹3,495");
  assert.equal(stayMoney(399.5), "₹399.50");
  assert.equal(stayMoney(999.99), "₹999.99");
  assert.equal(stayMoney(Math.round(3495 * 50) / 100), "₹1,747.50", "the Review's own half of the total");
  assert.equal(stayMoney(0), "₹0");
});
