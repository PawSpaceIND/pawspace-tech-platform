import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=p=>fs.readFileSync(p,"utf8");

test("People Gate 5 links Finance expenses to canonical employees without rewriting the expense ledger",()=>{const src=read("lib/people-finance-integration.ts");assert.match(src,/CREATE TABLE IF NOT EXISTS people_expense_links/);assert.match(src,/SELECT \* FROM finance_expenses WHERE id=/);assert.match(src,/SELECT id,employee_code,work_email FROM employees/);assert.match(src,/Expense already linked; use an explicit correction workflow/);});

test("payroll Finance journals require explicit approved account mappings and stay balanced",()=>{const src=read("lib/people-finance-integration.ts");for(const key of ["payroll.salary_expense","payroll.reimbursement_expense","payroll.employer_cost_expense","payroll.deductions_payable","payroll.net_pay_payable","payroll.employer_cost_payable"])assert.ok(src.includes(key),key);assert.match(src,/configuration_required: finance account mapping missing/);assert.match(src,/Payroll Finance journal is not balanced/);assert.match(src,/source_type,source_id,account_code/);for(const forbidden of ["6200-Operating expense","2100-Expense payable","pfRate","esiRate","professionalTaxRate"])assert.ok(!src.includes(forbidden),`invented Finance/statutory constant ${forbidden}`);});

test("Finance period locks gate employee expense links payroll journals statutory exports and reconciliations",()=>{const src=read("lib/people-finance-integration.ts");assert.match(src,/SELECT status FROM finance_close_periods WHERE period_code=/);assert.match(src,/period_locked/);assert.match(src,/people_payroll_finance_posts \(payroll_run_id TEXT PRIMARY KEY/);assert.match(src,/people_bank_reconciliation_refs \(id TEXT PRIMARY KEY,payroll_batch_id TEXT NOT NULL UNIQUE/);});

test("statutory policy is explicit versioned configuration with sandbox-only exports",()=>{const src=read("lib/people-finance-integration.ts");assert.match(src,/people_statutory_policy_versions/);assert.match(src,/Explicit statutory configuration is required/);assert.match(src,/approval_reference TEXT NOT NULL/);assert.match(src,/people_statutory_exports/);assert.match(src,/sandbox_only INTEGER NOT NULL DEFAULT 1/);assert.match(src,/external_submission INTEGER NOT NULL DEFAULT 0/);assert.match(src,/externalSubmission:false/);assert.match(src,/submissionReady:false/);});

test("bank reconciliation records references only and cannot become a live transmission",()=>{const src=read("lib/people-finance-integration.ts");assert.match(src,/Sandbox payroll payment batch is required/);assert.match(src,/external_transmission INTEGER NOT NULL DEFAULT 0/);assert.match(src,/bankReconciliationMode:"sandbox_reference_only"/);assert.match(src,/liveBankTransmissionEnabled:false/);});

test("People Finance API uses existing Finance RBAC and security audit",()=>{const api=read("app/api/people-finance/route.ts");assert.match(api,/authorize\(request,"finance\.view"\)/);assert.match(api,/authorize\(request,"finance\.manage"\)/);assert.match(api,/securityAudit/);assert.match(api,/sandboxOnly:true/);});

test("Gate 5 workspace states the UAT boundary without claiming filing bank or production readiness",()=>{const page=read("app/team/people/finance/page.tsx");assert.match(page,/Gate 5 integration control/);assert.match(page,/External statutory submission:<\/b> NO/);assert.match(page,/Live bank transmission:<\/b> NO/);assert.match(page,/Production ready:<\/b> NO/);});
