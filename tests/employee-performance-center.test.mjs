import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(path,"utf8");

test("employee leaderboard is source-derived and uses transparent selectable metrics",()=>{const src=read("lib/employee-performance-center.ts");assert.match(src,/sales_productivity_fact_runs/);assert.match(src,/sales_productivity_facts/);for(const metric of ["net_collected_revenue","booking_conversions","first_response_rate","qualified_leads","meaningful_actions"])assert.match(src,new RegExp(metric));assert.match(src,/operational_metric_sort/);assert.match(src,/compositeScore:false/);});

test("employee leaderboard never becomes payroll or disciplinary authority",()=>{const src=read("lib/employee-performance-center.ts"),page=read("app/team/performance/page.tsx");assert.match(src,/rankingAuthority:false/);assert.match(src,/payrollAuthority:false/);assert.match(src,/disciplinaryAuthority:false/);assert.match(page,/Ranking authority:<\/b> NO/);assert.match(page,/Payroll authority:<\/b> NO/);assert.match(page,/Disciplinary authority:<\/b> NO/);});

test("employee performance endpoint is reports permissioned and UI refreshes live",()=>{const api=read("app/api/employee-performance/route.ts"),page=read("app/team/performance/page.tsx");assert.match(api,/authorize\(request,"reports\.view"\)/);assert.match(page,/setInterval/);assert.match(page,/60_000/);assert.match(page,/Booking conversions/);assert.match(page,/First-response SLA %/);});
