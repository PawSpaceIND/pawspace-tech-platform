import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__REMOTE_FIN_DB__", "__REMOTE_FIN_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth=0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer=depth===0;if(outer)sqlite.exec("BEGIN IMMEDIATE");depth++;
      try { const out=[];for(const item of items)out.push(await item.run());if(outer)sqlite.exec("COMMIT");return out; }
      catch(error){if(outer)sqlite.exec("ROLLBACK");throw error;}
      finally{depth--;}
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function refundWorld() {
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  globalThis.__REMOTE_FIN_DB__=db;globalThis.__REMOTE_FIN_ENV__={};
  const { ensureSecurityTables }=await import("../lib/server-auth.ts");await ensureSecurityTables(db);
  const now=Date.now();
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,total_amount REAL NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,amount REAL NOT NULL)");
  sqlite.exec("CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?)").run("BK-R","CUS-R","PROV-R",1899);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?)").run("PAY-R","BK-R",1899);
  for(const [id,email] of [["U-M","maker@pawspace.test"],["U-C","checker@pawspace.test"]])sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'founder','active',?,?)").run(id,email,id,now,now);
  const route=await import("../app/api/booking-operations/route.ts");
  const created=await route.POST(new Request("https://ops.pawspace.example/api/booking-operations",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-email":"maker@pawspace.test"},body:JSON.stringify({bookingId:"BK-R",providerId:"PROV-R",action:"refund_requested",reason:"Initial refund request for retry test"})}));
  assert.equal(created.status,201,await created.text());
  const row=sqlite.prepare("SELECT id FROM booking_refund_cases LIMIT 1").get();
  sqlite.prepare("UPDATE booking_refund_cases SET status='failed',approved_by='checker@pawspace.test',gateway_reference='rfnd_old' WHERE id=?").run(row.id);
  return{sqlite,db,route,refundCaseId:String(row.id)};
}

async function move(route,caseId,status){
  const response=await route.POST(new Request("https://ops.pawspace.example/api/booking-operations",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-email":"checker@pawspace.test"},body:JSON.stringify({bookingId:"BK-R",providerId:"PROV-R",action:"refund_status",reason:`Finance moves failed refund to ${status}`,refundCaseId:caseId,refundStatus:status})}));
  return{status:response.status,body:await response.json().catch(()=>null)};
}

test("failed refund can resume processing or return through a fresh maker/checker cycle",async()=>{
  const first=await refundWorld();
  const direct=await move(first.route,first.refundCaseId,"processing");
  assert.equal(direct.status,200,JSON.stringify(direct.body));
  assert.equal(first.sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(first.refundCaseId).status,"processing");

  first.sqlite.prepare("UPDATE booking_refund_cases SET status='failed' WHERE id=?").run(first.refundCaseId);
  const review=await move(first.route,first.refundCaseId,"requested");
  assert.equal(review.status,200,JSON.stringify(review.body));
  const returned=first.sqlite.prepare("SELECT status,approved_by FROM booking_refund_cases WHERE id=?").get(first.refundCaseId);
  assert.equal(returned.status,"requested");assert.equal(returned.approved_by,null);

  const approve=await move(first.route,first.refundCaseId,"approved");
  assert.equal(approve.status,200,JSON.stringify(approve.body));
  const processing=await move(first.route,first.refundCaseId,"processing");
  assert.equal(processing.status,200,JSON.stringify(processing.body));
  assert.equal(first.sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(first.refundCaseId).status,"processing");
});

test("processing refunds are excluded from company analytics, unit economics and P&L until processed",async()=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  globalThis.__REMOTE_FIN_DB__=db;globalThis.__REMOTE_FIN_ENV__={};
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,zone_id TEXT NOT NULL,provider_id TEXT,status TEXT NOT NULL,total_amount REAL NOT NULL,currency TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (booking_id TEXT PRIMARY KEY,amount REAL NOT NULL,amount_due_now REAL NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE booking_refund_cases (booking_id TEXT,amount REAL,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("B1","C1","dog_walking","P","blr-east","PRV","completed",1000,"INR","2026-09-09T09:00:00.000Z","2026-09-09T10:00:00.000Z");
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?)").run("B1",1000,1000,"captured","razorpay_sandbox");
  const now=Date.parse("2026-09-09T11:00:00.000Z");
  sqlite.prepare("INSERT INTO booking_refund_cases VALUES (?,?,?,?,?)").run("B1",300,"processing",now,now);
  sqlite.prepare("INSERT INTO booking_refund_cases VALUES (?,?,?,?,?)").run("B1",200,"processed",now,now);

  const {buildCompanyAnalytics}=await import("../lib/company-analytics.ts");
  const {buildUnitEconomics}=await import("../lib/unit-economics.ts");
  const {generatePnlReport}=await import("../lib/pnl-reporting.ts");
  const analytics=await buildCompanyAnalytics(db,{from:"2026-09-09",to:"2026-09-09"});
  const unit=await buildUnitEconomics(db,{from:"2026-09-09",to:"2026-09-09"});
  const pnl=await generatePnlReport(db,{fromMonth:"2026-09",toMonth:"2026-09"});
  assert.equal(analytics.money.refunds,200);
  assert.equal(unit.company.refunds,200);
  const refundLine=pnl.revenue.lines.find(line=>line.code==="4900-Refunds and Cancellations");
  assert.equal(refundLine?.total,-200);
});

test("refund_failed reconciliation exceptions create a critical Finance work item",async()=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  sqlite.exec("CREATE TABLE payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,event_id TEXT,exception_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)");
  sqlite.prepare("INSERT INTO payment_reconciliation_exceptions (id,booking_id,payment_id,event_id,exception_type,severity,status,created_at) VALUES (?,?,?,?,?,'critical','open',?)").run("EX-R","BK-R","PAY-R","EV-R","refund_failed",Date.now());
  const {sweepWorkQueue}=await import("../lib/ops-work-queue.ts");
  const result=await sweepWorkQueue(db,{actorId:"scheduler:test"});
  assert.equal(result.created.refund_failed,1);
  const task=sqlite.prepare("SELECT rule,queue,priority,booking_id FROM ops_work_queue_tasks WHERE rule='refund_failed'").get();
  assert.deepEqual({...task},{rule:"refund_failed",queue:"finance",priority:"critical",booking_id:"BK-R"});
});

test("an explicitly reclaimed non-terminal inner gateway event re-enters processing and repairs the refund journal",async()=>{
  const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
  globalThis.__REMOTE_FIN_DB__=db;globalThis.__REMOTE_FIN_ENV__={};
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?)").run("BK-WH","CUS-WH","blr","grooming");
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','upi','prepaid','captured','razorpay_sandbox','idem','{}',?,?)").run("PAY-WH","BK-WH","CUS-WH",1899,1899,Date.now(),Date.now());
  sqlite.prepare("INSERT INTO booking_refund_cases VALUES (?,?,?,?,?,'processed','ops','finance','rfnd_recover',?,?)").run("RF-WH","BK-WH","PAY-WH",1899,"cancelled",Date.now(),Date.now());
  const {ensurePaymentReconciliationTables,linkSandboxGatewayOrder,processGatewayEvent}=await import("../lib/grooming-payment-reconciliation.ts");
  await ensurePaymentReconciliationTables(db);
  await linkSandboxGatewayOrder(db,{bookingId:"BK-WH",gatewayOrderId:"order_recover",actorId:"test"});
  sqlite.prepare("UPDATE payment_gateway_links SET gateway_payment_id='pay_recover' WHERE booking_id='BK-WH'").run();
  sqlite.prepare("UPDATE payment_reconciliation_records SET captured_amount=1899,gateway_status='captured',reconciliation_status='matched' WHERE payment_id='PAY-WH'").run();
  sqlite.prepare("INSERT INTO payment_gateway_events (id,provider,environment,event_id,event_type,booking_id,payment_id,gateway_order_id,gateway_payment_id,gateway_refund_id,amount_subunits,currency,signature_verified,payload_hash,processing_status,detail_json,received_at) VALUES ('PAYEV-REC','razorpay','sandbox','evt_recover','refund.processed','BK-WH','PAY-WH','order_recover','pay_recover','rfnd_recover',189900,'INR',1,'hash','received','{}',?)").run(Date.now());

  const result=await processGatewayEvent(db,{provider:"razorpay",environment:"sandbox",eventId:"evt_recover",eventType:"refund.processed",bookingId:"BK-WH",gatewayOrderId:"order_recover",gatewayPaymentId:"pay_recover",gatewayRefundId:"rfnd_recover",amountSubunits:189900,currency:"INR",createdAt:Date.now(),signatureVerified:true,payloadHash:"hash"},{allowRecovery:true});
  assert.equal(result.reason,"refund_already_processed");
  assert.equal(sqlite.prepare("SELECT processing_status FROM payment_gateway_events WHERE id='PAYEV-REC'").get().processing_status,"processed");
  const journal=sqlite.prepare("SELECT debit,credit FROM finance_journal_entries WHERE source_id='rfnd_recover'").all();
  assert.equal(journal.length,2);assert.equal(journal.reduce((s,r)=>s+Number(r.debit||0),0),1899);assert.equal(journal.reduce((s,r)=>s+Number(r.credit||0),0),1899);
});
