import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=p=>fs.readFileSync(p,"utf8");

test("People foundation owns canonical employee identity and effective dated employment history",()=>{const src=read("lib/people-foundation.ts");assert.match(src,/CREATE TABLE IF NOT EXISTS employees/);assert.match(src,/CREATE TABLE IF NOT EXISTS employee_employment_versions/);assert.match(src,/UNIQUE\(employee_id,version\)/);assert.match(src,/effective_until/);assert.match(src,/manager_employee_id/);assert.match(src,/cost_centre_code/);assert.match(src,/location_code/);});

test("People foundation audits employee and employment changes",()=>{const src=read("lib/people-foundation.ts");assert.match(src,/CREATE TABLE IF NOT EXISTS people_audit_events/);assert.match(src,/employee\.created/);assert.match(src,/employee\.updated/);assert.match(src,/employment\.version_created/);});

test("People directory masks employee phone unless People manage authority is present",()=>{const src=read("lib/people-foundation.ts"),api=read("app/api/people-foundation/route.ts");assert.match(src,/maskEmployeePhone/);assert.match(src,/sensitiveMasked/);assert.match(api,/people\.view/);assert.match(api,/people\.manage/);assert.match(api,/includeSensitive/);});

test("People RBAC has explicit people and payroll permissions",()=>{const src=read("lib/platform-security.ts");for(const permission of ["people.view","people.manage","payroll.view","payroll.manage"])assert.ok(src.includes(`\"${permission}\"`),`missing ${permission}`);assert.match(src,/code:"finance"[\s\S]*payroll\.manage/);});

test("People UI reflects Gates 1-5 UAT status without claiming external statutory bank or production readiness",()=>{const page=read("app/team/people/page.tsx");assert.ok(!page.includes("../../ops/page"));assert.match(page,/Employee and employment system of record/);assert.match(page,/People Gates 1–5:<\/b> IMPLEMENTED FOR UAT/);assert.match(page,/External statutory\/live bank:<\/b> NOT ENABLED/);assert.match(page,/Production ready:<\/b> NO/);});

test("People gate does not invent deferred employment payroll incentive or statutory policy values",()=>{const src=read("lib/people-foundation.ts")+read("app/team/people/page.tsx");for(const forbidden of ["probationDays","graceMinutes","overtimeRate","pfRate","esiRate","incentiveRate","salaryAmount"])assert.ok(!src.includes(forbidden),`invented policy constant ${forbidden}`);});
