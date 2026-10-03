import test from 'node:test';
import assert from 'node:assert/strict';
import { freshWorld, seedBooking, CUSTOMER, TRAINER, OTHER_TRAINER } from './helpers/training-lifecycle-harness.mjs';
const { ensureTrainingWorkflowNotificationTables: ensure, trainingWorkflowNotificationStatements: statements, listTrainingProviderNotifications: list } = await import('../lib/training-workflow-notifications.ts');
function setup(){ const w=freshWorld();seedBooking(w,{id:'TN-1',group:'TN-G',sessions:1});return w; }
const input={key:'request-1',bookingId:'TN-1',customerId:CUSTOMER,providerId:TRAINER,event:'reschedule_requested',sourceId:'SESSION-1',actorId:'customer:test'};
test('atomic replay makes one actionable Operations request and truthful parent/trainer inbox updates',async()=>{
 const w=setup();await ensure(w.db);await w.db.batch(statements(w.db,input));await w.db.batch(statements(w.db,input));
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_workflow_outbox').get().n,1);
 const alert=w.sqlite.prepare('SELECT * FROM staff_alerts').get();assert.equal(alert.team_code,'operations');assert.equal(alert.status,'open');
 const notice=w.sqlite.prepare('SELECT * FROM order_notifications').get();assert.match(notice.body,/requested/);assert.match(notice.body,/reservation remains active/);assert.equal(notice.status,'unread');assert.equal(notice.read_at,null);
 assert.equal((await list(w.db,TRAINER)).length,1);assert.equal((await list(w.db,OTHER_TRAINER)).length,0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages').get().n,0);
 assert.equal(w.sqlite.prepare('SELECT external_delivery FROM training_workflow_outbox').get().external_delivery,0);
});
test('Finance request is not cancellation; opted-out customer is suppressed while internal review remains actionable',async()=>{
 const w=setup();await ensure(w.db);w.sqlite.prepare('UPDATE canonical_customers SET consent_json=? WHERE id=?').run('{"serviceUpdates":false}',CUSTOMER);
 await w.db.batch(statements(w.db,{...input,event:'programme_cancellation_requested'}));
 assert.equal(w.sqlite.prepare('SELECT team_code FROM staff_alerts').get().team_code,'finance');
 const {authorizeStaffAlertAction}=await import('../lib/staff-alert-authority.ts');const alert=w.sqlite.prepare('SELECT * FROM staff_alerts').get();
 assert.equal(authorizeStaffAlertAction({email:'ops@test',permissions:['customers.manage']},alert,'resolve').allowed,false);
 assert.equal(authorizeStaffAlertAction({email:'finance@test',permissions:['finance.manage']},alert,'acknowledge').allowed,true);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM order_notifications').get().n,0);
 assert.match(w.sqlite.prepare('SELECT body FROM training_provider_notifications').get().body,/not yet been cancelled/);
 assert.equal(w.sqlite.prepare('SELECT status FROM canonical_bookings').get().status,'confirmed');
});
test('foreign ownership and changed replay binding roll back the business mutation and every notice',async()=>{
 const w=setup();await ensure(w.db);
 await assert.rejects(w.db.batch([w.db.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='TN-1'"),...statements(w.db,{...input,providerId:OTHER_TRAINER})]));
 assert.equal(w.sqlite.prepare('SELECT status FROM canonical_bookings').get().status,'confirmed');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_workflow_outbox').get().n,0);
 await w.db.batch(statements(w.db,input));
 await assert.rejects(w.db.batch([w.db.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='TN-1'"),...statements(w.db,{...input,sourceId:'OTHER'})]));
 assert.equal(w.sqlite.prepare('SELECT status FROM canonical_bookings').get().status,'confirmed');
});
test('approved cancellation is a separate status update, never claims completed refund',async()=>{
 const w=setup();await ensure(w.db);await w.db.batch(statements(w.db,{...input,key:'approval-1',event:'programme_cancelled'}));
 const notice=w.sqlite.prepare('SELECT * FROM order_notifications').get();assert.match(notice.body,/cancellation approved/);assert.match(notice.body,/separate Finance process/);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM staff_alerts').get().n,0);
});

test('real cancellation request route rejects foreign customer and replays one Finance case without releasing capacity',async()=>{
 const { sessionCookie,routeCall,OTHER_CUSTOMER }=await import('./helpers/training-lifecycle-harness.mjs');
 const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
 const route=await import('../app/api/training-cancellation/route.ts');
 const w=setup();await materializeTrainingProgramme(w.db,{bookingId:'TN-1',actorId:'test'});
 const foreign=await sessionCookie(w.db,'customer',OTHER_CUSTOMER);
 const body={action:'request',bookingId:'TN-1',reason:'Relocating and requesting cancellation',idempotencyKey:'cancel-route-1'};
 const denied=await routeCall(route.POST,'POST','/api/training-cancellation',{body,cookie:foreign});assert.equal(denied.status,403);
 const own=await sessionCookie(w.db,'customer',CUSTOMER);
 const first=await routeCall(route.POST,'POST','/api/training-cancellation',{body,cookie:own});assert.equal(first.status,200,JSON.stringify(first.body));
 const replay=await routeCall(route.POST,'POST','/api/training-cancellation',{body,cookie:own});assert.equal(replay.status,200);assert.equal(replay.body.data.duplicatePrevented,true);
 const caseId=w.sqlite.prepare('SELECT id FROM training_cancellation_cases').get().id;
 const forbiddenApproval=await routeCall(route.POST,'POST','/api/training-cancellation',{body:{action:'approve',caseId,reason:'Customer trying to approve own request'},cookie:own});assert.equal(forbiddenApproval.status,403);
 const {approveTrainingCancellation}=await import('../lib/training-cancellation.ts');
 const requestedBy=w.sqlite.prepare('SELECT requested_by FROM training_cancellation_cases').get().requested_by;
 await assert.rejects(approveTrainingCancellation(w.db,{caseId,actorId:requestedBy,reason:'Cannot approve own cancellation request'}),error=>error instanceof Response&&error.status===409);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_cancellation_cases').get().n,1);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM staff_alerts WHERE team_code=\'finance\'').get().n,1);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_workflow_outbox').get().n,1);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM scheduling_reservations WHERE status=\'cancelled\'').get().n,0);
});

test('Finance inbox failure rolls back the actual cancellation request and audit event',async()=>{
 const w=setup();const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
 const {requestTrainingCancellation}=await import('../lib/training-cancellation.ts');
 await materializeTrainingProgramme(w.db,{bookingId:'TN-1',actorId:'test'});await ensure(w.db);
 w.sqlite.exec("CREATE TRIGGER fail_finance_notice BEFORE INSERT ON staff_alerts BEGIN SELECT RAISE(ABORT,'synthetic inbox failure'); END");
 await assert.rejects(requestTrainingCancellation(w.db,{bookingId:'TN-1',reason:'Relocating and requesting cancellation',idempotencyKey:'fail-request',actorId:'synthetic-parent'}));
 for(const table of ['training_cancellation_cases','training_cancellation_events','training_workflow_outbox','order_notifications','training_provider_notifications'])assert.equal(w.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 assert.equal(w.sqlite.prepare('SELECT status FROM canonical_bookings').get().status,'confirmed');
});

test('session replacement sends to actual new session owner without changing programme ownership',async()=>{
 const w=setup();const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
 const {sessions}=await materializeTrainingProgramme(w.db,{bookingId:'TN-1',actorId:'test'});await ensure(w.db);
 await w.db.batch([w.db.prepare('UPDATE training_sessions SET provider_id=? WHERE id=?').bind(OTHER_TRAINER,sessions[0].id),...statements(w.db,{...input,key:'replace-1',event:'provider_replaced',providerId:OTHER_TRAINER,sessionId:sessions[0].id})]);
 assert.equal(w.sqlite.prepare('SELECT provider_id FROM canonical_bookings').get().provider_id,TRAINER);
 assert.equal((await list(w.db,OTHER_TRAINER)).length,1);assert.equal((await list(w.db,TRAINER)).length,0);
 await assert.rejects(w.db.batch(statements(w.db,{...input,key:'foreign-replace',event:'provider_replaced',providerId:TRAINER,sessionId:sessions[0].id})));
});

test('concurrent cancellation requests with distinct action keys cannot create duplicate review work',async()=>{
 const w=setup();const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
 const {requestTrainingCancellation}=await import('../lib/training-cancellation.ts');await materializeTrainingProgramme(w.db,{bookingId:'TN-1',actorId:'test'});
 const attempts=await Promise.allSettled(['concurrent-1','concurrent-2'].map(idempotencyKey=>requestTrainingCancellation(w.db,{bookingId:'TN-1',reason:'Relocating and requesting cancellation',idempotencyKey,actorId:'synthetic-parent'})));
 assert.ok(attempts.some(result=>result.status==='fulfilled'));
 for(const result of attempts)if(result.status==='rejected')assert.equal(result.reason.status,409);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_cancellation_cases').get().n,1);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM staff_alerts').get().n,1);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_workflow_outbox').get().n,1);
});

async function lifecycleWorld(){const w=setup();const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');const {sessions}=await materializeTrainingProgramme(w.db,{bookingId:'TN-1',actorId:'test'});return {w,session:sessions[0]};}
test('actual lifecycle request/replay, approved reschedule, replacement and cancellation emit truthful once-only notices',async()=>{
 const {w,session}=await lifecycleWorld();const {mutateTrainingSession}=await import('../lib/training-session-lifecycle.ts');
 const {seedRoster,sessionDate,sessionStart,sessionEnd}=await import('./helpers/training-lifecycle-harness.mjs');
 const call=(action,key,extra={})=>mutateTrainingSession(w.db,{sessionId:session.id,action,idempotencyKey:key,actorId:'ops:test',...extra});
 await call('request_reschedule','actual-request',{reason:'Trainer requesting different session time'});
 const replay=await call('request_reschedule','actual-request',{reason:'Trainer requesting different session time'});assert.equal(replay.duplicatePrevented,true);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_recovery_cases WHERE recovery_type='reschedule'").get().n,1);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM staff_alerts WHERE team_code='operations'").get().n,1);
 seedRoster(w,TRAINER,sessionDate(2));
 await call('reschedule','actual-approved',{staffOverride:true,newStart:sessionStart(2),newEnd:sessionEnd(2)});
 assert.equal(w.sqlite.prepare("SELECT status FROM training_session_recovery_cases WHERE recovery_type='reschedule'").get().status,'resolved');
 assert.equal(w.sqlite.prepare('SELECT scheduled_start FROM scheduling_reservations').get().scheduled_start,sessionStart(2));
 seedRoster(w,OTHER_TRAINER,sessionDate(2));
 await call('replace_provider','actual-replace',{staffOverride:true,newProviderId:OTHER_TRAINER,reason:'Assigned trainer is unavailable'});
 assert.ok((await list(w.db,OTHER_TRAINER)).some(n=>n.event_type==='provider_replaced'));
 const {sessionCookie,routeCall}=await import('./helpers/training-lifecycle-harness.mjs');const route=await import('../app/api/training-sessions/route.ts');
 const newCookie=await sessionCookie(w.db,'provider',OTHER_TRAINER);
 const ownedFeed=await routeCall(route.GET,'GET',`/api/training-sessions?providerId=${OTHER_TRAINER}`,{cookie:newCookie});assert.equal(ownedFeed.status,200,JSON.stringify(ownedFeed.body));assert.ok(ownedFeed.body.notifications.some(n=>n.event_type==='provider_replaced'));
 const foreignFeed=await routeCall(route.GET,'GET',`/api/training-sessions?providerId=${TRAINER}`,{cookie:newCookie});assert.equal(foreignFeed.status,403);

 assert.equal(w.sqlite.prepare('SELECT provider_id FROM scheduling_reservations').get().provider_id,OTHER_TRAINER);
 await call('cancel_session','actual-cancel',{staffOverride:true,reason:'Customer requested cancellation of this session'});
 const notices=w.sqlite.prepare('SELECT event_type,body FROM order_notifications ORDER BY created_at,rowid').all();
 assert.deepEqual(notices.map(n=>n.event_type),['reschedule_requested','reschedule_approved','provider_replaced','session_cancelled']);
 assert.match(notices[0].body,/requested/);assert.match(notices[1].body,/approved/);assert.match(notices[3].body,/has been cancelled/);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM training_session_consumptions').get().n,0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_messages').get().n,0);
});
test('actual lifecycle request inbox failure atomically rolls back session, event, recovery and notifications',async()=>{
 const {w,session}=await lifecycleWorld();const {mutateTrainingSession}=await import('../lib/training-session-lifecycle.ts');await ensure(w.db);
 w.sqlite.exec("CREATE TRIGGER fail_ops_notice BEFORE INSERT ON staff_alerts BEGIN SELECT RAISE(ABORT,'synthetic Operations inbox failure'); END");
 await assert.rejects(mutateTrainingSession(w.db,{sessionId:session.id,action:'request_reschedule',idempotencyKey:'actual-failure',actorId:'ops:test',reason:'Trainer requesting a new session window'}));
 assert.equal(w.sqlite.prepare('SELECT status FROM training_sessions WHERE id=?').get(session.id).status,'scheduled');
 for(const table of ['training_session_events','training_session_recovery_cases','training_workflow_outbox','order_notifications','training_provider_notifications','staff_alerts'])assert.equal(w.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 assert.equal(w.sqlite.prepare('SELECT status FROM scheduling_reservations').get().status,'assigned');
});
