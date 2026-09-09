import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveServiceCoverage} from '../lib/service-zone-client.ts';

test('logo-only entry never blocks Home on denied or stalled location',()=>{
 const source=readFileSync('app/mobile-app/location-welcome.tsx','utf8');
 const splash=source.split('if (!compact) return <section')[1].split('</section>;')[0];
 assert.match(splash,/pawspace-official-lockup/);
 assert.doesNotMatch(splash,/<button|<p|<form|<h1/);
 assert.match(source,/setTimeout\(\(\) => finish\(null\), 8000\)/);
 assert.match(source,/compact \|\| !note/);
 assert.match(readFileSync('app/mobile-app/location-welcome.module.css','utf8'),/prefers-reduced-motion/);
});

test('address suggestions debounce typing and discard stale responses without submitting a booking',()=>{
 const source=readFileSync('app/mobile-app/address-autofill.tsx','utf8');
 assert.match(source,/350/);
 assert.match(source,/if \(!active\) return/);
 assert.match(source,/active = false; clearTimeout\(timer\)/);
 assert.match(source,/autoComplete="street-address"/);
 assert.match(source,/Suggestions are unavailable/);
 assert.doesNotMatch(source,/method: "POST"/);
 for(const file of ['address-picker','taxi-flow','relocation-flow']) assert.match(readFileSync(`app/mobile-app/${file}.tsx`,'utf8'),/<AddressAutofill/);
});

test('pet suggestions reuse an existing profile explicitly and keep standard breed validation',()=>{
 const source=readFileSync('app/mobile-app/pet-manager.tsx','utf8');
 assert.match(source,/Matching saved pets/);
 assert.match(source,/onClick=\{\(\) => openEdit\(pet\)\}/);
 assert.match(source,/list="pet-breed-options"/);
 assert.match(source,/validatePetProfile/);
});

test('welcome and home share GPS-first location with neighbourhood search and optional PIN fallback',()=>{
 const welcome=readFileSync('app/mobile-app/location-welcome.tsx','utf8');
 const home=readFileSync('app/mobile-app/premium-discovery-home.tsx','utf8');
 assert.match(welcome,/Or search your neighbourhood/);
 assert.match(welcome,/<details className=\{styles.fallback\}>/);
 assert.match(welcome,/mode: "search", query: search.trim\(\)/);
 assert.match(welcome,/mode: "resolve", placeId/);
 assert.match(welcome,/await checkPin\(foundPin, request\)/);
 assert.match(home,/editingLocation && <LocationWelcome compact/);
 assert.match(home,/onClose=\{\(\) => setEditingLocation\(false\)\}/);
 assert.doesNotMatch(home,/Area PIN code/);
});

test('location welcome requests optional one-shot location only from an action',()=>{
 const source=readFileSync('app/mobile-app/location-welcome.tsx','utf8');
 assert.match(source,/onClick=\{\(\) => void locate\(\)\}/);
 assert.match(source,/getCurrentPosition/);
 assert.doesNotMatch(source,/watchPosition|localStorage/);
 assert.match(source,/timeout: 8000/);
 assert.match(source,/AbortSignal.timeout\(10000\)/);
 assert.match(source,/Browse without location/);
 assert.match(source,/request !== generation.current/);
 assert.doesNotMatch(source,/setNote\(error.message\)/);
 assert.match(source,/Continue in \{coverage.city\}/);
 assert.match(source,/pawspace-official-lockup.png/);
 assert.doesNotMatch(source,/professionalArt|golden-retriever-hero|SERVICE_ART/);
});

test('coverage forwards cancellation and uses server city rather than hardcoded Bengaluru',async()=>{
 const original=globalThis.fetch;
 const controller=new AbortController();
 try{
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'/api/service-zone?pincode=400001');assert.equal(options.signal,controller.signal);
  return Response.json({data:{assignment:{pincode:'400001',zoneId:'mum-south',cityId:'mum',city:'Mumbai',area:'Fort'},zone:{zoneId:'mum-south',serviceAvailable:true}}});
 };
 const result=await resolveServiceCoverage('400001',controller.signal);
 assert.equal(result.cityId,'mum');assert.equal(result.city,'Mumbai');
 globalThis.fetch=async()=>Response.json({error:'not served'},{status:409});
 await assert.rejects(()=>resolveServiceCoverage('400001'));
 }finally{globalThis.fetch=original;}
});

test('stored discovery area is revalidated and is not a booking address',()=>{
 const source=readFileSync('app/mobile-app/premium-discovery-home.tsx','utf8');
 assert.match(source,/resolveServiceCoverage\(pin, AbortSignal.timeout/);
 assert.doesNotMatch(source,/SELECTED_SERVICE_ADDRESS_KEY/);
 assert.match(source,/if \(showWelcome\) return <LocationWelcome/);
});

test('customer shell does not invent a city or unread notification count',()=>{
 const source=readFileSync('app/mobile-app/page.tsx','utf8');
 assert.doesNotMatch(source,/Bengaluru is your current service area|3 unread updates|📍 Bengaluru/);
 assert.match(source,/aria-label="View booking activity" onClick=\{\(\)=>setTab\("activity"\)\}/);
});

test('grooming comparison and readable actions retain QA corrections',()=>{
 const source=readFileSync('app/mobile-app/grooming-flow.tsx','utf8');
 assert.match(source,/hygiene\|nail\|routine\|everything in bath & basic/);
 const css=readFileSync('app/mobile-app/grooming-flow.module.css','utf8');
 assert.match(css,/position: relative; bottom: auto; background: var\(--paw-primary\)/);
 assert.match(css,/color: var\(--paw-on-primary\); box-shadow: none; font-size: 16px/);
});
