import test from "node:test";
import assert from "node:assert/strict";
import{freshWorld,seedBooking,seedRoster,sessionDate,TRAINER,OTHER_TRAINER}from"./helpers/training-lifecycle-harness.mjs";
const{materializeTrainingProgramme}=await import("../lib/training-programme.ts");
const{ensureProviderCapacityTables}=await import("../lib/provider-capacity-governance.ts");
const{executeProviderLeaveRecovery}=await import("../lib/provider-leave-recovery-execution.ts");

test("G19 approved Training leave replaces each active session through canonical Training replacement",async()=>{
 const w=freshWorld(),now=Date.now(),bookingId="BK-LEAVE-TRAIN",group="GRP-LEAVE-TRAIN";
 await ensureProviderCapacityTables(w.db);
 seedBooking(w,{id:bookingId,group,sessions:2,provider:TRAINER});
 for(const day of [0,1])seedRoster(w,OTHER_TRAINER,sessionDate(day));
 const programme=await materializeTrainingProgramme(w.db,{bookingId,actorId:"qa"});
 assert.equal(programme.sessions.length,2);
 w.sqlite.prepare("INSERT INTO provider_recovery_cases (id,group_id,booking_id,failed_provider_id,reason_code,status,replacement_provider_id,detail_json,opened_at,resolved_at,updated_at) VALUES ('REC-TRAIN',?,?,?,'provider_leave_pending','ops_escalation',NULL,?, ?,NULL,?)")
  .run(group,bookingId,TRAINER,JSON.stringify({leaveRequestId:"LVR-TRAIN",bookingPreserved:true}),now,now);
 const result=await executeProviderLeaveRecovery(w.db,{recoveryCaseId:"REC-TRAIN",actorId:"ops@test"});
 assert.equal(result.status,"resolved");
 assert.equal(result.execution,"training_session_replacement");
 assert.equal(result.unresolvedSessions.length,0);
 const rows=w.sqlite.prepare("SELECT id,provider_id,status FROM training_sessions WHERE booking_id=? ORDER BY sequence_no").all(bookingId).map(row=>({...row}));
 assert.equal(rows.length,2);
 assert.ok(rows.every(row=>row.provider_id===OTHER_TRAINER),JSON.stringify(rows));
 assert.deepEqual(rows.map(row=>row.status),["scheduled","locked"]);
 const reservations=w.sqlite.prepare("SELECT provider_id,status FROM scheduling_reservations WHERE group_id=? ORDER BY occurrence_number").all(group).map(row=>({...row}));
 assert.ok(reservations.every(row=>row.provider_id===OTHER_TRAINER&&row.status==="assigned"),JSON.stringify(reservations));
 const recovery={...w.sqlite.prepare("SELECT status,replacement_provider_id FROM provider_recovery_cases WHERE id='REC-TRAIN'").get()};
 assert.deepEqual(recovery,{status:"resolved",replacement_provider_id:OTHER_TRAINER});
});
