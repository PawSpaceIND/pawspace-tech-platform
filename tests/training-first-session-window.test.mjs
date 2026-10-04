import test from 'node:test';
import assert from 'node:assert/strict';
import{trainingFirstSessionDecision as check}from '../lib/training-first-session-window.ts';
const oct1=Date.parse('2026-10-01T18:29:00Z'); // Oct 1, 23:59 in Bengaluru
const ist={now:oct1};
test('two full Bengaluru preparation days mean October 1 booking can first start October 4',()=>{
 assert.equal(check('2026-10-03T08:00:00+05:30',ist).ok,false);
 assert.equal(check('2026-10-04T08:00:00+05:30',ist).ok,true);
 assert.equal(check('2026-10-04T20:00:00+05:30',ist).ok,true);
});
test('whole-hour 08:00 through 20:00 and no past start',()=>{
 for(const time of ['07:00','20:30','21:00','08:15'])assert.equal(check(`2026-10-04T${time}:00+05:30`,ist).ok,false,time);
 assert.equal(check('2026-10-04T09:00:00+05:30',ist).ok,true);
 assert.equal(check('2026-10-04T09:00:00.500+05:30',ist).ok,false);
 assert.equal(check('2026-10-04T09:00:00.0001+05:30',ist).ok,false);
 assert.equal(check('2026-10-01T23:00:00+05:30',ist).ok,false);
 assert.equal(check('2026-10-04T08:00:00',ist).ok,false);
});
test('local calendar dates govern around DST changes, not 72 elapsed hours',()=>{
 const ny={timeZone:'America/New_York',now:Date.parse('2026-03-07T23:30:00-05:00')};
 assert.equal(check('2026-03-09T08:00:00-04:00',ny).ok,false);
 assert.equal(check('2026-03-10T08:00:00-04:00',ny).ok,true);
});
test('new rolling quote enforces the window while historical series mode keeps its original rule',async()=>{
 const{freshWorld}=await import('./helpers/training-lifecycle-harness.mjs');
 const{createTrainingQuote}=await import('../lib/training-commercial-governance.ts');
 const w=freshWorld(),today=new Date(Date.now()+330*60_000).toISOString().slice(0,10);
 const day=(delta)=>new Date(Date.parse(`${today}T00:00:00Z`)+delta*86_400_000).toISOString().slice(0,10);
 const tooEarly=`${day(2)}T09:00:00+05:30`,valid=`${day(3)}T09:00:00+05:30`;
 const input={packageCode:'training-4-puppy',petCount:1,paymentMode:'prepaid'};
 await assert.rejects(createTrainingQuote(w.db,{...input,scheduledStart:tooEarly,schedulingMode:'rolling_v1'}),error=>error instanceof Response&&error.status===400);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_commercial_quotes').get().n,0);
 const rolling=await createTrainingQuote(w.db,{...input,scheduledStart:valid,schedulingMode:'rolling_v1'});
 assert.equal(rolling.schedulingMode,'rolling_v1');
 const legacy=await createTrainingQuote(w.db,{...input,scheduledStart:tooEarly,schedulingMode:'series_v1'});
 assert.equal(legacy.schedulingMode,'series_v1');
});
