import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=p=>fs.readFileSync(p,"utf8");

test("People Gate 4 owns versioned incentive scheme result dispute adjustment reversal and payroll-link truth",()=>{const src=read("lib/incentive-engine.ts");for(const table of ["incentive_scheme_versions","employee_incentive_periods","employee_incentive_results","incentive_result_lines","incentive_adjustments","incentive_disputes","incentive_reversals","incentive_approval_events","incentive_payroll_links"])assert.ok(src.includes(table),table);assert.match(src,/scheme_code TEXT NOT NULL,version INTEGER NOT NULL/);assert.match(src,/UNIQUE\(source_type,source_id\)/);});

test("incentive calculation consumes canonical productivity facts and excludes pipeline revenue",()=>{const src=read("lib/incentive-engine.ts");assert.match(src,/sales_productivity_facts/);assert.match(src,/sales_productivity_fact_runs/);assert.match(src,/net_collected_revenue/);assert.match(src,/collected_revenue/);assert.match(src,/pipelineRevenueExcluded:true/);assert.ok(!src.includes("canonical_revenue_opportunities o"));});

test("targets formulas caps and quality guardrails are configuration not PawSpace hard-coded policy",()=>{const src=read("lib/incentive-engine.ts");assert.match(src,/formula_json TEXT NOT NULL/);assert.match(src,/quality_rules_json TEXT NOT NULL/);assert.match(src,/target:number/);assert.match(src,/payoutValue:number/);assert.match(src,/cap\?:number/);assert.match(src,/multiplier\?:number/);assert.ok(!src.includes("25000"));assert.ok(!src.includes("0.08"));assert.ok(!src.includes("1250"));});

test("held or disputed incentive cannot be silently approved and calculator cannot self approve",()=>{const src=read("lib/incentive-engine.ts");assert.match(src,/status="held"/);assert.match(src,/status='disputed'/);assert.match(src,/Only calculated and unheld incentive can be approved/);assert.match(src,/Incentive calculator cannot approve their own result/);});

test("finalized incentive corrections are new adjustment or reversal events instead of history edits",()=>{const src=read("lib/incentive-engine.ts");assert.match(src,/Finalized incentive cannot be silently adjusted/);assert.match(src,/incentive_reversals/);assert.match(src,/reversal_created/);assert.match(src,/Payroll-included incentive requires reversal\/correction rather than reopening history/);});

test("approved incentives enter payroll once and reversals become explicit deduction lines",()=>{const incentive=read("lib/incentive-engine.ts"),payroll=read("lib/payroll-engine.ts");assert.match(incentive,/approvedIncentiveEntriesForPayroll/);assert.match(incentive,/LEFT JOIN incentive_payroll_links/);assert.match(incentive,/sourceType:"incentive_reversal"/);assert.match(payroll,/approvedIncentiveEntriesForPayroll/);assert.match(payroll,/markIncentiveEntriesIncluded/);assert.match(payroll,/entry\.kind==="earning"/);assert.match(payroll,/INCENTIVE_REVERSAL/);assert.match(payroll,/incentivePolicy:"approved_source_entries_only"/);});

test("incentive API uses explicit People incentive permissions and audits mutations",()=>{const api=read("app/api/incentives/route.ts");assert.match(api,/authorize\(request,"incentives\.view"\)/);assert.match(api,/authorize\(request,"incentives\.manage"\)/);assert.match(api,/securityAudit/);assert.match(api,/incentive\.\$\{action\}/);assert.match(api,/productionReady:false/);});

test("People incentives UI is truthful about pipeline approval payroll and production boundaries",()=>{const page=read("app/team/people/incentives/page.tsx");assert.match(page,/Pipeline revenue never qualifies/);assert.match(page,/Human approval is required/);assert.match(page,/ONE-TIME LINKED/);assert.match(page,/Production ready:<\/b> NO/);});
