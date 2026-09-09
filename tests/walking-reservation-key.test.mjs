import test from 'node:test';
import assert from 'node:assert/strict';
import {walkingReservationKey} from '../lib/walking-reservation-key.ts';
const request={customerId:'customer',petId:'Milo',address:'42 Test Street',pincode:'560102',packageCode:'walking-30',scheduledStart:'2026-09-10T01:30:00Z',scheduledEnd:'2026-09-10T02:00:00Z',walkCount:2,weekdays:[1,3],ownerCare:{instructions:'Red harness',handoverPreference:'owner'}};
test('same Walking request retains a stable opaque retry identity',async()=>{const key=await walkingReservationKey(request);assert.equal(key,await walkingReservationKey({...request,weekdays:[3,1]}));assert.match(key,/^walking-[a-f0-9]{64}$/);assert.doesNotMatch(key,/Milo|Street|harness/);});
test('changing Walking pet, address, time or care cannot replay an older request',async()=>{const old=await walkingReservationKey(request);for(const change of [{petId:'Luna'},{address:'99 Other Street'},{pincode:'560038'},{scheduledStart:'2026-09-11T01:30:00Z'},{ownerCare:{...request.ownerCare,instructions:'Blue harness'}}])assert.notEqual(await walkingReservationKey({...request,...change}),old);});
