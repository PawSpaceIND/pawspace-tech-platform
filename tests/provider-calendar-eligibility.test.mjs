import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__G15_G19_CALENDAR_DB__');
const {schedule}=await import('../backend/src/scheduling.ts');
const provider=(model='commission')=>({id:'CALENDAR-P',cityId:'blr',name:'Synthetic calendar provider',model,services:['grooming','boarding','pet_sitting'],zones:['blr-east'],live:true,rating:5,qualityScore:100,capacity:4,travelBufferMinutes:30,maxDailyJobs:6});
const row=(date,windows,extra={})=>({id:'OPEN-'+date,providerId:'CALENDAR-P',cityId:'blr',zoneId:'blr-east',date,windows,source:'partner_app',updatedAt:'2026-09-29T00:00:00Z',...extra});
function repo(rows,model='commission'){
 return {listEligibleProviders:async()=>[provider(model)],listBookings:async()=>[],
  listAvailability:async(_id,date)=>rows.filter(r=>r.date===date),
  getPet:async id=>({id,customerId:'SYNTHETIC-C',name:'Synthetic pet',species:'dog',allergies:[],vaccinationStatus:'verified'})};
}
const request=(serviceCode,start,end,extra={})=>({cityId:'blr',zoneId:'blr-east',serviceCode,petIds:['SYNTHETIC-PET'],scheduledStart:start,scheduledEnd:end,preferredProviderId:'CALENDAR-P',repeatProviderId:'CALENDAR-P',...extra});
const stay=(serviceCode='boarding')=>request(serviceCode,'2026-10-05T10:00:00+05:30','2026-10-06T10:00:00+05:30',serviceCode==='pet_sitting'?{careMode:'overnight'}:{});
function refused(result){assert.equal(result.provider,null);assert.deepEqual(result.shortlist,[]);assert.equal(result.evaluations[0].eligible,false);}
for(const service of ['boarding','pet_sitting']){
 test(`G17 ${service}: an explicit empty day is blocked even for a preferred provider`,async()=>{
  refused(await schedule(repo([row('2026-10-05',['09:00-19:00']),row('2026-10-06',[])]),stay(service)));
 });
 test(`G18 ${service}: a different zone does not authorize an open day`,async()=>{
  refused(await schedule(repo([row('2026-10-05',['09:00-19:00']),row('2026-10-06',['09:00-19:00'],{zoneId:'blr-west'})]),stay(service)));
 });
 test(`G18 ${service}: malformed hours are not evidence of availability`,async()=>{
  refused(await schedule(repo([row('2026-10-05',['09:00-19:00']),row('2026-10-06',['00:00-25:99'])]),stay(service)));
 });
}
for(const model of ['full_time','commission'])test(`G15/G18 ${model}: daytime rows cannot authorize a visit across the closed night`,async()=>{
 const rows=[row('2026-10-05',['09:00-19:00']),row('2026-10-06',['09:00-19:00'])];
 refused(await schedule(repo(rows,model),request('grooming','2026-10-05T18:00:00+05:30','2026-10-06T06:00:00+05:30')));
});
test('G18 a visit ending exactly at midnight does not consume the next date',async()=>{
 const result=await schedule(repo([row('2026-10-05',['22:00-24:00'])]),request('grooming','2026-10-05T22:00:00+05:30','2026-10-06T00:00:00+05:30'));
 assert.equal(result.provider?.id,'CALENDAR-P');
});
test('G18 a visit even one millisecond beyond closing is not inside the published interval',async()=>{
 refused(await schedule(repo([row('2026-10-05',['10:00-12:00'])]),request('grooming','2026-10-05T10:00:00+05:30','2026-10-05T12:00:00.001+05:30')));
});
for(const windows of [['09:00-25:99'],['09:00-24:01'],['24:00-24:00'],['10:00-09:00'],['not-a-window'],[null],null])test(`G18 invalid roster windows fail closed: ${JSON.stringify(windows)}`,async()=>{
 refused(await schedule(repo([row('2026-10-05',windows)]),request('grooming','2026-10-05T10:00:00+05:30','2026-10-05T12:00:00+05:30')));
});
test('G18 both published parts of a real cross-midnight visit stay eligible',async()=>{
 const result=await schedule(repo([row('2026-10-05',['22:00-24:00']),row('2026-10-06',['00:00-02:00'])]),request('grooming','2026-10-05T22:00:00+05:30','2026-10-06T02:00:00+05:30'));
 assert.equal(result.provider?.id,'CALENDAR-P');
});
for(const service of ['boarding','pet_sitting'])test(`Existing ${service} day-level stay availability remains valid`,async()=>{
 const result=await schedule(repo([row('2026-10-05',['09:00-19:00']),row('2026-10-06',['09:00-19:00'])]),stay(service));
 assert.equal(result.provider?.id,'CALENDAR-P');
});
test('G18 normal published appointment keeps full-time automatic and commission offer behavior',async()=>{
 for(const model of ['full_time','commission']){
  const result=await schedule(repo([row('2026-10-05',['09:00-19:00'])],model),request('grooming','2026-10-05T10:00:00+05:30','2026-10-05T12:00:00+05:30'));
  assert.equal(result.provider?.id,'CALENDAR-P');assert.equal(result.mode,model==='full_time'?'automatic':'offer');
 }
});
test('G18 existing leave overlap wins over published windows, preference and manual override',async()=>{
 const repository={...repo([row('2026-10-05',['09:00-19:00'])]),providerUnavailableForWindow:async()=>true};
 refused(await schedule(repository,request('grooming','2026-10-05T10:00:00+05:30','2026-10-05T12:00:00+05:30',{manualProviderId:'CALENDAR-P',manualOverrideReason:'Synthetic audit override'})));
});
test('G18 no calendar remains unavailable rather than inventing working hours',async()=>{
 refused(await schedule(repo([]),request('grooming','2026-10-05T10:00:00+05:30','2026-10-05T12:00:00+05:30')));
});
