import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSaleBaseline,assertSpokenQuote,assertSpokenBooking,assertSandboxSale} from '../scripts/voice-spoken-sale-guards.mjs';
import {voiceCalendarContext} from '../lib/voice-calendar-context.ts';
const baseline=()=>({aiPaused:false,dialed:false,pendingOffers:[],completedBookings:['OLD']});
test('refuses paused contexts and pre-existing offers before sending speech',()=>{
 assert.throws(()=>assertSaleBaseline({...baseline(),aiPaused:true}));
 assert.throws(()=>assertSaleBaseline({...baseline(),pendingOffers:[{id:'STALE'}]}));
});
test('requires a fresh single quote and no booking before confirmation',()=>{
 const before=baseline(),after={...before,pendingOffers:[{id:'O',summary:'Bruno Essential Bath',expiresAt:200}]};
 assert.equal(assertSpokenQuote(before,after,100),'O');
 assert.throws(()=>assertSpokenQuote(before,after,201));
 assert.throws(()=>assertSpokenQuote(before,{...after,completedBookings:['OLD','EARLY']},100));
 assert.throws(()=>assertSpokenQuote(before,{...after,pendingOffers:[...after.pendingOffers,...after.pendingOffers]},100));
});
test('rejects missing, duplicate or still-pending booking confirmation',()=>{
 assert.equal(assertSpokenBooking(baseline(),{...baseline(),completedBookings:['OLD','NEW']}),'NEW');
 assert.throws(()=>assertSpokenBooking(baseline(),baseline()));
 assert.throws(()=>assertSpokenBooking(baseline(),{...baseline(),completedBookings:['OLD','A','B']}));
});
test('requires exact canonical booking and synthetic payment capture with replay',()=>{
 const r={dialed:false,synthetic:true,replayChecked:true,captured:true,booking:{id:'NEW',booking_status:'confirmed',payment_status:'captured',gateway_order_id:'order_test',currency:'INR',payment_amount:1241,total_amount:1241}};
 assert.doesNotThrow(()=>assertSandboxSale(r,'NEW'));
 for(const change of [{synthetic:false},{replayChecked:false},{booking:{...r.booking,id:'OTHER'}},{booking:{...r.booking,payment_amount:1}},{booking:{...r.booking,payment_status:'pending'}}])assert.throws(()=>assertSandboxSale({...r,...change},'NEW'));
});

test('spoken sale guard executes production voice context code',()=>{
 const context=voiceCalendarContext(Date.UTC(2026,8,27,18,0,0));
 assert.ok(context && typeof context==='object');
});
