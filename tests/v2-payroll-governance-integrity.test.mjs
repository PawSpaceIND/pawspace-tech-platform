import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { employeeAuditD1 } from "./helpers/employee-audit-d1.mjs";
import { v2PayrollFixture } from "./helpers/v2-payroll-governance-fixture.mjs";
installWorkersHooks("__V2PG_DB__", "__V2PG_ENV__");
const invalid = error => error instanceof Response && [400,409].includes(error.status);
async function world(t) {
  const w = employeeAuditD1(t);
  globalThis.__V2PG_DB__ = w.db;
  globalThis.__V2PG_ENV__ = { DB:w.db, PAWSPACE_DEPLOYMENT_ENV:"staging", PAWSPACE_WORKSPACE_IDENTITY_TRUST:"openai-dispatch", PAWSPACE_PAYMENT_ENV:"sandbox", FORBID_PRODUCTION:"true" };
  return { ...w, ...await v2PayrollFixture(w.db) };
}
test("V2 deductions: one approved adjustment applies once and exact replay changes nothing", async t => {
  const w=await world(t); await w.adjustment(); assert.equal((await w.apply()).applied,1);
  assert.equal((await w.result()).net_pay,29000); assert.equal((await w.lines()).length,1);
  assert.equal((await w.apply()).applied,0); assert.equal((await w.result()).total_deductions,1000);
});
test("V2 deductions: concurrent requests cannot deduct or insert the same adjustment twice", async t => {
  const w=await world(t); await w.adjustment(); const results=await Promise.allSettled([w.apply(),w.apply()]);
  assert.ok(results.some(r=>r.status==="fulfilled")); assert.equal((await w.result()).net_pay,29000);
  assert.equal((await w.result()).total_deductions,1000); assert.equal((await w.lines()).length,1);
});
test("V2 deductions: governed adjustments retain canonical payment-preparation integrity", async t => {
  const w=await world(t); await w.adjustment(); await w.apply(); await w.approve();
  const batch=await w.payroll.prepareSandboxPaymentBatch(w.db,{runId:w.runId,actorId:"finance@v2-payroll.test"});
  assert.equal(batch.externalTransmission,false); assert.equal((await w.result()).net_pay,29000);
});
test("V2 deductions: suppressed line rolls back result and application marker, then retry succeeds", async t => {
  const w=await world(t); const id=await w.adjustment();
  w.sqlite.exec("CREATE TRIGGER v2qa_ignore BEFORE INSERT ON payroll_result_lines WHEN NEW.source_type='v2_hr_payroll_adjustment' BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(w.apply); assert.equal((await w.result()).net_pay,30000);
  assert.equal(w.sqlite.prepare("SELECT status FROM v2_payroll_adjustments WHERE id=?").get(id).status,"approved");
  w.sqlite.exec("DROP TRIGGER v2qa_ignore"); assert.equal((await w.apply()).applied,1);
});
test("V2 deductions: a run reviewed between reading and commit cannot be altered", async t => {
  const w=await world(t); await w.adjustment(); const batch=w.db.batch; let changed=false;
  w.db.batch=async statements=>{if(!changed&&statements.some(s=>s.sql.includes("UPDATE employee_payroll_results"))){changed=true;w.sqlite.prepare("UPDATE payroll_runs SET status='reviewed' WHERE id=?").run(w.runId);}return batch(statements);};
  await assert.rejects(w.apply,invalid); assert.equal(changed,true); assert.equal((await w.result()).net_pay,30000);
});
for(const releaseAt of [0,-1,Number.NaN,Number.POSITIVE_INFINITY]) test(`V2 holds reject invalid release date ${releaseAt}`,async t=>{
  const w=await world(t); await w.approve(); const salaryDate=Date.now()+86400000;
  await w.governance.createV2SalaryReleasePlan(w.db,{runId:w.runId,salaryDate,items:[{employeeId:w.employeeId,hold:true,holdReason:"Synthetic reviewed hold"}],actorId:"maker@v2-payroll.test"});
  await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"hr",actorId:"checker@v2-payroll.test"});
  await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"finance",actorId:"finance@v2-payroll.test"});
  await assert.rejects(()=>w.governance.releaseHeldV2Salary(w.db,{runId:w.runId,employeeId:w.employeeId,releaseAt,actorId:"finance@v2-payroll.test"}),invalid);
  assert.equal(w.sqlite.prepare("SELECT hold_status FROM v2_salary_release_items").get().hold_status,"held");
});
test("V2 policy malformed leave configuration refuses rather than becoming no leave",async t=>{
  const w=await world(t); w.sqlite.prepare("UPDATE v2_payroll_policies SET paid_leave_codes_json='not-json'").run();
  const row={employee_id:w.employeeId,work_date:"2026-09-10",status:"absent"};
  w.sqlite.prepare("INSERT INTO attendance_days (id,employee_id,work_date,status,worked_minutes,updated_at) VALUES ('V2-DAY',?,?,?,0,?)").run(row.employee_id,row.work_date,row.status,Date.now());
  await assert.rejects(()=>w.governance.deriveV2Lop(w.db,{runId:w.runId,employeeId:w.employeeId,actorId:"hr@v2-payroll.test",evidenceReference:"QA-ATTENDANCE"}),invalid);
});

const governance=await import("../lib/v2-payroll-governance.ts");
test("V2 payroll input booleans never enable a control from a string",()=>{
 assert.equal(governance.v2PayrollBoolean(true,"Control"),true);
 assert.equal(governance.v2PayrollBoolean(false,"Control"),false);
 for(const value of ["false","true",0,1,null,undefined,{},[]])
  assert.throws(()=>governance.v2PayrollBoolean(value,"Control"),invalid);
});
for(const damage of ["amount","approval","missing_marker","missing_line"])test(`V2 adjusted payroll refuses ${damage} before payment preparation`,async t=>{
 const w=await world(t);const id=await w.adjustment();await w.apply();
 if(damage==="amount")w.sqlite.prepare("UPDATE v2_payroll_adjustments SET amount=amount+1 WHERE id=?").run(id);
 if(damage==="approval")w.sqlite.prepare("UPDATE v2_payroll_adjustments SET finance_approved_by=requested_by WHERE id=?").run(id);
 if(damage==="missing_marker")w.sqlite.prepare("UPDATE v2_payroll_adjustments SET status='approved',applied_at=NULL WHERE id=?").run(id);
 if(damage==="missing_line")w.sqlite.prepare("DELETE FROM payroll_result_lines WHERE source_reference=?").run(id);
 await w.approve();
 await assert.rejects(()=>w.payroll.prepareSandboxPaymentBatch(w.db,{runId:w.runId,actorId:"finance@v2-payroll.test"}),invalid);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_payment_batches").get().n,0);
});

const salary=await import("../lib/employee-payroll-payout.ts");
const {configureSalaryFinanceFixture}=await import("./helpers/salary-finance-fixture.mjs");
async function releaseWorld(t,mode="due"){
 const w=await world(t);await w.adjustment();await w.apply();await w.approve();
 if(mode!=="missing_plan"){
  const salaryDate=Date.now()+(mode==="future"?86400000:-1000);
  await w.governance.createV2SalaryReleasePlan(w.db,{runId:w.runId,salaryDate,items:[{employeeId:w.employeeId,hold:mode==="held",holdReason:"Synthetic approved hold"}],actorId:"plan-maker@v2-payroll.test"});
  await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"hr",actorId:"plan-hr@v2-payroll.test"});
  if(mode!=="pending_finance")await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"finance",actorId:"plan-finance@v2-payroll.test"});
 }
 await w.payroll.prepareSandboxPaymentBatch(w.db,{runId:w.runId,actorId:"finance@v2-payroll.test"});
 await configureSalaryFinanceFixture(w.db);
 await salary.saveEmployeeSalaryBeneficiary(w.db,{employeeId:w.employeeId,fundAccountId:"fa_V2PAYQA",verificationReference:"LOCAL-TEST-ONLY",expiresAt:Date.now()+86400000,actorId:"finance@v2-payroll.test"});
 return{...w,queue:()=>salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"salary-approver@v2-payroll.test"})};
}
for(const mode of ["missing_plan","pending_finance","held","future"])test(`V2 salary release boundary: canonical queue refuses ${mode}`,async t=>{
 const w=await releaseWorld(t,mode);let error;
 try{await w.queue();}catch(e){error=e;}
 assert.ok(error instanceof Response);assert.equal(error.status,409);
 assert.match(await error.text(),/V2 salary release/);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_salary_instructions").get().n,0);
});
test("V2 salary release boundary: due approved salary queues once without dispatch",async t=>{
 const w=await releaseWorld(t);const first=await w.queue(),again=await w.queue();
 assert.equal(first.instructions.length,1);assert.equal(first.instructions[0].amountPaise,2900000);
 assert.equal(again.duplicatePrevented,true);assert.equal(again.instructions[0].id,first.instructions[0].id);
 assert.equal(w.sqlite.prepare("SELECT status FROM employee_salary_instructions").get().status,"approved_sandbox");
});
test("V2 salary release boundary: a hold arriving before queue commit refuses instructions",async t=>{
 const w=await releaseWorld(t);const batch=w.db.batch;let changed=false;
 w.db.batch=async statements=>{if(!changed&&statements.some(s=>s.sql.includes("INSERT INTO employee_salary_instructions"))){changed=true;w.sqlite.prepare("UPDATE v2_salary_release_items SET hold_status='held'").run();}return batch(statements);};
 await assert.rejects(w.queue);assert.equal(changed,true);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_salary_instructions").get().n,0);
});
test("V2 salary release boundary: an explicit empty selection never queues everyone",async t=>{
 const w=await releaseWorld(t);
 await assert.rejects(()=>salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"salary-approver@v2-payroll.test",resultIds:[]}));
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_salary_instructions").get().n,0);
});
for(const stage of ["hr","finance"])test(`V2 release-plan ${stage} approval cannot be overwritten by a concurrent checker`,async t=>{
 const w=await world(t);await w.approve();
 await w.governance.createV2SalaryReleasePlan(w.db,{runId:w.runId,salaryDate:Date.now()+86400000,actorId:"plan-maker@v2-payroll.test"});
 if(stage==="finance")await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"hr",actorId:"plan-hr@v2-payroll.test"});
 const outcomes=await Promise.allSettled(["a","b"].map(name=>w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage,actorId:`${name}@v2-payroll.test`})));
 assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
 assert.equal(outcomes.filter(r=>r.status==="rejected").length,1);
});
test("V2 salary hold edits invalidate earlier HR approval before Finance can approve",async t=>{
 const w=await releaseWorld(t,"pending_finance");
 await w.governance.setV2SalaryHold(w.db,{runId:w.runId,employeeId:w.employeeId,hold:true,reason:"Synthetic later request",actorId:"hr@v2-payroll.test"});
 assert.equal(w.sqlite.prepare("SELECT hold_status FROM v2_salary_release_items").get().hold_status,"held");
 const plan=w.sqlite.prepare("SELECT * FROM v2_salary_release_plans").get();assert.equal(plan.status,"draft");assert.equal(plan.hr_approved_by,null);
 await assert.rejects(()=>w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"finance",actorId:"other-finance@v2-payroll.test"}),invalid);
});
