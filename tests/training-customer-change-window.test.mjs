import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorld,seedBooking,sessionCookie,routeCall,CUSTOMER} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
const route=await import('../app/api/training-customer-session-change/route.ts');
const HOUR=3600000;
const NOW=Date.parse('2026-09-30T05:00:00.000Z');

async function fixture(t,offset){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const world=freshWorld();t.after(()=>world.sqlite.close());
 seedBooking(world,{id:'WINDOW',group:'WINDOW-G',sessions:2});
 const {sessions}=await materializeTrainingProgramme(world.db,{bookingId:'WINDOW',actorId:'qa'});
 const start=typeof offset==='number'?new Date(NOW+offset).toISOString():offset;
 world.sqlite.prepare('UPDATE training_sessions SET scheduled_start=? WHERE id=?').run(start,sessions[0].id);
 const cookie=await sessionCookie(world.db,'customer',CUSTOMER);
 const request=(currentCookie=cookie)=>routeCall(route.POST,'POST','/api/training-customer-session-change',{cookie:currentCookie,body:{action:'request_reschedule',bookingId:'WINDOW',sessionId:sessions[0].id,reason:'Family commitments have changed',idempotencyKey:'window-request'}});
 return {...world,session:sessions[0],request};
}
for(const [name,offset] of [['past',-HOUR],['now',0],['just inside 24 hours',24*HOUR-1],['invalid','not-a-date']]){
 test(`customer self-service refuses ${name} without changing the session or recovery ledger`,async t=>{
  const f=await fixture(t,offset),result=await f.request();
  assert.equal(result.status,409,JSON.stringify(result.body));
  assert.equal(result.body.code,'training_change_window_closed');
  assert.equal(f.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(f.session.id).status,'scheduled');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM training_session_recovery_cases').get().n,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='request_reschedule'").get().n,0);
 });
}
for(const offset of [24*HOUR,24*HOUR+1,30*HOUR]){
 test(`customer self-service accepts the permitted ${offset}ms boundary exactly once`,async t=>{
  const f=await fixture(t,offset),result=await f.request();
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.data.status,'reschedule_requested');
  const retry=await f.request();assert.equal(retry.status,200,JSON.stringify(retry.body));assert.equal(retry.body.data.duplicatePrevented,true);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM training_session_recovery_cases').get().n,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='request_reschedule'").get().n,1);
 });
}
test('a customer slot changed after its preflight cannot bypass the change window in the lifecycle batch',async t=>{
 const f=await fixture(t,30*HOUR),batch=f.db.batch.bind(f.db);let injected=false;
 f.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.startsWith("UPDATE training_sessions SET status='reschedule_requested'"))){injected=true;f.sqlite.prepare('UPDATE training_sessions SET scheduled_start=? WHERE id=?').run(new Date(NOW+HOUR).toISOString(),f.session.id);}return batch(statements);};
 const result=await f.request();assert.equal(injected,true);assert.equal(result.status,409,JSON.stringify(result.body));
 assert.equal(f.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(f.session.id).status,'scheduled');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM training_session_recovery_cases').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='request_reschedule'").get().n,0);
});

test('an accepted same-key request replays after cutoff; a new key still cannot change a past session',async t=>{
 const f=await fixture(t,30*HOUR);const first=await f.request();assert.equal(first.status,200);
 t.mock.timers.setTime(NOW+31*HOUR);
 const renewed=await sessionCookie(f.db,'customer',CUSTOMER);
 const replay=await f.request(renewed);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.data.duplicatePrevented,true);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM training_session_recovery_cases').get().n,1);
 // A different still-scheduled session cannot borrow that accepted request or its earlier decision.
 f.sqlite.prepare("UPDATE training_sessions SET status='scheduled' WHERE id=?").run(f.session.id);
 const cookie=await sessionCookie(f.db,'customer',CUSTOMER);
 const fresh=await routeCall(route.POST,'POST','/api/training-customer-session-change',{cookie,body:{action:'request_reschedule',bookingId:'WINDOW',sessionId:f.session.id,reason:'A new change request after the cutoff',idempotencyKey:'window-new'}});
 assert.equal(fresh.status,409,JSON.stringify(fresh.body));assert.equal(fresh.body.code,'training_change_window_closed');
});
