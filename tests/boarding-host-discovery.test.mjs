import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("Boarding discovery filters governed hosts for the exact stay window",()=>{
  const source=read("lib/boarding-host-discovery.ts");
  assert.match(source,/ensureBoardingStayLifecycleTables/);
  assert.match(source,/home_verified/);
  assert.match(source,/kyc_status/);
  assert.match(source,/background_check_status/);
  assert.match(source,/services\.includes\("boarding"\)/);
  assert.match(source,/requestedSpecies\.some/);
  assert.match(source,/provider_unavailability/);
  assert.match(source,/boarding_capacity_locks/);
  assert.match(source,/scheduling_reservations/);
  assert.match(source,/status!='cancelled'/);
  assert.match(source,/lockedGroups/);
  assert.match(source,/one_family_only/);
  assert.match(source,/available<petCount/);
  assert.match(source,/availabilityMode:"uat_canonical"/);
});

test("Boarding commercial API exposes window-aware UAT availability without claiming production live state",()=>{
  const api=read("app/api/boarding-commercial/route.ts"),client=read("lib/boarding-commercial-client.ts");
  assert.match(api,/discoverBoardingHosts/);
  assert.match(api,/scheduledStart/);
  assert.match(api,/scheduledEnd/);
  assert.match(api,/petCount/);
  assert.match(api,/species/);
  assert.match(api,/hasLocation=Boolean\(cityId&&zoneId\)/);
  assert.match(api,/availabilityMode:hasLocation\?\(windowAware\?"uat_canonical":"catalogue_only"\):"location_required"/);
  assert.match(api,/availabilityVerified:windowAware/);
  assert.match(api,/liveAvailability:false/);
  assert.match(client,/availableGuestPets/);
  assert.match(client,/species\.join\(","\)/);
  assert.match(client,/scheduledStart/);
  assert.match(client,/scheduledEnd/);
});

test("Boarding customer search renders only governed discovered hosts",()=>{
  const flow=read("app/mobile-app/stay-flow.tsx");
  assert.doesNotMatch(flow,/const boardingHosts: Caregiver\[\] =/);
  assert.match(flow,/toBoardingCaregiver/);
  assert.match(flow,/boardingHostWindowKey === boardingHostQueryKey \? boardingHosts : \[\]/);
  assert.match(flow,/loadBoardingCommercial\(\{cityId:serviceLocation\.assignment\.cityId,zoneId:serviceLocation\.assignment\.zoneId,scheduledStart:/);
  assert.match(flow,/species:selectedSpecies/);
  assert.match(flow,/item\.providerId===caregiver\.providerId/);
  assert.match(flow,/Selected Boarding host is no longer available for this stay window/);
  assert.match(flow,/No verified Boarding host currently has capacity for every selected pet/);
  assert.match(flow,/disabled=\{mode === "boarding" && !caregiver\.providerId\}/);
});

test("Boarding customer host cards do not fabricate marketplace proof",()=>{
  const flow=read("app/mobile-app/stay-flow.tsx");
  assert.doesNotMatch(flow,/maya-rohan-profile\.webp/);
  assert.doesNotMatch(flow,/indiranagar-home\.webp/);
  assert.doesNotMatch(flow,/pet-guest-room\.webp/);
  assert.match(flow,/selected-window capacity checked/);
  assert.match(flow,/guest-pet spots available/);
  assert.match(flow,/Host media and customer reviews are not connected in Boarding UAT/);
  assert.match(flow,/Live masked chat is not connected yet/);
  assert.match(flow,/does not fabricate reviews, response times, media, amenities or day-by-day availability/);
  assert.match(flow,/Production OTP is not connected/);
});

test("Boarding customer search does not pretend an unimplemented area or production availability feed",()=>{
  const flow=read("app/mobile-app/stay-flow.tsx"),api=read("app/api/boarding-commercial/route.ts");
  assert.match(flow,/<AddressPicker onZoneResolved=\{setServiceLocation\}/);
  assert.match(flow,/serviceLocation\.assignment\.zoneId/);
  assert.match(flow,/selected-window availability verified in UAT/);
  assert.match(flow,/Host profile \+ leave blocks \+ accepted stay locks \+ pending Boarding scheduler reservations/);
  assert.match(api,/liveAvailability:false/);
});

test("Boarding roster keeps dog+cat (the app's default pet selection) bookable under load",()=>{
  // Regression guard for the UAT defect where host_sana was the ONLY cat-accepting host and is
  // one_family_only, so a single overlapping commitment made every dog+cat stay unbookable.
  const source=read("lib/boarding-governance.ts");
  const rosterMatch=source.match(/const hosts=\[([\s\S]*?)\] as const;/);
  assert.ok(rosterMatch,"boarding host roster not found");
  const entries=[...rosterMatch[1].matchAll(/\{providerId:[\s\S]*?\}/g)].map(m=>m[0]);
  const catHosts=entries.filter(entry=>/species:\[[^\]]*"cat"/.test(entry));
  assert.ok(catHosts.length>=2,`need at least 2 cat-accepting boarding hosts, found ${catHosts.length}`);
  const sharedCatHost=catHosts.filter(entry=>/oneFamilyOnly:0/.test(entry));
  assert.ok(sharedCatHost.length>=1,"need at least one cat-accepting host that is not one_family_only");
  // Every roster host must also exist in the capacity profile seed, or discovery's JOIN drops it.
  const capacity=read("lib/provider-capacity-governance.ts");
  for(const entry of entries){
    const id=entry.match(/providerId:"([^"]+)"/)[1];
    assert.match(capacity,new RegExp(`\\{id:"${id}"[^}]*services:\\["boarding"\\]`),`${id} missing boarding capacity profile`);
  }
});
