import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorld,seedBooking,seedEvidence,TRAINER,DOORSTEP,REPORT} from './helpers/training-lifecycle-harness.mjs';
const {materializeTrainingProgramme}=await import('../lib/training-programme.ts');
const {mutateTrainingSession,getTrainingSession}=await import('../lib/training-session-lifecycle.ts');

test('existing handover API persists corrections with distinct audit events, replays once and closes edits at completion',async t=>{
 const w=freshWorld();t.after(()=>w.sqlite.close());seedBooking(w,{id:'EDIT',group:'EDIT-G',sessions:1,total:8000,dueNow:8000});const record=await materializeTrainingProgramme(w.db,{bookingId:'EDIT',actorId:'fixture'}),s=record.sessions[0];
 const act=(action,key,extra={})=>mutateTrainingSession(w.db,{sessionId:s.id,actorId:'trainer:'+TRAINER,action,idempotencyKey:key,...extra});
 for(const [action,extra] of [['accept',{}],['on_the_way',{}],['arrive',DOORSTEP],['start',{}]])await act(action,'edit-'+action,extra);
 await act('owner_handover','edit-first',{ownerHandoverCompleted:true,ownerHandoverMinutes:10});const corrected=await act('owner_handover','edit-correction',{ownerHandoverCompleted:true,ownerHandoverMinutes:20});assert.equal(corrected.ownerHandover.durationMinutes,20);
 assert.equal((await act('owner_handover','edit-correction',{ownerHandoverCompleted:true,ownerHandoverMinutes:20})).duplicatePrevented,true);assert.equal((await getTrainingSession(w.db,s.id)).owner_handover_minutes,20);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='owner_handover'").get().n,2);
 const report={...REPORT,evidenceRefs:seedEvidence(w,'EDIT-PROOF',s)};assert.equal((await act('complete','edit-complete',{report})).status,'completed');await assert.rejects(act('owner_handover','edit-after-complete',{ownerHandoverCompleted:true,ownerHandoverMinutes:12}),e=>e instanceof Response&&e.status===409);assert.equal(w.sqlite.prepare('SELECT duration_minutes FROM training_owner_handover WHERE session_id=?').get(s.id).duration_minutes,20);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_session_events WHERE event_type='owner_handover'").get().n,2);
});
