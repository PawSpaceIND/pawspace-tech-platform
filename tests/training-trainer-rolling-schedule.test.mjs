import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {trainingChangeRequestRegistry} from '../app/trainer/lifecycle-presentation.ts';
test('exact provider retry keeps key; changed payload gets another key',()=>{
 let count=0;const request=trainingChangeRequestRegistry(()=>`uuid-${++count}`),payload={bookingId:'owned',actorKind:'provider',action:'propose_change',sessionId:'session',slots:[{start:'2026-10-08T10:00:00Z',end:'2026-10-08T11:00:00Z'}],reason:'Mutually change time'};
 const initial=request(payload);assert.equal(request(structuredClone(payload)),initial);assert.equal(count,1);
 for(const changed of [{...payload,bookingId:'foreign'},{...payload,slots:[{start:'2026-10-09T10:00:00Z',end:'2026-10-09T11:00:00Z'}]},{bookingId:'owned',actorKind:'provider',action:'accept_change',changeId:'change'}])assert.notEqual(JSON.parse(request(changed)).idempotencyKey,JSON.parse(initial).idempotencyKey);
 assert.equal(request(payload),initial);
});
test('trainer approval is opposite-party only and never self-books or date-gates',()=>{
 const source=readFileSync(new URL('../app/trainer/rolling-schedule.tsx',import.meta.url),'utf8');
 for(const pattern of [/actorKind=provider&sessionId=/,/item\.id===sessionId&&item\.provider_id===providerId/,/proposal\.proposedBy==="customer"&&/,/slots:\[chosen\]/,/original appointment stays confirmed/,/no-show session\(s\) need Operations and Finance review/])assert.match(source,pattern);
 assert.doesNotMatch(source,/action:\s*["'](?:hold|confirm)["']/);assert.doesNotMatch(source,/Date\.now\(\)|new Date\([^)]*scheduled_start/);
 const page=readFileSync(new URL('../app/trainer/page.tsx',import.meta.url),'utf8');assert.match(page,/schedulingMode==="rolling_v1"&&<TrainerRollingSchedule/);
});
