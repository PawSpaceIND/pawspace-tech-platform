import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceCalendarContext} from '../lib/voice-calendar-context.ts';
test('relative dates use India midnight, including month and year boundaries',()=>{
 for(const [time,today,tomorrow] of [
 ['2026-09-26T18:29:59Z','2026-09-26','2026-09-27'],
 ['2026-09-26T18:30:00Z','2026-09-27','2026-09-28'],
 ['2026-12-31T18:30:00Z','2027-01-01','2027-01-02']]){
 const c=voiceCalendarContext(Date.parse(time));assert.equal(c.todayDate,today);assert.equal(c.tomorrowDate,tomorrow);assert.equal(c.timezone,'Asia/Kolkata');assert.equal(Date.parse(c.asOfIso),c.asOf);
 }
});
