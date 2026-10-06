import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
installWorkersHooks('__TRAINING_V4_INDEPENDENT__');
const {createRollingBooking, frozenRollingClient} = await import('../lib/training-rolling-booking.ts');
const now = 1791093600000;
const slot = {start:'2026-10-08T04:30:00.000Z', end:'2026-10-08T05:30:00.000Z'};
const summary = {bookingId:'BK-REVIEW', programmeId:'PG-REVIEW', schedulingMode:'rolling_v1', providerId:'PR-REVIEW', totalSessions:8, consumedSessions:1, remainingSessions:7, remainingUnallocatedSessions:6, validFrom:now-1000, validUntil:now+86400000*30, minutesPerSession:60, maxUpcomingSessions:3, upcomingSessions:[], holds:[], changes:[], availableSlots:[slot], availabilityWindow:{from:'2026-10-08',to:'2026-10-15',bounded:true}, canSchedule:true, externalDelivery:false};
function fake(status='confirmed') {
  const sent=[]; let id=0;
  const client={loadSummary:async()=>summary,sendAction:async(body)=>{sent.push(body);return body.action==='hold'?{action:'hold',holdId:'H'+(++id),expiresAt:now+1000}:{action:'confirm',status};}};
  return {client,sent};
}
test('v4 invokes actual frozen summary/action helpers with customer hold and distinct confirm keys', async()=>{
  const prior=globalThis.fetch;const sent=[];
  globalThis.fetch=async(url,init={})=>{
    const body=init.method==='POST'?JSON.parse(init.body):null;sent.push({url:String(url),body});
    return Response.json({data:body?(body.action==='hold'?{action:'hold',holdId:'H-REAL',expiresAt:now+1000}:{action:'confirm',status:'confirmed',sessionIds:['S-REAL']}):summary});
  };
  try{
    const m=createRollingBooking({bookingId:'BK-REVIEW',client:frozenRollingClient(),now:()=>now});
    await m.load();m.select(slot);await m.hold();await m.confirm();
    assert.equal(m.state.phase,'confirmed');assert.deepEqual(m.state.confirmedSessionIds,['S-REAL']);
    assert.match(sent[0].url,/bookingId=BK-REVIEW&actorKind=customer/);
    const writes=sent.filter(x=>x.body).map(x=>x.body);
    assert.deepEqual(writes[0].slots,[slot]);assert.equal(writes[0].actorKind,'customer');
    assert.equal(writes[1].holdId,'H-REAL');assert.equal(writes[1].action,'confirm');
    assert.notEqual(writes[0].idempotencyKey,writes[1].idempotencyKey);
    assert.equal(sent.filter(x=>!x.body).length,2);
  }finally{globalThis.fetch=prior;}
});
test('v4 does not claim success for a negative confirmation status',async()=>{
  const f=fake('not_confirmed');const m=createRollingBooking({bookingId:'BK',client:f.client,now:()=>now});
  await m.load();m.select(slot);await m.hold();await m.confirm();
  assert.notEqual(m.state.phase,'confirmed');assert.equal(m.state.confirmedSessionIds.length,0);
});
test('v4 expired UI reset followed by the same offered slot creates a new hold intent',async()=>{
  const f=fake();let clock=now;const m=createRollingBooking({bookingId:'BK',client:f.client,now:()=>clock});
  await m.load();m.select(slot);await m.hold();clock+=2000;
  assert.equal(m.holdExpired(),true);m.reset();m.select(slot);await m.hold();
  const holds=f.sent.filter(x=>x.action==='hold');assert.equal(holds.length,2);
  assert.notEqual(holds[0].idempotencyKey,holds[1].idempotencyKey);
});
test('v4 ambiguous confirmation retains its key without asserting that no booking happened',async()=>{
  const f=fake();const original=f.client.sendAction;
  f.client.sendAction=async(body)=>body.action==='confirm'?Promise.reject(new TypeError('Response lost')):original(body);
  const m=createRollingBooking({bookingId:'BK',client:f.client,now:()=>now});
  await m.load();m.select(slot);await m.hold();await m.confirm();
  assert.equal(m.state.phase,'held');assert.doesNotMatch(m.state.error,/nothing is booked/i);
});
