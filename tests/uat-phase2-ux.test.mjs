import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__PHASE2_UX_DB__");
const { stayCareWindow } = await import("../lib/stay-care-window.ts");
const { defaultStayAddress, validateSavedStayAddress } = await import("../lib/stay-saved-address.ts");
const { groomingSelectionForType, groomingPetIssue } = await import("../lib/grooming-pet-selection.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: GroomingPetList } = await import("../app/mobile-app/grooming-pet-list.tsx");
const { default: StayFlow } = await import("../app/mobile-app/stay-flow.tsx");

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
    assert.equal(window.sittingPackage,hours>10?"sitting-overnight":"sitting-visit-60");
  }
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
