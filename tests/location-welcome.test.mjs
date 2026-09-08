import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveServiceCoverage} from '../lib/service-zone-client.ts';

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
