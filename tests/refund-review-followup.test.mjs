import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { d1 } from "./helpers/execution-harness.mjs";
import { setupJourney, runCompletedJourney } from "./helpers/grooming-journey-harness.mjs";

const accounts = await import("../lib/finance-accounts.ts");
const queue = await import("../lib/ops-work-queue.ts");
const bridge = await import("../lib/lifecycle-communications.ts");
const engine = await import("../lib/communication-engine.ts");
const fresh = t => { const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close()); return { sqlite, db: d1(sqlite) }; };
const journal = {groupKey:"REFUND-REVIEW-1",entryDate:"2026-09-01",periodCode:"2026-09",sourceType:"refund_completed",sourceId:"rfnd_review",narration:"Synthetic refund",lines:[{accountCode:accounts.ACCT.REFUNDS,debit:100},{accountCode:accounts.ACCT.GATEWAY_CLEARING,credit:100}]};

test("an existing balanced journal replays without writes after its period is locked",async t=>{
 const {sqlite,db}=fresh(t);await accounts.postJournal(db,journal);
 sqlite.exec("CREATE TABLE finance_close_periods (period_code TEXT PRIMARY KEY,status TEXT); INSERT INTO finance_close_periods VALUES ('2026-09','locked')");
 const before=sqlite.prepare("SELECT * FROM finance_journal_entries ORDER BY id").all();
 const result=await accounts.postJournal(db,journal);assert.equal(result.posted,false);assert.equal(result.duplicatePrevented,true);
 assert.deepEqual(sqlite.prepare("SELECT * FROM finance_journal_entries ORDER BY id").all(),before);
 await assert.rejects(()=>accounts.postJournal(db,{...journal,groupKey:"NEW-LOCKED"}),/period_locked/);
 await assert.rejects(()=>accounts.postJournal(db,{...journal,periodCode:"2026-10"}),/period_mismatch/);
 assert.deepEqual(sqlite.prepare("SELECT * FROM finance_journal_entries ORDER BY id").all(),before);
});

async function queueWorld(t,{both=false,closed=false,legacy=true}={}){
 const f=fresh(t);await queue.ensureWorkQueueTables(f.db);const now=Date.now();
 f.sqlite.exec("CREATE TABLE payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,exception_type TEXT,severity TEXT,status TEXT,detail_json TEXT,created_at INTEGER)");
 f.sqlite.prepare("INSERT INTO payment_reconciliation_exceptions VALUES ('EX-REVIEW','BK-REVIEW','PAY-REVIEW','refund_failed','critical','open','{}',?)").run(now);
 const add=(id,rule,status,owner)=>f.sqlite.prepare("INSERT INTO ops_work_queue_tasks (id,rule,queue,priority,title,entity_type,entity_id,source_key,status,owner,sla_minutes,due_at,created_at,updated_at) VALUES (?,?,'finance','high','Existing task','payment_exception','EX-REVIEW',?,?,?,120,?,?,?)").run(id,rule,`${rule}:EX-REVIEW`,status,owner,now+120*60000,now,now);
 if(legacy){add("OLD-TASK","payment_exception",closed?"resolved":"in_progress","finance-owner@pawspace.test");f.sqlite.prepare("INSERT INTO ops_work_queue_events VALUES ('OLD-NOTE','OLD-TASK','note','finance-owner@pawspace.test','Keep this audit note',?)").run(now);}
 if(both)add("NEW-TASK","refund_failed","open",null);
 return {...f,now};
}
test("legacy refund failure task migrates in place without losing ownership or audit notes",async t=>{
 const f=await queueWorld(t);await queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now});
 const rows=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks").all();assert.equal(rows.length,1);
 assert.equal(rows[0].id,"OLD-TASK");assert.equal(rows[0].rule,"refund_failed");assert.equal(rows[0].source_key,"refund_failed:EX-REVIEW");assert.equal(rows[0].status,"in_progress");assert.equal(rows[0].owner,"finance-owner@pawspace.test");assert.equal(rows[0].priority,"critical");assert.equal(rows[0].sla_minutes,60);assert.ok(rows[0].due_at<=f.now+60*60000);
 assert.equal(f.sqlite.prepare("SELECT note FROM ops_work_queue_events WHERE id='OLD-NOTE'").get().note,"Keep this audit note");
 const before=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks").all();await queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now});assert.deepEqual(f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks").all(),before);
});
test("already duplicated legacy refund task is superseded once, not deleted",async t=>{
 const f=await queueWorld(t,{both:true});await queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now});
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ops_work_queue_tasks WHERE status IN ('open','acknowledged','in_progress')").get().n,1);
 const old=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks WHERE id='OLD-TASK'").get();assert.equal(old.status,"dismissed");assert.match(old.resolution_note,/refund_failed/);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ops_work_queue_events WHERE id='OLD-NOTE'").get().n,1);
 const before=f.sqlite.prepare("SELECT * FROM ops_work_queue_events ORDER BY id").all();await queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now});assert.deepEqual(f.sqlite.prepare("SELECT * FROM ops_work_queue_events ORDER BY id").all(),before);
});
test("a resolved legacy refund task is not reopened by the new rule",async t=>{
 const f=await queueWorld(t,{closed:true});await queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now});const rows=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks").all();assert.equal(rows.length,1);assert.equal(rows[0].status,"resolved");assert.equal(rows[0].rule,"refund_failed");
});
test("concurrent sweeps migrate one legacy task and create no duplicate",async t=>{
 const f=await queueWorld(t);await Promise.all([queue.sweepWorkQueue(f.db,{actorId:"sweep-a",now:f.now}),queue.sweepWorkQueue(f.db,{actorId:"sweep-b",now:f.now})]);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ops_work_queue_tasks").get().n,1);
});

async function bridgeWorld(t){
 const f=fresh(t);f.sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT); INSERT INTO canonical_bookings VALUES ('BK-REVIEW','CUS-REVIEW','blr','grooming'); CREATE TABLE booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,channel TEXT,template_code TEXT,message TEXT,status TEXT,event_id TEXT,created_at INTEGER)");
 await engine.ensureCommunicationTables(f.db);await bridge.ensureLifecycleCommunicationTables(f.db);await engine.setCommunicationPreference(f.db,{customerId:"CUS-REVIEW",serviceUpdates:true,marketing:false,source:"synthetic-review"});
 for(const [id,template,at] of [["OLDER","running_late",1],["CANCEL","booking_cancelled",2]])f.sqlite.prepare("INSERT INTO booking_customer_notifications VALUES (?,'BK-REVIEW','CUS-REVIEW','whatsapp',?,'Synthetic notification','queued',?,?)").run(id,template,`EVENT-${id}`,at);
 return f;
}
test("a scoped lifecycle handoff queues only its committed notification",async t=>{
 const f=await bridgeWorld(t);const r=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"BK-REVIEW",source:"booking_customer_notifications",notificationId:"CANCEL"});assert.equal(r.failed,0);assert.equal(r.enqueued,1);
 assert.deepEqual(f.sqlite.prepare("SELECT notification_id FROM lifecycle_communication_links").all().map(x=>x.notification_id),["CANCEL"]);
 const again=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"BK-REVIEW",source:"booking_customer_notifications",notificationId:"CANCEL"});assert.equal(again.enqueued,0);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM communication_outbox").get().n,1);
});
test("empty or unknown notification scope never widens to a booking-wide handoff",async t=>{
 const f=await bridgeWorld(t);for(const notificationId of [""," ","NOT-OWNED"]){const r=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"BK-REVIEW",source:"booking_customer_notifications",notificationId});assert.equal(r.enqueued,0);}
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM communication_messages").get().n,0);
});
test("the existing unscoped recovery handoff still handles all pending rows",async t=>{
 const f=await bridgeWorld(t);const r=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"BK-REVIEW",source:"booking_customer_notifications"});assert.equal(r.failed,0);assert.equal(r.enqueued,2);
});

async function booked(t){
 const f=await setupJourney();t.after(f.close);const start=new Date(Date.now()+3*86400000);start.setUTCHours(3,30,0,0);
 const config={customerId:"CUST-REFUND-REVIEW",customerName:"Synthetic Customer",phone:"+919900000515",petSourceId:"PET-REVIEW",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"GROOM-REVIEW",start:start.toISOString(),stopAfterCapture:true};
 const result=await runCompletedJourney(f,config);await engine.setCommunicationPreference(f.db,{customerId:config.customerId,serviceUpdates:true,marketing:false,source:"synthetic-review"});
 const call=async()=>{const {POST}=await import("../app/api/grooming-booking-change/route.ts");const r=await POST(new Request("https://uat.pawspace.in/api/grooming-booking-change",{method:"POST",headers:{cookie:result.customerCookie,"content-type":"application/json"},body:JSON.stringify({bookingId:result.bookingId,customerId:config.customerId,action:"cancel",reason:"Synthetic customer cancellation"})}));return {status:r.status,body:await r.json()};};return {...f,result,config,call};
}
test("zero additional refund does not falsely claim that no payment was ever taken",async t=>{
 const f=await booked(t);f.sqlite.prepare("UPDATE booking_payments SET status='refunded' WHERE booking_id=?").run(f.result.bookingId);const r=await f.call();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.refundAmount,0);
 const n=f.sqlite.prepare("SELECT message FROM booking_customer_notifications WHERE booking_id=? AND template_code='booking_cancelled'").get(f.result.bookingId);assert.ok(n);assert.doesNotMatch(n.message,/no payment was taken/i);assert.match(n.message,/cancelled/i);
});
test("the customer cancellation route does not hand off an older unrelated notification",async t=>{
 const f=await booked(t);f.sqlite.exec("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
 f.sqlite.prepare("INSERT INTO booking_customer_notifications VALUES ('OLDER-ROUTE',?,?,'whatsapp','running_late','Older synthetic update','queued','OLD-EVENT',?)").run(f.result.bookingId,f.config.customerId,Date.now()-60000);
 const r=await f.call();assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.data.refundAmount>0);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM lifecycle_communication_links WHERE notification_id='OLDER-ROUTE'").get().n,0);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM lifecycle_communication_links WHERE booking_id=? AND template_code='booking_cancelled'").get(f.result.bookingId).n,1);
});

test("refund task migration rolls back its audit event if the task write fails",async t=>{
 const f=await queueWorld(t);const tasks=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks ORDER BY id").all(),events=f.sqlite.prepare("SELECT * FROM ops_work_queue_events ORDER BY id").all();
 f.sqlite.exec("CREATE TRIGGER refuse_review_migration BEFORE UPDATE OF rule ON ops_work_queue_tasks BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END");
 await assert.rejects(()=>queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now}),/synthetic migration failure/);
 assert.deepEqual(f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks ORDER BY id").all(),tasks);assert.deepEqual(f.sqlite.prepare("SELECT * FROM ops_work_queue_events ORDER BY id").all(),events);
 f.sqlite.exec("DROP TRIGGER refuse_review_migration");await queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now});assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ops_work_queue_tasks").get().n,1);
});
test("duplicate retirement is atomic and preserves the earlier owner's deadline",async t=>{
 const f=await queueWorld(t,{both:true});const tasks=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks ORDER BY id").all(),events=f.sqlite.prepare("SELECT * FROM ops_work_queue_events ORDER BY id").all();
 f.sqlite.exec("CREATE TRIGGER refuse_review_retirement BEFORE UPDATE OF status ON ops_work_queue_tasks WHEN NEW.id='OLD-TASK' BEGIN SELECT RAISE(ABORT,'synthetic retirement failure'); END");
 await assert.rejects(()=>queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now}),/synthetic retirement failure/);
 assert.deepEqual(f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks ORDER BY id").all(),tasks);assert.deepEqual(f.sqlite.prepare("SELECT * FROM ops_work_queue_events ORDER BY id").all(),events);
 f.sqlite.exec("DROP TRIGGER refuse_review_retirement");await Promise.all([queue.sweepWorkQueue(f.db,{actorId:"a",now:f.now}),queue.sweepWorkQueue(f.db,{actorId:"b",now:f.now})]);
 const current=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks WHERE id='NEW-TASK'").get();assert.equal(current.owner,"finance-owner@pawspace.test");assert.ok(current.due_at<=f.now+60*60000);assert.equal(JSON.parse(current.detail_json).supersedesTaskId,"OLD-TASK");assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ops_work_queue_events WHERE event_type='superseded'").get().n,1);
});
test("refund rule migration leaves unrelated generic exceptions untouched",async t=>{
 const f=await queueWorld(t);f.sqlite.prepare("INSERT INTO ops_work_queue_tasks SELECT 'OTHER-TASK',rule,queue,priority,title,detail_json,booking_id,customer_id,provider_id,entity_type,'EX-OTHER','payment_exception:EX-OTHER',status,owner,sla_minutes,due_at,escalated,escalated_at,resolution_note,resolved_by,resolved_at,created_at,updated_at FROM ops_work_queue_tasks WHERE id='OLD-TASK'").run();
 const before=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks WHERE id='OTHER-TASK'").get();await queue.sweepWorkQueue(f.db,{actorId:"review-sweep",now:f.now});assert.deepEqual(f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks WHERE id='OTHER-TASK'").get(),before);
});
test("new failed-refund tasks still get created exactly once without legacy state",async t=>{
 const f=await queueWorld(t,{legacy:false});await Promise.all([queue.sweepWorkQueue(f.db,{actorId:"a",now:f.now}),queue.sweepWorkQueue(f.db,{actorId:"b",now:f.now})]);const rows=f.sqlite.prepare("SELECT * FROM ops_work_queue_tasks").all();assert.equal(rows.length,1);assert.equal(rows[0].rule,"refund_failed");assert.equal(rows[0].status,"open");assert.equal(rows[0].sla_minutes,60);
});
test("notification scoping cannot cross the booking boundary or expand null and undefined",async t=>{
 const f=await bridgeWorld(t);for(const notificationId of [undefined,null]){const r=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"BK-REVIEW",source:"booking_customer_notifications",notificationId});assert.equal(r.enqueued,0);}
 const foreign=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"OTHER-BOOKING",source:"booking_customer_notifications",notificationId:"CANCEL"});assert.equal(foreign.enqueued,0);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM communication_messages").get().n,0);
});
test("a failed scoped handoff remains retryable and does not enqueue older notifications",async t=>{
 const f=await bridgeWorld(t);f.sqlite.exec("CREATE TRIGGER refuse_review_message BEFORE INSERT ON communication_messages BEGIN SELECT RAISE(ABORT,'synthetic communication failure'); END");
 const failed=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"BK-REVIEW",source:"booking_customer_notifications",notificationId:"CANCEL"});assert.equal(failed.failed,1);assert.equal(failed.enqueued,0);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM lifecycle_communication_links").get().n,0);
 f.sqlite.exec("DROP TRIGGER refuse_review_message");const retry=await bridge.bridgeLifecycleCommunications(f.db,{bookingId:"BK-REVIEW",source:"booking_customer_notifications",notificationId:"CANCEL"});assert.equal(retry.enqueued,1);assert.deepEqual(f.sqlite.prepare("SELECT notification_id FROM lifecycle_communication_links").all().map(r=>r.notification_id),["CANCEL"]);
});
