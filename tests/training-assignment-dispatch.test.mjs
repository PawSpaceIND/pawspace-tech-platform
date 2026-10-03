import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorld,seedBooking,seedRoster,sessionDate,sessionStart,sessionEnd,TRAINER,OTHER_TRAINER,trainer,sessionCookie,routeCall} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
const {ensureTrainingDispatchTables,respondTrainingOffer,runTrainingOfferExpirySweep,trainingAssignmentOffer}=await import('../lib/training-assignment-dispatch.ts');
const {seedAssignmentPolicies}=await import('../lib/provider-assignment-policy.ts');
const {seedProviderCapacityDefaults}=await import('../lib/provider-capacity-governance.ts');
const {mutateTrainingSession}=await import('../lib/training-session-lifecycle.ts');
const offersRoute=await import('../app/api/training-assignment-offers/route.ts');
const {schedule}=await import('../backend/src/scheduling.ts');
const refusal=async(p,status=409)=>{await assert.rejects(p,e=>e instanceof Response&&e.status===status);};
async function fixture({strict=false,max=3,ops=10,expired=false,fullTime=false}={}){
 const w=freshWorld({PAWSPACE_SCHEDULING_ENV:'production'});
 await ensureTrainingDispatchTables(w.db);await seedProviderCapacityDefaults(w.db);await seedAssignmentPolicies(w.db);
 w.sqlite.prepare('UPDATE provider_capacity_profiles SET live=0').run();
 for(const [id,quality,model] of [[TRAINER,90,'commission'],[OTHER_TRAINER,95,fullTime?'full_time':'commission'],['train_next',80,'commission']]){
  w.sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,effective_from,updated_by,updated_at) VALUES (?,'blr',?,?,'[\"dog_training\"]','[\"blr-east\"]',1,5,?,1,30,6,3,'active','2026-01-01','fixture',?) ON CONFLICT(id) DO UPDATE SET live=1,provider_model=excluded.provider_model,services_json=excluded.services_json,zones_json=excluded.zones_json,quality_score=excluded.quality_score,capacity=1,max_daily_jobs=6").run(id,id,model,quality,Date.now());
  for(let i=0;i<2;i++)seedRoster(w,id,sessionDate(i));
 }
 w.sqlite.exec("CREATE TABLE scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT,shortlist_json TEXT,selected_provider_id TEXT,status TEXT,actor_id TEXT,reason TEXT,updated_at INTEGER); CREATE TABLE scheduling_rules (id TEXT PRIMARY KEY,service_code TEXT,city_id TEXT,zone_id TEXT,condition_json TEXT,active INTEGER,priority INTEGER)");
 const request={cityId:'blr',zoneId:'blr-east',serviceCode:'dog_training',petIds:[],scheduledStart:sessionStart(0),scheduledEnd:sessionEnd(0),occurrences:2,cadenceDays:1,...(strict?{preferredProviderId:TRAINER}:{})};
 w.sqlite.prepare("INSERT INTO scheduling_assignment_decisions VALUES ('G1','auto',?,?,'assigned','fixture',NULL,?)").run(JSON.stringify({request}),TRAINER,Date.now());
 const config=JSON.parse(w.sqlite.prepare("SELECT config_json FROM service_policy_configs WHERE id='spolicy_provider_assignment_policy_dog_training_any'").get().config_json);config.fallbackAttempts=max;config.opsEscalationMinutes=ops;
 w.sqlite.prepare("UPDATE service_policy_configs SET config_json=? WHERE id='spolicy_provider_assignment_policy_dog_training_any'").run(JSON.stringify(config));
 seedBooking(w,{id:'B1',group:'G1',sessions:2});
 w.sqlite.prepare("INSERT INTO provider_work_orders VALUES ('W1','B1','G1',?,?,'commission','dog_training',?,?,2,'awaiting_acceptance','{}',?,?)").run(TRAINER,TRAINER,sessionStart(0),sessionEnd(1),Date.now(),Date.now());
 const now=Date.now(),start=expired?now-4*60000:now;
 w.sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES ('G1','B1',?,'pending',?,?,1,?)").run(TRAINER,start,start+3*60000,now);
 w.sqlite.prepare("UPDATE scheduling_availability SET source='roster'").run();
 const programme=await materializeTrainingProgramme(w.db,{bookingId:'B1',actorId:'fixture'});
 return {...w,programme,first:programme.sessions[0],request};
}
const decline=(w,key='decline1',extra={})=>respondTrainingOffer(w.db,{sessionId:w.first.id,providerId:TRAINER,action:'decline',expectedAttemptNo:1,idempotencyKey:key,reason:'Trainer unavailable',actorId:trainer(TRAINER),...extra});

test('Training full-time tier wins despite lower score; Grooming ranking stays score-based; strict customer selection holds',async()=>{
 const ft={id:'ft',cityId:'blr',name:'ft',model:'full_time',services:['dog_training','grooming'],zones:['blr-east'],live:true,qualityScore:1,rating:1,capacity:1,travelBufferMinutes:0,maxDailyJobs:6};const contractor={...ft,id:'contract',model:'commission',qualityScore:100,rating:5};
 const repo={listEligibleProviders:async()=>[contractor,ft],listBookings:async()=>[],listAvailability:async(providerId,date)=>[{providerId,cityId:'blr',zoneId:'blr-east',date,windows:['00:00-23:59'],source:'roster'}],getPet:async()=>null};
 const input={cityId:'blr',zoneId:'blr-east',serviceCode:'dog_training',petIds:[],scheduledStart:sessionStart(0),scheduledEnd:sessionEnd(0)};
 assert.equal((await schedule(repo,input)).provider.id,'ft');assert.equal((await schedule(repo,{...input,serviceCode:'grooming',scheduledEnd:new Date(Date.parse(input.scheduledStart)+120*60000).toISOString()})).provider.id,'contract');assert.equal((await schedule(repo,{...input,preferredProviderId:'contract',preferredProviderMode:'strict'})).provider.id,'contract');
});
test('decline reoffers exactly one contractor and atomically moves every programme owner; stable replay adds nothing',async()=>{
 const w=await fixture();const result=await decline(w);assert.equal(result.state,'open');assert.equal(result.providerId,OTHER_TRAINER);assert.equal(result.attemptNo,2);assert.equal(result.externalDelivery,false);
 for(const table of ['canonical_bookings','training_programmes','training_sessions','provider_work_orders'])assert.equal(w.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE provider_id!=?`).get(OTHER_TRAINER).n,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id='G1' AND provider_id=?").get(OTHER_TRAINER).n,2);
 assert.equal(w.sqlite.prepare("SELECT selected_provider_id FROM scheduling_assignment_decisions WHERE group_id='G1'").get().selected_provider_id,OTHER_TRAINER);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_assignment_attempts WHERE status='pending'").get().n,1);
 assert.equal((await decline(w)).duplicatePrevented,true);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_attempts').get().n,2);
 await refusal(decline(w,'decline1',{reason:'Different reason'}));await refusal(decline(w,'stale'));
 assert.equal((await trainingAssignmentOffer(w.db,'B1',TRAINER)).state,'withdrawn');
});
test('expired acceptance is rejected; bounded timeout advances only new Training chains',async()=>{
 const w=await fixture({expired:true});await refusal(mutateTrainingSession(w.db,{sessionId:w.first.id,action:'accept',actorId:trainer(TRAINER),idempotencyKey:'expiredaccept'}));
 w.sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,provider_id,status,offered_at,expires_at,updated_at) VALUES ('HISTORICAL',?,'pending',1,2,1)").run(TRAINER);
 const result=await runTrainingOfferExpirySweep(w.db);assert.equal(result.scanned,1);assert.equal(result.results[0].attemptNo,2);assert.equal(w.sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id='HISTORICAL'").get().status,'pending');
 assert.equal((await runTrainingOfferExpirySweep(w.db)).scanned,0);
});
test('valid session acceptance atomically accepts offer and replay remains exactly once',async()=>{
 const w=await fixture();const input={sessionId:w.first.id,action:'accept',actorId:trainer(TRAINER),idempotencyKey:'accept1'};
 assert.equal((await mutateTrainingSession(w.db,input)).status,'accepted');assert.equal(w.sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id='G1'").get().status,'accepted');assert.equal(w.sqlite.prepare('SELECT state FROM training_assignment_chains').get().state,'accepted');assert.equal((await mutateTrainingSession(w.db,input)).duplicatePrevented,true);await refusal(decline(w));
});
test('configured attempt bound and strict chosen trainer each create one Ops case without replacing trainer',async()=>{
 for(const opts of [{max:1},{strict:true}]){const w=await fixture(opts);const result=await decline(w);assert.equal(result.state,'needs_operations');assert.equal(w.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='B1'").get().provider_id,TRAINER);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_ops_cases').get().n,1);await decline(w);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_ops_cases').get().n,1);}
});
test('Ops deadline caps whole chain; eligible full-time replacement is assigned automatically',async()=>{
 const w=await fixture({fullTime:true});const r=await decline(w);assert.equal(r.state,'assigned');assert.equal(r.providerId,OTHER_TRAINER);
 const overdue=await fixture({expired:true,ops:1});const swept=await runTrainingOfferExpirySweep(overdue.db);assert.equal(swept.results[0].state,'needs_operations');assert.equal(swept.results[0].reason,'ops_deadline_elapsed');
});
test('capacity race inside writing batch rolls back every ownership/attempt effect',async()=>{
 const w=await fixture();const original=w.db.batch.bind(w.db);let injected=false;
 w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.includes('Training sequential reoffer'))){injected=true;w.sqlite.prepare("INSERT INTO scheduling_reservations SELECT 'R-RACE','RACE',?,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at FROM scheduling_reservations WHERE id='R-B1-1'").run(OTHER_TRAINER);}return original(statements);};
 await refusal(decline(w));assert.equal(injected,true);assert.equal(w.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='B1'").get().provider_id,TRAINER);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_attempts').get().n,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_responses').get().n,0);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_assertions').get().n,0);
});
test('new programme and dispatch chain roll back together if initial dispatch insert fails',async()=>{
 const w=await fixture();w.sqlite.prepare("DELETE FROM training_sessions").run();w.sqlite.prepare('DELETE FROM training_programmes').run();w.sqlite.prepare('DELETE FROM training_assignment_chains').run();w.sqlite.prepare('DELETE FROM training_assignment_attempts').run();w.sqlite.prepare('DELETE FROM training_assignment_notifications').run();
 w.sqlite.exec("CREATE TRIGGER fail_dispatch BEFORE INSERT ON training_assignment_chains BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 await assert.rejects(materializeTrainingProgramme(w.db,{bookingId:'B1',actorId:'fixture'}));assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_programmes').get().n,0);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_sessions').get().n,0);
});
test('foreign provider cannot read or decline another Training offer; cross-origin action is refused',async()=>{
 const w=await fixture();const cookie=await sessionCookie(w.db,'provider',OTHER_TRAINER);
 assert.equal((await routeCall(offersRoute.GET,'GET','/api/training-assignment-offers?bookingId=B1&providerId='+OTHER_TRAINER,{cookie})).status,403);
 assert.equal((await routeCall(offersRoute.POST,'POST','/api/training-assignment-offers',{cookie,body:{sessionId:w.first.id,providerId:TRAINER,action:'decline',expectedAttemptNo:1,idempotencyKey:'foreign',reason:'Unavailable'}})).status,403);
 const response=await offersRoute.POST(new Request('https://example.test/api/training-assignment-offers',{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:JSON.stringify({action:'expire_due'})}));assert.equal(response.status,403);
});

test('failed old acceptance lease cannot strand replacement ownership; an active lease blocks reoffer',async()=>{
 const w=await fixture();const {ensureProviderLifecycleRecord}=await import('../lib/provider-lifecycle.ts');
 await ensureProviderLifecycleRecord(w.db,{bookingId:'B1',serviceCode:'dog_training',scopeId:w.first.id,providerId:TRAINER,status:'provider_matched',actorId:'fixture'});
 w.sqlite.prepare("UPDATE provider_lifecycle_records SET lease_token='busy',lease_expires_at=?").run(Date.now()+60000);
 await refusal(decline(w));assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_responses').get().n,0);
 w.sqlite.prepare('UPDATE provider_lifecycle_records SET lease_token=NULL,lease_expires_at=NULL').run();
 await decline(w);assert.equal(w.sqlite.prepare('SELECT provider_id FROM provider_lifecycle_records').get().provider_id,OTHER_TRAINER);
 assert.equal((await mutateTrainingSession(w.db,{sessionId:w.first.id,action:'accept',actorId:trainer(OTHER_TRAINER),idempotencyKey:'newowneraccept'})).status,'accepted');
});
test('authored calendar changed immediately before commit fails closed with no reoffer',async()=>{
 const w=await fixture();const original=w.db.batch.bind(w.db);let injected=false;
 w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.includes('Training sequential reoffer'))){injected=true;w.sqlite.prepare("UPDATE scheduling_availability SET windows_json='[]',updated_at=? WHERE provider_id=?").run(Date.now()+1,OTHER_TRAINER);}return original(statements);};
 await refusal(decline(w));assert.equal(w.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='B1'").get().provider_id,TRAINER);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_attempts').get().n,1);
});
test('Ops fallback appears in the existing Training recovery queue; zero fallback policy still allows the initial offer only',async()=>{
 const w=await fixture({max:0});assert.equal((await decline(w)).state,'needs_operations');const r=w.sqlite.prepare("SELECT recovery_type,status,booking_id FROM training_session_recovery_cases").get();assert.equal(r.recovery_type,'assignment_recovery');assert.equal(r.status,'open');assert.equal(r.booking_id,'B1');
});
test('offer projection is table-free on cold database and never discloses a replacement trainer to the old recipient',async()=>{
 const w=freshWorld();const before=w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;assert.equal(await trainingAssignmentOffer(w.db,'unknown',TRAINER),null);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n,before);
 const ready=await fixture();await decline(ready);const old=await trainingAssignmentOffer(ready.db,'B1',TRAINER);assert.equal(old.state,'withdrawn');assert.equal(old.providerId,TRAINER);assert.equal(old.canDecline,false);
});
test('simultaneous identical declines retain a single replacement attempt and single saved response',async()=>{
 const w=await fixture();const results=await Promise.all([decline(w),decline(w)]);assert.equal(results.filter(r=>r.duplicatePrevented).length,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_attempts').get().n,2);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_responses').get().n,1);
});
test('published employee linkage with provider_id primary key participates in the atomic source snapshot',async()=>{
 const w=await fixture();w.sqlite.exec("CREATE TABLE provider_people_links (provider_id TEXT PRIMARY KEY,employee_id TEXT,status TEXT)");
 assert.equal((await decline(w)).providerId,OTHER_TRAINER);
});
test('expired offer recheck occurs inside session acceptance commit and leaves the session scheduled',async()=>{
 const w=await fixture();const original=w.db.batch.bind(w.db);let injected=false;
 w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.includes("UPDATE training_sessions SET status='accepted'"))){injected=true;w.sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id='G1'").run(Date.now()-1);}return original(statements);};
 await refusal(mutateTrainingSession(w.db,{sessionId:w.first.id,action:'accept',actorId:trainer(TRAINER),idempotencyKey:'racingexpiry'}));assert.equal(injected,true);assert.equal(w.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(w.first.id).status,'scheduled');assert.equal(w.sqlite.prepare("SELECT state FROM training_assignment_chains WHERE booking_id='B1'").get().state,'pending');
});
test('own provider HTTP decline replay is still authorized after ownership moves to the replacement',async()=>{
 const w=await fixture();const cookie=await sessionCookie(w.db,'provider',TRAINER),body={sessionId:w.first.id,providerId:TRAINER,action:'decline',expectedAttemptNo:1,idempotencyKey:'httpdecline',reason:'Trainer unavailable'};
 const first=await routeCall(offersRoute.POST,'POST','/api/training-assignment-offers',{cookie,body});assert.equal(first.status,200);assert.equal(first.body.data.providerId,OTHER_TRAINER);
 const replay=await routeCall(offersRoute.POST,'POST','/api/training-assignment-offers',{cookie,body});assert.equal(replay.status,200);assert.equal(replay.body.data.duplicatePrevented,true);
});

test('real gateway permits owned provider offer reads/declines and rejects foreign scope or staff timeout',async()=>{
 const w=await fixture();const cookie=await sessionCookie(w.db,'provider',TRAINER);
 w.sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
 const {authorizePlatformSessionRequest}=await import('../lib/session-api-gateway.ts');
 const {authorizeApiRequest,requiredPermission}=await import('../lib/api-gateway.ts');
 const req=(path,body)=>new Request(`https://pawspace.test${path}`,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json',origin:'https://pawspace.test'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const own=req(`/api/training-assignment-offers?bookingId=B1&providerId=${TRAINER}`);assert.equal((await authorizePlatformSessionRequest(own,w.db)).permission,'bookings.view');assert.equal((await authorizeApiRequest(own,{DB:w.db})).permission,'bookings.view');
 const declineReq=req('/api/training-assignment-offers',{action:'decline',providerId:TRAINER});assert.equal((await authorizePlatformSessionRequest(declineReq,w.db)).permission,'bookings.view');assert.equal(await requiredPermission(declineReq),'bookings.view');
 assert.equal((await authorizePlatformSessionRequest(req(`/api/training-assignment-offers?bookingId=B1&providerId=${OTHER_TRAINER}`),w.db)).status,403);
 const timeout=req('/api/training-assignment-offers',{action:'timeout'});assert.equal(await requiredPermission(timeout),'bookings.manage');assert.equal((await authorizeApiRequest(timeout,{DB:w.db})).status,403);
});

test('resolved staff per-session replacement projects and accepts independently of canonical shared offer',async()=>{
 const w=await fixture();await mutateTrainingSession(w.db,{sessionId:w.first.id,action:'accept',actorId:trainer(TRAINER),idempotencyKey:'original-accept'});
 const replaced=await mutateTrainingSession(w.db,{sessionId:w.first.id,action:'replace_provider',newProviderId:OTHER_TRAINER,reason:'Approved trainer replacement',staffOverride:true,actorId:'ops:fixture',idempotencyKey:'replace-scoped'});assert.equal(replaced.providerId,OTHER_TRAINER);
 assert.equal(w.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='B1'").get().provider_id,TRAINER);
 assert.equal(await trainingAssignmentOffer(w.db,'B1',OTHER_TRAINER,w.first.id),null);
 const sessionsRoute=await import('../app/api/training-sessions/route.ts');const cookie=await sessionCookie(w.db,'provider',OTHER_TRAINER);
 const list=await routeCall(sessionsRoute.GET,'GET',`/api/training-sessions?providerId=${OTHER_TRAINER}`,{cookie});assert.equal(list.status,200,JSON.stringify(list.body));assert.equal(list.body.data[0].id,w.first.id);assert.equal(list.body.data[0].assignmentOffer,null);
 assert.equal((await mutateTrainingSession(w.db,{sessionId:w.first.id,action:'accept',actorId:trainer(OTHER_TRAINER),idempotencyKey:'replacement-accept'})).status,'accepted');
 await refusal(trainingAssignmentOffer(w.db,'B1','foreign',w.first.id),403);
 const unapproved=await fixture();unapproved.sqlite.prepare('UPDATE training_sessions SET provider_id=? WHERE id=?').run(OTHER_TRAINER,unapproved.first.id);
 await refusal(trainingAssignmentOffer(unapproved.db,'B1',OTHER_TRAINER,unapproved.first.id),403);
 await refusal(mutateTrainingSession(unapproved.db,{sessionId:unapproved.first.id,action:'accept',actorId:trainer(OTHER_TRAINER),idempotencyKey:'unapproved-accept'}));
 assert.equal(unapproved.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(unapproved.first.id).status,'scheduled');
});

test('commit rejects a timeout whose expiry was extended and a decline whose offer expired',async()=>{
 for(const action of ['timeout','decline']){
  const w=await fixture({expired:action==='timeout'}),original=w.db.batch.bind(w.db);let injected=false;
  w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.includes('expires_at=? AND'))){injected=true;w.sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id='G1'").run(action==='timeout'?Date.now()+600000:1);}return original(statements);};
  await refusal(respondTrainingOffer(w.db,{sessionId:w.first.id,providerId:TRAINER,action,expectedAttemptNo:1,idempotencyKey:`expiry-race-${action}`,reason:'Scoped expiry race fixture',actorId:trainer(TRAINER)}));assert.equal(injected,true);
  assert.equal(w.sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id='B1'").get().provider_id,TRAINER);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_attempts').get().n,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_assignment_responses').get().n,0);
 }
});
