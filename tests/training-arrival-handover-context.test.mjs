import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorld,seedBooking,sessionCookie,routeCall,TRAINER,OTHER_TRAINER,DOORSTEP,trainer} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
const {mutateTrainingSession:mutate,getTrainingSession,assertArrivalGeofence}=await import('../lib/training-session-lifecycle.ts');
const {approveTrainingArrivalTest:approve,availableTrainingArrivalSimulation:available}=await import('../lib/training-arrival-test-approval.ts');
const {trainingHandoverReminder}=await import('../lib/training-session-context.ts');
const contextRoute=await import('../app/api/training-session-context/route.ts');
const approvalRoute=await import('../app/api/training-arrival-test-approval/route.ts');
const sandbox={PAWSPACE_DEPLOYMENT_ENV:'e2e',PAWSPACE_UAT_PERSONAS:'on',PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'test-only-'.repeat(4),FORBID_PRODUCTION:'true'};
const request=new Request('http://localhost/api/training-sessions');
async function fixture({synthetic=false,env={}}={}){const w=freshWorld(env);seedBooking(w,{id:'AR1',group:'ARG',customer:synthetic?'UAT-AUDIT-CUSTOMER-A':undefined,sessions:2});if(synthetic)w.sqlite.prepare("UPDATE canonical_customers SET source='uat_audit_fixture',primary_phone='9000000841' WHERE id='UAT-AUDIT-CUSTOMER-A'").run();const p=await materializeTrainingProgramme(w.db,{bookingId:'AR1',actorId:'fixture'});return{...w,first:p.sessions[0]};}
const act=(w,action,key,extra={})=>mutate(w.db,{sessionId:w.first.id,action,actorId:trainer(),idempotencyKey:key,...extra});
async function onway(w){await act(w,'accept','accept');await act(w,'on_the_way','way');}
const reject=async promise=>assert.rejects(promise,e=>e instanceof Response&&[403,409].includes(e.status));

test('real GPS allows 499m, refuses501m, absent/poor accuracy and invalid coordinates without state mutation',async()=>{
 const w=await fixture();await onway(w);const row=await getTrainingSession(w.db,w.first.id);
 // Exact spherical latitude offset, matching production haversine radius6371km.
 const point=metres=>({...DOORSTEP,latitude:DOORSTEP.latitude+metres/6371000*180/Math.PI});
 assert.ok((await assertArrivalGeofence(w.db,row,{...point(499)})).distanceMeters<=500);
 for(const bad of [point(501),{latitude:DOORSTEP.latitude,longitude:DOORSTEP.longitude},{...DOORSTEP,accuracyMeters:501},{...DOORSTEP,latitude:91}])await reject(act(w,'arrive',`bad-${JSON.stringify(bad)}`,bad));
 assert.equal(w.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(w.first.id).status,'on_the_way');assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='arrive'").get().n,0);
 assert.equal((await act(w,'arrive','valid',point(499))).geofence.evidenceMode,'device_gps');
});

test('explicit scoped sandbox simulation records no fabricated coordinates or physical visit and replays once',async()=>{
 const w=await fixture({synthetic:true,env:sandbox});await onway(w);
 const approved=await approve(w.db,{request,sessionId:w.first.id,providerId:TRAINER,reason:'Approved synthetic fixture test',actorId:'staff:fixture'});
 const simulation={approvalId:approved.approvalId,reason:'Device GPS deliberately unavailable'};
 const result=await act(w,'arrive','simulated',{trustedRequest:request,simulatedArrival:simulation});assert.equal(result.status,'arrived');assert.equal(result.geofence.simulation,true);assert.equal(result.geofence.physicalVisitVerified,false);assert.deepEqual(result.geofence.reportedLocation,{latitude:null,longitude:null,accuracyMeters:null});assert.equal(Object.hasOwn(result.geofence,'distanceMeters'),false);
 assert.equal((await act(w,'arrive','simulated',{trustedRequest:request,simulatedArrival:simulation})).duplicatePrevented,true);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='arrive'").get().n,1);assert.equal(w.sqlite.prepare('SELECT used_key FROM training_arrival_test_approvals').get().used_key,'simulated');assert.equal((await available(w.db,{request,sessionId:w.first.id,providerId:TRAINER})).eligible,false);
});

test('simulation rejects real identities, production host, unapproved/foreign/expired approval and provider self-approval',async()=>{
 const real=await fixture({env:sandbox});await onway(real);await reject(approve(real.db,{request,sessionId:real.first.id,providerId:TRAINER,reason:'Synthetic test only',actorId:'staff:fixture'}));
 const w=await fixture({synthetic:true,env:sandbox});await onway(w);const approved=await approve(w.db,{request,sessionId:w.first.id,providerId:TRAINER,reason:'Approved synthetic fixture test',actorId:'staff:fixture'});
 for(const [key,extra] of [['missing',{approvalId:'missing',reason:'Synthetic unavailable GPS'}],['live',{approvalId:approved.approvalId,reason:'Synthetic unavailable GPS'}]])await reject(act(w,'arrive',key,{trustedRequest:key==='live'?new Request('https://pawspace.in/api/training-sessions'):request,simulatedArrival:extra}));
 await reject(approve(w.db,{request,sessionId:w.first.id,providerId:OTHER_TRAINER,reason:'Foreign trainer request',actorId:'staff:fixture'}));
 w.sqlite.prepare('UPDATE training_arrival_test_approvals SET expires_at=1').run();await reject(act(w,'arrive','expired',{trustedRequest:request,simulatedArrival:{approvalId:approved.approvalId,reason:'Synthetic unavailable GPS'}}));
 const cookie=await sessionCookie(w.db,'provider',TRAINER); const actual=await approvalRoute.POST(new Request('https://pawspace.test/api/training-arrival-test-approval',{method:'POST',headers:{origin:'https://pawspace.test',cookie,'content-type':'application/json'},body:JSON.stringify({sessionId:w.first.id,providerId:TRAINER,reason:'Provider self test approval'})}));assert.equal(actual.status,403);
 assert.equal(w.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(w.first.id).status,'on_the_way');
});

test('owned navigation uses canonical doorstep in access window; foreign provider denied; reminder uses actual start and attestation accepts10minutes',async()=>{
 const w=await fixture();await onway(w);const start=Date.now()+3600000;w.sqlite.prepare('UPDATE training_sessions SET scheduled_start=?,scheduled_end=? WHERE id=?').run(new Date(start).toISOString(),new Date(start+3600000).toISOString(),w.first.id);
 const own=await sessionCookie(w.db,'provider',TRAINER);const view=await routeCall(contextRoute.GET,'GET',`/api/training-session-context?sessionId=${w.first.id}`,{cookie:own});assert.equal(view.status,200,JSON.stringify(view.body));assert.equal(view.body.data.navigation.available,true);assert.match(view.body.data.navigation.mapsUrl,/12\.9716/);
 const foreign=await sessionCookie(w.db,'provider',OTHER_TRAINER);assert.equal((await routeCall(contextRoute.GET,'GET',`/api/training-session-context?sessionId=${w.first.id}`,{cookie:foreign})).status,403);
 await act(w,'arrive','arrive',DOORSTEP);await act(w,'start','start');await reject(act(w,'owner_handover','no-handover',{ownerHandoverCompleted:false}));const result=await act(w,'owner_handover','done-handover',{ownerHandoverCompleted:true,ownerHandoverMinutes:10});assert.equal(result.ownerHandover.completed,true);assert.equal(result.ownerHandover.durationMinutes,10);
 const s={started_at:1000,status:'in_session',scheduled_start:'2026-10-03T10:00:00Z',scheduled_end:'2026-10-03T11:00:00Z'};assert.equal(trainingHandoverReminder(s,null,1000+49*60000).reminderDue,false);assert.equal(trainingHandoverReminder(s,null,1000+50*60000).reminderDue,true);assert.equal(trainingHandoverReminder(s,1001,1000+50*60000).reminderDue,false);
});

test('handover and idempotency event roll back together on event failure or ownership/status race',async()=>{
 for(const race of [false,true]){
  const w=await fixture();await onway(w);await act(w,'arrive','arrive',DOORSTEP);await act(w,'start','start');
  if(!race)w.sqlite.exec("CREATE TRIGGER fail_handover_event BEFORE INSERT ON training_session_events WHEN NEW.event_type='owner_handover' BEGIN SELECT RAISE(ABORT,'injected event failure'); END");
  else{const original=w.db.batch.bind(w.db);let injected=false;w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.startsWith('INSERT INTO training_owner_handover'))){injected=true;w.sqlite.prepare('UPDATE training_sessions SET provider_id=? WHERE id=?').run(OTHER_TRAINER,w.first.id);}return original(statements);};}
  await assert.rejects(act(w,'owner_handover','handover-atomic',{ownerHandoverCompleted:true}),e=>race?e instanceof Response&&e.status===409:/injected event failure/.test(e.message));
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_owner_handover').get().n,0);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='owner_handover'").get().n,0);
 }
 const w=await fixture();await onway(w);await act(w,'arrive','arrive',DOORSTEP);await act(w,'start','start');const input={sessionId:w.first.id,action:'owner_handover',actorId:trainer(),idempotencyKey:'concurrent-ack',ownerHandoverCompleted:true};const results=await Promise.all([mutate(w.db,input),mutate(w.db,input)]);assert.equal(results.filter(r=>r.duplicatePrevented).length,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_owner_handover').get().n,1);
});

test('approval revocation at arrival commit leaves arrival and replay receipt absent',async()=>{
 const w=await fixture({synthetic:true,env:sandbox});await onway(w);const a=await approve(w.db,{request,sessionId:w.first.id,providerId:TRAINER,reason:'Approved scoped synthetic fixture',actorId:'staff:fixture'});
 const original=w.db.batch.bind(w.db);let injected=false;w.db.batch=async statements=>{if(!injected&&statements.some(s=>s.sql.startsWith('UPDATE training_arrival_test_approvals SET used_key'))){injected=true;w.sqlite.prepare('UPDATE training_arrival_test_approvals SET expires_at=1').run();}return original(statements);};
 await assert.rejects(act(w,'arrive','revoked-race',{trustedRequest:request,simulatedArrival:{approvalId:a.approvalId,reason:'Synthetic unavailable GPS'}}));assert.equal(injected,true);assert.equal(w.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(w.first.id).status,'on_the_way');assert.equal(w.sqlite.prepare('SELECT used_key FROM training_arrival_test_approvals').get().used_key,null);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='arrive'").get().n,0);
});
