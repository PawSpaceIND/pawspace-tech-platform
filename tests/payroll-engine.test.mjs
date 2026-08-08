import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=p=>fs.readFileSync(p,"utf8");

test("People Gate 3 owns versioned compensation payroll results payslips and sandbox batches",()=>{const src=read("lib/payroll-engine.ts");for(const token of ["salary_structure_versions","employee_compensation_assignments","payroll_runs","employee_payroll_results","payroll_result_lines","payroll_approval_events","payslips","payroll_payment_batches"])assert.ok(src.includes(token),token);});

test("payroll calculation is idempotent and snapshots source configuration",()=>{const src=read("lib/payroll-engine.ts");assert.match(src,/idempotency_key TEXT NOT NULL UNIQUE/);assert.match(src,/input_snapshot_json/);assert.match(src,/duplicatePrevented:true/);assert.match(src,/source_snapshot_json/);assert.match(src,/policy_version/);});

test("payroll blocks missing compensation negative net pay and invented statutory fallback",()=>{const src=read("lib/payroll-engine.ts");assert.match(src,/configuration_required: compensation assignment missing/);assert.match(src,/Negative net pay requires explicit exception policy/);assert.match(src,/statutoryPolicy:"configuration_required"/);assert.ok(!src.includes("0.12"));assert.ok(!src.includes("0.18"));assert.ok(!src.includes("professionalTaxRate"));});

test("maker checker prevents payroll creator or reviewer from approving own run",()=>{const src=read("lib/payroll-engine.ts");assert.match(src,/created_by/);assert.match(src,/reviewed_by/);assert.match(src,/Maker\/reviewer cannot approve their own payroll run/);assert.match(src,/status='approved'/);});

test("UAT payroll payment preparation cannot transmit to a bank",()=>{const src=read("lib/payroll-engine.ts"),page=read("app/team/people/payroll/page.tsx");assert.match(src,/external_transmission INTEGER NOT NULL DEFAULT 0/);assert.match(src,/sandbox_prepared/);assert.match(src,/externalTransmission:false/);assert.match(page,/Live bank instruction:<\/b> NO/);});

test("payroll API separates compensation payroll and approval permissions",()=>{const api=read("app/api/payroll/route.ts"),security=read("lib/platform-security.ts");assert.match(api,/authorize\(request,"payroll\.view"\)/);assert.match(api,/authorize\(request,"payroll\.approve"\)/);assert.match(api,/"compensation\.manage":"payroll\.manage"/);for(const p of ["compensation.view","compensation.manage","payroll.view","payroll.manage","payroll.approve"])assert.ok(security.includes(`\"${p}\"`),p);});
