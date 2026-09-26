import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {freshSqlite,makeD1,stayWindow} from './helpers/stay-harness.mjs';
installWorkersHooks('__BST_AUDIT_DB__','__BST_AUDIT_ENV__');
const {discoverBoardingHosts}=await import('../lib/boarding-host-discovery.ts');
async function world(t){const sqlite=freshSqlite(),db=makeD1(sqlite);t.after(()=>sqlite.close());globalThis.__BST_AUDIT_DB__=db;globalThis.__BST_AUDIT_ENV__={};return{db,sqlite};}
const input=()=>({cityId:'blr',zoneId:'blr-east',...stayWindow({startInHours:336,durationHours:4}),petCount:1,species:['dog']});
test('B01: medication and no-resident-pets choices filter unsuitable hosts',async t=>{
 const f=await world(t);const all=await discoverBoardingHosts(f.db,input());assert.ok(all.some(h=>!h.medicationSupport),'negative fixture exists');
 const found=await discoverBoardingHosts(f.db,{...input(),requirements:{medicationRequired:true,noResidentPets:true}});
 assert.ok(found.length>0);assert.ok(found.every(h=>h.medicationSupport&&h.residentPets==='none'));
});
test('B01: one-family-only choice is a real filter, not just a note',async t=>{
 const f=await world(t);const found=await discoverBoardingHosts(f.db,{...input(),requirements:{oneFamilyOnly:true}});
 assert.ok(found.length>0);assert.ok(found.every(h=>h.oneFamilyOnly));
});
test('B02: fractional pet count fails before host discovery',async t=>{
 const f=await world(t);await assert.rejects(discoverBoardingHosts(f.db,{...input(),petCount:1.5}),e=>e instanceof Response&&e.status===400);
});

const governance=await import('../lib/boarding-governance.ts');
test('B01: final Boarding governance rejects an otherwise valid host that cannot meet requested care',async t=>{
 const {db,sqlite}=await world(t),window=stayWindow({startInHours:336,durationHours:4});
 const quote=await governance.createBoardingQuote(db,{...window,packageCode:'boarding-4h',petCount:1,paymentMode:'prepaid',cityId:'blr',zoneId:'blr-east'});
 const booking={quoteId:quote.quoteId,packageCode:quote.packageCode,packageName:quote.packageName,petCount:1,...window,submittedTotal:quote.totalAmount,submittedAmountDueNow:quote.amountDueNow,paymentMode:'prepaid',paymentStatus:'created',reservationCount:1,providerId:'host_arjun_tara',cityId:'blr',zoneId:'blr-east',species:['dog'],vaccinationStatuses:['verified'],customerId:'BST-LOCAL-CUSTOMER',requirements:{medicationRequired:true,noResidentPets:true}};
 await assert.rejects(governance.governBoardingBooking(db,booking),e=>e instanceof Response&&e.status===409);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM boarding_booking_quote_links').get().n,0);
 const valid=await governance.governBoardingBooking(db,{...booking,providerId:'host_priya_dev'});assert.equal(valid.totalAmount,quote.totalAmount);
});
test('B03: an early-morning IST check-in keeps its booked date for host effective dates',async t=>{
 const {db,sqlite}=await world(t);
 // 01:00 IST on the booked day is 19:30 UTC on the previous day; the host's effective dates must be read on the booked day.
 const day=new Date(Date.now()+20*86400000+330*60000).toISOString().slice(0,10),next=new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
 const window={scheduledStart:`${day}T01:00:00+05:30`,scheduledEnd:`${day}T05:00:00+05:30`},query={cityId:'blr',zoneId:'blr-east',...window,petCount:1,species:['dog']};
 await discoverBoardingHosts(db,query);
 sqlite.prepare("UPDATE provider_capacity_profiles SET effective_from=? WHERE id='host_priya_dev'").run(day);
 assert.ok((await discoverBoardingHosts(db,query)).some(h=>h.providerId==='host_priya_dev'),'a host effective from the booked IST day is offered for that day');
 sqlite.prepare("UPDATE provider_capacity_profiles SET effective_from=? WHERE id='host_priya_dev'").run(next);
 assert.equal((await discoverBoardingHosts(db,query)).some(h=>h.providerId==='host_priya_dev'),false,'a host that starts the day after is still excluded');
});
test('B03: equivalent UTC and IST windows discover the same host capacity',async t=>{
 const {db}=await world(t),q=input();const utc=await discoverBoardingHosts(db,q);
 const ist=value=>new Date(Date.parse(value)+330*60000).toISOString().replace('Z','+05:30');
 const other=await discoverBoardingHosts(db,{...q,scheduledStart:ist(q.scheduledStart),scheduledEnd:ist(q.scheduledEnd)});
 assert.deepEqual(other.map(h=>h.providerId),utc.map(h=>h.providerId));
});
import {indiaDateOffset,indiaDateTimeInput,indiaInputInstant,requireFutureIndiaInput,sameReviewedStayQuote} from '../lib/customer-booking-safety.ts';
test('S01: India calendar controls do not shift to yesterday at midnight',()=>{
 const now=Date.parse('2026-09-25T19:00:00Z');assert.equal(indiaDateOffset(0,now),'2026-09-26');assert.equal(indiaDateOffset(3,now),'2026-09-29');
 assert.equal(indiaDateTimeInput('2026-10-06T04:30:00Z'),'2026-10-06T10:00');assert.equal(indiaInputInstant('2026-10-06T10:00'),'2026-10-06T04:30:00.000Z');
});
test('TX02: empty and impossible calendar inputs are safe and cannot be scheduled',()=>{
 for(const value of ['', '2026-02-30T10:00','2026-10-06T25:00','garbage']){assert.equal(indiaInputInstant(value),'');assert.throws(()=>requireFutureIndiaInput(value));}
 assert.throws(()=>requireFutureIndiaInput('2020-01-01T10:00'));
});

import {taxiSelectionKey,taxiQuoteMatchesSelection} from '../lib/taxi-selection-safety.ts';
const selectedRide={originLabel:'Owner selected pickup',destinationLabel:'Owner selected destination',returnDropLabel:'',passengerCount:1,petIds:['PET-1'],luggageCount:0,scheduledStart:'2026-10-06T04:30:00.000Z',tripType:'one_way',ridePurpose:'regular',waitingMinutes:0};
const rideQuote={...selectedRide,petCount:1,expiresAt:2000000000000};
test('TX03: route, time, passenger, luggage, wait and pet identity changes invalidate the quoted selection',()=>{
 const base=taxiSelectionKey(selectedRide);
 for(const over of [{originLabel:'Different pickup'},{destinationLabel:'Different drop'},{scheduledStart:'2026-10-06T05:30:00Z'},{petIds:['PET-2']},{petIds:['PET-1','PET-2']},{passengerCount:0},{luggageCount:3},{tripType:'round_trip',returnDropLabel:'Return place',waitingMinutes:60},{ridePurpose:'airport'}])assert.notEqual(taxiSelectionKey({...selectedRide,...over}),base);
 assert.equal(taxiQuoteMatchesSelection(rideQuote,selectedRide,1800000000000),true);
 assert.equal(taxiQuoteMatchesSelection({...rideQuote,expiresAt:1700000000000},selectedRide,1800000000000),false);
 assert.equal(taxiQuoteMatchesSelection(rideQuote,{...selectedRide,passengerCount:0},1800000000000),false);
});
test('S02: refreshed stay price changes require another review, while equivalent timestamps match',()=>{
 const q={totalAmount:499,amountDueNow:499,paymentMode:'prepaid',petCount:1,scheduledStart:'2026-10-06T10:00:00+05:30',scheduledEnd:'2026-10-06T14:00:00+05:30'};
 assert.equal(sameReviewedStayQuote(q,{...q,scheduledStart:'2026-10-06T04:30:00Z'}),true);
 for(const over of [{totalAmount:599},{amountDueNow:250},{paymentMode:'split_50_50'},{petCount:2},{scheduledEnd:'2026-10-06T09:30:00Z'}])assert.equal(sameReviewedStayQuote(q,{...q,...over}),false);
});
test('TX04: scheduler receives selected pickup and PIN with unchanged customer and pet identity',async t=>{
 const {reserveTaxiSchedule}=await import('../lib/taxi-booking-client.ts');const old=globalThis.fetch;let sent;
 t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({data:{groupId:'LOCAL-GROUP',provider:{id:'LOCAL-DRIVER',name:'Test driver',model:'full_time',rating:4.5}}});};
 await reserveTaxiSchedule({clientRequestId:'LOCAL-GROUP',customerId:'LOCAL-CUSTOMER',petIds:['LOCAL-PET'],cityId:'blr',zoneId:'blr-east',scheduledStart:'2026-10-06T04:30:00Z',scheduledEnd:'2026-10-06T07:30:00Z',serviceAddress:'Selected pickup, not the saved home',servicePincode:'560038'});
 assert.equal(sent.serviceAddress,'Selected pickup, not the saved home');assert.equal(sent.servicePincode,'560038');assert.equal(sent.customerId,'LOCAL-CUSTOMER');assert.deepEqual(sent.petIds,['LOCAL-PET']);assert.equal(sent.serviceCode,'pet_taxi');
});

test('B04: reservation database failures do not advertise empty host capacity',async t=>{
 const {db,sqlite}=await world(t);await discoverBoardingHosts(db,input());
 sqlite.exec('CREATE TABLE IF NOT EXISTS scheduling_reservations(group_id TEXT,provider_id TEXT,service_code TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT,capacity_units INTEGER)');
 const broken={...db,prepare(sql){if(sql.startsWith('SELECT group_id,capacity_units'))throw new Error('simulated reservation read outage');return db.prepare(sql);}};
 await assert.rejects(discoverBoardingHosts(broken,input()),/reservation read outage/);
});
