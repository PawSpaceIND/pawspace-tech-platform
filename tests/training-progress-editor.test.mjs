import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingProgressFromRecord,trainingProgressReady} from '../lib/training-progress-editor.ts';
import {freshWorld,seedBooking,seedEvidence,TRAINER,DOORSTEP,REPORT} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
const {mutateTrainingSession,listTrainerSessions}=await import('../lib/training-session-lifecycle.ts');

test('missing and malformed scores stay explicitly unassessed; zero is preserved but cannot complete',()=>{
 const missing=trainingProgressFromRecord();assert.deepEqual(missing,{focus:null,recall:null,impulse:null,parent:null});assert.equal(trainingProgressReady(missing),false);
 const legacy=trainingProgressFromRecord({focus:0,recall:8,impulse:'7',parent:NaN});assert.deepEqual(legacy,{focus:0,recall:8,impulse:null,parent:null});assert.equal(trainingProgressReady(legacy),false);
 const sparse=trainingProgressFromRecord({obedience:6});assert.equal(sparse.obedience,6);assert.equal(trainingProgressReady(sparse),true);
 const explicit=trainingProgressFromRecord({focus:1,recall:10,impulse:6,parent:7});assert.equal(trainingProgressReady(explicit),true);
 assert.equal(trainingProgressReady({...explicit,parent:null}),true);assert.equal(trainingProgressReady({...explicit,focus:Infinity}),false);
});

test('draft unassessed scores survive save/reload but cannot complete or consume a session; entered assessments can',async t=>{
 const f=freshWorld();t.after(()=>f.sqlite.close());seedBooking(f,{id:'ASSESS',group:'ASSESS-G',sessions:1,total:8000,dueNow:8000});
 const {sessions}=await materializeTrainingProgramme(f.db,{bookingId:'ASSESS',actorId:'qa'}),session=sessions[0];
 const act=(action,key,extra={})=>mutateTrainingSession(f.db,{sessionId:session.id,action,actorId:TRAINER,idempotencyKey:key,...extra});
 for(const [action,extra] of [['accept',{}],['on_the_way',{}],['arrive',DOORSTEP],['start',{}],['owner_handover',{ownerHandoverMinutes:15}]])await act(action,`assess-${action}`,extra);
 const report={...REPORT,progress:trainingProgressFromRecord(),evidenceRefs:seedEvidence(f,'SCORE-MEDIA',session)};
 await act('save_report','assess-draft',{report});
 const reloaded=(await listTrainerSessions(f.db,TRAINER))[0];assert.deepEqual(reloaded.progress,report.progress);assert.equal(trainingProgressReady(trainingProgressFromRecord(reloaded.progress)),false);
 for(const [key,progress] of [['empty',{}],['null',report.progress],['nan',{focus:NaN}],['string',{focus:'7'}],['unknown-invalid',{obedience:'good'}],['unknown-unassessed',{obedience:null}]]){
  let refused;try{await act('complete',`assess-denied-${key}`,{report:{...report,progress}});}catch(error){refused=error;}assert.ok(refused instanceof Response);assert.equal(refused.status,409);assert.match(await refused.text(),/At least one 1-10 progress score is required/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM training_session_consumptions').get().n,0);
 }
 const scores={focus:8,recall:null,impulse:null,parent:null};assert.equal(trainingProgressReady(scores),true);
 const done=await act('complete','assess-complete',{report:{...report,progress:scores}});assert.equal(done.status,'completed');assert.equal(done.consumedExactlyOnce,true);
 assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT progress_json FROM training_sessions WHERE id=?').get(session.id).progress_json),scores);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM training_session_consumptions').get().n,1);
});
