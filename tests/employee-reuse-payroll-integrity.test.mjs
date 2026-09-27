import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__EMP_REUSE_DB__", "__EMP_REUSE_ENV__");
const people = await import("../lib/people-foundation.ts");
const payroll = await import("../lib/payroll-engine.ts");

// Real SQL and application functions. D1 batch is one transaction: never mock a payroll result.
function database(t) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const prepare = (sql, args = []) => ({sql,args,bind: (...values) => prepare(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({results: sqlite.prepare(sql).all(...args)}),
    run: async () => ({success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})});
  const db = {prepare, batch: async (statements) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {const results=statements.map(s=>({success:true,meta:{changes:Number(sqlite.prepare(s.sql).run(...s.args).changes)}}));sqlite.exec("COMMIT");return results;}
    catch(e){sqlite.exec("ROLLBACK");throw e;}
  }};
  globalThis.__EMP_REUSE_DB__=db;globalThis.__EMP_REUSE_ENV__={DB:db,PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true"};
  return {db,sqlite};
}
const START=Date.parse("2026-09-01T00:00:00+05:30"),END=Date.parse("2026-10-01T00:00:00+05:30");
async function world(t){const w=database(t);await people.ensurePeopleTables(w.db);await payroll.ensurePayrollTables(w.db);
  const e=await people.upsertEmployee(w.db,{employeeCode:"AUDIT-E",displayName:"Synthetic Employee",workEmail:"employee@audit.test",userEmail:"employee@audit.test",joinedAt:START-86400000,actorId:"hr@audit.test"});
  const s=await payroll.saveSalaryStructure(w.db,{structureCode:"AUDIT",effectiveFrom:START-86400000,components:[{code:"BASIC",label:"Basic",kind:"earning",amount:30000}],actorId:"hr@audit.test"});
  await payroll.assignCompensation(w.db,{employeeId:e.id,structureId:s.id,effectiveFrom:START-86400000,reason:"Synthetic payroll integrity fixture",actorId:"hr@audit.test"});return {...w,employeeId:e.id};}
const calculate=(w,key="monthly",periodStart=START,periodEnd=END)=>payroll.calculatePayroll(w.db,{periodStart,periodEnd,idempotencyKey:key,actorId:"maker@audit.test"});
async function approved(w){const r=await calculate(w);await payroll.reviewPayroll(w.db,{runId:r.run.id,actorId:"reviewer@audit.test"});await payroll.approvePayroll(w.db,{runId:r.run.id,actorId:"approver@audit.test"});return r.run.id;}

test("payroll failure rolls back run, results and lines; same-key retry produces a complete run",async t=>{
  const w=await world(t);w.sqlite.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON payroll_result_lines BEGIN SELECT RAISE(ABORT,'synthetic line failure'); END");
  await assert.rejects(()=>calculate(w),/synthetic line failure/);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_runs").get().n,0);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_payroll_results").get().n,0);
  w.sqlite.exec("DROP TRIGGER audit_fail");const r=await calculate(w);assert.equal(r.results.length,1);assert.equal(r.results[0].net_pay,30000);
});
test("a different key cannot create a second payroll for the same or overlapping period",async t=>{
  const w=await world(t);await calculate(w,"one");
  await assert.rejects(()=>calculate(w,"two"));
  await assert.rejects(()=>calculate(w,"overlap",START+86400000,END+86400000));
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_runs").get().n,1);
});
test("same-key replay is bound to the requested period",async t=>{const w=await world(t);await calculate(w);await assert.rejects(()=>calculate(w,"monthly",END,END+30*86400000));});
test("same-key replay refuses a legacy incomplete run rather than reporting success",async t=>{
  const w=await world(t);const r=await calculate(w);w.sqlite.prepare("DELETE FROM employee_payroll_results WHERE run_id=?").run(r.run.id);await assert.rejects(()=>calculate(w));
});
test("simultaneous same-key calculations converge to one complete run",async t=>{const w=await world(t);const [a,b]=await Promise.all([calculate(w),calculate(w)]);assert.equal(a.run.id,b.run.id);assert.equal(a.results.length,1);assert.equal(b.results.length,1);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_runs").get().n,1);});
test("simultaneous payment preparation returns one batch and one audit event",async t=>{
  const w=await world(t),runId=await approved(w);const [a,b]=await Promise.all([payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:"finance@audit.test"}),payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:"finance@audit.test"})]);
  assert.equal(a.id,b.id);assert.equal(a.externalTransmission,false);assert.equal(b.externalTransmission,false);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_payment_batches").get().n,1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_approval_events WHERE event_type='payment_prepared'").get().n,1);
});
test("payment preparation failure rolls back the batch, run transition and event",async t=>{
  const w=await world(t),runId=await approved(w);w.sqlite.exec("CREATE TRIGGER audit_batch_fail BEFORE INSERT ON payroll_approval_events WHEN NEW.event_type='payment_prepared' BEGIN SELECT RAISE(ABORT,'synthetic preparation failure'); END");
  await assert.rejects(()=>payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:"finance@audit.test"}),/synthetic preparation failure/);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_payment_batches").get().n,0);assert.equal(w.sqlite.prepare("SELECT status FROM payroll_runs WHERE id=?").get(runId).status,"approved");
});
test("two historical batches never return one silently as a valid repeat",async t=>{
 const w=await world(t),runId=await approved(w);await payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:"finance@audit.test"});
 w.sqlite.prepare("INSERT INTO payroll_payment_batches SELECT 'LEGACY-DUP',run_id,status,instruction_count,total_amount,external_transmission,created_by,created_at FROM payroll_payment_batches LIMIT 1").run();
 await assert.rejects(()=>payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:"finance@audit.test"}));
});

async function payrollSources(w){
 const scheme=await import("../lib/incentive-engine.ts"),daily=await import("../lib/daily-incentive-accrual.ts"),advances=await import("../lib/salary-advance-governance.ts");
 await scheme.ensureIncentiveTables(w.db);await daily.salesIncentivePeriodTruth(w.db,{employeeId:"employee@audit.test",monthStart:"2026-09-01"});
 w.sqlite.prepare("INSERT INTO incentive_scheme_versions (id,scheme_code,version,status,role_code,team_code,effective_from,formula_json,created_by,created_at) VALUES ('IS1','AUDIT',1,'active_uat','associate','sales',?,'{}','manager',?)").run(START,START);
 w.sqlite.prepare("INSERT INTO employee_incentive_periods (id,idempotency_key,scheme_id,period_start,period_end,calculated_by,created_at) VALUES ('IP1','ip1','IS1',?,?,'manager',?)").run(START,END,START);
 w.sqlite.prepare("INSERT INTO employee_incentive_results (id,period_id,employee_id,employee_email,source_fact_run_id,metric_value,calculated_amount,approved_amount,status,evidence_json) VALUES ('IR1','IP1',?,'employee@audit.test','FACT1',1,500,500,'approved','{}')").run(w.employeeId);
 w.sqlite.prepare("INSERT INTO sales_incentive_period_results (id,employee_id,month_start,daily_accrued_total,monthly_achieved_value,monthly_bonus,approved_total,status,generated_by,generated_at) VALUES ('SR1','employee@audit.test','2026-09-01',250,1000,0,250,'approved','manager',?)").run(START);
 const requested=await advances.requestSalaryAdvance(w.db,{employeeId:w.employeeId,amount:1000,recoveryMonths:1,reason:"Synthetic advance for rollback proof",actorId:"maker@audit.test"});
 await advances.approveSalaryAdvance(w.db,{advanceId:requested.id,actorId:"checker@audit.test"});
 return {advances,advanceId:requested.id};
}
test("late failure rolls back incentive consumption and advance recovery as well as salary",async t=>{
 const w=await world(t);await payrollSources(w);
 w.sqlite.exec("CREATE TRIGGER audit_payslip_failure BEFORE INSERT ON payslips BEGIN SELECT RAISE(ABORT,'synthetic payslip failure'); END");
 await assert.rejects(()=>calculate(w),/synthetic payslip failure/);
 for(const table of ["payroll_runs","employee_payroll_results","payroll_result_lines","incentive_payroll_links","sales_incentive_payroll_links"])assert.equal(w.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 assert.equal(w.sqlite.prepare("SELECT status FROM sales_incentive_period_results WHERE id='SR1'").get().status,"approved");
 assert.equal(w.sqlite.prepare("SELECT status FROM salary_advance_installments").get().status,"pending");
 assert.equal(w.sqlite.prepare("SELECT status FROM salary_advances").get().status,"active");
 w.sqlite.exec("DROP TRIGGER audit_payslip_failure");const result=await calculate(w);assert.equal(result.results[0].net_pay,29750);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM incentive_payroll_links").get().n,1);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sales_incentive_payroll_links").get().n,1);
 assert.equal(w.sqlite.prepare("SELECT status FROM salary_advances").get().status,"recovered");
});

for(const [label,change] of [
 ["scheme incentive", "UPDATE employee_incentive_results SET status='held' WHERE id='IR1'"],
 ["sales incentive", "UPDATE sales_incentive_period_results SET approved_total=999 WHERE id='SR1'"],
 ["salary advance", "UPDATE salary_advances SET status='cancelled'"]
])test(`a changed ${label} between snapshot and commit refuses the entire payroll`,async t=>{
 const w=await world(t);await payrollSources(w);const original=w.db.batch;let changed=false;
 w.db.batch=async statements=>{
  if(!changed&&statements.some(s=>s.sql.startsWith("INSERT INTO payroll_runs"))){w.sqlite.exec(change);changed=true;}
  return original(statements);
 };
 await assert.rejects(()=>calculate(w),e=>e instanceof Response&&e.status===409);
 assert.equal(changed,true);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_runs").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM incentive_payroll_links").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sales_incentive_payroll_links").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_integrity_checks").get().n,0);
});
test("concurrent different keys cannot create two runs for an overlapping period",async t=>{
 const w=await world(t),results=await Promise.allSettled([calculate(w,"a"),calculate(w,"b")]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 const rejected=results.find(r=>r.status==="rejected");assert.ok(rejected.reason instanceof Response);assert.equal(rejected.reason.status,409);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_runs").get().n,1);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_integrity_checks").get().n,0);
});

for(const [field,value]of[["amount",29999],["component_code","ALTERED"],["source_reference","OTHER"],["policy_version","salary_structure:other"],["label","Changed without recalculation"]])test(`replay refuses changed payroll line ${field} without a line-count change`,async t=>{
 const w=await world(t);await calculate(w);w.sqlite.prepare(`UPDATE payroll_result_lines SET ${field}=?`).run(value);
 await assert.rejects(()=>calculate(w),e=>e instanceof Response&&e.status===409);
});
test("payment preparation refuses a missing employee payslip",async t=>{
 const w=await world(t),runId=await approved(w);w.sqlite.prepare("DELETE FROM payslips WHERE run_id=?").run(runId);
 await assert.rejects(()=>payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:"finance@audit.test"}),e=>e instanceof Response&&e.status===409);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_payment_batches").get().n,0);
});
test("replay refuses internally consistent but changed result amounts",async t=>{
 const w=await world(t);await calculate(w);w.sqlite.prepare("UPDATE employee_payroll_results SET gross_earnings=gross_earnings+1,net_pay=net_pay+1").run();
 await assert.rejects(()=>calculate(w),e=>e instanceof Response&&e.status===409);
});

test("draft payroll is not an approved cost or employee payslip",async t=>{
 const w=await world(t),r=await calculate(w),self=await import("../lib/employee-self-service.ts"),reports=await import("../lib/people-reports.ts");
 const input={actorEmail:"finance@audit.test",roleCode:"finance",permissions:["payroll.view"],periodStart:START,periodEnd:END};
 assert.equal((await reports.peopleReports(w.db,input)).payroll.register.length,0);
 assert.equal((await self.employeeSelfServiceView(w.db,{email:"employee@audit.test"})).payslips.list.length,0);
 await payroll.reviewPayroll(w.db,{runId:r.run.id,actorId:"reviewer@audit.test"});await payroll.approvePayroll(w.db,{runId:r.run.id,actorId:"approver@audit.test"});
 const approved=await reports.peopleReports(w.db,input);assert.equal(approved.payroll.register.length,1);assert.equal(approved.payroll.runTotals[0].netPay,30000);
 assert.equal((await self.employeeSelfServiceView(w.db,{email:"employee@audit.test"})).payslips.list.length,1);
});
test("historical conflicting approved runs are excluded rather than double-counted",async t=>{
 const w=await world(t),runId=await approved(w),reports=await import("../lib/people-reports.ts"),self=await import("../lib/employee-self-service.ts");
 w.sqlite.prepare("INSERT INTO payroll_runs SELECT 'HISTORY-DUP','history-dup',period_start,period_end,status,input_snapshot_json,created_by,created_at,reviewed_by,reviewed_at,approved_by,approved_at,payment_prepared_at FROM payroll_runs WHERE id=?").run(runId);
 w.sqlite.prepare("INSERT INTO employee_payroll_results SELECT 'RESULT-DUP','HISTORY-DUP',employee_id,structure_id,gross_earnings,total_deductions,reimbursements,employer_cost,net_pay,source_snapshot_json FROM employee_payroll_results WHERE run_id=?").run(runId);
 const report=await reports.peopleReports(w.db,{actorEmail:"finance@audit.test",roleCode:"finance",permissions:["payroll.view"],periodStart:START,periodEnd:END});
 assert.equal(report.payroll.register.length,0);assert.equal(report.payroll.runTotals.length,0);
 assert.equal((await self.employeeSelfServiceView(w.db,{email:"employee@audit.test"})).payslips.list.length,0);
});

test("partial-month salary requires an explicit approved calculation policy",async t=>{
 const w=await world(t);w.sqlite.prepare("UPDATE employees SET joined_at=? WHERE id=?").run(Date.parse("2026-09-16T00:00:00+05:30"),w.employeeId);
 await assert.rejects(()=>calculate(w),e=>e instanceof Response&&e.status===409);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM payroll_runs").get().n,0);
});
test("approved calendar proration pays 15 of 30 days for a 16 September joiner",async t=>{
 const w=await world(t),policy=await import("../lib/payroll-proration.ts");w.sqlite.prepare("UPDATE employees SET joined_at=? WHERE id=?").run(Date.parse("2026-09-16T00:00:00+05:30"),w.employeeId);
 const structure=w.sqlite.prepare("SELECT id FROM salary_structure_versions").get();await policy.saveSalaryCalculationPolicy(w.db,{structureId:structure.id,mode:"calendar_days",componentCodes:["BASIC"],approvalReference:"QA-POLICY-1",actorId:"finance@audit.test"});
 const result=await calculate(w);assert.equal(result.results[0].net_pay,15000);assert.equal(JSON.parse(result.results[0].source_snapshot_json).proration.employedDays,15);
 assert.equal((await calculate(w)).results[0].net_pay,15000);
});
test("a deliberately approved full-period policy is explicit and immutable after use",async t=>{
 const w=await world(t),policy=await import("../lib/payroll-proration.ts");w.sqlite.prepare("UPDATE employees SET joined_at=? WHERE id=?").run(Date.parse("2026-09-16T00:00:00+05:30"),w.employeeId);
 const structure=w.sqlite.prepare("SELECT id FROM salary_structure_versions").get();await policy.saveSalaryCalculationPolicy(w.db,{structureId:structure.id,mode:"full_period",componentCodes:[],approvalReference:"QA-FULL-PERIOD",actorId:"finance@audit.test"});
 assert.equal((await calculate(w)).results[0].net_pay,30000);
 await assert.rejects(()=>policy.saveSalaryCalculationPolicy(w.db,{structureId:structure.id,mode:"calendar_days",componentCodes:["BASIC"],approvalReference:"QA-CHANGE",actorId:"finance@audit.test"}),e=>e instanceof Response&&e.status===409);
});
