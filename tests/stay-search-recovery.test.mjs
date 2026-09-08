import test from 'node:test';
import assert from 'node:assert/strict';
import {staySearchKey,canPlanStay,currentBoardingHost} from '../lib/stay-search-state.ts';
import {loadBoardingCommercial,quoteBoarding} from '../lib/boarding-commercial-client.ts';
const query={cityId:'blr',zoneId:'blr-east',location:'doorstep-one',start:'2026-09-20',end:'2026-09-22',careWindow:'24 hours',petIds:['p1','p2'],species:['dog','cat']};
test('stay planning cannot advance without verified, serviceable address, pets and dates',()=>{
 for(const serviceAvailable of [undefined,false])assert.equal(canPlanStay({datesValid:true,petCount:1,serviceAvailable}),false);
 assert.equal(canPlanStay({datesValid:false,petCount:1,serviceAvailable:true}),false);
 assert.equal(canPlanStay({datesValid:true,petCount:0,serviceAvailable:true}),false);
 assert.equal(canPlanStay({datesValid:true,petCount:2,serviceAvailable:true}),true);
});
test('changing city, zone, dates, care duration or pet species invalidates a selected host',()=>{
 const loaded=staySearchKey(query),host={providerId:'h1',availabilityVerified:true};
 for(const change of [{location:'doorstep-two'},{cityId:'bom'},{zoneId:'blr-west'},{start:'2026-09-21'},{end:'2026-09-23'},{careWindow:'4 hours'},{petIds:['p1']},{species:['dog']}]){
  assert.equal(currentBoardingHost([host],'h1',loaded,staySearchKey({...query,...change})),undefined,JSON.stringify(change));
 }
 assert.equal(currentBoardingHost([host],'h1',loaded,loaded),host);
 assert.equal(staySearchKey({...query,petIds:['p2','p1'],species:['cat','dog']}),loaded,'order changes do not change the request');
});
test('placeholder, removed and unverified hosts cannot carry current availability',()=>{
 const key=staySearchKey(query);
 assert.equal(currentBoardingHost([],undefined,key,key),undefined);
 assert.equal(currentBoardingHost([{providerId:'h1',availabilityVerified:false}],'h1',key,key),undefined);
 assert.equal(currentBoardingHost([{providerId:'h2',availabilityVerified:true}],'h1',key,key),undefined);
});
test('boarding errors and malformed responses produce recovery messages, never host data',async t=>{
 const saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});
 globalThis.fetch=async()=>Response.json({data:{hosts:[{providerId:'untrusted'}]},error:'Capacity unavailable'},{status:503});
 await assert.rejects(loadBoardingCommercial(query),/Capacity unavailable/);
 globalThis.fetch=async()=>new Response('<html>gateway error</html>');
 await assert.rejects(loadBoardingCommercial(query),/could not be read/);
 globalThis.fetch=async()=>Response.json(null);
 await assert.rejects(loadBoardingCommercial(query),/request failed/);
});
test('boarding host and quote requests time out rather than spin indefinitely',async t=>{
 const savedFetch=globalThis.fetch,savedTimeout=globalThis.setTimeout;t.after(()=>{globalThis.fetch=savedFetch;globalThis.setTimeout=savedTimeout;});
 globalThis.setTimeout=callback=>savedTimeout(callback,1);
 globalThis.fetch=async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
 await assert.rejects(loadBoardingCommercial(query),/timed out/);
 await assert.rejects(quoteBoarding({}),/timed out/);
});

test('customer afternoon and evening stay choices preserve IST start, duration and midnight rollover',async()=>{
 const{careWindowDates}=await import('../lib/stay-search-state.ts');
 for(const[time,utc]of[['09:00','03:30'],['13:00','07:30'],['18:00','12:30']])for(const[window,hours]of[['4 hours',4],['10 hours',10],['12 hours',12]]){
  const value=careWindowDates('2026-09-14','2026-09-16',window,time);
  assert.equal(value.scheduledStart.toISOString(),`2026-09-14T${utc}:00.000Z`);assert.equal(value.scheduledEnd-value.scheduledStart,hours*3600000);
 }
 const overnight=careWindowDates('2026-09-14','2026-09-16','24 hours','18:00');assert.equal(overnight.scheduledStart.toISOString(),'2026-09-14T03:30:00.000Z');assert.equal(overnight.scheduledEnd.toISOString(),'2026-09-16T03:30:00.000Z');
});
test('changing daytime start invalidates a host selected for another time',()=>{
 const morning=staySearchKey({...query,careWindow:'4 hours',startTime:'09:00'}),afternoon=staySearchKey({...query,careWindow:'4 hours',startTime:'13:00'});
 assert.notEqual(morning,afternoon);assert.equal(currentBoardingHost([{providerId:'h1',availabilityVerified:true}],'h1',morning,afternoon),undefined);
});
