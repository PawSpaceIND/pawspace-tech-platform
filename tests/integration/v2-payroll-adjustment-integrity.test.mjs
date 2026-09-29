import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";
import { v2PayrollFixture } from "../helpers/v2-payroll-governance-fixture.mjs";
installWorkersHooks("__V2PG_NATIVE_DB__", "__V2PG_NATIVE_ENV__");
async function world(t,governanceScope){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,
  script:"export default {fetch(){return new Response('isolated V2 payroll test')}}",
  compatibilityDate:"2026-09-01",d1Databases:{DB:"v2-payroll-adjustment-test"},d1Persist:false,cf:false,
  outboundService:async()=>{throw new Error("This local test forbids outbound requests");}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database("DB");
 globalThis.__V2PG_NATIVE_DB__=db;globalThis.__V2PG_NATIVE_ENV__={DB:db,PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true"};
 return v2PayrollFixture(db,{governanceScope});
}
async function noChecks(db){assert.equal((await db.prepare("SELECT COUNT(*) n FROM payroll_integrity_checks").first()).n,0);}
test("native V2 payroll: approved deduction remains valid for canonical payment preparation",{timeout:60000},async t=>{
 const w=await world(t);await w.adjustment();assert.equal((await w.apply()).applied,1);
 assert.equal((await w.apply()).applied,0);await w.approve();
 const batch=await w.payroll.prepareSandboxPaymentBatch(w.db,{runId:w.runId,actorId:"finance@v2-payroll.test"});
 assert.equal(batch.externalTransmission,false);assert.equal((await w.result()).net_pay,29000);
 assert.equal((await w.lines()).length,1);await noChecks(w.db);
});
test("native V2 payroll: six concurrent applications cannot deduct twice",{timeout:60000},async t=>{
 const w=await world(t);await w.adjustment();const outcomes=await Promise.allSettled(Array.from({length:6},()=>w.apply()));
 assert.equal(outcomes.filter(x=>x.status==="fulfilled").reduce((n,x)=>n+x.value.applied,0),1);
 assert.equal((await w.result()).net_pay,29000);assert.equal((await w.result()).total_deductions,1000);
 assert.equal((await w.lines()).length,1);await noChecks(w.db);
});
for(const fault of ["line","snapshot"])test(`native V2 payroll: suppressed ${fault} rolls back all adjustment effects`,{timeout:60000},async t=>{
 const w=await world(t);const id=await w.adjustment();
 const before=await w.db.prepare("SELECT input_snapshot_json FROM payroll_runs WHERE id=?").bind(w.runId).first();
 const sql=fault==="line"
  ? "CREATE TRIGGER v2qa_fail BEFORE INSERT ON payroll_result_lines WHEN NEW.source_type='v2_hr_payroll_adjustment' BEGIN SELECT RAISE(IGNORE); END"
  : "CREATE TRIGGER v2qa_fail BEFORE UPDATE OF input_snapshot_json ON payroll_runs BEGIN SELECT RAISE(IGNORE); END";
 await w.db.prepare(sql).run();await assert.rejects(w.apply);
 assert.equal((await w.result()).net_pay,30000);assert.equal((await w.lines()).length,0);
 assert.equal((await w.db.prepare("SELECT status FROM v2_payroll_adjustments WHERE id=?").bind(id).first()).status,"approved");
 assert.deepEqual(await w.db.prepare("SELECT input_snapshot_json FROM payroll_runs WHERE id=?").bind(w.runId).first(),before);
 assert.equal((await w.db.prepare("SELECT COUNT(*) n FROM v2_payroll_governance_events WHERE action='adjustments_applied'").first()).n,0);
 await noChecks(w.db);await w.db.prepare("DROP TRIGGER v2qa_fail").run();assert.equal((await w.apply()).applied,1);
 assert.equal((await w.result()).net_pay,29000);await noChecks(w.db);
});
test("native V2 payroll: review racing with application preserves the reviewed salary",{timeout:60000},async t=>{
 const w=await world(t);await w.adjustment();let readAdjustments=false,changed=false;
 // D1's proxy does not accept monkey-patching methods. Pass an explicit wrapper instead.
 const observed={prepare(sql){if(sql.includes("status='approved' AND applied_at IS NULL"))readAdjustments=true;return w.db.prepare(sql);},
  async batch(statements){if(readAdjustments&&!changed){changed=true;await w.db.prepare("UPDATE payroll_runs SET status='reviewed' WHERE id=?").bind(w.runId).run();}return w.db.batch(statements);}};
 await assert.rejects(()=>w.governance.applyApprovedV2Adjustments(observed,{runId:w.runId,actorId:"operator@v2-payroll.test"}),error=>error instanceof Response&&error.status===409);
 assert.equal(changed,true);assert.equal((await w.result()).net_pay,30000);assert.equal((await w.lines()).length,0);await noChecks(w.db);
});

for(const mode of ["due","held","future"])test(`native V2 salary queue observes ${mode} release evidence`,async t=>{
 const w=await world(t);await w.adjustment();await w.apply();await w.approve();
 const salaryDate=Date.now()+(mode==="future"?86400000:-1000);
 await w.governance.createV2SalaryReleasePlan(w.db,{runId:w.runId,salaryDate,items:[{employeeId:w.employeeId,hold:mode==="held",holdReason:"Synthetic native hold"}],actorId:"maker@native-v2.test"});
 await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"hr",actorId:"hr@native-v2.test"});
 await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"finance",actorId:"finance@native-v2.test"});
 await w.payroll.prepareSandboxPaymentBatch(w.db,{runId:w.runId,actorId:"finance@v2-payroll.test"});
 const {configureSalaryFinanceFixture}=await import("../helpers/salary-finance-fixture.mjs");await configureSalaryFinanceFixture(w.db);
 const salary=await import("../../lib/employee-payroll-payout.ts");
 await salary.saveEmployeeSalaryBeneficiary(w.db,{employeeId:w.employeeId,fundAccountId:"fa_NATIVEV2QA",verificationReference:"LOCAL-NATIVE-TEST",expiresAt:Date.now()+86400000,actorId:"finance@native-v2.test"});
 const queue=()=>salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"approver@native-v2.test"});
 if(mode==="due"){
  const first=await queue(),again=await queue();assert.equal(first.instructions.length,1);assert.equal(first.instructions[0].amountPaise,2900000);
  assert.equal(again.duplicatePrevented,true);assert.equal((await w.db.prepare("SELECT status FROM employee_salary_instructions").first()).status,"approved_sandbox");
 }else{
  let error;try{await queue();}catch(e){error=e;}assert.ok(error instanceof Response);assert.match(await error.text(),/V2 salary release/);
  assert.equal((await w.db.prepare("SELECT COUNT(*) n FROM employee_salary_instructions").first()).n,0);
 }
});

test("native V2 payroll: no deduction still requires a release plan at the shared queue",{timeout:60000},async t=>{
 const w=await world(t,"v2");
 const run=await w.db.prepare("SELECT input_snapshot_json FROM payroll_runs WHERE id=?").bind(w.runId).first();
 assert.equal(JSON.parse(run.input_snapshot_json).payrollScope,"v2");await w.approve();
 await w.payroll.prepareSandboxPaymentBatch(w.db,{runId:w.runId,actorId:"finance@v2-payroll.test"});
 const salary=await import("../../lib/employee-payroll-payout.ts");
 await assert.rejects(()=>salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"independent@native-v2.test"}),e=>e instanceof Response&&e.status===409);
 assert.equal((await w.db.prepare("SELECT COUNT(*) n FROM employee_salary_instructions").first()).n,0);
});
test("native V2 held release: a failed approval reset rolls back the amendment; retry requires reapproval",{timeout:60000},async t=>{
 const w=await world(t,"v2");await w.approve();const salaryDate=Date.now()-1000;
 await w.governance.createV2SalaryReleasePlan(w.db,{runId:w.runId,salaryDate,items:[{employeeId:w.employeeId,hold:true,holdReason:"Native isolated hold"}],actorId:"maker@native.test"});
 await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"hr",actorId:"hr@native.test"});
 await w.governance.approveV2SalaryReleasePlan(w.db,{runId:w.runId,stage:"finance",actorId:"finance@native.test"});
 const before=await w.db.prepare("SELECT * FROM v2_salary_release_items").first();
 await w.db.prepare("CREATE TRIGGER held_reset_fail BEFORE UPDATE ON v2_salary_release_plans WHEN NEW.status='draft' BEGIN SELECT RAISE(IGNORE); END").run();
 const release=()=>w.governance.releaseHeldV2Salary(w.db,{runId:w.runId,employeeId:w.employeeId,releaseAt:Date.now(),actorId:"finance@native.test"});
 await assert.rejects(release);assert.deepEqual(await w.db.prepare("SELECT * FROM v2_salary_release_items").first(),before);
 assert.equal((await w.db.prepare("SELECT status FROM v2_salary_release_plans").first()).status,"approved");
 await w.db.prepare("DROP TRIGGER held_reset_fail").run();assert.equal((await release()).approvalRequired,true);
 const plan=await w.db.prepare("SELECT * FROM v2_salary_release_plans").first();assert.equal(plan.status,"draft");assert.equal(plan.hr_approved_by,null);assert.equal(plan.finance_approved_by,null);await noChecks(w.db);
});
