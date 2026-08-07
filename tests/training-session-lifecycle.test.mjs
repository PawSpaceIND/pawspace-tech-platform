import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
const read=(path)=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Training Gate 2 owns each trainer session and consumes completion exactly once",async()=>{
 const[lifecycle,route,sessionGateway,gateway]=await Promise.all([read("lib/training-session-lifecycle.ts"),read("app/api/training-sessions/route.ts"),read("lib/session-api-gateway.ts"),read("lib/api-gateway.ts")]);
 assert.match(lifecycle,/training_session_events/);
 assert.match(lifecycle,/idempotency_key TEXT NOT NULL UNIQUE/);
 assert.match(lifecycle,/training_session_consumptions \(session_id TEXT PRIMARY KEY/);
 assert.match(lifecycle,/INSERT OR IGNORE INTO training_session_consumptions/);
 assert.match(lifecycle,/Training session cannot/);
 for(const action of ["accept","on_the_way","arrive","start","save_report","complete","request_reschedule","no_show","reschedule","replace_provider","cancel_session"])assert.match(lifecycle,new RegExp(`\\"${action}\\"`));
 assert.match(route,/requireProviderOwnership/);
 assert.match(route,/staffActions/);
 assert.match(route,/bookings\.manage/);
 assert.match(sessionGateway,/training-sessions/);
 assert.match(sessionGateway,/replace_provider/);
 assert.match(gateway,/training-sessions/);
 assert.match(gateway,/bookings\.manage/);
});

test("Training completion requires attendance homework progress and exact-session secure media",async()=>{
 const[lifecycle,media]=await Promise.all([read("lib/training-session-lifecycle.ts"),read("app/api/training-session-media/route.ts")]);
 assert.match(lifecycle,/Attendance mode must be parent or trainer_led/);
 assert.match(lifecycle,/Parent\/caretaker attendance confirmation is required/);
 assert.match(lifecycle,/Meaningful homework is required before completion/);
 assert.match(lifecycle,/At least one 1-10 progress score is required/);
 assert.match(lifecycle,/training_session_media_links/);
 assert.match(lifecycle,/String\(asset\.session_id\)!==String\(row\.id\)/);
 assert.match(lifecycle,/scan_status\)!==\"clean\"/);
 assert.match(lifecycle,/Number\(asset\.synthetic\|\|0\)!==0/);
 assert.match(media,/requireProviderOwnership/);
 assert.match(media,/training_homework/);
 assert.match(media,/sessionId/);
 assert.match(media,/duplicatePrevented/);
 assert.doesNotMatch(media,/uat:\/\//);
});

test("Training recovery preserves paid-session integrity",async()=>{
 const lifecycle=await read("lib/training-session-lifecycle.ts");
 assert.match(lifecycle,/training_session_recovery_cases/);
 assert.match(lifecycle,/consumption:\"pending_policy\"/);
 assert.match(lifecycle,/consumption:\"not_consumed\"/);
 assert.match(lifecycle,/startMs<=now/);
 assert.match(lifecycle,/travel_buffer_minutes/);
 assert.match(lifecycle,/Replacement trainer is not eligible/);
 assert.match(lifecycle,/staff booking permission/);
 assert.doesNotMatch(lifecycle,/UPDATE training_session_consumptions SET/);
});

test("Trainer workspace is canonical-session driven and does not present fixture earnings",async()=>{
 const[page,client]=await Promise.all([read("app/trainer/page.tsx"),read("lib/training-session-client.ts")]);
 assert.match(page,/currentProviderIdentity/);
 assert.match(page,/loadTrainerSessions/);
 assert.match(page,/trainingSessionAction/);
 assert.match(page,/Complete & consume one session/);
 assert.match(page,/Not yet canonical/);
 assert.match(page,/No unverified money shown/);
 assert.doesNotMatch(page,/const dogs =/);
 assert.doesNotMatch(page,/₹42,680/);
 assert.doesNotMatch(page,/Bank ending 2481/);
 assert.match(client,/\/api\/identity-session/);
 assert.match(client,/\/api\/training-sessions/);
 assert.match(client,/\/api\/training-session-media/);
});
