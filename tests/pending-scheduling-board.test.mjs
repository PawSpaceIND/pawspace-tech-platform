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

const operation=(groupId,action,providerId)=>routeCall('../../app/api/uat-scheduling/route.ts','POST','/api/uat-scheduling',{groupId,action,providerId,reason:'Verified request from the operations desk'});
const decision=(ctx,id)=>ctx.sqlite.prepare('SELECT * FROM scheduling_assignment_decisions WHERE group_id=?').get(id);
const active=(ctx,id)=>ctx.sqlite.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' ORDER BY id").all(id);

for(const boundary of ['release','dispatch'])for(const winnerAction of ['assign','manual','cancel'])test(`a concurrent ${winnerAction} wins before the stale assignment ${boundary}`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId;
 const choices=JSON.parse(decision(ctx,groupId).shortlist_json).choices.map(choice=>choice.provider.id);
 if(boundary==='dispatch'&&winnerAction==='assign')ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET provider_model='commission' WHERE id=?").run(choices[1]);
 let injected=false,winner,saved,rows,offers,audits;
 ctx.db.beforeBatch=async statements=>{
  const target=boundary==='release'?"UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=":"INSERT INTO scheduling_reservations (";
  if(!injected&&statements.some(statement=>statement._sql?.startsWith(target))){
   injected=true;winner=await operation(groupId,winnerAction,choices[1]);assert.equal(winner.status,200,JSON.stringify(winner.body));saved=decision(ctx,groupId);rows=active(ctx,groupId);
   offers=ctx.sqlite.prepare('SELECT * FROM provider_assignment_offers WHERE group_id=?').all(groupId);
   audits=ctx.sqlite.prepare("SELECT * FROM security_audit_events WHERE resource_id=? AND outcome='completed' ORDER BY id").all(groupId);
  }
 };
 const stale=await operation(groupId,'assign',choices[0]);
 assert.equal(injected,true);assert.equal(stale.status,409,JSON.stringify(stale.body));assert.equal(stale.body.code,'SCHEDULING_DECISION_CHANGED');
 assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),rows);assert.equal(rows.length,winnerAction==='cancel'?0:1);
 assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM provider_assignment_offers WHERE group_id=?').all(groupId),offers);
 assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM security_audit_events WHERE resource_id=? AND outcome='completed' ORDER BY id").all(groupId),audits);
 if(boundary==='dispatch'&&winnerAction==='assign'){assert.equal(offers.length,1);assert.equal(offers[0].provider_id,choices[1]);assert.equal(offers[0].status,'pending');}
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM scheduling_dispatch_assertions').get().n,0);
});

test('normal staff assignment removes the waiting request and refuses duplicate or missing selections',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId;
 const choices=JSON.parse(decision(ctx,groupId).shortlist_json).choices.map(choice=>choice.provider.id);
 assert.equal((await operation(groupId,'assign',undefined)).status,400);assert.equal(active(ctx,groupId).length,0);
 const first=await operation(groupId,'assign',choices[0]);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data.provider.id,choices[0]);
 assert.deepEqual((await board(input.scheduledStart.slice(0,10))).body.data.pendingRequests,[]);
 const saved=decision(ctx,groupId),rows=active(ctx,groupId);
 const replay=await operation(groupId,'assign',choices[0]);assert.equal(replay.status,409);assert.equal(replay.body.code,'SCHEDULING_DECISION_CHANGED');assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),rows);
});

test('unavailable recommended provider leaves the request waiting and does not claim an existing assignment',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId;
 const saved=decision(ctx,groupId),provider=JSON.parse(saved.shortlist_json).choices[0].provider.id;
 ctx.sqlite.prepare("UPDATE provider_capacity_profiles SET status='inactive'").run();
 const response=await operation(groupId,'assign',provider);assert.equal(response.status,409);assert.match(response.body.error,/still needs admin assignment/);assert.equal(response.body.restored,false);assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),[]);assert.equal((await board(input.scheduledStart.slice(0,10))).body.data.pendingRequests.length,1);
});

for(const action of ['assign','manual','reassign'])for(const timing of ['past','short_notice'])test(`${action} refuses a saved request whose appointment is ${timing}`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId,saved=decision(ctx,groupId),provider=JSON.parse(saved.shortlist_json).choices[0].provider.id;
 const now=Date.now;Date.now=()=>Date.parse(input.scheduledStart)+(timing==='past'?7200000:-60000);
 let response;try{response=await operation(groupId,action,provider);}finally{Date.now=now;}
 assert.equal(response.status,400,JSON.stringify(response.body));assert.equal(response.body.code,timing==='past'?'start_in_past':'below_minimum_lead_time');assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),[]);
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM provider_assignment_offers WHERE group_id=?').get(groupId).n,0);
});

test('a tightened booking horizon is applied to the saved shortlist',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId,saved=decision(ctx,groupId),provider=JSON.parse(saved.shortlist_json).choices[0].provider.id;
 const updated=ctx.sqlite.prepare("UPDATE service_policy_configs SET config_json=json_set(config_json,'$.maximumHorizonDays',1),version=version+1 WHERE policy_domain='booking_time_policy' AND service_code='grooming'").run();assert.ok(updated.changes>0);
 const response=await operation(groupId,'assign',provider);assert.equal(response.status,400,JSON.stringify(response.body));assert.equal(response.body.code,'beyond_booking_horizon');assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),[]);
});

test('lead time is checked again after the scheduling evaluation begins',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId,saved=decision(ctx,groupId),provider=JSON.parse(saved.shortlist_json).choices[0].provider.id;
 const now=Date.now;let advanced=false;
 ctx.db.beforeBatch=async statements=>{if(!advanced&&statements.some(s=>s._sql?.startsWith("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id="))){advanced=true;Date.now=()=>Date.parse(input.scheduledStart)-60000;}};
 let response;try{response=await operation(groupId,'assign',provider);}finally{Date.now=now;}
 assert.equal(advanced,true);assert.equal(response.status,400,JSON.stringify(response.body));assert.equal(response.body.code,'below_minimum_lead_time');assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),[]);
});

test('an expired waiting request can still be cancelled',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId;
 const now=Date.now;Date.now=()=>Date.parse(input.scheduledEnd)+86400000;
 let response;try{response=await operation(groupId,'cancel');}finally{Date.now=now;}
 assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(decision(ctx,groupId).status,'cancelled');assert.deepEqual(active(ctx,groupId),[]);
});

test('a reassign refused after evaluation restores the original reservation',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId;
 const choices=JSON.parse(decision(ctx,groupId).shortlist_json).choices.map(choice=>choice.provider.id);
 assert.equal((await operation(groupId,'assign',choices[0])).status,200);
 const saved=decision(ctx,groupId),rows=active(ctx,groupId),now=Date.now;let advanced=false;
 ctx.db.beforeBatch=async statements=>{if(!advanced&&statements.some(s=>s._sql?.startsWith("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id="))){advanced=true;Date.now=()=>Date.parse(input.scheduledStart)-60000;}};
 let response;try{response=await operation(groupId,'reassign',choices[1]);}finally{Date.now=now;}
 assert.equal(advanced,true);assert.equal(response.status,400,JSON.stringify(response.body));assert.equal(response.body.code,'below_minimum_lead_time');assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),rows);
});

for(const action of ['assign','cancel'])test(`a stale day-board revision cannot ${action} changed appointment details`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=await pending(ctx),groupId=input.clientRequestId;
 const old=(await board(input.scheduledStart.slice(0,10))).body.data.pendingRequests[0];assert.match(old.revision,/^[a-f0-9]{64}$/);assert.ok(old.candidates.length);assert.equal(old.candidates[0].providerName,JSON.parse(decision(ctx,groupId).shortlist_json).choices[0].provider.name);
 const payload=JSON.parse(decision(ctx,groupId).shortlist_json);payload.request.serviceAddress='Updated doorstep address';ctx.sqlite.prepare('UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?').run(JSON.stringify(payload),groupId);
 const saved=decision(ctx,groupId),current=(await board(input.scheduledStart.slice(0,10))).body.data.pendingRequests[0];assert.notEqual(current.revision,old.revision);assert.equal(current.updatedAt,old.updatedAt);
 const response=await routeCall('../../app/api/uat-scheduling/route.ts','POST','/api/uat-scheduling',{action,groupId,providerId:old.candidates[0].providerId,expectedRevision:old.revision,reason:'Reviewed the saved request'});
 assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(response.body.code,'SCHEDULING_DECISION_CHANGED');assert.deepEqual(decision(ctx,groupId),saved);assert.deepEqual(active(ctx,groupId),[]);
 const accepted=await routeCall('../../app/api/uat-scheduling/route.ts','POST','/api/uat-scheduling',{action,groupId,providerId:current.candidates[0].providerId,expectedRevision:current.revision,reason:'Reviewed the updated request'});assert.equal(accepted.status,200,JSON.stringify(accepted.body));
});
