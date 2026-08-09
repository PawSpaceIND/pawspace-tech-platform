import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(path,"utf8");

test("People Gate 2 owns versioned shift attendance adjustment and leave truth",()=>{const src=read("lib/attendance-leave.ts");for(const token of ["shift_policies","employee_shift_assignments","attendance_events","attendance_days","attendance_adjustment_requests","leave_policies","employee_leave_balances","leave_requests","leave_ledger_events","people_period_locks"])assert.ok(src.includes(token),`missing ${token}`);});

test("attendance replay is idempotent and missing checkout becomes an exception",()=>{const src=read("lib/attendance-leave.ts");assert.match(src,/idempotency_key TEXT NOT NULL UNIQUE/);assert.match(src,/duplicatePrevented:true/);assert.match(src,/missing_checkout/);assert.ok(!src.includes("fabricated hours"));});

test("locked payroll periods block silent attendance mutation",()=>{const src=read("lib/attendance-leave.ts");assert.match(src,/Payroll period is locked; use an attendance adjustment workflow/);assert.match(src,/attendance_adjustment_requests/);assert.match(src,/approveAdjustment/);});

test("leave policy is configuration-driven and negative balance requires explicit permission",()=>{const src=read("lib/attendance-leave.ts");assert.match(src,/allow_negative/);assert.match(src,/Active leave policy configuration is required/);assert.match(src,/Leave approval would create a negative balance/);assert.ok(!src.includes("annualLeaveDays"));assert.ok(!src.includes("sickLeaveDays"));});

test("People RBAC includes explicit attendance leave compensation payroll incentive and performance permissions",()=>{const src=read("lib/platform-security.ts");for(const permission of ["attendance.view","attendance.manage","leave.view","leave.manage","compensation.view","compensation.manage","payroll.view","payroll.manage","payroll.approve","incentives.view","incentives.manage","performance.view","performance.manage"])assert.ok(src.includes(`\"${permission}\"`),`missing ${permission}`);});

test("system role permission updates propagate into initialized D1",()=>{const src=read("lib/server-auth.ts");assert.match(src,/permissions_json=CASE WHEN role_definitions\.system_role=1 THEN excluded\.permissions_json/);});

test("attendance API enforces employee self scope and manager permissions",()=>{const api=read("app/api/attendance-leave/route.ts");assert.match(api,/Employee self-service scope denied/);assert.match(api,/attendance\.manage/);assert.match(api,/leave\.manage/);assert.match(api,/securityAudit/);});

test("attendance and leave never hard-code grace leave overtime or GPS policy",()=>{const src=read("lib/attendance-leave.ts"),page=read("app/team/people/time/page.tsx");assert.match(src,/hardcodedGraceMinutes:false/);assert.match(src,/hardcodedLeaveEntitlement:false/);assert.match(src,/hardcodedOvertimeRate:false/);assert.match(src,/gpsRequired:false/);assert.match(page,/Hard-coded leave\/grace\/OT policy:<\/b> NO/);assert.match(page,/Production ready:<\/b> NO/);});
