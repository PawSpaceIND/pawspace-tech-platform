import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {employeeAuditD1} from "./helpers/employee-audit-d1.mjs";
installWorkersHooks("__CONTRACT_PAYOUT_DB__","__CONTRACT_PAYOUT_ENV__");
const payout=await import("../lib/contractor-payout.ts"),runtime=await import("../lib/razorpayx-payout-runtime.ts"),finance=await import("../lib/finance-accounts.ts");
const env={PAWSPACE_DEPLOYMENT_ENV:"staging",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_RAZORPAYX_ENV:"sandbox",PAWSPACE_RAZORPAYX_LIVE_APPROVED:"false",RAZORPAYX_KEY_ID_SANDBOX:"rzp_test_OFFLINE",RAZORPAYX_KEY_SECRET_SANDBOX:"offline-key",RAZORPAYX_ACCOUNT_NUMBER_SANDBOX:"offline-account",RAZORPAYX_WEBHOOK_SECRET_SANDBOX:"offline-webhook"};
const input={statementId:"CTS-OFFLINE",expectedNetPayable:900,actorId:"finance@offline.test",reason:"Reviewed synthetic contractor TEST payout"};
async function world(t){
 const w=employeeAuditD1(t);w.db.exec=async sql=>{w.sqlite.exec(sql);return{count:0,duration:0};};globalThis.__CONTRACT_PAYOUT_DB__=w.db;globalThis.__CONTRACT_PAYOUT_ENV__={...env,DB:w.db};
 await runtime.ensureRazorpayXPayoutRuntime(w.db);const at=Date.now();
 w.sqlite.exec("CREATE TABLE provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,updated_at INTEGER);CREATE TABLE provider_verifications (id TEXT PRIMARY KEY,application_id TEXT,verification_type TEXT,status TEXT,verified_at INTEGER,expires_at INTEGER,updated_at INTEGER,created_at INTEGER)");
 w.sqlite.prepare("INSERT INTO provider_compensation_profiles (provider_id,engagement_model,razorpayx_contact_id,razorpayx_fund_account_id,updated_by,created_at,updated_at) VALUES ('CONTRACT-OFFLINE','full_time','cont_OFFLINE','fa_OFFLINE','fixture',?,?)").run(at,at);
 w.sqlite.prepare("INSERT INTO provider_onboarding_applications VALUES ('APP-OFFLINE','CONTRACT-OFFLINE',?)").run(at);
 w.sqlite.prepare("INSERT INTO provider_verifications VALUES ('VERIFY-OFFLINE','APP-OFFLINE','bank_kyc','verified',?,?,?,?)").run(at,at+86400000,at,at);
 const date=new Date(at).toISOString().slice(0,10);
 const plan=await finance.postJournal(w.db,{groupKey:"CONTRACT-OFFLINE",entryDate:date,periodCode:date.slice(0,7),sourceType:"contractor_statement",sourceId:input.statementId,narration:"Synthetic approved contract accrual",lines:[{accountCode:"6000-Contract Expense",debit:1000},{accountCode:"2110-Provider Payable",credit:900},{accountCode:"2150-TDS Payable",credit:100}]});
 w.sqlite.prepare("INSERT INTO contractor_monthly_statements (id,provider_id,period_code,service_code,status,days_in_month,active_days,fixed_fee,incentive,petrol,tds_section,tds_rate_pct,tds_base,tds_amount,net_payable,lines_json,blockers_json,journal_group,approved_by,approved_at,created_at,updated_at) VALUES (?,'CONTRACT-OFFLINE','2026-08','grooming','approved',31,31,1000,0,0,'194J',10,1000,100,900,'[]','[]',?,'approver@offline.test',?,?,?)").run(input.statementId,plan.journalGroup,at,at,at);
 t.mock.method(globalThis,"fetch",()=>{throw Error("OFFLINE ONLY: unexpected network request");});return w;
}
const balance=(w,account)=>w.sqlite.prepare("SELECT COALESCE(SUM(debit-credit),0) value FROM finance_journal_entries WHERE account_code=?").get(account).value;
const receipt=(instruction,status,id="receipt-"+status)=>{const rawBody=JSON.stringify({event:"payout."+status,payload:{payout:{entity:{id:"pout_CONTRACT",amount:90000,currency:"INR",fund_account_id:"fa_OFFLINE",reference_id:instruction.id,status}}}});return{rawBody,eventId:id,signature:createHmac("sha256",env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX).update(rawBody).digest("hex")};};
test("contractor TEST release is one instruction and preserves contractor/employee separation",async t=>{
 const w=await world(t),a=await payout.queueContractorPayout(w.db,env,input),b=await payout.queueContractorPayout(w.db,env,input);
 assert.equal(a.id,b.id);assert.equal(b.duplicatePrevented,true);assert.equal(balance(w,"2110-Provider Payable"),0);assert.equal(balance(w,"2115-Provider Payouts in Transit"),-900);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_order_payouts").get().n,0);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM partner_payout_instructions").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT status FROM contractor_monthly_statements").get().status,"approved");
 assert.equal((await payout.contractorPayoutDirectory(w.db,"2026-08"))[0].id,a.id);
});
test("contractor concurrent release cannot duplicate its instruction or journal",async t=>{
 const w=await world(t),results=await Promise.all([payout.queueContractorPayout(w.db,env,input),payout.queueContractorPayout(w.db,env,input)]);
 assert.equal(new Set(results.map(r=>r.id)).size,1);assert.equal(balance(w,"2115-Provider Payouts in Transit"),-900);
});
for(const problem of ["draft","amount","bank","expired","books","live"])test(`contractor payout refuses ${problem} before creating payment authority`,async t=>{
 const w=await world(t);let e=env,i=input;
 if(problem==="draft")w.sqlite.exec("UPDATE contractor_monthly_statements SET status='draft'");
 if(problem==="amount")i={...input,expectedNetPayable:901};
 if(problem==="bank")w.sqlite.exec("UPDATE provider_verifications SET status='pending'");
 if(problem==="expired")w.sqlite.exec("UPDATE provider_verifications SET expires_at=1");
 if(problem==="books")w.sqlite.exec("UPDATE finance_journal_entries SET posted=0");
 if(problem==="live")e={...env,PAWSPACE_PAYMENT_ENV:"live"};
 await assert.rejects(()=>payout.queueContractorPayout(w.db,e,i));assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM contractor_payout_instructions").get().n,0);
});
test("contractor signed receipts settle principal once, reverse once and leave taxes unchanged",async t=>{
 const w=await world(t),instruction=await payout.queueContractorPayout(w.db,env,input);
 const processed=receipt(instruction,"processed");await runtime.processRazorpayXWebhook(w.db,env,processed);await runtime.processRazorpayXWebhook(w.db,env,processed);
 assert.equal(balance(w,"2115-Provider Payouts in Transit"),0);assert.equal(balance(w,"1010-Bank"),-900);assert.equal(balance(w,"2150-TDS Payable"),-100);
 await runtime.processRazorpayXWebhook(w.db,env,receipt(instruction,"reversed"));await runtime.processRazorpayXWebhook(w.db,env,receipt(instruction,"processed","late-processed"));
 assert.equal(balance(w,"1010-Bank"),0);assert.equal(balance(w,"2115-Provider Payouts in Transit"),-900);assert.equal(balance(w,"2150-TDS Payable"),-100);
 assert.equal(w.sqlite.prepare("SELECT status FROM contractor_payout_instructions").get().status,"reversed_sandbox");assert.equal(w.sqlite.prepare("SELECT status FROM razorpayx_payout_accounting").get().status,"reconciliation_required");
});
