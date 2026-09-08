import test from 'node:test';
import assert from 'node:assert/strict';
import {customerActivityBookings,customerBookingManageHref} from '../lib/customer-activity.ts';
const booking=(id,status,scheduledStart)=>({id,status,scheduledStart,serviceCode:'pet_sitting'});
test('overdue and in-progress care remain reachable with future care',()=>{
 const rows=[booking('future','assigned','2099-01-01'),booking('late','assigned','2020-01-01'),booking('active','in_progress','2021-01-01'),booking('done','completed','2020-01-01')];
 assert.deepEqual(customerActivityBookings(rows,'upcoming').map(x=>x.id),['late','active','future']);assert.equal(rows[0].id,'future','does not mutate the account snapshot');
});
test('history includes terminal outcomes, while subscriptions are separate',()=>{const rows=['completed','cancelled','refunded','assigned'].map(s=>booking(s,s,'2026-01-01'));assert.deepEqual(customerActivityBookings(rows,'completed').map(x=>x.id),['completed','cancelled','refunded']);assert.deepEqual(customerActivityBookings(rows,'subscriptions'),[]);});
test('management links retain the exact booking identifier and only target supported routes',()=>{for(const [serviceCode,path] of [['boarding','boarding'],['pet_sitting','sitting'],['dog_walking','walking'],['pet_taxi','taxi']])assert.equal(customerBookingManageHref({id:'B & 1',serviceCode,status:'assigned',scheduledStart:''}),`/${path}/manage?bookingId=B%20%26%201`);assert.equal(customerBookingManageHref({id:'B',serviceCode:'pet_food',status:'assigned',scheduledStart:''}),null);});
