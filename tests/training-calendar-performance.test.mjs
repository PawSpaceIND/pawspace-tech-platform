import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {schedulingCalendarReads,schedulingDates} from '../lib/scheduling-calendar-reads.ts';
import {schedule,buildOccurrences} from '../backend/src/scheduling.ts';

function fixture(t) {
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 sqlite.exec(`CREATE TABLE scheduling_availability(provider_id TEXT,city_id TEXT,zone_id TEXT,date TEXT,windows_json TEXT,source TEXT);
 CREATE TABLE provider_capacity_profiles(id TEXT,city_id TEXT);
 CREATE TABLE provider_unavailability(provider_id TEXT,starts_at TEXT,ends_at TEXT,status TEXT);`);
 let reads=0;
 const db={prepare(sql){return {bind(...args){return {async all(){reads++;return {results:sqlite.prepare(sql).all(...args)};}};}};}};
 const input={cityId:'blr',zoneId:'blr-south',serviceCode:'dog_training',petIds:['dog'],scheduledStart:'2026-10-01T10:00:00+05:30',scheduledEnd:'2026-10-01T11:00:00+05:30',occurrences:12,cadenceDays:7};
 const occurrences=buildOccurrences(input),dates=schedulingDates(occurrences,330);
 const providers=Array.from({length:3},(_,i)=>({id:`trainer-${i}`,name:`Trainer ${i}`,cityId:'blr',model:'commission',qualityScore:90-i,rating:5,capacity:1,maxDailyJobs:4,travelBufferMinutes:30}));
 for(const p of providers){sqlite.prepare('INSERT INTO provider_capacity_profiles VALUES (?,?)').run(p.id,'blr');for(const date of dates)sqlite.prepare('INSERT INTO scheduling_availability VALUES (?,?,?,?,?,?)').run(p.id,'blr','blr-south',date,'["09:00-19:00"]','uat_roster');}
 const repository=()=>{const calendar=schedulingCalendarReads(db,'blr',occurrences,330);return {listEligibleProviders:async()=>providers,getPet:async()=>({id:'dog',species:'dog'}),listBookings:async()=>[],listAvailability:async(id,date)=>(await calendar.availability(id,date)).map(r=>({zoneId:r.zone_id,windows:JSON.parse(r.windows_json)})),providerUnavailableForWindow:calendar.unavailable};};
 return {sqlite,input,occurrences,dates,repository,reads:()=>reads};
}

test('12-session, three-trainer search uses two calendar reads and still checks the last session',async t=>{
 const f=fixture(t),last=f.occurrences.at(-1);
 f.sqlite.prepare('INSERT INTO provider_unavailability VALUES (?,?,?,?)').run('trainer-0',last.start,last.end,'active');
 const result=await schedule(f.repository(),f.input);
 assert.equal(f.reads(),2);
 assert.equal(result.occurrences.length,12);
 assert.deepEqual(result.shortlist.map(x=>x.provider.id),['trainer-1','trainer-2']);
 assert.match(result.evaluations[0].reasons.join(' '),/unavailable/);
});

test('a later reservation reads newly published leave, including offset timestamps',async t=>{
 const f=fixture(t);
 assert.equal((await schedule(f.repository(),f.input)).provider.id,'trainer-0');
 f.sqlite.prepare('INSERT INTO provider_unavailability VALUES (?,?,?,?)').run('trainer-0','2026-10-01T10:30:00+05:30','2026-10-01T11:30:00+05:30','active');
 assert.equal((await schedule(f.repository(),f.input)).provider.id,'trainer-1');
 assert.equal(f.reads(),4,'no snapshot is reused between requests');
});

test('authored roster overrides UAT availability even when authored in another zone',async t=>{
 const f=fixture(t);
 f.sqlite.prepare('INSERT INTO scheduling_availability VALUES (?,?,?,?,?,?)').run('trainer-0','blr','blr-east',f.dates[5],'["09:00-19:00"]','partner_app');
 const result=await schedule(f.repository(),f.input);
 assert.equal(result.provider.id,'trainer-1');
 assert.match(result.evaluations[0].reasons.join(' '),/outside roster/);
});

test('cleared leave and touching endpoints do not block; database errors fail closed',async t=>{
 const f=fixture(t);
 f.sqlite.prepare('INSERT INTO provider_unavailability VALUES (?,?,?,?)').run('trainer-0',f.input.scheduledStart,f.input.scheduledEnd,'cleared');
 f.sqlite.prepare('INSERT INTO provider_unavailability VALUES (?,?,?,?)').run('trainer-0',f.input.scheduledEnd,'2026-10-01T12:00:00+05:30','active');
 assert.equal((await schedule(f.repository(),f.input)).provider.id,'trainer-0');
 f.sqlite.exec('DROP TABLE provider_unavailability');
 await assert.rejects(()=>schedule(f.repository(),f.input),/no such table/);
});

test('roster dates contain only programme days and include local overnight boundaries',()=>{
 const input={cityId:'blr',zoneId:'blr-south',serviceCode:'dog_training',petIds:['dog'],scheduledStart:'2026-10-01T10:00:00+05:30',scheduledEnd:'2026-10-01T11:00:00+05:30',occurrences:4,cadenceDays:7};
 assert.deepEqual(schedulingDates(buildOccurrences(input),330),['2026-10-01','2026-10-08','2026-10-15','2026-10-22']);
 assert.deepEqual(schedulingDates([{start:'2026-10-01T23:00:00+05:30',end:'2026-10-02T07:00:00+05:30'}],330),['2026-10-01','2026-10-02']);
});
