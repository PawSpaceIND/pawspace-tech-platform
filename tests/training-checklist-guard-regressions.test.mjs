import test from 'node:test';
import assert from 'node:assert/strict';
import{freshWorld,seedBooking,TRAINER,sessionCookie,routeCall}from './helpers/training-lifecycle-harness.mjs';
const{materializeTrainingProgramme}=await import('../lib/training-programme.ts');
const life=await import('../lib/training-session-lifecycle.ts');
const media=await import('../app/api/training-session-media/route.ts');
async function fixture(){const w=freshWorld();seedBooking(w,{id:'CHK',group:'CHK-G',sessions:2});const p=await materializeTrainingProgramme(w.db,{bookingId:'CHK',actorId:'test'});return{...w,record:p};}
test('SD-05 wrong-session media token cannot consume its actual grant or change either asset',async()=>{
 const w=await fixture(),cookie=await sessionCookie(w.db,'provider',TRAINER);const grants=[];
 for(const session of w.record.sessions)w.sqlite.prepare("UPDATE training_sessions SET status='arrived',attendance_json=? WHERE id=?").run(JSON.stringify({mode:'parent',safeAreaConfirmed:true,parentOrCaretakerConfirmed:true}),session.id);
 for(let i=0;i<2;i++){const r=await routeCall(media.POST,'POST','/api/training-session-media',{cookie,body:{sessionId:w.record.sessions[i].id,purpose:'before_service',mimeType:'image/jpeg',sizeBytes:32,sha256:String(i+1).repeat(64)}});assert.equal(r.status,201,JSON.stringify(r.body));grants.push(r.body.data);}
 const actual=grants[1];const wrong=await routeCall(media.PATCH,'PATCH','/api/training-session-media',{cookie,body:{id:grants[0].id,action:'confirm_upload',uploadToken:actual.upload.token,storageReference:actual.upload.objectKey,observedSizeBytes:32,observedSha256:'2'.repeat(64),observedMimeType:'image/jpeg'}});
 assert.equal(wrong.status,403);assert.equal(w.sqlite.prepare('SELECT status FROM media_upload_grants WHERE media_id=?').get(actual.id).status,'issued');for(const g of grants)assert.equal(w.sqlite.prepare('SELECT access_status FROM service_media_assets WHERE id=?').get(g.id).access_status,'pending_upload');
 const own=await routeCall(media.PATCH,'PATCH','/api/training-session-media',{cookie,body:{id:actual.id,action:'confirm_upload',uploadToken:actual.upload.token,storageReference:actual.upload.objectKey,observedSizeBytes:32,observedSha256:'2'.repeat(64),observedMimeType:'image/jpeg'}});assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(w.sqlite.prepare('SELECT status FROM media_upload_grants WHERE media_id=?').get(actual.id).status,'consumed');
});
test('Workbook Training proof order requires attendance and safety before before-photo, then handover before after-photo',async()=>{
 const w=await fixture(),session=w.record.sessions[0],cookie=await sessionCookie(w.db,'provider',TRAINER);
 const upload=async(purpose,sha)=>routeCall(media.POST,'POST','/api/training-session-media',{cookie,body:{sessionId:session.id,purpose,mimeType:'image/jpeg',sizeBytes:32,sha256:sha.repeat(64)}});
 assert.equal((await upload('before_service','a')).status,409);
 w.sqlite.prepare("UPDATE training_sessions SET status='arrived' WHERE id=?").run(session.id);
 assert.equal((await upload('before_service','a')).status,409);
 w.sqlite.prepare("UPDATE training_sessions SET attendance_json=? WHERE id=?").run(JSON.stringify({mode:'parent',safeAreaConfirmed:true}),session.id);
 assert.equal((await upload('before_service','a')).status,201);
 w.sqlite.prepare("UPDATE training_sessions SET status='in_session' WHERE id=?").run(session.id);
 assert.equal((await upload('before_service','b')).status,409);
 assert.equal((await upload('after_service','c')).status,409);
 await life.ensureTrainingSessionLifecycleTables(w.db);
 w.sqlite.prepare("INSERT INTO training_owner_handover(session_id,programme_id,booking_id,duration_minutes,completed_by,completed_at) VALUES(?,?,?,?,?,?)").run(session.id,w.record.programme.id,'CHK',5,TRAINER,Date.now());
 assert.equal((await upload('after_service','c')).status,201);
});
test('HW-02 report and audit event roll back together, then exact retry saves once',async()=>{
 const w=await fixture(),session=w.record.sessions[0];await life.ensureTrainingSessionLifecycleTables(w.db);w.sqlite.prepare("UPDATE training_sessions SET status='in_session',homework_json=? WHERE id=?").run(JSON.stringify({text:'Original practice homework'}),session.id);
 w.sqlite.exec("CREATE TRIGGER fail_report_event BEFORE INSERT ON training_session_events WHEN NEW.event_type='save_report' BEGIN SELECT RAISE(ABORT,'synthetic report event failure'); END");const input={sessionId:session.id,action:'save_report',actorId:TRAINER,idempotencyKey:'check-report',report:{homework:'Updated sit practice homework'}};
 await assert.rejects(life.mutateTrainingSession(w.db,input));assert.equal(JSON.parse(w.sqlite.prepare('SELECT homework_json FROM training_sessions WHERE id=?').get(session.id).homework_json).text,'Original practice homework');assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='save_report'").get().n,0);
 w.sqlite.exec('DROP TRIGGER fail_report_event');assert.equal((await life.mutateTrainingSession(w.db,input)).reportSaved,true);assert.equal((await life.mutateTrainingSession(w.db,input)).duplicatePrevented,true);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='save_report'").get().n,1);
});
test('HW-02 report rejects transaction-time ownership or inactive-booking changes without saving stale homework',async()=>{
 for(const kind of ['provider','booking']){const w=await fixture(),session=w.record.sessions[0];await life.ensureTrainingSessionLifecycleTables(w.db);w.sqlite.prepare("UPDATE training_sessions SET status='in_session',homework_json=? WHERE id=?").run(JSON.stringify({text:'Original practice homework'}),session.id);const batch=w.db.batch.bind(w.db);let changed=false;w.db.batch=async statements=>{if(!changed&&statements.some(x=>x.sql.includes('INSERT INTO training_session_mutation_assertions'))){changed=true;if(kind==='provider')w.sqlite.prepare("UPDATE training_sessions SET provider_id='different-trainer' WHERE id=?").run(session.id);else w.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id='CHK'").run();}return batch(statements);};await assert.rejects(life.mutateTrainingSession(w.db,{sessionId:session.id,action:'save_report',actorId:TRAINER,idempotencyKey:`check-${kind}`,report:{homework:'Stale practice homework update'}}),e=>e instanceof Response&&e.status===409);assert.equal(changed,true);assert.equal(JSON.parse(w.sqlite.prepare('SELECT homework_json FROM training_sessions WHERE id=?').get(session.id).homework_json).text,'Original practice homework');assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='save_report'").get().n,0);}
});
