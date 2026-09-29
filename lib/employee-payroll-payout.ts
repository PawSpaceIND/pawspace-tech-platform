import {ensurePeopleFinanceTables,postPayrollJournal} from "./people-finance-integration";
import {prepareJournalPosting,periodOf} from "./finance-accounts";
import {prepareRazorpayXPayoutAccounting,razorpayXPayoutAccountingDirectory} from "./razorpayx-payout-accounting";
import {razorpayXPayoutIdentityProblem} from "./razorpayx-payout-identity";
import{ensurePayrollTables}from"./payroll-engine";
import{appendPayrollCheck,completePayrollResults,payrollIntegrityConflict}from"./payroll-integrity";
import{createRazorpayXSandboxPayout,fetchRazorpayXSandboxPayout,razorpayXSandboxReadiness}from"./razorpayx-client";
import{verifyRazorpayRawBody,sha256Hex}from"./financial-lifecycle";
import{governedJsonError}from"./governed-http-error";
type Row=Record<string,unknown>;type Env=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim(),uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,18)}`;
const refusal=(error:string,status=409)=>governedJsonError({error},status);
function sandbox(env:Env){const ready=razorpayXSandboxReadiness(env);if(!ready.ready)throw refusal(`Employee salary TEST transport is not configured: ${ready.problems.join('; ')}`,503);}
export async function ensureEmployeeSalaryTables(db:D1Database){await ensurePayrollTables(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS employee_salary_beneficiaries (employee_id TEXT PRIMARY KEY,fund_account_id TEXT NOT NULL,verification_reference TEXT NOT NULL,verified_by TEXT NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,environment TEXT NOT NULL CHECK(environment='sandbox'))"),
 db.prepare("CREATE TABLE IF NOT EXISTS employee_salary_instructions (id TEXT PRIMARY KEY,result_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,employee_id TEXT NOT NULL,amount_paise INTEGER NOT NULL CHECK(amount_paise>=100),currency TEXT NOT NULL DEFAULT 'INR',fund_account_id TEXT NOT NULL,beneficiary_snapshot_json TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,provider_payout_id TEXT UNIQUE,utr TEXT,last_error TEXT,approved_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'))"),
 db.prepare("CREATE INDEX IF NOT EXISTS employee_salary_run_idx ON employee_salary_instructions(run_id,status)"),
 db.prepare("CREATE TABLE IF NOT EXISTS employee_salary_events (id TEXT PRIMARY KEY,instruction_id TEXT,action TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS employee_salary_webhook_events (event_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,instruction_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);}
export async function saveEmployeeSalaryBeneficiary(db:D1Database,input:{employeeId:string;fundAccountId:string;verificationReference:string;expiresAt:number;actorId:string}){
 await ensureEmployeeSalaryTables(db);
 const now=Date.now();if(!/^fa_[A-Za-z0-9]+$/.test(input.fundAccountId)||input.verificationReference.trim().length<8||!Number.isFinite(input.expiresAt)||input.expiresAt<=now||input.expiresAt>now+90*86400000||!text(input.actorId))throw refusal("Reviewed TEST fund account, verification evidence reference and expiry within 90 days are required",400);
 const exitTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_exit_cases'").first<Row>();const eligible=exitTable?"(employment_status='active' OR (employment_status='exited' AND EXISTS(SELECT 1 FROM employee_exit_cases x WHERE x.employee_id=employees.id AND x.access_ends_at=employees.ended_at AND x.status IN ('access_revoked','settled_sandbox'))))":"employment_status='active'";const employee=await db.prepare(`SELECT id FROM employees WHERE id=? AND ${eligible}`).bind(input.employeeId).first<Row>();if(!employee)throw refusal("An active employee or a verified exited employee owed final payroll is required");
 await db.batch([
  db.prepare("INSERT INTO employee_salary_beneficiaries (employee_id,fund_account_id,verification_reference,verified_by,verified_at,expires_at,environment) VALUES (?,?,?,?,?,?,'sandbox') ON CONFLICT(employee_id) DO UPDATE SET fund_account_id=excluded.fund_account_id,verification_reference=excluded.verification_reference,verified_by=excluded.verified_by,verified_at=excluded.verified_at,expires_at=excluded.expires_at").bind(input.employeeId,input.fundAccountId,input.verificationReference.trim(),input.actorId,now,input.expiresAt),
  db.prepare("INSERT INTO employee_salary_events (id,instruction_id,action,actor_id,detail_json,created_at) VALUES (?,NULL,'beneficiary_reviewed',?,?,?)").bind(uid("SE"),input.actorId,JSON.stringify({employeeId:input.employeeId,verificationReference:input.verificationReference.trim(),environment:"sandbox"}),now),
 ]);return{employeeId:input.employeeId,environment:"sandbox",reviewed:true,automaticallyVerified:false};
}
const instructionView=(r:Row)=>({id:text(r.id),runId:text(r.run_id),resultId:text(r.result_id),employeeId:text(r.employee_id),amountPaise:Number(r.amount_paise),status:text(r.status),providerPayoutId:r.provider_payout_id?text(r.provider_payout_id):null,utr:r.utr?text(r.utr):null,error:r.last_error?text(r.last_error):null,environment:"sandbox"});
export async function employeeSalaryDirectory(db:D1Database,runId?:string){await ensureEmployeeSalaryTables(db);const instructions=(await db.prepare("SELECT * FROM employee_salary_instructions WHERE (?='' OR run_id=?) ORDER BY created_at DESC LIMIT 500").bind(runId||"",runId||"").all<Row>()).results;return{instructions:instructions.map(instructionView),payoutAccounting:await razorpayXPayoutAccountingDirectory(db,instructions.map(r=>text(r.id))),environment:"sandbox",liveSalaryEnabled:false};}
export async function queueEmployeeSalary(db:D1Database,input:{runId:string;actorId:string;resultIds?:string[]}){
 await ensureEmployeeSalaryTables(db);const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();
 if(!run||text(run.status)!=="payment_prepared")throw refusal("Approve payroll and prepare its sandbox batch before authorizing salary instructions");
 if([run.created_by,run.reviewed_by].some(v=>text(v).toLowerCase()===input.actorId.toLowerCase()))throw refusal("Payroll maker/reviewer cannot authorize salary instructions");
 const results=await completePayrollResults(db,run),existing=(await db.prepare("SELECT * FROM employee_salary_instructions WHERE run_id=?").bind(input.runId).all<Row>()).results;
 const allPayable=results.filter(r=>Number(r.net_pay)>0),requested=input.resultIds?.length?new Set(input.resultIds.map(text).filter(Boolean)):null;
 const payable=requested?allPayable.filter(r=>requested.has(text(r.id))):allPayable;if(!payable.length)throw refusal("No positive employee salaries are payable for this release");
 if(requested&&payable.length!==requested.size)throw payrollIntegrityConflict();
 const selectedExisting=existing.filter(row=>payable.some(r=>text(r.id)===text(row.result_id)));
 if(selectedExisting.some(row=>!payable.some(r=>text(r.id)===text(row.result_id)&&Math.round(Number(r.net_pay)*100)===Number(row.amount_paise))))throw payrollIntegrityConflict();
 if(selectedExisting.length===payable.length)return{instructions:selectedExisting.map(instructionView),duplicatePrevented:true,environment:"sandbox"};
 const pendingPayable=payable.filter(r=>!selectedExisting.some(row=>text(row.result_id)===text(r.id)));
 const periodCode=new Date(Number(run.period_end)).toISOString().slice(0,7);
 await ensurePeopleFinanceTables(db);const existingPost=await db.prepare("SELECT payroll_run_id FROM people_payroll_finance_posts WHERE payroll_run_id=? AND status='posted_uat'").bind(input.runId).first<Row>();
 // A previously accrued salary can be paid in a later open month without reopening or reposting its closed accrual month.
 if(!existingPost){try{await postPayrollJournal(db,{runId:input.runId,periodCode,actorId:input.actorId});}catch(error){if(!/UNIQUE constraint failed: people_payroll_finance_posts/.test(error instanceof Error?error.message:String(error)))throw error;}}
 const mapping=await db.prepare("SELECT account_code FROM people_finance_account_mappings WHERE source_key='payroll.net_pay_payable'").first<Row>();if(!mapping?.account_code)throw refusal("Approved payroll Finance account mapping is required before salary preparation");
 const writes:D1PreparedStatement[]=[],now=Date.now();appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM people_payroll_finance_posts WHERE payroll_run_id=? AND status='posted_uat') AND ABS(COALESCE((SELECT SUM(credit-debit) FROM finance_journal_entries WHERE source_type='payroll_run' AND source_id=? AND account_code=? AND posted=1),0)-(SELECT COALESCE(SUM(net_pay),0) FROM employee_payroll_results WHERE run_id=?))<0.005",[input.runId,input.runId,mapping.account_code,input.runId]);appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM payroll_runs WHERE id=? AND status='payment_prepared') AND (SELECT COUNT(*) FROM payroll_payment_batches WHERE run_id=? AND external_transmission=0)=1",[input.runId,input.runId]);
 for(const result of pendingPayable){
  const beneficiary=await db.prepare("SELECT * FROM employee_salary_beneficiaries WHERE employee_id=? AND environment='sandbox' AND expires_at>?").bind(result.employee_id,now).first<Row>();
  if(!beneficiary)throw refusal("Every payable employee needs unexpired reviewed TEST beneficiary evidence");
  const amount=Math.round(Number(result.net_pay)*100);if(!Number.isSafeInteger(amount)||amount<100)throw refusal("Salary amounts must be integer paise of at least one rupee");
  appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_payroll_results WHERE id=? AND run_id=? AND employee_id=? AND ABS(net_pay*100-?)<0.001) AND EXISTS(SELECT 1 FROM employee_salary_beneficiaries WHERE employee_id=? AND fund_account_id=? AND verified_at=? AND expires_at>?)",[result.id,input.runId,result.employee_id,amount,result.employee_id,beneficiary.fund_account_id,beneficiary.verified_at,now]);
  const date=new Date(now).toISOString().slice(0,10),release=await prepareJournalPosting(db,{groupKey:`SALARY-RELEASE-${text(result.id)}`,entryDate:date,periodCode:periodOf(date),sourceType:"employee_salary_release",sourceId:text(result.id),narration:"Approved employee salary TEST instruction; not bank paid",lines:[{accountCode:text(mapping.account_code),debit:amount/100},{accountCode:"2116-Employee Salary Payouts in Transit",credit:amount/100}],metadata:{verificationStatus:"sandbox",transactionAt:now}});
  writes.push(...release.statements);
  writes.push(db.prepare("INSERT INTO employee_salary_instructions (id,result_id,run_id,employee_id,amount_paise,currency,fund_account_id,beneficiary_snapshot_json,idempotency_key,status,approved_by,created_at,updated_at) VALUES (?,?,?,?,?,'INR',?,?,?,'approved_sandbox',?,?,?)").bind(uid("SALPAY"),result.id,input.runId,result.employee_id,amount,beneficiary.fund_account_id,JSON.stringify(beneficiary),`salary:${text(result.id)}`,input.actorId,now,now));
 }
 writes.push(db.prepare("INSERT INTO employee_salary_events (id,instruction_id,action,actor_id,detail_json,created_at) VALUES (?,NULL,'run_authorized',?,?,?)").bind(uid("SE"),input.actorId,JSON.stringify({runId:input.runId,count:pendingPayable.length,selectedResultIds:payable.map(r=>text(r.id))}),now));
 try{await db.batch(writes);}catch(error){const rows=(await db.prepare("SELECT * FROM employee_salary_instructions WHERE run_id=?").bind(input.runId).all<Row>()).results,selected=rows.filter(row=>payable.some(r=>text(r.id)===text(row.result_id)));if(selected.length===payable.length&&selected.every(row=>payable.some(r=>text(r.id)===text(row.result_id)&&Math.round(Number(r.net_pay)*100)===Number(row.amount_paise))))return{instructions:selected.map(instructionView),duplicatePrevented:true,environment:"sandbox"};throw error;}
 return{...(await employeeSalaryDirectory(db,input.runId)),duplicatePrevented:false};
}
async function salaryInstruction(db:D1Database,id:string){await ensureEmployeeSalaryTables(db);const row=await db.prepare("SELECT * FROM employee_salary_instructions WHERE id=?").bind(id).first<Row>();if(!row)throw refusal("Employee salary instruction not found",404);return row;}
async function applySalaryProviderState(db:D1Database,row:Row,payout:Row,actorId:string,event?:{id:string;hash:string}){
 const identityProblem=razorpayXPayoutIdentityProblem(payout,{localPayoutId:text(row.id),fundAccountId:text(row.fund_account_id),amountPaise:Number(row.amount_paise),currency:"INR",providerPayoutId:text(row.provider_payout_id)||null});
 if(identityProblem)throw refusal(identityProblem);
 const statuses=new Set(["queued","pending","initiated","processing","processed","failed","reversed","rejected","cancelled"]);const incoming=text(payout.status);if(!statuses.has(incoming))throw refusal("Unsupported salary payout state",400);
 const current=text(row.status),next=incoming==="processed"?"paid_sandbox":["failed","reversed","rejected","cancelled"].includes(incoming)?`${incoming}_sandbox`:"processing_sandbox";
 const terminal=["paid_sandbox","failed_sandbox","rejected_sandbox","cancelled_sandbox","reversed_sandbox"];
 const preserve=terminal.includes(current)&&!(current==="paid_sandbox"&&next==="reversed_sandbox");const effective=preserve?current:next;
 const writes:D1PreparedStatement[]=[],now=Date.now();appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_salary_instructions WHERE id=? AND status=? AND COALESCE(provider_payout_id,'')=? AND environment='sandbox' AND run_id=? AND result_id=? AND employee_id=? AND amount_paise=? AND fund_account_id=? AND currency='INR')",[row.id,current,text(row.provider_payout_id),row.run_id,row.result_id,row.employee_id,row.amount_paise,row.fund_account_id]);
 if(event)writes.push(db.prepare("INSERT INTO employee_salary_webhook_events (event_id,payload_hash,instruction_id,status,created_at) VALUES (?,?,?,'processed',?)").bind(event.id,event.hash,row.id,now));
 writes.push(db.prepare("UPDATE employee_salary_instructions SET status=?,provider_payout_id=?,utr=COALESCE(?,utr),last_error=?,updated_at=? WHERE id=?").bind(effective,payout.id,text(payout.utr)||null,["failed_sandbox","reversed_sandbox","rejected_sandbox","cancelled_sandbox"].includes(effective)?effective:null,now,row.id));
 writes.push(db.prepare("UPDATE payslips SET status=? WHERE run_id=? AND employee_id=? AND result_id=?").bind(effective,row.run_id,row.employee_id,row.result_id));
 writes.push(db.prepare("UPDATE payroll_runs SET status='paid_sandbox' WHERE id=? AND status='payment_prepared' AND NOT EXISTS(SELECT 1 FROM employee_salary_instructions WHERE run_id=? AND status<>'paid_sandbox') AND (SELECT COUNT(*) FROM employee_salary_instructions WHERE run_id=?)=(SELECT COUNT(*) FROM employee_payroll_results WHERE run_id=? AND net_pay>0)").bind(row.run_id,row.run_id,row.run_id,row.run_id));
 if(effective==="reversed_sandbox")writes.push(db.prepare("UPDATE payroll_runs SET status='payment_prepared' WHERE id=? AND status='paid_sandbox'").bind(row.run_id));
 writes.push(db.prepare("INSERT INTO employee_salary_events (id,instruction_id,action,actor_id,detail_json,created_at) VALUES (?,?,'provider_state',?,?,?)").bind(uid("SE"),row.id,actorId,JSON.stringify({status:effective,providerPayoutId:payout.id,environment:"sandbox"}),now));
 const accounting=await prepareRazorpayXPayoutAccounting(db,{source:"salary",row:{...row,statement_id:row.result_id,amount:Number(row.amount_paise)/100},status:effective.replace(/_sandbox$/,"").replace(/^paid$/,"processed"),providerPayoutId:text(payout.id),at:now});
 writes.push(...accounting.statements);
 await db.batch(writes);return{instruction:instructionView({...row,status:effective,provider_payout_id:payout.id,utr:text(payout.utr)||row.utr}),accounting:{status:accounting.status,principalOnly:true,bankStatementReconciled:false},environment:"sandbox"};
}
export async function dispatchEmployeeSalarySandbox(db:D1Database,env:Env,input:{instructionId:string;actorId:string}){
 sandbox(env);const row=await salaryInstruction(db,input.instructionId),status=text(row.status),now=Date.now();
 if(["paid_sandbox","failed_sandbox","reversed_sandbox","rejected_sandbox","cancelled_sandbox"].includes(status))return{instruction:instructionView(row),duplicatePrevented:true};
 if(row.provider_payout_id)return reconcileEmployeeSalarySandbox(db,env,input);
 if(!["approved_sandbox","reconciliation_required","dispatching_sandbox"].includes(status)||(status==="dispatching_sandbox"&&Number(row.updated_at)>now-60000))throw refusal("Salary instruction is already being dispatched; reconcile before retrying");
 const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(row.run_id).first<Row>();if(!run||text(run.status)!=="payment_prepared")throw refusal("Canonical payroll is not prepared for this salary instruction");
 const results=await completePayrollResults(db,run);if(!results.some(r=>text(r.id)===text(row.result_id)&&Math.round(Number(r.net_pay)*100)===Number(row.amount_paise)))throw payrollIntegrityConflict();
 const beneficiary=JSON.parse(text(row.beneficiary_snapshot_json)) as Row;
 if(Number(beneficiary.expires_at)<=now)throw refusal("Approved beneficiary evidence expired before salary dispatch");
 const updated=await db.prepare("UPDATE employee_salary_instructions SET status='dispatching_sandbox',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status=? AND updated_at=? AND environment='sandbox' AND EXISTS(SELECT 1 FROM employee_salary_beneficiaries b WHERE b.employee_id=employee_salary_instructions.employee_id AND b.fund_account_id=employee_salary_instructions.fund_account_id AND b.verified_at=? AND b.expires_at>? AND b.environment='sandbox')").bind(now,row.id,status,row.updated_at,beneficiary.verified_at,now).run();
 if(!Number(updated.meta.changes))throw refusal("Another request owns this salary instruction or its reviewed beneficiary changed; refresh and review before dispatch");
 const sent=await createRazorpayXSandboxPayout(env,{localPayoutId:text(row.id),payroll:{employeeId:text(row.employee_id),runId:text(row.run_id)},fundAccountId:text(row.fund_account_id),amountPaise:Number(row.amount_paise),currency:"INR",idempotencyKey:text(row.idempotency_key)});
 if(!sent.connected){await db.prepare("UPDATE employee_salary_instructions SET status='reconciliation_required',last_error=?,updated_at=? WHERE id=? AND status='dispatching_sandbox'").bind(sent.reason,Date.now(),row.id).run();const observed=await salaryInstruction(db,text(row.id));if(observed.provider_payout_id&&["paid_sandbox","reversed_sandbox","failed_sandbox"].includes(text(observed.status)))return{connected:true,instruction:instructionView(observed),receiptAlreadyObserved:true,environment:"sandbox"};return{connected:false,reconciliationRequired:true,environment:"sandbox"};}
 try{return await applySalaryProviderState(db,await salaryInstruction(db,text(row.id)),sent.payout,input.actorId);}catch(error){await db.prepare("UPDATE employee_salary_instructions SET status='reconciliation_required',last_error='provider_response_requires_review',updated_at=? WHERE id=? AND status='dispatching_sandbox'").bind(Date.now(),row.id).run();throw error;}
}
export async function reconcileEmployeeSalarySandbox(db:D1Database,env:Env,input:{instructionId:string;actorId:string}){
 sandbox(env);const row=await salaryInstruction(db,input.instructionId);if(!row.provider_payout_id)throw refusal("Provider ID not yet known; retry the original instruction with its unchanged idempotency key");
 const result=await fetchRazorpayXSandboxPayout(env,text(row.provider_payout_id));if(!result.connected)return{connected:false,reconciliationRequired:true,environment:"sandbox"};
 return applySalaryProviderState(db,row,result.payout,input.actorId);
}
export async function processEmployeeSalaryWebhook(db:D1Database,env:Env,input:{rawBody:string;signature:string;eventId?:string|null}){
 sandbox(env);if(!await verifyRazorpayRawBody(input.rawBody,input.signature,text(env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX)))throw refusal("Invalid salary webhook signature",401);
 let body:Row;try{body=JSON.parse(input.rawBody) as Row;}catch{throw refusal("Invalid payout webhook JSON",400);}
 if(!body||typeof body!=="object"||Array.isArray(body))throw refusal("Invalid payout webhook payload",400);
 const wrapper=(body.payload as Row|undefined)?.payout as Row|undefined,payout=wrapper?.entity as Row|undefined;
 if(!payout||typeof payout!=="object")throw refusal("Payout entity is required",400);
 if(!text(payout.reference_id).startsWith("SALPAY-"))return null;
 await ensureEmployeeSalaryTables(db);const hash=await sha256Hex(input.rawBody),eventId=text(input.eventId)||`${text(body.event)}:${text(payout.id)}:${hash.slice(0,24)}`;
 const allowed=new Set(["payout.queued","payout.pending","payout.initiated","payout.processed","payout.failed","payout.reversed","payout.rejected","payout.cancelled"]);
 if(!allowed.has(text(body.event)))throw refusal("Unsupported employee salary webhook event",400);
 const expected=text(body.event).slice(7);if(text(payout.status)!==(expected==="initiated"?"processing":expected))throw refusal("Salary webhook event and payout status disagree",400);
 for(let attempt=0;attempt<3;attempt++){
  const seen=await db.prepare("SELECT payload_hash FROM employee_salary_webhook_events WHERE event_id=?").bind(eventId).first<Row>();
  if(seen){if(text(seen.payload_hash)!==hash)throw refusal("Salary webhook event id was reused with different content");return{matched:true,duplicatePrevented:true,environment:"sandbox"};}
  const row=await db.prepare("SELECT * FROM employee_salary_instructions WHERE id=?").bind(payout.reference_id).first<Row>();
  if(!row)return{matched:false,environment:"sandbox"};
  try{return{matched:true,...await applySalaryProviderState(db,row,payout,"provider:signed-webhook",{id:eventId,hash})};}
  catch(error){if(!/payroll_integrity_condition|UNIQUE constraint failed: employee_salary_webhook_events.event_id/.test(error instanceof Error?error.message:String(error)))throw error;}
 }
 throw refusal("Concurrent salary webhook processing requires retry");
}
export async function runEmployeeSalarySandboxSweep(db:D1Database,env:Env){
 if(text(env.PAWSPACE_EMPLOYEE_SALARY_SANDBOX_AUTODISPATCH)!=="on")return{enabled:false,processed:0,failed:0,environment:"sandbox",liveSalaryEnabled:false};
 sandbox(env);await ensureEmployeeSalaryTables(db);
 const{runV2SalaryReleaseSweep}=await import("./v2-payroll-governance");
 const release=await runV2SalaryReleaseSweep(db,{asOf:Date.now(),actorId:"system:scheduled-worker"});
 const pending=(await db.prepare("SELECT id,provider_payout_id FROM employee_salary_instructions WHERE status IN ('approved_sandbox','processing_sandbox') ORDER BY created_at LIMIT 10").all<Row>()).results;
 const results=[];
 for(const row of pending){try{const input={instructionId:text(row.id),actorId:"system:approved-salary-sandbox"};results.push(row.provider_payout_id?await reconcileEmployeeSalarySandbox(db,env,input):await dispatchEmployeeSalarySandbox(db,env,input));}catch{results.push({instructionId:text(row.id),reviewRequired:true});}}
 const failed=release.failed+results.filter(result=>{const value=result as Record<string,unknown>;return value.reviewRequired===true||value.reconciliationRequired===true||value.connected===false;}).length;
 return{enabled:true,processed:pending.length,failed,release,results,environment:"sandbox",liveSalaryEnabled:false};
}
