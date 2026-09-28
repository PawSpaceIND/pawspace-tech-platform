import test from 'node:test';import assert from 'node:assert/strict';
import{partnerServiceDay,partnerServiceTime}from'../lib/partner-job-time.ts';
test('partner job grouping rolls over at IST midnight, not Worker UTC midnight',()=>{
 const before=partnerServiceDay(Date.parse('2026-09-27T18:29:59Z'));
 const after=partnerServiceDay(Date.parse('2026-09-27T18:30:00Z'));
 assert.equal(before.end,Date.parse('2026-09-27T18:30:00Z'));
 assert.equal(after.start,before.end);assert.equal(after.end-after.start,86400000);
});
test('provider schedule converts UTC to explicit IST and handles invalid dates',()=>{
 assert.match(partnerServiceTime('2026-09-28T11:30:00Z'),/5:00.*pm IST/i);
 assert.equal(partnerServiceTime('bad'),'Not scheduled');
});
