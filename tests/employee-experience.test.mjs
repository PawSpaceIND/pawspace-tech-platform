import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const selfLib = await read("../lib/employee-self-service.ts");
const selfRoute = await read("../app/api/me/route.ts");
const leaderLib = await read("../lib/live-leaderboard.ts");
const leaderRoute = await read("../app/api/leaderboard/route.ts");
const accrual = await read("../lib/daily-incentive-accrual.ts");
const scheduler = await read("../lib/background-scheduler.ts");
const security = await read("../lib/platform-security.ts");

test("employee self-service is strictly own-record-only and governed", () => {
  assert.match(selfLib, /export async function resolveEmployeeForActor/);
  assert.match(selfLib, /LOWER\(work_email\)=\? OR LOWER\(user_email\)=\?/);          // resolves to the caller's own record
  assert.match(selfLib, /export async function employeeSelfServiceView/);
  assert.match(selfLib, /export async function applyForLeave/);                        // employee is the maker
  assert.match(selfLib, /actorId:text\(input\.email\)/);                               // requester = the employee
  assert.match(selfLib, /ownRecordOnly:true/);
  // the route gates on self_service.view and blocks cross-origin writes
  assert.match(selfRoute, /authorize\(request,"self_service\.view"\)/);
  assert.match(selfRoute, /Cross-origin self-service write blocked/);
  for (const a of ["apply_leave", "check_in", "check_out"]) assert.match(selfRoute, new RegExp(`"${a}"`));
});

test("the live leaderboard ranks employees, groomers and trainers and is recognition-only", () => {
  assert.match(leaderLib, /export async function liveLeaderboard/);
  assert.match(leaderLib, /employeeBoard|groomerBoard|trainerBoard/);
  assert.match(leaderLib, /rankGroomersForMonth/);
  assert.match(leaderLib, /computeTrainerMonthlyIncentive/);
  assert.match(leaderLib, /payrollAuthority:false,disciplinaryAuthority:false/);       // not payroll/disciplinary authority
  assert.match(leaderRoute, /authorize\(request,"self_service\.view"\)/);
});

test("daily incentive auto-accrues once per day, idempotently, and is wired into the scheduler", () => {
  assert.match(accrual, /export async function runDailyIncentiveAccrualSweep/);
  assert.match(accrual, /computeDailySalesIncentive/);
  assert.match(accrual, /ON CONFLICT\(employee_id,accrual_date\) DO NOTHING/);          // one accrual per employee per day
  assert.match(accrual, /already_processed/);                                           // per-day sweep marker
  assert.match(accrual, /auto-ACCRUAL, not auto-disbursement/);                         // no money moves
  assert.match(scheduler, /runDailyIncentiveAccrualSweep\(db,\{asOf\}\)/);
  assert.match(scheduler, /"dailyIncentiveAccrual"/);
});

test("a scoped self_service.view permission exists and is granted to staff-facing roles", () => {
  assert.match(security, /"self_service\.view"/);
  // associate + service_provider carry it so employees and providers can see their own workspace
  assert.match(security, /code:"associate"[\s\S]*?self_service\.view/);
  assert.match(security, /code:"service_provider"[\s\S]*?self_service\.view/);
});
