import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney,routeCall} from './helpers/grooming-journey-harness.mjs';
import {seedOwnedPet} from './helpers/saved-pet-fixture.mjs';

async function pending(ctx){
 const start=new Date(Date.now()+9*86400000);start.setUTCHours(18,30,0,0);
 await seedOwnedPet(ctx.db,'PENDING-CUSTOMER','PENDING-PET','Pending test dog');
 const input={clientRequestId:'PENDING-ADMIN-GROUP',customerId:'PENDING-CUSTOMER',petIds:['PENDING-PET'],serviceCode:'grooming',assignmentStrategy:'admin_choice',serviceAddress:'42 Test Road, Indiranagar, Bengaluru',servicePincode:'560038',scheduledStart:new Date(start.getTime()-13*3600000).toISOString(),scheduledEnd:new Date(start.getTime()-11*3600000).toISOString()};
 const result=await routeCall('../../app/api/uat-scheduling/route.ts','POST','/api/uat-scheduling',input);
 assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.status,'awaiting_admin');
 return input;
}
async function board(date){
 const {GET}=await import('../app/api/uat-scheduling/route.ts');
 const response=await GET(new Request(`https://uat.pawspace.in/api/uat-scheduling?date=${date}`,{headers:{'oai-authenticated-user-email':'closure-admin@pawspace.test'}}));
 return {status:response.status,body:await response.json()};
}

test('saved awaiting-admin request remains visible with zero reservations; cancellation removes it',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx);
 const result=await board(input.scheduledStart.slice(0,10));assert.equal(result.status,200);
 assert.equal(result.body.data.total,0);assert.deepEqual(result.body.data.providers,[]);
 const [row]=result.body.data.pendingRequests;assert.equal(row.groupId,input.clientRequestId);assert.equal(row.customerId,input.customerId);assert.equal(row.status,'awaiting_admin');assert.equal(row.petCount,1);assert.equal(row.occurrences[0].start,input.scheduledStart);assert.equal(row.shortlist,undefined);
 const next=new Date(Date.parse(input.scheduledStart)+86400000).toISOString().slice(0,10);assert.deepEqual((await board(next)).body.data.pendingRequests,[]);
 const cancelled=await routeCall('../../app/api/uat-scheduling/route.ts','POST','/api/uat-scheduling',{action:'cancel',groupId:input.clientRequestId,reason:'Customer no longer needs this appointment'});assert.equal(cancelled.status,200);assert.deepEqual((await board(input.scheduledStart.slice(0,10))).body.data.pendingRequests,[]);
});

test('waiting recurring visits and overnight care appear on every relevant IST day',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx);
 const stored=ctx.sqlite.prepare('SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?').get(input.clientRequestId);const payload=JSON.parse(stored.shortlist_json);
 payload.request={...payload.request,serviceCode:'dog_walking',occurrences:2,cadenceDays:2};
 ctx.sqlite.prepare('UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?').run(JSON.stringify(payload),input.clientRequestId);
 const later=new Date(Date.parse(input.scheduledStart)+2*86400000).toISOString().slice(0,10);const visit=(await board(later)).body.data.pendingRequests[0];assert.equal(visit.occurrences[0].occurrenceNumber,2);
 payload.request={...payload.request,serviceCode:'boarding',scheduledEnd:new Date(Date.parse(input.scheduledStart)+3*86400000).toISOString()};
 ctx.sqlite.prepare('UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?').run(JSON.stringify(payload),input.clientRequestId);
 assert.equal((await board(later)).body.data.pendingRequests.length,1);
});

test('waiting list uses IST boundaries and survives a decisions-only database',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx);
 const stored=ctx.sqlite.prepare('SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?').get(input.clientRequestId);const payload=JSON.parse(stored.shortlist_json);
 const day=input.scheduledStart.slice(0,10);payload.request.scheduledStart=`${day}T18:30:00.000Z`;payload.request.scheduledEnd=`${day}T20:30:00.000Z`;
 ctx.sqlite.prepare('UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?').run(JSON.stringify(payload),input.clientRequestId);
 ctx.sqlite.exec('DROP TABLE scheduling_reservations');
 assert.deepEqual((await board(day)).body.data.pendingRequests,[]);
 const tomorrow=new Date(Date.parse(input.scheduledStart)+86400000).toISOString().slice(0,10);assert.equal((await board(tomorrow)).body.data.pendingRequests.length,1);
});
