/* Price authority stays in the existing engine. The new separate-request flow displays that
 * server response; it must not imply an included trial, a payment, or new owner-approved terms. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {meetGreetPrice} from '../lib/meet-and-greet.ts';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__MEETING_PRICE_DB__','__MEETING_PRICE_ENV__');
const {stayMeetingPolicy}=await import('../lib/stay-meeting-policy.ts');
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
test('existing in-person fee stays 499; a phone call stays free',()=>{
 for(const days of [0,1,4]){assert.equal(meetGreetPrice('house_visit',days).amount,499);assert.equal(meetGreetPrice('phone',days).amount,0);}
});
test('the existing five-day intended-stay waiver remains named and unchanged',()=>{
 const price=meetGreetPrice('house_visit',5);assert.equal(price.amount,0);assert.equal(price.waived,true);assert.equal(price.reason,'stay_5_days_or_more');
 const policy=stayMeetingPolicy('2026-10-01','2026-10-06');assert.deepEqual(policy.house_visit,{...price,durationMinutes:240});
});
test('stay review takes meeting fee and status from the persisted request, not a typed-in price',async()=>{
 const flow=await read('app/mobile-app/stay-flow.tsx'),card=await read('app/mobile-app/stay-meeting-request.tsx');
 assert.match(flow,/StayMeetingRequest/);assert.match(flow,/currentMeeting\.priceCharged/);assert.match(flow,/currentMeeting\.id/);assert.match(flow,/currentMeeting\.status/);
 assert.doesNotMatch(flow,/const meetFee\s*=|meetFeeLabel|meeting fee is collected now|₹\s*\d/);
 assert.match(card,/policy\.house_visit\.amount/);assert.match(card,/policy\.phone\.amount/);assert.match(card,/r\.priceWaivedReason/);
});
test('separate introduction never changes or joins the stay total',async()=>{
 const flow=await read('app/mobile-app/stay-flow.tsx'),card=await read('app/mobile-app/stay-meeting-request.tsx');
 assert.match(flow,/excluded from this stay total/);assert.match(card,/No meeting fee is collected by this form/);assert.match(card,/priceWaivedReason/);assert.match(card,/Request status is not proof of payment or service completion/);
 assert.doesNotMatch(card,/razorpay|CustomerCheckoutController|\/api\/payment-order/);
});
