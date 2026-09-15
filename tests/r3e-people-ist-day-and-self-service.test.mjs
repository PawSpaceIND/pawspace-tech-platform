/**
 * People: the IST day, the employee's own numbers, and the refusals that were lying.
 *
 * Round-3 runtime audit R3-E, reproduced against the REAL engines, routes and shipped screens.
 *
 *  E3  THE UTC DAY BOUNDARY, in three places, all rolling over at 05:30 IST:
 *      (1) recordAttendance stamped work_date with toISOString().slice(0,10) and grouped the day's
 *          events with substr(datetime(...,'unixepoch'),1,10), so one 02:00-11:00 IST shift became a
 *          fabricated previous day flagged missing_checkout plus a today row with no check-in and no
 *          worked minutes;
 *      (2) the period lock was bounded with UTC day edges, so "1 Sep - 14 Sep" really ran 1 Sep 05:30
 *          IST to 15 Sep 05:29 IST - a check-in on the 15th was refused and one at 02:00 on the 1st
 *          was accepted and filed against August;
 *      (3) peopleReports bounded the payroll register against UTC day edges while an IST payroll month
 *          starts at 18:30Z the previous day, so an AUGUST report returned every SEPTEMBER payroll row;
 *      (4) lib/manager-dashboard.ts derived `today` the same way - suspected but unreproducible from
 *          outside the process, because the route does not expose `asOf`. Established here by calling
 *          buildManagerDashboard with an explicit asOf.
 *  E4  The employee's own salary screen computed net as gross - deductions and ignored reimbursements,
 *      while payroll pays gross - deductions + reimbursements. "MY SALARY ... net 58,200" sat ten lines
 *      above "Net take-home (latest) 60,200" from the same employee's payslip.
 *  E5  The statutory export's run dropdown was fed from postableRuns, which excludes a run once its
 *      journal is posted - the normal next step - so the export became unreachable with no explanation
 *      while the same export succeeded over the API.
 *  E6  Manager scope was enforced on Reports and not on Time & Leave.
 *  E7  leave_requests.units had no relationship to start_date/end_date.
 *  E8  add_employment_version threw plain Errors, so correctable input arrived as 500.
 *  E10 missing_checkout was raised the instant an employee clocked in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__R3E_PEOPLE_DB__", "__R3E_PEOPLE_ENV__");

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const attendanceRoute = await import("../app/api/attendance-leave/route.ts");
const meRoute = await import("../app/api/me/route.ts");
const reportsRoute = await import("../app/api/people-reports/route.ts");
const peopleRoute = await import("../app/api/people-foundation/route.ts");
const financeRoute = await import("../app/api/people-finance/route.ts");
const payrollRoute = await import("../app/api/payroll/route.ts");
const timeScreen = await import("../app/team/people/time/page.tsx");
const reportsScreenModule = await import("../app/team/people/reports/page.tsx");
const financeScreen = await import("../app/team/people/finance/page.tsx");
const payrollScreen = await import("../app/team/people/payroll/page.tsx");
const engine = await import("../lib/attendance-leave.ts");
const payroll = await import("../lib/payroll-engine.ts");
const managerDashboard = await import("../lib/manager-dashboard.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
const { istDayString } = await import("../lib/ist-day.ts");

const HOST = "https://uat.pawspace.in";
const HR = "hr.ops@pawspace.test";            // admin: people.manage -> company-wide
const MGR1 = "manager.one@pawspace.test";     // manager: attendance.manage, directs EMP-1 / EMP-2
const MGR2 = "manager.two@pawspace.test";     // manager: attendance.manage, direct EMP-3
const EMP1 = "emp1@pawspace.test";
const EMP3 = "emp3@pawspace.test";
const FINANCE = "finance@pawspace.test";      // finance: payroll.manage + finance.manage
const FINANCE2 = "finance2@pawspace.test";
const NOW = Date.UTC(2026, 8, 15, 6, 0, 0);

const ist = (value) => Date.parse(value);
const read = async (response) => ({ status: response.status, body: await response.json() });
const attendancePost = (email, body) => attendanceRoute.POST(new Request(`${HOST}/api/attendance-leave`, {
  method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify(body),
}));
const attendanceGet = (email) => attendanceRoute.GET(new Request(`${HOST}/api/attendance-leave`, { headers: { "oai-authenticated-user-email": email } }));
const mePost = (email, body) => meRoute.POST(new Request(`${HOST}/api/me`, {
  method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email, origin: HOST, host: "uat.pawspace.in" }, body: JSON.stringify(body),
}));
const meGet = (email) => meRoute.GET(new Request(`${HOST}/api/me`, { headers: { "oai-authenticated-user-email": email } }));
const reportsGet = (email, query = "") => reportsRoute.GET(new Request(`${HOST}/api/people-reports${query}`, { headers: { "oai-authenticated-user-email": email } }));
const peoplePost = (email, body) => peopleRoute.POST(new Request(`${HOST}/api/people-foundation`, {
  method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify(body),
}));
const financePost = (email, body) => financeRoute.POST(new Request(`${HOST}/api/people-finance`, {
  method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify(body),
}));
const financeGet = (email) => financeRoute.GET(new Request(`${HOST}/api/people-finance`, { headers: { "oai-authenticated-user-email": email } }));
const payrollPost = (email, body) => payrollRoute.POST(new Request(`${HOST}/api/payroll`, {
  method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify(body),
}));
const reportsPeriod = (date) => String(reportsScreenModule.periodStartMs(date));
const reportsPeriodEnd = (date) => String(reportsScreenModule.periodEndMs(date));
const one = (sqlite, sql, ...args) => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; };

async function world() {
  const { db, sqlite } = freshCountingD1();
  globalThis.__R3E_PEOPLE_DB__ = db;
  globalThis.__R3E_PEOPLE_ENV__ = {};
  enterWorkersDbScope(db);
  await ensureSecurityTables(db);
  await ensurePeopleTables(db);
  await engine.ensureAttendanceLeaveTables(db);
  await payroll.ensurePayrollTables(db);
  const user = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  user.run("U-HR", HR, "Hana HR", "admin", NOW, NOW);
  user.run("U-MGR1", MGR1, "Manager One", "manager", NOW, NOW);
  user.run("U-MGR2", MGR2, "Manager Two", "manager", NOW, NOW);
  user.run("U-EMP1", EMP1, "Employee One", "associate", NOW, NOW);
  user.run("U-EMP3", EMP3, "Employee Three", "associate", NOW, NOW);
  user.run("U-FIN", FINANCE, "Fay Finance", "finance", NOW, NOW);
  user.run("U-FIN2", FINANCE2, "Faisal Finance", "finance", NOW, NOW);

  const employee = sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)");
  employee.run("MGR-1", MGR1, "PS-M1", "Manager One", MGR1, Date.UTC(2026, 0, 1), NOW, NOW);
  employee.run("MGR-2", MGR2, "PS-M2", "Manager Two", MGR2, Date.UTC(2026, 0, 1), NOW, NOW);
  employee.run("EMP-1", EMP1, "PS-1", "Employee One", EMP1, Date.UTC(2026, 0, 1), NOW, NOW);
  employee.run("EMP-2", "emp2@pawspace.test", "PS-2", "Employee Two", "emp2@pawspace.test", Date.UTC(2026, 0, 1), NOW, NOW);
  employee.run("EMP-3", EMP3, "PS-3", "Employee Three", EMP3, Date.UTC(2026, 0, 1), NOW, NOW);
  const version = sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,team_code,manager_employee_id,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'direct_employee','ops',?,'seed','seed',?)");
  version.run("V-1", "EMP-1", Date.UTC(2026, 0, 1), "MGR-1", NOW);
  version.run("V-2", "EMP-2", Date.UTC(2026, 0, 1), "MGR-1", NOW);
  version.run("V-3", "EMP-3", Date.UTC(2026, 0, 1), "MGR-2", NOW);
  return { db, sqlite };
}

const COMPONENTS = [
  { code: "BASIC", label: "Basic", kind: "earning", amount: 40_000 },
  { code: "HRA", label: "House rent allowance", kind: "earning", amount: 20_000 },
  { code: "PF", label: "Provident fund", kind: "deduction", amount: 1_800 },
  { code: "TRAVEL", label: "Travel reimbursement", kind: "reimbursement", amount: 2_000 },
  { code: "EPF", label: "Employer provident fund", kind: "employer_cost", amount: 1_800 },
];
/* Every ACTIVE employee needs an assignment or calculatePayroll refuses the whole run with
 * "configuration_required: compensation assignment missing", which is the engine working correctly. */
const ALL_EMPLOYEES = ["MGR-1", "MGR-2", "EMP-1", "EMP-2", "EMP-3"];
async function compensate(db, employeeIds = ALL_EMPLOYEES) {
  const structure = await payroll.saveSalaryStructure(db, { structureCode: "R3E-STD", effectiveFrom: Date.UTC(2026, 0, 1), components: COMPONENTS, actorId: HR });
  for (const employeeId of employeeIds) {
    await payroll.assignCompensation(db, { employeeId, structureId: String(structure.id), effectiveFrom: Date.UTC(2026, 0, 1), reason: "Initial compensation assignment", actorId: HR });
  }
  return structure;
}

// =================================================================================================
// E3 (1). One IST shift is one attendance day.
// =================================================================================================

test("E3: a 02:00-11:00 IST shift is ONE work day with real hours, not a fabricated yesterday", async () => {
  const { db, sqlite } = await world();
  const checkIn = ist("2026-09-13T02:00:00+05:30"), checkOut = ist("2026-09-13T11:00:00+05:30");

  const inEvent = await engine.recordAttendance(db, { employeeId: "EMP-1", eventType: "check_in", occurredAt: checkIn, idempotencyKey: "r3e:in", actorId: EMP1 });
  assert.equal(inEvent.workDate, "2026-09-13", "R3-E read 2026-09-12 here: the day before the shift started");
  const outEvent = await engine.recordAttendance(db, { employeeId: "EMP-1", eventType: "check_out", occurredAt: checkOut, idempotencyKey: "r3e:out", actorId: EMP1 });
  assert.equal(outEvent.workDate, "2026-09-13");

  const days = sqlite.prepare("SELECT work_date,worked_minutes,exception_code,first_check_in,last_check_out FROM attendance_days WHERE employee_id='EMP-1' ORDER BY work_date").all();
  assert.equal(days.length, 1, "one shift must be one row, not a missing_checkout day plus an empty one");
  assert.equal(days[0].work_date, "2026-09-13");
  assert.equal(Number(days[0].worked_minutes), 540, "02:00 to 11:00 is 540 minutes");
  assert.equal(days[0].exception_code, null, "a completed shift is not an exception");
  assert.equal(Number(days[0].first_check_in), checkIn);
  assert.equal(Number(days[0].last_check_out), checkOut);
});

// =================================================================================================
// E3 (2). The payroll period lock covers the days it says it covers.
// =================================================================================================

test("E3: a period lock typed as 1-14 Sep locks 1 Sep 02:00 IST and leaves 15 Sep open", async () => {
  const { sqlite } = await world();
  const lockBody = timeScreen.periodLockBody({ periodStart: "2026-09-01", periodEnd: "2026-09-14", status: "locked" });
  assert.equal(lockBody.periodStart, ist("2026-09-01T00:00:00.000+05:30"));
  assert.equal(lockBody.periodEnd, ist("2026-09-14T23:59:59.999+05:30"));
  assert.equal((await read(await attendancePost(HR, lockBody))).status, 200);

  // R3-E: a check-in at 02:00 IST on 1 September - inside the locked window - was ACCEPTED, and filed
  // itself as workDate 2026-08-31, inside the previous payroll month.
  const insideLock = await read(await attendancePost(EMP1, { action: "check_in", employeeId: "EMP-1", occurredAt: ist("2026-09-01T02:00:00+05:30"), idempotencyKey: "r3e:lock:inside" }));
  assert.equal(insideLock.status, 409, "a locked day must refuse the check-in");
  assert.match(insideLock.body.error, /Payroll period is locked/);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM attendance_events").get().c), 0);

  // R3-E: a check-in on 15 September - a day nobody locked - was REFUSED 409.
  const outsideLock = await read(await attendancePost(EMP1, { action: "check_in", employeeId: "EMP-1", occurredAt: ist("2026-09-15T09:30:00+05:30"), idempotencyKey: "r3e:lock:outside" }));
  assert.equal(outsideLock.status, 200, "15 September was never locked and must be accepted");
  assert.equal(outsideLock.body.data.workDate, "2026-09-15");

  // The last IST hour of the locked window is still locked.
  const lastHour = await read(await attendancePost(EMP1, { action: "check_in", employeeId: "EMP-1", occurredAt: ist("2026-09-14T23:30:00+05:30"), idempotencyKey: "r3e:lock:last" }));
  assert.equal(lastHour.status, 409);
});

// =================================================================================================
// E3 (3). An August report is an August report.
// =================================================================================================

test("E3: an August People report does not contain the September payroll register", async () => {
  const { db } = await world();
  await compensate(db);
  const sept = payrollScreen.payrollMonthBounds("2026-09");
  assert.equal((await read(await payrollPost(FINANCE, { action: "calculate", ...sept }))).status, 200);

  const augustUrl = `?start=${reportsPeriod("2026-08-01")}&end=${reportsPeriodEnd("2026-08-31")}`;
  const augustReport = await read(await reportsGet(HR, augustUrl));
  assert.equal(augustReport.status, 200);
  assert.equal(augustReport.body.data.period.startDate, "2026-08-01");
  assert.equal(augustReport.body.data.period.endDate, "2026-08-31");
  assert.equal(augustReport.body.data.payroll.register.length, 0, "R3-E read all ten September rows here");
  assert.deepEqual(augustReport.body.data.payroll.costByCostCentre, [], "and 'unassigned 6,18,000.00' under a heading that said August");

  // The same question for September answers with the run.
  const septemberUrl = `?start=${reportsPeriod("2026-09-01")}&end=${reportsPeriodEnd("2026-09-30")}`;
  const septemberReport = await read(await reportsGet(HR, septemberUrl));
  assert.equal(septemberReport.body.data.payroll.register.length, ALL_EMPLOYEES.length, "September's payroll belongs to September");
  assert.equal(septemberReport.body.data.period.startDate, "2026-09-01");
});

test("E3: the reports screen's own period control sends IST day edges", async () => {
  assert.equal(reportsScreenModule.periodStartMs("2026-08-01"), ist("2026-08-01T00:00:00.000+05:30"));
  assert.equal(reportsScreenModule.periodEndMs("2026-08-31"), ist("2026-08-31T23:59:59.999+05:30"));
  assert.equal(
    reportsScreenModule.peopleReportQuery({ start: "2026-08-01", end: "2026-08-31" }),
    `/api/people-reports?start=${ist("2026-08-01T00:00:00.000+05:30")}&end=${ist("2026-08-31T23:59:59.999+05:30")}`,
  );
});

// =================================================================================================
// E3 (4). The manager dashboard's "today" - the suspected, previously unreproducible one.
// =================================================================================================

test("E3: the manager dashboard dates itself by the IST day, established with an explicit asOf", async () => {
  const { db } = await world();
  // 02:00 IST on 13 September is 20:30Z on the 12th: the UTC derivation reported the 12th.
  const earlyMorning = await managerDashboard.buildManagerDashboard(db, { actorEmail: HR, permissions: ["people.manage"], asOf: ist("2026-09-13T02:00:00+05:30") });
  assert.equal(earlyMorning.today, "2026-09-13", "between midnight and 05:30 IST the dashboard described yesterday");
  assert.equal(earlyMorning.today, istDayString(earlyMorning.asOf));

  const afternoon = await managerDashboard.buildManagerDashboard(db, { actorEmail: HR, permissions: ["people.manage"], asOf: ist("2026-09-13T14:00:00+05:30") });
  assert.equal(afternoon.today, "2026-09-13", "and the same IST day after 05:30, which is when it used to agree");
});

// =================================================================================================
// E10. An open shift is not an exception until the day is over.
// =================================================================================================

test("E10: checking in today raises no exception, and yesterday's open day is flagged when it ends", async () => {
  const { db, sqlite } = await world();
  const now = Date.now();
  const today = istDayString(now), yesterday = istDayString(now - 86_400_000);

  const clockIn = await engine.recordAttendance(db, { employeeId: "EMP-1", eventType: "check_in", occurredAt: now, idempotencyKey: "r3e:today:in", actorId: EMP1 });
  assert.equal(clockIn.workDate, today);
  assert.equal(clockIn.exception, null, "R3-E: 'Exception: missing_checkout' appeared the instant Check in was pressed");
  assert.equal(one(sqlite, "SELECT exception_code e FROM attendance_days WHERE employee_id='EMP-1' AND work_date=?", today).e, null);

  // A day that is genuinely over and was never closed IS an exception.
  await engine.recordAttendance(db, { employeeId: "EMP-2", eventType: "check_in", occurredAt: now - 86_400_000, idempotencyKey: "r3e:yesterday:in", actorId: "emp2@pawspace.test" });
  assert.equal(one(sqlite, "SELECT exception_code e FROM attendance_days WHERE employee_id='EMP-2' AND work_date=?", yesterday).e, "missing_checkout");

  // And an open day left behind is flagged the next time the employee clocks on, so the signal that
  // used to fire too early is not simply lost.
  sqlite.prepare("UPDATE attendance_days SET exception_code=NULL WHERE employee_id='EMP-2'").run();
  await engine.recordAttendance(db, { employeeId: "EMP-2", eventType: "check_in", occurredAt: now, idempotencyKey: "r3e:today:in2", actorId: "emp2@pawspace.test" });
  assert.equal(one(sqlite, "SELECT exception_code e FROM attendance_days WHERE employee_id='EMP-2' AND work_date=?", yesterday).e, "missing_checkout");
  assert.equal(one(sqlite, "SELECT exception_code e FROM attendance_days WHERE employee_id='EMP-2' AND work_date=?", today).e, null);
});

// =================================================================================================
// E4. The employee's own net take-home.
// =================================================================================================

test("E4: MY SALARY nets the same number the payslip does, reimbursements included", async () => {
  const { db } = await world();
  await compensate(db);

  // Before any payroll run the header has nothing but the compensation figure to show.
  const before = await read(await meGet(EMP1));
  assert.equal(before.status, 200);
  assert.equal(before.body.data.compensation.grossMonthly, 60_000);
  assert.equal(before.body.data.compensation.fixedDeductions, 1_800);
  assert.equal(before.body.data.compensation.reimbursements, 2_000);
  assert.equal(before.body.data.compensation.netMonthly, 60_200, "R3-E read 58,200: the travel reimbursement was dropped");

  // After the run, the two numbers on the one screen agree.
  const sept = payrollScreen.payrollMonthBounds("2026-09");
  assert.equal((await read(await payrollPost(FINANCE, { action: "calculate", ...sept }))).status, 200);
  const after = (await read(await meGet(EMP1))).body.data;
  assert.equal(after.payslips.latest.net, 60_200);
  assert.equal(after.compensation.netMonthly, after.payslips.latest.net,
    "R3-E: 'MY SALARY ... net 58,200' sat ten lines above 'Net take-home (latest) 60,200'");
  assert.equal(after.payslips.latest.reimbursements, 2_000);
  assert.equal(
    after.payslips.latest.gross - after.payslips.latest.deductions + after.payslips.latest.reimbursements,
    after.payslips.latest.net,
    "the payslip columns must add up to the net they sit beside",
  );
});

// =================================================================================================
// E5. The statutory export stays reachable after the journal is posted.
// =================================================================================================

test("E5: posting the Finance journal does not hide the run from the statutory export control", async () => {
  const { db, sqlite } = await world();
  await compensate(db);
  const sept = payrollScreen.payrollMonthBounds("2026-09");
  const run = await read(await payrollPost(FINANCE, { action: "calculate", ...sept }));
  const runId = String(run.body.data.run.id);
  assert.equal((await read(await payrollPost(FINANCE2, { action: "review", runId }))).status, 200);
  assert.equal((await read(await payrollPost(HR, { action: "approve", runId }))).status, 200);

  for (const sourceKey of ["payroll.salary_expense", "payroll.reimbursement_expense", "payroll.employer_cost_expense", "payroll.deductions_payable", "payroll.net_pay_payable", "payroll.employer_cost_payable"]) {
    assert.equal((await read(await financePost(FINANCE, { action: "configure_account", sourceKey, accountCode: `ACC-${sourceKey}`, approvalReference: "FIN-2026-09" }))).status, 200);
  }
  const policy = await read(await financePost(FINANCE, { action: "save_statutory_policy", policyCode: "PF", effectiveFrom: Date.UTC(2026, 0, 1), config: { rate: 0.12 }, approvalReference: "STAT-2026" }));
  assert.equal(policy.status, 200);

  const beforePost = (await read(await financeGet(FINANCE))).body.data;
  assert.equal(beforePost.postableRuns.length, 1);
  assert.equal(beforePost.exportableRuns.length, 1);
  assert.equal(beforePost.postableRuns[0].period_code, "2026-09", "the IST month boundary makes the Finance period the month the payroll is FOR");

  // The normal next step.
  const journal = await read(await financePost(FINANCE, financeScreen.postPayrollJournalPayload({ runId, periodCode: "2026-09" }).body));
  assert.equal(journal.status, 200, JSON.stringify(journal.body));

  const afterPost = (await read(await financeGet(FINANCE))).body.data;
  assert.equal(afterPost.postableRuns.length, 0, "posted runs correctly leave the POSTING control");
  assert.equal(afterPost.exportableRuns.length, 1, "R3-E: the export dropdown emptied itself here, with no explanation");
  assert.equal(afterPost.exportableRuns[0].id, runId);

  // And the export the control now offers actually succeeds - the engine never had this rule.
  const exportBody = financeScreen.createStatutoryExportPayload({ runId, periodCode: afterPost.exportableRuns[0].period_code, policyVersionId: String(policy.body.data.id) });
  assert.equal(exportBody.ok, true, exportBody.ok ? "" : exportBody.error);
  const exported = await read(await financePost(FINANCE, exportBody.body));
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(Number(exported.body.data.exportRecord.sandbox_only), 1);
  assert.equal(Number(exported.body.data.exportRecord.external_submission), 0, "a sandbox package is never submitted anywhere");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM people_statutory_exports WHERE payroll_run_id=?").get(runId).c), 1);
});

// =================================================================================================
// E6. A manager's Time & Leave is their own reporting line.
// =================================================================================================

test("E6: a manager reads their own reporting line on Time & Leave, not the whole roster", async () => {
  const { db } = await world();
  for (const [employeeId, actor, key] of [["EMP-1", EMP1, "e1"], ["EMP-3", EMP3, "e3"]]) {
    assert.equal((await read(await attendancePost(actor, { action: "check_in", employeeId, occurredAt: ist("2026-09-14T09:30:00+05:30"), idempotencyKey: `r3e:${key}` }))).status, 200);
  }
  void db;

  const managerOne = (await read(await attendanceGet(MGR1))).body.data;
  assert.equal(managerOne.scope.mode, "manager");
  assert.equal(managerOne.scope.organizationalScope, "reporting_line");
  assert.deepEqual([...new Set(managerOne.attendanceDays.map((r) => r.employee_id))], ["EMP-1"],
    "R3-E: Manager One read EMP-3's attendance row, and EMP-3 reports to Manager Two");
  assert.deepEqual(managerOne.employees.map((e) => e.id).sort(), ["EMP-1", "EMP-2", "MGR-1"],
    "the roster the controls name a person from is the same reporting line");

  // And the screen states which rows it is showing rather than leaving the reader to guess.
  const html = renderToStaticMarkup(React.createElement(timeScreen.TimeAndLeaveScreen, {
    data: managerOne, busy: false, loading: false, error: "", message: "", onPost: async () => {}, onRefresh: () => {},
  }));
  assert.match(html, /Showing your own reporting line/);

  const managerTwo = (await read(await attendanceGet(MGR2))).body.data;
  assert.deepEqual([...new Set(managerTwo.attendanceDays.map((r) => r.employee_id))], ["EMP-3"]);

  // people.manage is still company-wide, which is the rule lib/people-reports.ts already used.
  const hr = (await read(await attendanceGet(HR))).body.data;
  assert.equal(hr.scope.organizationalScope, "global");
  assert.deepEqual([...new Set(hr.attendanceDays.map((r) => r.employee_id))].sort(), ["EMP-1", "EMP-3"]);
});

// =================================================================================================
// E7. Leave units are the days requested.
// =================================================================================================

test("E7: leave units are tied to the dates, and an inverted range is refused", async () => {
  const { db, sqlite } = await world();
  assert.equal((await read(await attendancePost(HR, timeScreen.leavePolicyBody({ name: "Annual", leaveCode: "AL", allowNegative: true, entitlementUnits: "12", effectiveFrom: "2026-04-01" })))).status, 200);
  void db;

  // The three R3-E reproductions, each of which answered 200.
  const tenDaysOneUnit = await read(await mePost(EMP1, { action: "apply_leave", leaveCode: "AL", startDate: "2027-01-01", endDate: "2027-01-10", units: 1, reason: "family" }));
  assert.equal(tenDaysOneUnit.status, 400, "a ten-day absence must not be bookable against one day of balance");
  assert.match(tenDaysOneUnit.body.error, /is 10 day\(s\)/);

  const inverted = await read(await mePost(EMP1, { action: "apply_leave", leaveCode: "AL", startDate: "2027-02-10", endDate: "2027-02-01", units: 1, reason: "family" }));
  assert.equal(inverted.status, 400);
  assert.match(inverted.body.error, /end on or after the start/);

  const oneDayNineUnits = await read(await mePost(EMP1, { action: "apply_leave", leaveCode: "AL", startDate: "2027-03-01", endDate: "2027-03-01", units: 9, reason: "family" }));
  assert.equal(oneDayNineUnits.status, 400);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM leave_requests").get().c), 0, "not one of the three may create a request");

  // What a correct request looks like, including a half day.
  const matching = await read(await mePost(EMP1, { action: "apply_leave", leaveCode: "AL", startDate: "2027-01-01", endDate: "2027-01-10", units: 10, reason: "family" }));
  assert.equal(matching.status, 200);
  const halfDay = await read(await mePost(EMP1, { action: "apply_leave", leaveCode: "AL", startDate: "2027-04-01", endDate: "2027-04-01", units: 0.5, reason: "clinic" }));
  assert.equal(halfDay.status, 200);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM leave_requests").get().c), 2);
  assert.equal(Number(one(sqlite, "SELECT units u FROM leave_requests WHERE start_date='2027-01-01'").u), 10);
});

test("E7: neither leave form lets a mismatch be typed in the first place", async () => {
  // /me computes the days from the dates; the field is no longer free text.
  const { leaveSpanDays, leaveUnitsFor } = await import("../lib/leave-span.ts");
  assert.equal(leaveSpanDays("2027-01-01", "2027-01-10"), 10);
  assert.equal(leaveSpanDays("2027-02-10", "2027-02-01"), null, "an inverted range has no span");
  assert.equal(leaveSpanDays("not-a-date", "2027-02-01"), null);
  assert.equal(leaveUnitsFor("2027-01-01", "2027-01-10", false), 10);
  assert.equal(leaveUnitsFor("2027-01-01", "2027-01-10", true), 9.5);

  // The manager-side form derives the same number, and refuses a hand-edited mismatch before posting.
  const draft = { leaveCode: "AL", startDate: "2027-01-01", endDate: "2027-01-10", units: "1", reason: "family" };
  const policies = [{ id: "P1", name: "Annual", version: 1, leave_code: "AL", allow_negative: 1, entitlement_units: 12, effective_from: 0 }];
  assert.ok(timeScreen.missingLeaveRequestFields(draft, policies).some((m) => /2027-01-01 to 2027-01-10 is 10 day\(s\)/.test(m)));
  assert.deepEqual(timeScreen.withDerivedDays(draft).units, "10");
  assert.deepEqual(timeScreen.missingLeaveRequestFields(timeScreen.withDerivedDays(draft), policies), []);
});

// =================================================================================================
// E8. Correctable People input is a 4xx with its reason, not a 500.
// =================================================================================================

test("E8: add_employment_version refusals arrive as readable 4xx, not 500 'People update failed'", async () => {
  const { sqlite } = await world();

  const unknownEmployee = await read(await peoplePost(HR, { action: "add_employment_version", employeeId: "EMP-DOES-NOT-EXIST", effectiveFrom: Date.UTC(2026, 6, 1), reason: "a perfectly good reason" }));
  assert.equal(unknownEmployee.status, 404, "R3-E read 500 here");
  assert.match(unknownEmployee.body.error, /Employee not found: EMP-DOES-NOT-EXIST/);
  assert.notEqual(unknownEmployee.body.error, "People update failed");

  const sameDate = await read(await peoplePost(HR, { action: "add_employment_version", employeeId: "EMP-1", effectiveFrom: Date.UTC(2026, 0, 1), reason: "a perfectly good reason" }));
  assert.equal(sameDate.status, 409, "R3-E read 500 here too");
  assert.match(sameDate.body.error, /effective-dated after the current version/);
  assert.notEqual(sameDate.body.error, "People update failed");

  // The siblings in the same engine.
  const noReason = await read(await peoplePost(HR, { action: "add_employment_version", employeeId: "EMP-1", effectiveFrom: Date.UTC(2026, 6, 1), reason: "short" }));
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error, /employment change reason/);
  const noDate = await read(await peoplePost(HR, { action: "add_employment_version", employeeId: "EMP-1", effectiveFrom: 0, reason: "a perfectly good reason" }));
  assert.equal(noDate.status, 400);
  assert.match(noDate.body.error, /Effective-from/);
  const badUpsert = await read(await peoplePost(HR, { action: "upsert_employee", employeeCode: "", displayName: "", workEmail: "" }));
  assert.equal(badUpsert.status, 400);
  assert.match(badUpsert.body.error, /Employee code, name and work email/);

  // A manager id that names nobody is no longer persisted (the onboarding form's "PLACEHOLDER").
  const placeholder = await read(await peoplePost(HR, { action: "add_employment_version", employeeId: "EMP-1", effectiveFrom: Date.UTC(2026, 6, 1), reason: "a perfectly good reason", managerEmployeeId: "PLACEHOLDER" }));
  assert.equal(placeholder.status, 404);
  assert.match(placeholder.body.error, /Manager employee not found: PLACEHOLDER/);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM employee_employment_versions WHERE manager_employee_id='PLACEHOLDER'").get().c), 0);

  // A real one still goes through, and supersedes the previous version.
  const accepted = await read(await peoplePost(HR, { action: "add_employment_version", employeeId: "EMP-1", effectiveFrom: Date.UTC(2026, 6, 1), reason: "moved to Manager Two", managerEmployeeId: "MGR-2" }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(Number(accepted.body.data.employment.version), 2);
});

test("E4/E10: the /me payload carries the reimbursement column and no exception for an open day", async () => {
  const { db } = await world();
  await compensate(db);
  const sept = payrollScreen.payrollMonthBounds("2026-09");
  await payrollPost(FINANCE, { action: "calculate", ...sept });
  assert.equal((await read(await mePost(EMP1, { action: "check_in" }))).status, 200);

  const view = (await read(await meGet(EMP1))).body.data;
  assert.equal(view.attendance[0].workDate, istDayString(Date.now()));
  assert.equal(view.attendance[0].exception, null, "pressing Check in must not report an exception for a shift still in progress");
  assert.equal(view.payslips.list[0].reimbursements, 2_000, "the payslip row carries the column that makes Gross/Deductions/Net add up");
  assert.equal(view.payslips.list[0].gross - view.payslips.list[0].deductions + view.payslips.list[0].reimbursements, view.payslips.list[0].net);
});

test("E11: the onboarding form offers a manager to choose, not an id to invent", async () => {
  const onboarding = await import("../app/team/people/onboarding/page.tsx");
  const html = renderToStaticMarkup(React.createElement(onboarding.default));
  assert.match(html, /Activate employee/);
  assert.match(html, /Reporting manager/);
  assert.match(html, /No reporting manager/);
  assert.doesNotMatch(html, /Manager employee ID/, "the free text box that accepted and stored \"PLACEHOLDER\" is gone");

  // And the roster the dropdown is filled from is what /api/payroll now returns.
  const { db } = await world();
  const directory = await payroll.payrollDirectory(db);
  assert.deepEqual(directory.employees.map((e) => e.id).sort(), ["EMP-1", "EMP-2", "EMP-3", "MGR-1", "MGR-2"]);
});
