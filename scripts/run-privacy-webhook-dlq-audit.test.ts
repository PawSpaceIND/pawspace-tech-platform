import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{DatabaseSync}from"node:sqlite";
import{captureInboundWebhook,ensureGatewayInboundQueueTables,runInboundWebhookAttempt}from"../lib/gateway-inbound-queue.ts";
import{assertActiveVerifiedPayoutBeneficiary,preauthorizeVerifiedPayoutBeneficiary}from"../lib/payout-beneficiary-verification.ts";
import{eraseCustomerPersonalData}from"../lib/dpdp-erasure.ts";

assert.equal(process.env.PAWSPACE_PAYMENT_ENV,"sandbox","privacy/webhook/DLQ audit must run with PAWSPACE_PAYMENT_ENV=sandbox");
assert.equal(process.env.FORBID_PRODUCTION,"true","privacy/webhook/DLQ audit must run with FORBID_PRODUCTION=true");
assert.notEqual(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED,"true","live payment approval must remain disabled during audit");

type Args=unknown[];
function d1(sqlite:DatabaseSync){
 const statement=(sql:string,args:Args=[]):any=>({
  bind:(...values:Args)=>statement(sql,values),
  first:async()=>sqlite.prepare(sql).get(...args)??null,
  run:async()=>{const out=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(out.changes||0)}};},
  all:async()=>({results:sqlite.prepare(sql).all(...args)})
 });
 return{prepare:(sql:string)=>statement(sql),batch:async(items:any[])=>{sqlite.exec("BEGIN");try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec("COMMIT");return out;}catch(error){sqlite.exec("ROLLBACK");throw error;}},exec:async(sql:string)=>{sqlite.exec(sql);return{count:0,duration:0};}} as unknown as D1Database;
}
function world(){const sqlite=new DatabaseSync(":memory:");sqlite.exec("PRAGMA foreign_keys=ON");return{sqlite,db:d1(sqlite)};}

function read(path:string){return fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");}

test("sandbox locks and universal webhook wiring are non-vacuous",()=>{
 const pkg=JSON.parse(read("package.json"));assert.equal(pkg.scripts["test:privacy-webhook-dlq"],"node --import tsx scripts/run-privacy-webhook-dlq-audit.test.ts");
 for(const path of["app/api/email-provider-webhook/route.ts","app/api/whatsapp/meta-webhook/route.ts","app/api/whatsapp-uat-webhook/route.ts","app/api/communication-provider-callback/route.ts","app/api/voice-provider-webhook/route.ts"]){const source=read(path);assert.match(source,/captureInboundWebhook/,`${path} must persist accepted callbacks before business processing`);assert.match(source,/runInboundWebhookAttempt/,`${path} must use leased retry processing`);}
 const migration=read("drizzle/0030_privacy_webhook_beneficiary.sql");assert.match(migration,/gateway_webhook_to_universal_inbox/);assert.match(migration,/gateway_webhook_events_raw_payload_scrub_only/);assert.match(read("app/api/partner-finance/route.ts"),/preauthorizeVerifiedPayoutBeneficiary/);assert.match(read("app/api/privacy-erasure/route.ts"),/authorize\(request,"data\.delete"\)/);
});

test("universal webhook inbox dedupes payloads, rejects token rebinding, retries exponentially and terminates in DLQ",async()=>{
 const{sqlite,db}=world();await ensureGatewayInboundQueueTables(db);const first=await captureInboundWebhook(db,{provider:"audit",routeKey:"audit-hook",environment:"sandbox",eventId:"evt-1",messageId:"msg-1",rawBody:'{"amount":1}',maxAttempts:3,now:1_000});assert.equal(first.duplicatePrevented,false);
 const replay=await captureInboundWebhook(db,{provider:"audit",routeKey:"audit-hook",environment:"sandbox",eventId:"evt-1",messageId:"msg-1",rawBody:'{"amount":1}',maxAttempts:3,now:1_001});assert.equal(replay.duplicatePrevented,true);assert.equal(replay.duplicateReason,"event_id");
 await assert.rejects(()=>captureInboundWebhook(db,{provider:"audit",routeKey:"audit-hook",environment:"sandbox",eventId:"evt-1",messageId:"msg-1",rawBody:'{"amount":999}',now:1_002}),error=>error instanceof Response&&error.status===409);
 let now=1_000,delays:number[]=[];for(let attempt=1;attempt<=3;attempt++){const result=await runInboundWebhookAttempt(db,{queueId:String(first.row.id),workerId:`worker-${attempt}`,now,handler:async()=>{throw new Error("synthetic persistent failure");}});assert.equal(result.claimed,true);assert.equal(result.ok,false);if(result.ok)throw new Error("expected failure");if(result.failure.status==="RETRY"){delays.push(result.failure.retryDelayMs);now=result.failure.nextAttemptAt;}else{assert.equal(attempt,3);assert.equal(result.failure.status,"DEAD_LETTER");}}
 assert.deepEqual(delays,[60_000,120_000]);const queue=sqlite.prepare("SELECT status,attempts,raw_payload FROM gateway_inbound_queue WHERE id=?").get(String(first.row.id))as any;assert.equal(queue.status,"DEAD_LETTER");assert.equal(queue.attempts,3);assert.equal(queue.raw_payload,null);const dlq=sqlite.prepare("SELECT attempts,failure_reason FROM gateway_inbound_dead_letters WHERE queue_id=?").get(String(first.row.id))as any;assert.equal(dlq.attempts,3);assert.match(dlq.failure_reason,/synthetic persistent failure/);
});

test("DPDP erasure removes operational PII while preserving immutable double-entry totals and is idempotent",async()=>{
 const{sqlite,db}=world();sqlite.exec(`
  CREATE TABLE canonical_customers(id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT,consent_json TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE canonical_pets(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,profile_json TEXT,source_pet_id TEXT,updated_at INTEGER);
  CREATE TABLE customer_addresses(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT,line1 TEXT,line2 TEXT,area TEXT,city TEXT,postal_code TEXT,is_default INTEGER,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE crm_contacts(id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,pet_names TEXT,pet_summary TEXT,area TEXT,updated_at INTEGER);
  CREATE TABLE lead_work_items(id TEXT PRIMARY KEY,customer_id TEXT,source TEXT,last_outcome TEXT,opt_out INTEGER,updated_at INTEGER);
  CREATE TABLE communication_messages(id TEXT PRIMARY KEY,customer_id TEXT,payload_json TEXT,policy_json TEXT,provider_reference TEXT,updated_at INTEGER);
  CREATE TABLE crm_email_events(id TEXT PRIMARY KEY,customer_id TEXT,detail_json TEXT,provider_message_id TEXT);
  CREATE TABLE customer_contact_preferences(customer_id TEXT PRIMARY KEY,marketing_consent INTEGER,service_consent INTEGER,whatsapp_consent INTEGER,sms_consent INTEGER,email_consent INTEGER,opt_out INTEGER,source TEXT,updated_at INTEGER);
  CREATE TABLE journal_transactions(id TEXT PRIMARY KEY,status TEXT NOT NULL);
  CREATE TABLE journal_entries(id TEXT PRIMARY KEY,transaction_id TEXT NOT NULL,direction TEXT NOT NULL,amount_paise INTEGER NOT NULL);
 `);
 sqlite.prepare("INSERT INTO canonical_customers VALUES (?,?,?,?,?,?,?,?,?,?)").run("CUS-1","blr","Jane Doe","9876543210","9123456780","jane@example.com","app",'{"whatsapp":true}',1,1);sqlite.prepare("INSERT INTO canonical_pets VALUES (?,?,?,?,?,?,?,?)").run("PET-1","CUS-1","Buddy","dog","Labrador",'{"photo":"secret"}',"source-pet",1);sqlite.prepare("INSERT INTO customer_addresses VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("ADDR-1","CUS-1","Home","12 Secret St",null,"Indiranagar","Bengaluru","560001",1,1,1);sqlite.prepare("INSERT INTO crm_contacts VALUES (?,?,?,?,?,?,?,?,?,?)").run("CRM-1","CUS-1","Jane Doe","9876543210",null,"jane@example.com","Buddy","Labrador","Indiranagar",1);sqlite.prepare("INSERT INTO lead_work_items VALUES (?,?,?,?,?,?)").run("LEAD-1","CUS-1","Website","Called Jane",0,1);sqlite.prepare("INSERT INTO communication_messages VALUES (?,?,?,?,?,?)").run("MSG-1","CUS-1",'{"text":"call 9876543210"}','{"phone":"9876543210"}',"provider-secret",1);sqlite.prepare("INSERT INTO crm_email_events VALUES (?,?,?,?)").run("E-1","CUS-1",'{"from":"jane@example.com"}',"provider-message");sqlite.prepare("INSERT INTO customer_contact_preferences VALUES (?,?,?,?,?,?,?,?,?)").run("CUS-1",1,1,1,1,1,0,"signup",1);
 sqlite.prepare("INSERT INTO journal_transactions VALUES ('JT-1','POSTED')").run();sqlite.prepare("INSERT INTO journal_entries VALUES ('JE-D','JT-1','DEBIT',12500)").run();sqlite.prepare("INSERT INTO journal_entries VALUES ('JE-C','JT-1','CREDIT',12500)").run();
 const before=sqlite.prepare("SELECT COUNT(*) n,SUM(CASE WHEN direction='DEBIT' THEN amount_paise ELSE 0 END) d,SUM(CASE WHEN direction='CREDIT' THEN amount_paise ELSE 0 END) c FROM journal_entries").get()as any;const result=await eraseCustomerPersonalData(db,{customerId:"CUS-1",idempotencyKey:"erase-1",requestedBy:"privacy@pawspace.in",reason:"data principal erasure"});assert.equal(result.ledgerPreserved,true);const after=sqlite.prepare("SELECT COUNT(*) n,SUM(CASE WHEN direction='DEBIT' THEN amount_paise ELSE 0 END) d,SUM(CASE WHEN direction='CREDIT' THEN amount_paise ELSE 0 END) c FROM journal_entries").get()as any;assert.deepEqual(after,before);
 const customer=sqlite.prepare("SELECT name,primary_phone,secondary_phone,email,consent_json FROM canonical_customers WHERE id='CUS-1'").get()as any;assert.notEqual(customer.name,"Jane Doe");assert.notEqual(customer.primary_phone,"9876543210");assert.equal(customer.secondary_phone,null);assert.notEqual(customer.email,"jane@example.com");assert.equal(customer.consent_json,"{}");assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_addresses WHERE customer_id='CUS-1'").get().n,0);assert.equal((sqlite.prepare("SELECT payload_json FROM communication_messages WHERE id='MSG-1'").get()as any).payload_json,"{}");assert.equal((sqlite.prepare("SELECT name,breed,profile_json FROM canonical_pets WHERE id='PET-1'").get()as any).breed,null);
 const repeat=await eraseCustomerPersonalData(db,{customerId:"CUS-1",idempotencyKey:"erase-1",requestedBy:"privacy@pawspace.in"});assert.equal(repeat.duplicatePrevented,true);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM dpdp_erasure_requests").get().n,1);
});

async function beneficiaryWorld(){
 const{sqlite,db}=world();sqlite.exec(`
  CREATE TABLE provider_compensation_profiles(provider_id TEXT PRIMARY KEY,engagement_model TEXT,status TEXT,razorpayx_contact_id TEXT,razorpayx_fund_account_id TEXT);
  CREATE TABLE provider_onboarding_applications(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE provider_verifications(id TEXT PRIMARY KEY,application_id TEXT NOT NULL,verification_type TEXT NOT NULL,status TEXT NOT NULL,verified_at INTEGER,expires_at INTEGER,updated_at INTEGER,created_at INTEGER);
  CREATE TABLE provider_order_payouts(id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,amount REAL NOT NULL,currency TEXT,rail TEXT,environment TEXT,status TEXT,due_at INTEGER,razorpayx_contact_id TEXT,razorpayx_fund_account_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_by TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE partner_payout_instructions(id TEXT PRIMARY KEY,statement_id TEXT UNIQUE,provider_id TEXT NOT NULL,amount REAL,currency TEXT,environment TEXT,status TEXT,idempotency_key TEXT UNIQUE,provider_reference TEXT,last_error TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
 `);sqlite.prepare("INSERT INTO provider_compensation_profiles VALUES (?,?,?,?,?)").run("PRV-1","commission","active",null,null);sqlite.prepare("INSERT INTO provider_onboarding_applications VALUES (?,?,?)").run("APP-1","PRV-1",1000);return{sqlite,db};
}

test("beneficiary assertion rejects missing KYC, missing bindings and expired KYC",async()=>{
 const{sqlite,db}=await beneficiaryWorld();await assert.rejects(()=>assertActiveVerifiedPayoutBeneficiary(db,"PRV-1",2000),/contact and fund account bindings/);sqlite.prepare("UPDATE provider_compensation_profiles SET razorpayx_contact_id='cont_1',razorpayx_fund_account_id='fa_1' WHERE provider_id='PRV-1'").run();await assert.rejects(()=>assertActiveVerifiedPayoutBeneficiary(db,"PRV-1",2000),/bank_kyc is not verified/);sqlite.prepare("INSERT INTO provider_verifications VALUES (?,?,?,?,?,?,?,?)").run("VER-1","APP-1","bank_kyc","verified",1500,1900,1500,1400);await assert.rejects(()=>assertActiveVerifiedPayoutBeneficiary(db,"PRV-1",2000),/bank_kyc has expired/);sqlite.prepare("UPDATE provider_verifications SET expires_at=5000 WHERE id='VER-1'").run();const verified=await assertActiveVerifiedPayoutBeneficiary(db,"PRV-1",2000);assert.equal(verified.razorpayxFundAccountId,"fa_1");assert.match(verified.snapshotSha256,/^[0-9a-f]{64}$/);
});

test("verified beneficiary snapshot is cryptographically bound to payout records before approval",async()=>{
 const{sqlite,db}=await beneficiaryWorld();sqlite.prepare("UPDATE provider_compensation_profiles SET razorpayx_contact_id='cont_1',razorpayx_fund_account_id='fa_1' WHERE provider_id='PRV-1'").run();sqlite.prepare("INSERT INTO provider_verifications VALUES (?,?,?,?,?,?,?,?)").run("VER-1","APP-1","bank_kyc","verified",1500,5000,1500,1400);
 const verified=await preauthorizeVerifiedPayoutBeneficiary(db,{providerId:"PRV-1",scopeType:"booking",scopeId:"BK-1",asOf:2000});sqlite.prepare("INSERT INTO provider_order_payouts (id,booking_id,provider_id,amount,currency,rail,environment,status,due_at,razorpayx_contact_id,razorpayx_fund_account_id,idempotency_key,created_by,created_at,updated_at) VALUES ('PX-1','BK-1','PRV-1',100,'INR','razorpayx','sandbox','queued_sandbox',2000,'cont_1','fa_1','idem-1','checker',2000,2000)").run();const payout=sqlite.prepare("SELECT beneficiary_snapshot_sha256,beneficiary_snapshot_json FROM provider_order_payouts WHERE id='PX-1'").get()as any;assert.equal(payout.beneficiary_snapshot_sha256,verified.snapshotSha256);assert.match(payout.beneficiary_snapshot_json,/"bank_kyc"/);
 assert.throws(()=>sqlite.prepare("INSERT INTO provider_order_payouts (id,booking_id,provider_id,amount,currency,rail,environment,status,due_at,idempotency_key,created_by,created_at,updated_at) VALUES ('PX-2','BK-2','PRV-1',100,'INR','razorpayx','sandbox','queued_sandbox',2000,'idem-2','checker',2000,2000)").run(),/verified payout beneficiary snapshot required/);
 sqlite.prepare("INSERT INTO partner_payout_instructions (id,statement_id,provider_id,amount,currency,environment,status,idempotency_key,created_by,created_at,updated_at) VALUES ('PI-1','SET-1','PRV-1',100,'INR','sandbox','awaiting_approval_2','set-1','maker',2000,2000)").run();const instructionVerified=await preauthorizeVerifiedPayoutBeneficiary(db,{providerId:"PRV-1",scopeType:"instruction",scopeId:"PI-1",asOf:2100});sqlite.prepare("UPDATE partner_payout_instructions SET status='approved_sandbox' WHERE id='PI-1'").run();const instruction=sqlite.prepare("SELECT beneficiary_snapshot_sha256,razorpayx_fund_account_id,status FROM partner_payout_instructions WHERE id='PI-1'").get()as any;assert.equal(instruction.status,"approved_sandbox");assert.equal(instruction.beneficiary_snapshot_sha256,instructionVerified.snapshotSha256);assert.equal(instruction.razorpayx_fund_account_id,"fa_1");
 sqlite.prepare("INSERT INTO partner_payout_instructions (id,statement_id,provider_id,amount,currency,environment,status,idempotency_key,created_by,created_at,updated_at) VALUES ('PI-2','SET-2','PRV-1',100,'INR','sandbox','awaiting_approval_2','set-2','maker',2000,2000)").run();assert.throws(()=>sqlite.prepare("UPDATE partner_payout_instructions SET status='approved_sandbox' WHERE id='PI-2'").run(),/verified payout beneficiary snapshot required/);
});
