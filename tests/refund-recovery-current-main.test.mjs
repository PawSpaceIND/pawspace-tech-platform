import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__REFUND_CLOSE_DB__", "__REFUND_CLOSE_ENV__");

const CITY="blr",ZONE="blr-east",CUSTOMER="RR-CUS-001",BOOKING="RR-BK-001",PROVIDER="groom_kiran",PAYMENT="RR-PAY-001",REFUND_CASE="RR-REF-001",AMOUNT=1899,OPS="finance-ops@pawspace.test",MAKER="finance-maker@pawspace.test";

function refundWorld(){return world("__REFUND_CLOSE_DB__","__REFUND_CLOSE_ENV__",{PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",FORBID_PRODUCTION:"true"});}
function seedCanonical(sqlite,over={}){
 const now=Date.now();
 sqlite.exec(`
 CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT,created_at INTEGER NOT NULL);
 `);
 sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)").run(CUSTOMER,"Refund Customer","9800000222","refund@example.test",CITY,"{}",now,now);
 sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at) VALUES (?,?,?,?,'grooming','dog-basic','Bath & Basic','RR-SG-1',?,?,?,?,'customer_app',?,'INR','{}','[]','test',?,?)`).run(BOOKING,CUSTOMER,CITY,ZONE,PROVIDER,new Date(now+2*86400000).toISOString(),new Date(now+2*86400000+7200000).toISOString(),over.bookingStatus??"completed",AMOUNT,now,now);
 sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES (?,?,?,?,?,'INR','card','prepaid',?,'razorpay',?,'{}',?,?)").run(PAYMENT,BOOKING,CUSTOMER,AMOUNT,AMOUNT,over.paymentStatus??"captured","rr-idem-1",now,now);
 return now;
}
function seedRefundCase(sqlite,{status,gatewayReference=null,approvedBy=null}){
 const now=Date.now();
 sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,policy_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
 sqlite.prepare("INSERT OR REPLACE INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,gateway_reference,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'{}',?,?)").run(REFUND_CASE,BOOKING,PAYMENT,AMOUNT,"Customer cancelled before the visit",status,MAKER,approvedBy,gatewayReference,now,now);
}
const refundStatus=sqlite=>sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(REFUND_CASE)?.status;
async function refundTransition(sqlite,db,toStatus,reason="Gateway rejected the first attempt; re-issuing"){
 await seedActors(sqlite,db,[{id:"USR-FINOPS",email:OPS,role:"finance"}]);
 const route=await import("../app/api/booking-operations/route.ts");
 return attempt(()=>route.POST(asActor(OPS,"/api/booking-operations",{method:"POST",body:JSON.stringify({bookingId:BOOKING,providerId:PROVIDER,action:"refund_status",refundCaseId:REFUND_CASE,refundStatus:toStatus,reason})})));
}

test("failed refund can be retried repeatedly and requeued, without opening unsafe jumps",async()=>{
 const{sqlite,db}=refundWorld();seedCanonical(sqlite);seedRefundCase(sqlite,{status:"failed",approvedBy:OPS});
 let result=await refundTransition(sqlite,db,"processing");assert.equal(result.status,200,result.body);assert.equal(refundStatus(sqlite),"processing");
 sqlite.prepare("UPDATE booking_refund_cases SET status='failed' WHERE id=?").run(REFUND_CASE);
 result=await refundTransition(sqlite,db,"processing","Second gateway failure; retry again");assert.equal(result.status,200,result.body);assert.equal(refundStatus(sqlite),"processing");
 sqlite.prepare("UPDATE booking_refund_cases SET status='failed' WHERE id=?").run(REFUND_CASE);
 result=await refundTransition(sqlite,db,"requested","Return to finance approval queue");assert.equal(result.status,200,result.body);assert.equal(refundStatus(sqlite),"requested");
 sqlite.prepare("UPDATE booking_refund_cases SET status='failed' WHERE id=?").run(REFUND_CASE);
 result=await refundTransition(sqlite,db,"completed","Unsafe jump");assert.equal(result.status,409);assert.equal(refundStatus(sqlite),"failed");
});

test("failed gateway refund becomes one critical finance task, not a duplicate generic exception",async()=>{
 const{sqlite,db}=refundWorld();seedCanonical(sqlite);const now=Date.now();
 sqlite.exec("CREATE TABLE IF NOT EXISTS payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,event_id TEXT,exception_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT);");
 const add=(id,type)=>sqlite.prepare("INSERT INTO payment_reconciliation_exceptions (id,booking_id,payment_id,event_id,exception_type,severity,status,detail_json,created_at) VALUES (?,?,?,?,?,'critical','open','{\"gatewayRefundId\":\"rfnd_TEST\"}',?)").run(id,BOOKING,PAYMENT,`evt-${id}`,type,now);
 add("PAYEX-FAILED","refund_failed");add("PAYEX-OTHER","refund_amount_mismatch");
 const{sweepWorkQueue}=await import("../lib/ops-work-queue.ts");await sweepWorkQueue(db,{actorId:"system:test",now});
 const rows=sqlite.prepare("SELECT rule,priority,entity_id,sla_minutes,queue FROM ops_work_queue_tasks ORDER BY rule").all();
 const failed=rows.filter(x=>x.rule==="refund_failed");assert.equal(failed.length,1);assert.equal(failed[0].entity_id,"PAYEX-FAILED");assert.equal(failed[0].priority,"critical");assert.equal(failed[0].queue,"finance");assert.ok(Number(failed[0].sla_minutes)<=60);
 assert.equal(rows.some(x=>x.rule==="payment_exception"&&x.entity_id==="PAYEX-FAILED"),false);
 assert.equal(rows.some(x=>x.rule==="payment_exception"&&x.entity_id==="PAYEX-OTHER"),true);
});

test("direct Grooming cancellation persists a customer notification tied to the cancellation event",async()=>{
 const{sqlite,db}=refundWorld();const now=seedCanonical(sqlite,{bookingStatus:"confirmed"});
 sqlite.exec(`
 CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER DEFAULT 1,status TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT);
 CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL,offered_at INTEGER,expires_at INTEGER,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL);
 `);
 const b=sqlite.prepare("SELECT scheduled_start,scheduled_end FROM canonical_bookings WHERE id=?").get(BOOKING);
 sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'grooming',?,?,?,'[]',?,?,1,1,NULL,'assigned','{}',?)").run("RR-RES-1","RR-SG-1",PROVIDER,CITY,ZONE,CUSTOMER,b.scheduled_start,b.scheduled_end,now);
 sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES (?,?,?,?,?,'commission','grooming',?,?,1,'confirmed',?,?)").run("RR-WO-1",BOOKING,"RR-SG-1",PROVIDER,"Kiran S.",b.scheduled_start,b.scheduled_end,now,now);
 await seedActors(sqlite,db,[{id:"USR-CUST",email:"refund@example.test",role:"admin"}]);
 const route=await import("../app/api/grooming-booking-change/route.ts");
 const cancelled=await attempt(()=>route.POST(asActor("refund@example.test","/api/grooming-booking-change",{method:"POST",body:JSON.stringify({bookingId:BOOKING,customerId:CUSTOMER,action:"cancel",reason:"Plans changed, cancelling this groom"})})));
 assert.equal(cancelled.status,200,cancelled.body);
 assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING)?.status,"cancelled");
 const notes=sqlite.prepare("SELECT template_code,message,event_id FROM booking_customer_notifications WHERE booking_id=?").all(BOOKING);assert.equal(notes.length,1);assert.equal(notes[0].template_code,"booking_cancelled");assert.match(notes[0].message,/cancelled/i);
 const eventId=sqlite.prepare("SELECT id FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_cancelled'").get(BOOKING)?.id;assert.equal(notes[0].event_id,eventId);
});

const refundEvent=(over={})=>({provider:"razorpay",environment:"sandbox",eventId:over.eventId??"evt_refund_processed_1",eventType:over.eventType??"refund.processed",bookingId:BOOKING,gatewayPaymentId:"pay_TESTFIN",gatewayRefundId:over.gatewayRefundId??"rfnd_TESTFIN",amountSubunits:AMOUNT*100,currency:"INR",createdAt:Date.now(),signatureVerified:true,payloadHash:`hash-${over.eventId??"evt_refund_processed_1"}`,...over});
async function reconciledWorld(){
 const{sqlite,db}=refundWorld();seedCanonical(sqlite);seedRefundCase(sqlite,{status:"processing",gatewayReference:"rfnd_TESTFIN",approvedBy:OPS});
 const recon=await import("../lib/grooming-payment-reconciliation.ts");const{ensureCollectionLedgerTables}=await import("../lib/collection-ledger.ts");await ensureCollectionLedgerTables(db);await recon.ensurePaymentReconciliationTables(db);await recon.linkSandboxGatewayOrder(db,{bookingId:BOOKING,gatewayOrderId:"order_TESTFIN",actorId:OPS});
 sqlite.prepare("UPDATE payment_reconciliation_records SET captured_amount=?,gateway_status='captured',reconciliation_status='matched' WHERE payment_id=?").run(AMOUNT,PAYMENT);return{sqlite,db,recon};
}
const ledgerRow=(sqlite,ref="rfnd_TESTFIN")=>sqlite.prepare("SELECT group_key,event,amount,reversal_reference FROM collection_ledger_postings WHERE group_key=?").get(`COLL-refund_completed-${ref}`);

test("processed gateway refund posts exactly one balanced refund ledger reversal",async()=>{
 const{sqlite,db,recon}=await reconciledWorld();const result=await recon.processGatewayEvent(db,refundEvent());assert.equal(result.status,"processed");assert.equal(refundStatus(sqlite),"processed");assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(PAYMENT)?.status,"refunded");
 const posting=ledgerRow(sqlite);assert.ok(posting);assert.equal(posting.event,"refund_completed");assert.equal(Math.round(Number(posting.amount)),AMOUNT);assert.equal(posting.reversal_reference,"rfnd_TESTFIN");
 const lines=sqlite.prepare("SELECT account_code,debit,credit FROM finance_journal_entries WHERE source_type=? AND source_id=? ORDER BY debit DESC").all("refund_completed","rfnd_TESTFIN");assert.equal(lines.length,2);assert.equal(Math.round(Number(lines[0].debit)),AMOUNT);assert.equal(Math.round(Number(lines[1].credit)),AMOUNT);assert.equal(Math.round(Number(lines[0].debit)-Number(lines[1].credit)),0);
 await recon.processGatewayEvent(db,refundEvent({eventId:"evt_refund_processed_replay"}));assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n,1);
});

test("redelivery repairs a half-committed processed refund instead of declaring it done",async()=>{
 const{sqlite,db,recon}=await reconciledWorld();sqlite.prepare("UPDATE booking_refund_cases SET status='processed',gateway_reference='rfnd_TESTFIN' WHERE id=?").run(REFUND_CASE);assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(PAYMENT)?.status,"captured");assert.equal(ledgerRow(sqlite),undefined);
 const recovery=await recon.processGatewayEvent(db,refundEvent({eventId:"evt_refund_redelivery"}));assert.equal(recovery.status,"processed");assert.notEqual(recovery.ignored,true);assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(PAYMENT)?.status,"refunded");assert.ok(ledgerRow(sqlite));const rr=sqlite.prepare("SELECT refunded_amount,reconciliation_status FROM payment_reconciliation_records WHERE payment_id=?").get(PAYMENT);assert.equal(Math.round(Number(rr.refunded_amount)),AMOUNT);assert.equal(rr.reconciliation_status,"matched");
 const duplicate=await recon.processGatewayEvent(db,refundEvent({eventId:"evt_refund_redelivery_2"}));assert.equal(duplicate.ignored,true);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE event='refund_completed'").get().n,1);
});

test("payment environment remains fail-closed while sandbox remains explicitly available",async()=>{
 const{parsePaymentEnvironment,sandboxCapabilitiesUnlocked}=await import("../lib/payment-environment.ts");for(const unset of [undefined,null,"",{},{PAWSPACE_PAYMENT_ENV:""},{PAWSPACE_PAYMENT_ENV:"production"}]){assert.throws(()=>parsePaymentEnvironment(unset),/must be exactly "sandbox" or "live"/);assert.equal(sandboxCapabilitiesUnlocked(unset),false);}assert.equal(parsePaymentEnvironment({PAWSPACE_PAYMENT_ENV:"sandbox"}),"sandbox");assert.equal(sandboxCapabilitiesUnlocked({PAWSPACE_PAYMENT_ENV:"sandbox"}),true);assert.equal(sandboxCapabilitiesUnlocked({PAWSPACE_PAYMENT_ENV:"live"}),false);
});
