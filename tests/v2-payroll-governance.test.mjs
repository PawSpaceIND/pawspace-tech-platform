import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=p=>fs.readFileSync(p,"utf8");
const lib=read("lib/v2-payroll-governance.ts");
const api=read("app/api/v2/payroll-governance/route.ts");
const page=read("app/team/people/payroll/page.tsx");
const bridge=read("app/v2/team/people/payroll/page.tsx");
const panel=read("app/v2/team/people/payroll/V2PayrollGovernancePanel.tsx");
const worker=read("worker/index.ts");
const security=read("lib/platform-security.ts");

test("V2 payroll governance is additive while V2 remains a canonical bridge",()=>{
 assert.match(bridge,/export \{ default \} from "\.\.\/\.\.\/\.\.\/\.\.\/team\/people\/payroll\/page"/);
 assert.match(page,/isV2=pathname\.startsWith\("\/v2\/"\)/);
 assert.match(page,/isV2&&data&&<V2PayrollGovernancePanel/);
});
test("V2 policy owns leave-aware LOP and governed authorized deductions",()=>{
 for(const token of["v2_payroll_policies","paid_leave_codes_json","unpaid_leave_codes_json","lop_component_codes_json","v2_payroll_adjustments"])assert.ok(lib.includes(token),token);
 assert.match(lib,/status='approved'/);assert.match(lib,/kind IN \('lop','authorized_deduction'\)/);
 assert.match(lib,/Requester cannot approve their own payroll adjustment/);
 assert.match(lib,/Finance approver must be independent/);
});
test("V2 salary plan supports dates batches holds and dual approval",()=>{
 for(const token of["v2_salary_release_plans","v2_salary_release_items","batch_code","release_at","hold_status","hold_reason"])assert.ok(lib.includes(token),token);
 assert.match(lib,/Plan creator cannot provide HR approval/);
 assert.match(lib,/Finance approval must be independent/);
 assert.match(lib,/hold_status='ready' AND release_at<=\?/);
});
test("V2 API separates HR and Finance authority",()=>{
 assert.match(api,/authorize\(request,"people\.manage"\)/);
 assert.match(api,/authorize\(request,"payroll\.approve"\)/);
 assert.match(api,/queue_due_salary/);
 assert.match(security,/code:"hr"/);assert.match(security,/without payment authority/);
});
test("scheduled release queues only approved due V2 salary before sandbox dispatch",()=>{
 assert.match(worker,/runV2SalaryReleaseSweep/);
 assert.match(worker,/runEmployeeSalarySandboxSweep/);
 assert.ok(worker.indexOf("runV2SalaryReleaseSweep(env.DB")<worker.indexOf("runEmployeeSalarySandboxSweep(env.DB"));
 assert.match(lib,/liveMoneyEnabled:false/);
});
test("V2 UI exposes policy LOP deductions salary date holds and batch queue",()=>{
 for(const label of["V2 payroll policy","Derive LOP","Propose deduction","Salary date","Default batch code","Hold salary","Queue due salary batches","HR approve plan","Finance approve plan"])assert.ok(panel.includes(label),label);
});
