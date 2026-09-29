import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {employeeAuditD1} from "./helpers/employee-audit-d1.mjs";
import {configureSalaryFinanceFixture} from "./helpers/salary-finance-fixture.mjs";
installWorkersHooks("__RX_ACCOUNT_BOUND_DB__","__RX_ACCOUNT_BOUND_ENV__");
const accounting=await import("../lib/razorpayx-payout-accounting.ts");
const accounts=await import("../lib/finance-accounts.ts");
const salary=await import("../lib/employee-payroll-payout.ts"),payroll=await import("../lib/payroll-engine.ts"),people=await import("../lib/people-foundation.ts"),finance=await import("../lib/people-finance-integration.ts");
async function salaryWorld(t){
 t.mock.method(Date,"now",()=>Date.parse("2026-09-28T12:00:00Z"));
 const w=employeeAuditD1(t);globalThis.__RX_ACCOUNT_BOUND_DB__=w.db;globalThis.__RX_ACCOUNT_BOUND_ENV__={DB:w.db};
 const start=Date.parse("2026-08-01T00:00:00+05:30"),end=Date.parse("2026-09-01T00:00:00+05:30");
 await people.ensurePeopleTables(w.db);const employee=await people.upsertEmployee(w.db,{employeeCode:"RX-MONTH",displayName:"Synthetic payroll month close",workEmail:"rx-month@qa.test",joinedAt:start-86400000,actorId:"hr@qa.test"});
 const structure=await payroll.saveSalaryStructure(w.db,{structureCode:"RX-MONTH",effectiveFrom:start-86400000,components:[{code:"BASIC",label:"Basic",kind:"earning",amount:10000}],actorId:"hr@qa.test"});
 await payroll.assignCompensation(w.db,{employeeId:employee.id,structureId:structure.id,effectiveFrom:start-86400000,reason:"Explicit synthetic salary",actorId:"hr@qa.test"});
 const result=await payroll.calculatePayroll(w.db,{periodStart:start,periodEnd:end,idempotencyKey:"rx-month",actorId:"maker@qa.test"}),runId=result.run.id;
 await payroll.reviewPayroll(w.db,{runId,actorId:"reviewer@qa.test"});await payroll.approvePayroll(w.db,{runId,actorId:"approver@qa.test"});await payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:"finance@qa.test"});
 await configureSalaryFinanceFixture(w.db);await accounts.ensureFinanceJournalTable(w.db);await finance.postPayrollJournal(w.db,{runId,periodCode:"2026-08",actorId:"finance@qa.test"});
 await salary.saveEmployeeSalaryBeneficiary(w.db,{employeeId:employee.id,fundAccountId:"fa_MONTH",verificationReference:"SYNTHETIC-BANK-REVIEW",expiresAt:Date.now()+86400000,actorId:"finance@qa.test"});
 t.mock.method(globalThis,"fetch",()=>{throw new Error("No provider calls permitted in month-close tests");});return{...w,runId};
}
function lock(w,period){w.sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,updated_at) VALUES (?,'locked','{}',?)").run(period,Date.now());}
test("previously posted payroll may be paid in an open month without rewriting the closed accrual month",async t=>{
 const w=await salaryWorld(t);lock(w,"2026-08");const before=w.sqlite.prepare("SELECT * FROM finance_journal_entries WHERE source_type='payroll_run' ORDER BY id").all();
 const queued=await salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"finance@qa.test"});assert.equal(queued.instructions.length,1);
 assert.deepEqual(w.sqlite.prepare("SELECT * FROM finance_journal_entries WHERE source_type='payroll_run' ORDER BY id").all(),before);
 assert.equal(w.sqlite.prepare("SELECT COALESCE(SUM(credit-debit),0) n FROM finance_journal_entries WHERE account_code='2116-Employee Salary Payouts in Transit'").get().n,10000);
});
test("a closed payout month still refuses a new salary release",async t=>{
 const w=await salaryWorld(t);lock(w,new Date(Date.now()).toISOString().slice(0,7));
 await assert.rejects(()=>salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"finance@qa.test"}),/period_locked/);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_salary_instructions").get().n,0);
});
test("payout accounting directory supports 251 records within D1's per-query binding limit",async t=>{
 const w=employeeAuditD1(t);await accounting.ensureRazorpayXPayoutAccounting(w.db);const ids=Array.from({length:251},(_,i)=>`BOUND-${i}`);
 const insert=w.sqlite.prepare("INSERT INTO razorpayx_payout_accounting (local_payout_id,source_type,source_id,amount_paise,status,updated_at) VALUES (?,'salary',?,100,'awaiting_provider',1)");for(const id of ids)insert.run(id,id);
 const prepare=w.db.prepare,counts=[];w.db.prepare=sql=>{const statement=prepare(sql);return{...statement,bind:(...values)=>{assert.ok(values.length<=100,"D1 permits at most 100 bound parameters per statement");if(sql.includes('WHERE local_payout_id IN'))counts.push(values.length);return statement.bind(...values);}};};
 const found=await accounting.razorpayXPayoutAccountingDirectory(w.db,[...ids,...ids]);assert.equal(found.length,251);assert.equal(new Set(found.map(r=>r.local_payout_id)).size,251);assert.ok(counts.length>=3);
});
