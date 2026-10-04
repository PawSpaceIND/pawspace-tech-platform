import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorld,seedBooking,seedRoster,seedAsset,DOORSTEP,REPORT,sessionStart,sessionEnd,sessionDate,TRAINER,OTHER_TRAINER,CUSTOMER,sessionCookie,routeCall} from './helpers/training-lifecycle-harness.mjs';
import {seedOwnedPet} from './helpers/saved-pet-fixture.mjs';
const capacity=await import('../lib/provider-capacity-governance.ts');
const dispatch=await import('../lib/training-assignment-dispatch.ts');
const commercial=await import('../lib/training-commercial-governance.ts');
const programme=await import('../lib/training-programme.ts');
const life=await import('../lib/training-session-lifecycle.ts');
const broadcast=await import('../lib/training-broadcast-integration.ts');
const scheduling=await import('../app/api/uat-scheduling/route.ts');
const offerRoute=await import('../app/api/training-assignment-offers/route.ts');
const sessionsRoute=await import('../app/api/training-sessions/route.ts');
const canonicalRoute=await import('../app/api/canonical-bookings/route.ts');
const programmesRoute=await import('../app/api/training-programmes/route.ts');

async function fixture({fullTime=false,throughScheduler=false,throughCanonical=false,tamperedModel,beforeMaterialize}={}) {
 const w=freshWorld({PAWSPACE_SCHEDULING_ENV:'production',PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE:'on'});
 await dispatch.ensureTrainingDispatchTables(w.db);await capacity.seedProviderCapacityDefaults(w.db);
 const {seedAssignmentPolicies}=await import('../lib/provider-assignment-policy.ts');await seedAssignmentPolicies(w.db);
 w.sqlite.prepare('UPDATE provider_capacity_profiles SET live=0').run();
 for(const [id,model,quality] of [[TRAINER,'commission',95],[OTHER_TRAINER,fullTime?'full_time':'commission',80],['train_next','commission',70]]) {
  w.sqlite.prepare("INSERT INTO provider_capacity_profiles(id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,effective_from,updated_by,updated_at) VALUES(?,'blr',?,?,'[\"dog_training\"]','[\"blr-east\"]',1,5,?,1,30,6,3,'active','2020-01-01','fixture',?) ON CONFLICT(id) DO UPDATE SET live=1,provider_model=excluded.provider_model,quality_score=excluded.quality_score,capacity=1,travel_buffer_minutes=30,max_daily_jobs=6").run(id,id,model,quality,Date.now());
  seedRoster(w,id,sessionDate(0));
 }
 w.sqlite.prepare("UPDATE scheduling_availability SET source='roster'").run();
 await seedOwnedPet(w.db,CUSTOMER,'broadcast-pet','QA Dog');
 const quote=await commercial.createTrainingQuote(w.db,{packageCode:'training-4-puppy',petCount:1,scheduledStart:sessionStart(0),paymentMode:'prepaid',schedulingMode:'rolling_v1'});
 const request={clientRequestId:'G1',customerId:CUSTOMER,cityId:'blr',zoneId:'blr-east',serviceCode:'dog_training',petIds:['broadcast-pet'],scheduledStart:sessionStart(0),scheduledEnd:sessionEnd(0),occurrences:1,serviceAddress:'12 MG Road, Bengaluru',servicePincode:'560038',trainingQuoteId:quote.quoteId,trainingSchedulingMode:'rolling_v1'};
 let providerId=fullTime?OTHER_TRAINER:TRAINER,provider,bookingId="B1";
 if(throughScheduler) {
  const customerCookie=await sessionCookie(w.db,'customer',CUSTOMER);
  const reserved=await routeCall(scheduling.POST,'POST','/api/uat-scheduling',{cookie:customerCookie,body:request});
  assert.equal(reserved.status,200,JSON.stringify(reserved.body)); providerId=reserved.body.data.provider.id;provider=reserved.body.data.provider;
  const saved=JSON.parse(w.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id='G1'").get().shortlist_json);
  assert.equal(saved.trainingDispatchVersion,1);assert.ok(saved.evaluations.length>=3);
 } else {
  w.sqlite.exec("CREATE TABLE scheduling_assignment_decisions(group_id TEXT PRIMARY KEY,strategy TEXT,shortlist_json TEXT,selected_provider_id TEXT,status TEXT,actor_id TEXT,reason TEXT,updated_at INTEGER);CREATE TABLE scheduling_rules(id TEXT PRIMARY KEY,service_code TEXT,city_id TEXT,zone_id TEXT,condition_json TEXT,active INTEGER,priority INTEGER)");
  w.sqlite.prepare("INSERT INTO scheduling_assignment_decisions VALUES('G1','auto',?,?,'assigned','fixture',NULL,?)").run(JSON.stringify({request,trainingDispatchVersion:1,trainingProviderModel:fullTime?'full_time':'commission'}),providerId,Date.now());
 }
 if(throughCanonical){
  const cookie=await sessionCookie(w.db,'customer',CUSTOMER);
  const booked=await routeCall(canonicalRoute.POST,'POST','/api/canonical-bookings',{cookie,body:{idempotencyKey:'G1',scheduleGroupId:'G1',customer:{id:CUSTOMER,name:'Trisha Kumar',primaryPhone:'+91-9000000001'},pets:[{sourceId:'broadcast-pet',name:'QA Dog',species:'dog',vaccinationStatus:'verified'}],cityId:'blr',zoneId:'blr-east',serviceCode:'dog_training',packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:sessionStart(0),scheduledEnd:sessionEnd(0),provider:{...provider,...(tamperedModel?{model:tamperedModel}:{})},totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:'upi',mode:quote.paymentMode,status:'created',detail:'Synthetic local fixture'},pricing:{discount:0,trainingQuoteId:quote.quoteId}}});
  assert.equal(booked.status,201,JSON.stringify(booked.body));bookingId=booked.body.data.bookingId;
  const expected=fullTime?providerId:broadcast.trainingBroadcastOwner(bookingId);for(const [table,ids]of Object.entries(owners(w)))if(!['training_programmes','training_sessions'].includes(table))assert.deepEqual(ids,[expected],table);
  const {ensurePaymentReconciliationTables}=await import('../lib/grooming-payment-reconciliation.ts');const capture=await import('../lib/razorpay-capture-atomic.ts');await ensurePaymentReconciliationTables(w.db);
  const captured=await capture.commitRazorpayCaptureAtomic(w.db,{authority:'provider_api',eventId:'qa-local-capture',environment:'sandbox',bookingId,paymentId:booked.body.data.paymentId,gatewayOrderId:'order_local',gatewayPaymentId:'pay_local',amountPaise:quote.amountDueNow*100,currency:'INR',payloadHash:'local-fixture'});
  const effects=await capture.executeRazorpayCapturePostCommit(w.db,{outboxId:captured.effectsOutboxId,workerId:'qa-local-capture'});assert.equal(effects.completed,true,JSON.stringify(effects));
  assert.equal(w.sqlite.prepare('SELECT status FROM canonical_bookings WHERE id=?').get(bookingId).status,'confirmed');
 }else{
 seedBooking(w,{id:'B1',group:'G1',provider:providerId,sessions:1,reservations:!throughScheduler,total:quote.totalAmount,dueNow:quote.amountDueNow,packageCode:quote.packageCode,packageName:quote.packageName,governedPayment:false});
 const terms=await commercial.governTrainingBooking(w.db,{quoteId:quote.quoteId,packageCode:quote.packageCode,packageName:quote.packageName,petCount:1,scheduledStart:sessionStart(0),submittedTotal:quote.totalAmount,submittedAmountDueNow:quote.amountDueNow,paymentMode:quote.paymentMode,paymentStatus:'created',reservationCount:1,reservationWindows:[{start:sessionStart(0),end:sessionEnd(0)}]});
 await commercial.captureTrainingQuoteSandbox(w.db,{quoteId:quote.quoteId,amount:quote.amountDueNow,paymentKey:'isolated-local-fixture'});await commercial.trainingQuoteLinkStatement(w.db,quote.quoteId,'B1').run();await commercial.consumeTrainingQuote(w.db,quote.quoteId,'B1');
 w.sqlite.prepare("UPDATE canonical_bookings SET pricing_json=? WHERE id='B1'").run(JSON.stringify({trainingCommercial:terms}));
 const now=Date.now();w.sqlite.prepare("INSERT INTO provider_work_orders VALUES('W1','B1','G1',?,?,?,'dog_training',?,?,1,?,'{}',?,?)").run(providerId,providerId,fullTime?'full_time':'commission',sessionStart(0),sessionEnd(0),fullTime?'assigned':'awaiting_acceptance',now,now);
 if(!throughScheduler&&!fullTime)w.sqlite.prepare("INSERT INTO provider_assignment_offers(group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES('G1','B1',?,'pending',?,?,1,?)").run(providerId,now,now+180000,now);
 }
 if(beforeMaterialize)await beforeMaterialize(w);
 const created=await routeCall(programmesRoute.POST,'POST','/api/training-programmes',{cookie:await sessionCookie(w.db,'customer',CUSTOMER),body:{bookingId}});
 assert.equal(created.status,201,JSON.stringify(created.body));
 return {...w,first:created.body.data.sessions[0],quote,providerId,request,bookingId,assignment:created.body.data.assignment};
}
const input=(w,id=OTHER_TRAINER,key='accept-other')=>({bookingId:w.bookingId,sessionId:w.first.id,providerId:id,idempotencyKey:key,actorId:'trainer:'+id});
const refusal=async(p,status=409)=>assert.rejects(p,e=>e instanceof Response&&e.status===status);
const owners=w=>Object.fromEntries(['canonical_bookings','provider_work_orders','training_programmes','training_sessions','scheduling_reservations'].filter(t=>w.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)).map(t=>[t,w.sqlite.prepare('SELECT provider_id FROM '+t).all().map(r=>r.provider_id)]));
function unclaimed(w) {assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_broadcast_claims').get().n,0);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_session_events').get().n,0);assert.equal(w.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(w.first.id).status,'scheduled');assert.ok(w.sqlite.prepare('SELECT provider_id FROM training_programmes').get().provider_id.startsWith('training-broadcast:'));}

test('normal scheduler + customer programme route broadcasts all eligible contractors and withholds provisional session access',async()=>{
 const w=await fixture({throughScheduler:true});
 const evaluated=JSON.parse(w.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id='G1'").get().shortlist_json).evaluations;
 assert.deepEqual(w.sqlite.prepare('SELECT provider_id FROM training_broadcast_offers ORDER BY provider_id').all().map(r=>r.provider_id),evaluated.filter(r=>r.eligible).map(r=>r.providerId).sort());
 assert.ok(w.sqlite.prepare('SELECT COUNT(*) n FROM training_broadcast_offers').get().n>=2);
 assert.equal(new Set(w.sqlite.prepare('SELECT expires_at FROM training_broadcast_offers').all().map(r=>r.expires_at)).size,1);
 assert.equal(w.sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id='G1'").get().status,'withdrawn');
 const cookie=await sessionCookie(w.db,'provider',TRAINER);
 const inbox=await routeCall(offerRoute.GET,'GET','/api/training-assignment-offers?providerId='+TRAINER,{cookie});assert.equal(inbox.status,200);assert.equal(inbox.body.data.length,1);assert.equal(inbox.body.data[0].customerId,undefined);assert.equal(inbox.body.data[0].address,undefined);
 assert.deepEqual((await routeCall(sessionsRoute.GET,'GET','/api/training-sessions?providerId='+TRAINER,{cookie})).body.data,[]);
 assert.equal((await routeCall(sessionsRoute.POST,'POST','/api/training-sessions',{cookie,body:{sessionId:w.first.id,action:'accept',idempotencyKey:'bypass'}})).status,403);
});
test('full-time normal route wins the tier and travels without any broadcast or Accept',async()=>{
 const w=await fixture({fullTime:true,throughScheduler:true});assert.equal(w.providerId,OTHER_TRAINER);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='training_broadcast_offers'").get().n,0);
 const result=await life.mutateTrainingSession(w.db,{sessionId:w.first.id,action:'on_the_way',actorId:'trainer:'+OTHER_TRAINER,idempotencyKey:'staff-travel'});assert.equal(result.status,'on_the_way');
});
test('two eligible acceptors race: one winner transfers all canonical rows and lifecycle, closes losers and exactly replays',async()=>{
 const w=await fixture();const settled=await Promise.allSettled([broadcast.acceptTrainingBroadcast(w.db,input(w)),broadcast.acceptTrainingBroadcast(w.db,input(w,TRAINER,'accept-first'))]);
 assert.equal(settled.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(settled));const winner=w.sqlite.prepare('SELECT * FROM training_broadcast_claims').get();
 for(const ids of Object.values(owners(w)))assert.deepEqual(ids,[winner.provider_id]);
 assert.equal(w.sqlite.prepare('SELECT status,provider_id FROM provider_lifecycle_records').get().status,'accepted');assert.equal(w.sqlite.prepare('SELECT provider_id FROM provider_lifecycle_records').get().provider_id,winner.provider_id);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_offers WHERE status='accepted'").get().n,1);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_offers WHERE status='pending'").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT status FROM provider_work_orders").get().status,'assigned');assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_session_events').get().n,1);
 assert.equal((await broadcast.acceptTrainingBroadcast(w.db,input(w,winner.provider_id,winner.idempotency_key))).duplicatePrevented,true);
 await refusal(broadcast.acceptTrainingBroadcast(w.db,input(w,winner.provider_id,'new-key')));await refusal(broadcast.acceptTrainingBroadcast(w.db,{...input(w,winner.provider_id,winner.idempotency_key),sessionId:'foreign-session'}),403);
});
test('owned offer route and both real gateways authorize accept, refuse foreign scope and support replay after ownership transfer',async()=>{
 const w=await fixture(),cookie=await sessionCookie(w.db,'provider',OTHER_TRAINER),body={...input(w),action:'accept'};
 const {authorizePlatformSessionRequest}=await import('../lib/session-api-gateway.ts');const {authorizeApiRequest}=await import('../lib/api-gateway.ts');
 const req=(providerId)=>new Request('https://app.pawspace.in/api/training-assignment-offers',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({...body,providerId})});
 assert.equal((await authorizePlatformSessionRequest(req(OTHER_TRAINER),w.db)).permission,'bookings.view');assert.equal((await authorizeApiRequest(req(OTHER_TRAINER),{DB:w.db})).permission,'bookings.view');
 assert.equal((await authorizePlatformSessionRequest(req(TRAINER),w.db)).status,403);
 const foreign=await routeCall(offerRoute.POST,'POST','/api/training-assignment-offers',{cookie,body:{...body,providerId:TRAINER}});assert.equal(foreign.status,403);
 const accepted=await routeCall(offerRoute.POST,'POST','/api/training-assignment-offers',{cookie,body});assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.data.status,'accepted');
 assert.equal((await routeCall(offerRoute.POST,'POST','/api/training-assignment-offers',{cookie,body})).body.data.duplicatePrevented,true);
 const sessions=await routeCall(sessionsRoute.GET,'GET','/api/training-sessions?providerId='+OTHER_TRAINER,{cookie});assert.equal(sessions.body.data[0].status,'accepted');assert.equal(sessions.body.data[0].providerModel,'commission');
});
test('decline affects only its recipient; exhaustion and expiry open one Ops case with replay and no sequential reoffer',async()=>{
 const w=await fixture();for(const id of [TRAINER,OTHER_TRAINER,'train_next']) {const decline={...input(w,id,'decline-'+id),action:'decline',reason:'Unavailable'};assert.equal((await broadcast.respondTrainingBroadcast(w.db,decline)).status,'declined');assert.equal((await broadcast.respondTrainingBroadcast(w.db,decline)).duplicatePrevented,true);}
 assert.equal(w.sqlite.prepare('SELECT state FROM training_assignment_chains').get().state,'needs_operations');assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_ops_cases').get().n,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_attempts').get().n,0);
 const expired=await fixture();expired.sqlite.prepare('UPDATE training_broadcast_offers SET expires_at=1').run();const swept=await dispatch.runTrainingOfferExpirySweep(expired.db);assert.ok(swept.scanned>0);assert.equal(expired.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_ops_cases').get().n,1);await dispatch.runTrainingOfferExpirySweep(expired.db);assert.equal(expired.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_ops_cases').get().n,1);
 await refusal(broadcast.acceptTrainingBroadcast(expired.db,input(expired)));unclaimed(expired);
});
test('cancelled booking, payment reversal, decline, expiry and roster changes fail before acceptance',async()=>{
 for(const kind of ['cancelled','payment','declined','expired','roster','capacity']) {const w=await fixture();
  if(kind==='cancelled')w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled'").run();
  if(kind==='payment')w.sqlite.prepare("UPDATE booking_payments SET status='refunded'").run();
  if(kind==='declined')w.sqlite.prepare("UPDATE training_broadcast_offers SET status='declined' WHERE provider_id=?").run(OTHER_TRAINER);
  if(kind==='expired')w.sqlite.prepare('UPDATE training_broadcast_offers SET expires_at=1').run();
  if(kind==='roster')w.sqlite.prepare("UPDATE scheduling_availability SET windows_json='[]' WHERE provider_id=?").run(OTHER_TRAINER);
  if(kind==='capacity')w.sqlite.prepare("INSERT INTO scheduling_reservations(id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) SELECT 'RACE','OTHER',?,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at FROM scheduling_reservations LIMIT 1").run(OTHER_TRAINER);
  await refusal(broadcast.acceptTrainingBroadcast(w.db,input(w)));unclaimed(w);
 }
});
test('roster/capacity/payment/cancellation/expiry drift at batch commit and zero-row ownership effects roll back claim, offers, owners and lifecycle',async()=>{
 for(const kind of ['roster','capacity','payment','cancelled','expired','zero-row']) {const w=await fixture(),before=owners(w),batch=w.db.batch.bind(w.db);let injected=false;
  w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.startsWith('INSERT INTO training_broadcast_claims'))) {injected=true;
    if(kind==='roster')w.sqlite.prepare("UPDATE scheduling_availability SET windows_json='[]' WHERE provider_id=?").run(OTHER_TRAINER);
    if(kind==='capacity')w.sqlite.prepare("INSERT INTO scheduling_reservations(id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) SELECT 'RACE','OTHER',?,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at FROM scheduling_reservations LIMIT 1").run(OTHER_TRAINER);
    if(kind==='payment')w.sqlite.prepare("UPDATE booking_payments SET status='refunded'").run();
    if(kind==='cancelled')w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled'").run();
    if(kind==='expired')w.sqlite.prepare('UPDATE training_broadcast_offers SET expires_at=1').run();
    if(kind==='zero-row')statements=statements.map(s=>s.sql.startsWith('UPDATE provider_work_orders SET')?w.db.prepare('SELECT 1'):s);
   }return batch(statements);};
  await refusal(broadcast.acceptTrainingBroadcast(w.db,input(w)));assert.equal(injected,true,kind);unclaimed(w);
  for(const [table,ids] of Object.entries(before))assert.deepEqual(owners(w)[table].slice(0,ids.length),ids,kind+':'+table);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_offers WHERE status='pending'").get().n,3);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_broadcast_assertions').get().n,0);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM provider_lifecycle_records WHERE lease_token IS NOT NULL').get().n,0);
 }
});
test('initial broadcast insertion failure rolls back programme, entitlement and every offer',async()=>{
 await assert.rejects(fixture({beforeMaterialize(w){w.sqlite.exec("CREATE TRIGGER fail_broadcast BEFORE INSERT ON training_assignment_chains BEGIN SELECT RAISE(ABORT,'fixture failure');END");const batch=w.db.batch.bind(w.db);w.db.batch=async statements=>{try{return await batch(statements)}catch(e){if(statements.some(s=>s.sql.includes('INSERT INTO training_programmes'))) {assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_programmes').get().n,0);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_sessions').get().n,0);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_broadcast_offers').get().n,0);}throw e;}};}}));
});


test('actual canonical booking POST withholds pending ownership and preserves the authoritative staff model',async()=>{
 for(const fullTime of [false,true]){
  const w=await fixture({throughScheduler:true,throughCanonical:true,fullTime,tamperedModel:fullTime?'commission':'full_time'});
  assert.equal(w.sqlite.prepare('SELECT provider_model FROM provider_work_orders').get().provider_model,fullTime?'full_time':'commission');
  assert.equal(w.assignment.state,fullTime?'assigned':'pending');assert.equal(w.assignment.providerId,fullTime?OTHER_TRAINER:null);
  if(!fullTime){
   const feed=await import('../lib/partner-job-feed.ts');const pending=await feed.listProviderJobs(w.db,TRAINER);assert.deepEqual(pending.upcoming,[]);assert.deepEqual(pending.today,[]);
   const workspace=await import('../lib/provider-workspace.ts');await assert.rejects(workspace.submitJobProof(w.db,{providerId:TRAINER,bookingId:w.bookingId,proofType:'reached',distanceKm:0}),/not assigned/);
   assert.equal((await broadcast.acceptTrainingBroadcast(w.db,input(w))).status,'accepted');for(const ids of Object.values(owners(w)))assert.deepEqual(ids,[OTHER_TRAINER]);
  }else assert.equal((await life.mutateTrainingSession(w.db,{sessionId:w.first.id,action:'on_the_way',actorId:'trainer:'+OTHER_TRAINER,idempotencyKey:'actual-ft-travel'})).status,'on_the_way');
 }
});

test('staff becoming eligible between reservation and programme materialization is assigned without Accept',async()=>{
 const w=await fixture({throughScheduler:true,throughCanonical:true,beforeMaterialize(w){w.sqlite.prepare("UPDATE provider_capacity_profiles SET provider_model='full_time' WHERE id=?").run(OTHER_TRAINER);}});
 assert.equal(w.assignment.mode,'full_time');assert.equal(w.assignment.state,'assigned');
 for(const ids of Object.values(owners(w)))assert.deepEqual(ids,[OTHER_TRAINER]);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_broadcast_offers').get().n,0);
 assert.equal((await life.mutateTrainingSession(w.db,{sessionId:w.first.id,action:'on_the_way',actorId:'trainer:'+OTHER_TRAINER,idempotencyKey:'newly-staff-travel'})).status,'on_the_way');
});

const expire=async w=>{w.sqlite.prepare("UPDATE training_broadcast_offers SET expires_at=1 WHERE status='pending'").run();await dispatch.runTrainingOfferExpirySweep(w.db);};
const retry=(w,key='retry-round-2')=>({bookingId:w.bookingId,idempotencyKey:key,reason:'Operations recovered roster coverage',actorId:'ops@example.test'});
test('staff retry excludes declines, keeps the original deadline, reopens Ops on second expiry and enforces attempt budget',async()=>{
 const w=await fixture();await broadcast.respondTrainingBroadcast(w.db,{...input(w,TRAINER,'decline-retry'),action:'decline',reason:'Unavailable'});await expire(w);
 const original=w.sqlite.prepare('SELECT started_at,ops_due_at FROM training_assignment_chains').get();
 const cookie=await sessionCookie(w.db,'provider',OTHER_TRAINER);assert.equal((await routeCall(offerRoute.POST,'POST','/api/training-assignment-offers',{cookie,body:{...retry(w),action:'retry_broadcast'}})).status,403);
 const result=await routeCall(offerRoute.POST,'POST','/api/training-assignment-offers',{preview:true,body:{...retry(w),action:'retry_broadcast'}});assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal((await broadcast.retryTrainingBroadcast(w.db,retry(w))).duplicatePrevented,true);
 assert.deepEqual(w.sqlite.prepare("SELECT provider_id FROM training_broadcast_offers WHERE status='pending' ORDER BY provider_id").all().map(r=>r.provider_id),[OTHER_TRAINER,'train_next'].sort());
 assert.deepEqual(w.sqlite.prepare('SELECT started_at,ops_due_at FROM training_assignment_chains').get(),original);
 assert.ok(w.sqlite.prepare("SELECT MAX(expires_at) expiry FROM training_broadcast_offers WHERE status='pending'").get().expiry<=original.ops_due_at);
 await expire(w);assert.equal(w.sqlite.prepare('SELECT status FROM training_assignment_ops_cases').get().status,'open');assert.equal(w.sqlite.prepare('SELECT status FROM training_session_recovery_cases').get().status,'open');
 w.sqlite.prepare('UPDATE training_assignment_chains SET max_attempts=2').run();await refusal(broadcast.retryTrainingBroadcast(w.db,retry(w,'round-3')));
 w.sqlite.prepare('UPDATE training_assignment_chains SET max_attempts=5,ops_due_at=1').run();await refusal(broadcast.retryTrainingBroadcast(w.db,retry(w,'expired-total')));
});
test('retry can auto-assign newly available full-time staff; atomic retry audience and ownership failures roll back',async()=>{
 const staff=await fixture();await expire(staff);staff.sqlite.prepare("UPDATE provider_capacity_profiles SET provider_model='full_time' WHERE id=?").run(OTHER_TRAINER);
 assert.equal((await broadcast.retryTrainingBroadcast(staff.db,retry(staff))).state,'assigned');for(const ids of Object.values(owners(staff)))assert.deepEqual(ids,[OTHER_TRAINER]);
 assert.equal((await life.mutateTrainingSession(staff.db,{sessionId:staff.first.id,action:'on_the_way',actorId:'trainer:'+OTHER_TRAINER,idempotencyKey:'recovery-ft-travel'})).status,'on_the_way');
 for(const kind of ['capacity','payment','zero-offer','zero-owner']){
  const w=await fixture();await expire(w);if(kind==='zero-owner')w.sqlite.prepare("UPDATE provider_capacity_profiles SET provider_model='full_time' WHERE id=?").run(OTHER_TRAINER);
  const batch=w.db.batch.bind(w.db),before=owners(w);let injected=false;
  w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.includes('INSERT INTO training_assignment_responses'))){injected=true;
   if(kind==='capacity')w.sqlite.prepare("INSERT INTO scheduling_reservations(id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) SELECT 'RETRY-RACE','OTHER',?,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at FROM scheduling_reservations LIMIT 1").run(OTHER_TRAINER);
   if(kind==='payment')w.sqlite.prepare("UPDATE booking_payments SET status='refunded'").run();
   if(kind==='zero-offer')statements=statements.map(s=>s.sql.startsWith('INSERT INTO training_broadcast_offers')?w.db.prepare('SELECT 1'):s);
   if(kind==='zero-owner')statements=statements.map(s=>s.sql.startsWith('UPDATE provider_work_orders SET')?w.db.prepare('SELECT 1'):s);
  }return batch(statements);};
  await refusal(broadcast.retryTrainingBroadcast(w.db,retry(w)));assert.equal(injected,true,kind);
  for(const [table,ids] of Object.entries(before))assert.deepEqual(owners(w)[table].slice(0,ids.length),ids,kind+':'+table);
  assert.equal(w.sqlite.prepare('SELECT state FROM training_assignment_chains').get().state,'needs_operations');assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_offers WHERE status='pending'").get().n,0);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_assignment_responses WHERE idempotency_key='retry-round-2'").get().n,0);
 }
});
test('provider change during snapshot capture and changed offer windows reject a stale winner',async()=>{
 const w=await fixture(),prepare=w.db.prepare.bind(w.db);let drifted=false;
 w.db.prepare=sql=>{const statement=prepare(sql);if(!drifted&&sql.startsWith('SELECT MAX(travel_buffer_minutes)')){drifted=true;w.sqlite.prepare('UPDATE provider_capacity_profiles SET live=0 WHERE id=?').run(OTHER_TRAINER);}return statement;};
 await refusal(broadcast.acceptTrainingBroadcast(w.db,input(w)));assert.equal(drifted,true);unclaimed(w);
 const changed=await fixture();changed.sqlite.prepare("UPDATE training_sessions SET scheduled_start='2099-01-01T05:30:00.000Z'").run();await refusal(broadcast.acceptTrainingBroadcast(changed.db,input(changed)));unclaimed(changed);
 const offset=await fixture();const stored=JSON.parse(offset.sqlite.prepare('SELECT request_json FROM training_assignment_chains').get().request_json);for(const key of ['scheduledStart','scheduledEnd'])stored[key]=new Date(Date.parse(stored[key])+19800000).toISOString().replace('Z','+05:30');offset.sqlite.prepare('UPDATE training_assignment_chains SET request_json=?').run(JSON.stringify(stored));assert.equal((await broadcast.acceptTrainingBroadcast(offset.db,input(offset))).status,'accepted');
});

async function arrived(w){await broadcast.acceptTrainingBroadcast(w.db,input(w));for(const [action,extra]of [['on_the_way',{}],['arrive',DOORSTEP]])await life.mutateTrainingSession(w.db,{sessionId:w.first.id,action,actorId:'trainer:'+OTHER_TRAINER,idempotencyKey:'precheck-'+action,...extra});return{...w.first,provider_id:OTHER_TRAINER};}
const mutate=(w,action,key,extra={})=>life.mutateTrainingSession(w.db,{sessionId:w.first.id,action,actorId:'trainer:'+OTHER_TRAINER,idempotencyKey:key,...extra});
test('arrived provider saves attendance before capturing proof, then starts with captured photo awaiting approval',async()=>{
 const w=await fixture({throughScheduler:true,throughCanonical:true});await arrived(w);const cookie=await sessionCookie(w.db,'provider',OTHER_TRAINER),media=await import('../app/api/training-session-media/route.ts');
 const upload=(sha='a')=>routeCall(media.POST,'POST','/api/training-session-media',{cookie,body:{sessionId:w.first.id,purpose:'before_service',mimeType:'image/jpeg',sizeBytes:32,sha256:sha.repeat(64)}});
 await refusal(mutate(w,'start','precheck-missing'));assert.equal((await upload()).status,409);
 const saved=await routeCall(sessionsRoute.POST,'POST','/api/training-sessions',{cookie,body:{sessionId:w.first.id,action:'save_report',idempotencyKey:'precheck-attendance',report:{attendance:REPORT.attendance}}});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.status,'arrived');
 await refusal(mutate(w,'start','precheck-no-proof'));const registered=await upload();assert.equal(registered.status,201,JSON.stringify(registered.body));await refusal(mutate(w,'start','precheck-not-uploaded'));
 const grant=registered.body.data,confirmed=await routeCall(media.PATCH,'PATCH','/api/training-session-media',{cookie,body:{id:grant.id,action:'confirm_upload',uploadToken:grant.upload.token,storageReference:grant.upload.objectKey,observedSizeBytes:32,observedSha256:'a'.repeat(64),observedMimeType:'image/jpeg'}});assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
 assert.equal(w.sqlite.prepare('SELECT access_status FROM service_media_assets WHERE id=?').get(grant.id).access_status,'quarantined');
 assert.equal((await mutate(w,'start','precheck-captured')).status,'in_session');assert.equal((await upload('b')).status,409);
});
test('invalid attendance or revoked/rejected evidence and transaction-time proof changes cannot start a session',async()=>{
 for(const kind of ['parent','safety','revoked','rejected','drift-attendance','drift-proof']){
  const w=await fixture(),session=await arrived(w);await mutate(w,'save_report','precheck-save',{report:{attendance:REPORT.attendance}});seedAsset(w,'PRECHECK','before_service',session,{access:'quarantined',scan:'pending'});
  if(kind==='parent'||kind==='safety')w.sqlite.prepare('UPDATE training_sessions SET attendance_json=?').run(JSON.stringify({...REPORT.attendance,[kind==='parent'?'parentOrCaretakerConfirmed':'safeAreaConfirmed']:false}));
  if(kind==='revoked')w.sqlite.prepare("UPDATE service_media_assets SET access_status='revoked'").run();if(kind==='rejected')w.sqlite.prepare("UPDATE service_media_assets SET review_status='rejected'").run();
  const batch=w.db.batch.bind(w.db);let injected=false;if(kind.startsWith('drift'))w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.startsWith("UPDATE training_sessions SET status='in_session'"))){injected=true;w.sqlite.prepare(kind==='drift-attendance'?"UPDATE training_sessions SET attendance_json='{}'":"UPDATE service_media_assets SET access_status='revoked'").run();}return batch(statements);};
  await refusal(mutate(w,'start','precheck-refused'));assert.equal(w.sqlite.prepare('SELECT status FROM training_sessions').get().status,'arrived');assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='start'").get().n,0);assert.equal(w.sqlite.prepare('SELECT status FROM provider_lifecycle_records').get().status,'arrived');if(kind.startsWith('drift'))assert.equal(injected,true);
 }
 const precheck=await import('../lib/training-partner-precheck.ts');assert.equal(precheck.trainingAttendanceReady(REPORT.attendance),true);assert.equal(precheck.trainingBeforeCaptured([{purpose:'before_service',access_status:'quarantined',review_status:'pending'}]),true);assert.equal(precheck.trainingBeforeCaptured([{purpose:'before_service',access_status:'revoked'}]),false);
});
