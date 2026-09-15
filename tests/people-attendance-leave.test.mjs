/**
 * People Gate 2 - attendance, adjustments and leave - as EXECUTED behaviour.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT WAS REWRITTEN. Every one of its eight tests was an
 * `assert.match(fs.readFileSync("lib/attendance-leave.ts"), /some string/)`. It ran no engine code at
 * all, so it passed against:
 *
 *   - an engine that returns the wrong leave balance, as long as the words "allow_negative" appear;
 *   - an engine that fabricates worked hours for a day with no check-out, as long as the literal
 *     "missing_checkout" appears somewhere in the file;
 *   - an engine that silently writes through a locked payroll period, as long as the refusal STRING is
 *     still present in the source;
 *   - a route whose self-scope check has been deleted, as long as the message is still written down.
 *
 * Worse, the claims were true of the FILE and false of the PRODUCT: the same source text that satisfied
 * "locked payroll periods block silent attendance mutation" described a lock nothing in the repository
 * could ever write, and the leave policy whose rules the balance obeys could be created by no screen.
 * A string match cannot tell those apart. Each claim below is the same claim, executed against the real
 * engine and the real route over a real SQLite-backed D1.
 *
 * End-to-end coverage of the SCREEN controls that make these actions reachable at all lives in
 * tests/w2c-attendance-leave-controls.test.mjs; this file stays on the engine, the RBAC catalogue and
 * the route's scope rule, which is what it always claimed to be about.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshCountingD1, makeCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__PEOPLE_ATTENDANCE_LEAVE_DB__", "__PEOPLE_ATTENDANCE_LEAVE_ENV__");

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const engine = await import("../lib/attendance-leave.ts");
const route = await import("../app/api/attendance-leave/route.ts");
const screen = await import("../app/team/people/time/page.tsx");
const { authError, ensureSecurityTables } = await import("../lib/server-auth.ts");
const { defaultRoles, parsePermissions, permissionCatalog } = await import("../lib/platform-security.ts");
const { ensurePeopleTables } = await import("../lib/people-foundation.ts");

const API = "https://uat.pawspace.in/api/attendance-leave";
const MANAGER = "meera.manager@pawspace.test";
const ASHA = "asha@pawspace.test";
const BHAVNA = "bhavna@pawspace.test";
const NOW = Date.UTC(2026, 8, 15, 6, 0, 0);
const IN = Date.UTC(2026, 8, 14, 9, 0);
const OUT = Date.UTC(2026, 8, 14, 17, 30);

const post = (email, body) => route.POST(new Request(API, {
  method: "POST",
  headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
  body: JSON.stringify(body),
}));
const get = (email) => route.GET(new Request(API, { headers: { "oai-authenticated-user-email": email } }));
const answer = async (response) => ({ status: response.status, body: await response.json() });
const one = (sqlite, sql, ...args) => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; };
const count = (sqlite, table) => Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c);
const balance = (sqlite, employeeId, leaveCode) => Number(one(sqlite, "SELECT balance b FROM employee_leave_balances WHERE employee_id=? AND leave_code=?", employeeId, leaveCode).b);

/** Just the engine: no identity, no route. */
async function engineWorld() {
  const { db, sqlite } = freshCountingD1();
  await engine.ensureAttendanceLeaveTables(db);
  return { db, sqlite };
}

/** The engine behind the real route, with real role definitions and real identities. */
async function routeWorld() {
  const { db, sqlite } = freshCountingD1();
  globalThis.__PEOPLE_ATTENDANCE_LEAVE_DB__ = db;
  globalThis.__PEOPLE_ATTENDANCE_LEAVE_ENV__ = {};
  enterWorkersDbScope(db);
  await ensureSecurityTables(db);
  await ensurePeopleTables(db);
  const user = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  user.run("U-MGR", MANAGER, "Meera Manager", "manager", NOW, NOW);
  user.run("U-ASHA", ASHA, "Asha Associate", "associate", NOW, NOW);
  user.run("U-BHAVNA", BHAVNA, "Bhavna Associate", "associate", NOW, NOW);
  const employee = sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)");
  employee.run("EMP-A", ASHA, "PS-A", "Asha Associate", ASHA, NOW, NOW, NOW);
  employee.run("EMP-B", BHAVNA, "PS-B", "Bhavna Associate", BHAVNA, NOW, NOW, NOW);
  return { db, sqlite };
}

// -------------------------------------------------------------------------------------------------
// 1. Gate 2 really owns VERSIONED shift, attendance, adjustment and leave truth
// -------------------------------------------------------------------------------------------------

test("Gate 2 creates and uses versioned shift, attendance, adjustment and leave tables", async () => {
  const { db, sqlite } = await engineWorld();
  const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const table of ["shift_policies", "employee_shift_assignments", "attendance_events", "attendance_days",
    "attendance_adjustment_requests", "leave_policies", "employee_leave_balances", "leave_requests",
    "leave_ledger_events", "people_period_locks"]) {
    assert.ok(tables.has(table), `missing ${table}`);
  }

  // Versioning is behaviour, not a column: saving the same policy name twice publishes v1 then v2, and
  // a new assignment supersedes the old one instead of overwriting it.
  const first = await engine.saveShiftPolicy(db, { name: "General shift", timezone: "Asia/Kolkata", startTime: "09:30", endTime: "18:30", weeklyOff: ["sun"], effectiveFrom: Date.UTC(2026, 3, 1), actorId: MANAGER });
  const second = await engine.saveShiftPolicy(db, { name: "General shift", timezone: "Asia/Kolkata", startTime: "10:00", endTime: "19:00", weeklyOff: ["sun"], effectiveFrom: Date.UTC(2026, 6, 1), actorId: MANAGER });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(count(sqlite, "shift_policies"), 2, "a new version must never overwrite the one payroll already ran against");

  await engine.assignShift(db, { employeeId: "EMP-A", shiftPolicyId: first.id, effectiveFrom: Date.UTC(2026, 3, 1), reason: "joined the general shift", actorId: MANAGER });
  await engine.assignShift(db, { employeeId: "EMP-A", shiftPolicyId: second.id, effectiveFrom: Date.UTC(2026, 6, 1), reason: "moved to the later shift", actorId: MANAGER });
  const open = sqlite.prepare("SELECT shift_policy_id FROM employee_shift_assignments WHERE employee_id='EMP-A' AND effective_until IS NULL").all();
  assert.equal(open.length, 1, "exactly one assignment may be open at a time");
  assert.equal(open[0].shift_policy_id, second.id);
  assert.equal(Number(one(sqlite, "SELECT effective_until u FROM employee_shift_assignments WHERE shift_policy_id=?", first.id).u), Date.UTC(2026, 6, 1) - 1,
    "the superseded assignment must close the instant before the new one opens");
});

// -------------------------------------------------------------------------------------------------
// 2. Replay is idempotent, and a missing check-out is an exception rather than invented hours
// -------------------------------------------------------------------------------------------------

test("attendance replay is idempotent: the same idempotency key twice writes one event and one day", async () => {
  const { db, sqlite } = await engineWorld();
  const first = await engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_in", occurredAt: IN, idempotencyKey: "asha:2026-09-14:in", actorId: ASHA });
  assert.equal(first.duplicatePrevented, false);
  const replay = await engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_in", occurredAt: IN, idempotencyKey: "asha:2026-09-14:in", actorId: ASHA });
  assert.equal(replay.duplicatePrevented, true, "a replayed event must be recognised, not inserted again");
  assert.equal(replay.eventId, first.eventId, "the replay must resolve to the original event");
  assert.equal(count(sqlite, "attendance_events"), 1);
  assert.equal(count(sqlite, "attendance_days"), 1);

  // A genuinely new event on the same day updates that one day row rather than creating a second.
  await engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_out", occurredAt: OUT, idempotencyKey: "asha:2026-09-14:out", actorId: ASHA });
  assert.equal(count(sqlite, "attendance_events"), 2);
  assert.equal(count(sqlite, "attendance_days"), 1, "one employee, one work date, one row");
});

test("a missing check-out records an exception and NO hours - the engine never invents the end of a day", async () => {
  const { db, sqlite } = await engineWorld();
  const checkedIn = await engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_in", occurredAt: IN, idempotencyKey: "asha:in", actorId: ASHA });
  assert.equal(checkedIn.exception, "missing_checkout");
  const open = one(sqlite, "SELECT first_check_in,last_check_out,worked_minutes,exception_code FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'");
  assert.equal(Number(open.first_check_in), IN);
  assert.equal(open.last_check_out, null);
  assert.equal(open.worked_minutes, null, "worked_minutes must stay NULL - a fabricated 8h would be indistinguishable to payroll");
  assert.equal(open.exception_code, "missing_checkout");

  // Close the day and the hours become the REAL difference, to the minute.
  const closed = await engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_out", occurredAt: OUT, idempotencyKey: "asha:out", actorId: ASHA });
  assert.equal(closed.exception, null);
  const done = one(sqlite, "SELECT last_check_out,worked_minutes,exception_code FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'");
  assert.equal(Number(done.last_check_out), OUT);
  assert.equal(Number(done.worked_minutes), 510, "09:00 to 17:30 is 510 minutes");
  assert.equal(done.exception_code, null);
});

// -------------------------------------------------------------------------------------------------
// 3. A locked payroll period blocks the silent mutation; the adjustment workflow is the way through
// -------------------------------------------------------------------------------------------------

test("a locked payroll period refuses attendance writes, and the adjustment workflow still corrects the day", async () => {
  const { db, sqlite } = await engineWorld();
  await engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_in", occurredAt: IN, idempotencyKey: "asha:in", actorId: ASHA });
  await engine.setPeriodLock(db, { periodStart: Date.UTC(2026, 8, 1), periodEnd: Date.UTC(2026, 8, 30, 23, 59, 59), status: "locked", actorId: MANAGER });

  const before = count(sqlite, "attendance_events");
  await assert.rejects(
    () => engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_out", occurredAt: OUT, idempotencyKey: "asha:out", actorId: ASHA }),
    /Payroll period is locked; use an attendance adjustment workflow/,
  );
  assert.equal(count(sqlite, "attendance_events"), before, "a refused write must leave no event behind");
  assert.equal(one(sqlite, "SELECT worked_minutes w FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'").w, null);

  const request = await engine.requestAdjustment(db, {
    employeeId: "EMP-A", workDate: "2026-09-14", requestedStatus: "present",
    requestedCheckIn: IN, requestedCheckOut: OUT, reason: "forgot to check out before leaving site", actorId: ASHA,
  });
  assert.equal(request.status, "pending");
  assert.equal(one(sqlite, "SELECT worked_minutes w FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'").w, null,
    "a pending adjustment must not change attendance by itself");

  await engine.approveAdjustment(db, { requestId: request.id, actorId: MANAGER });
  const corrected = one(sqlite, "SELECT status,first_check_in,last_check_out,worked_minutes,exception_code FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'");
  assert.equal(corrected.status, "present");
  assert.equal(Number(corrected.first_check_in), IN);
  assert.equal(Number(corrected.last_check_out), OUT);
  assert.equal(Number(corrected.worked_minutes), 510);
  assert.equal(corrected.exception_code, null);
  assert.equal(one(sqlite, "SELECT approved_by a FROM attendance_adjustment_requests WHERE id=?", request.id).a, MANAGER,
    "the correction carries an approver; the silent mutation it replaced carried nobody");

  // An adjustment still needs a reason, and an already-decided one cannot be approved twice.
  await assert.rejects(() => engine.requestAdjustment(db, { employeeId: "EMP-A", workDate: "2026-09-14", reason: "typo", actorId: ASHA }), /Attendance adjustment reason is required/);
  await assert.rejects(() => engine.approveAdjustment(db, { requestId: request.id, actorId: MANAGER }), /Pending attendance adjustment not found/);
});

// -------------------------------------------------------------------------------------------------
// 4. Leave is configuration-driven: flip allow_negative and the refusal appears and disappears
// -------------------------------------------------------------------------------------------------

test("leave refuses until a policy exists, and allow_negative alone decides whether the balance may go under", async () => {
  const { db, sqlite } = await engineWorld();
  const request = (units) => ({ employeeId: "EMP-A", leaveCode: "CL", startDate: "2026-09-21", endDate: "2026-09-23", units, reason: "family function", actorId: ASHA });

  // No configuration -> refused, and nothing written.
  await assert.rejects(() => engine.requestLeave(db, request(3)), /Active leave policy configuration is required/);
  assert.equal(count(sqlite, "leave_requests"), 0);

  // A strict policy with a real entitlement.
  await engine.saveLeavePolicy(db, { name: "Casual leave", leaveCode: "CL", allowNegative: false, entitlementUnits: 4, effectiveFrom: Date.UTC(2026, 3, 1), actorId: MANAGER });
  await engine.grantLeaveEntitlement(db, { employeeId: "EMP-A", leaveCode: "CL", reason: "annual entitlement", actorId: MANAGER });
  assert.equal(balance(sqlite, "EMP-A", "CL"), 4);

  // Within the balance: accepted, then approved, and the balance moves by exactly the days taken.
  const within = await engine.requestLeave(db, request(3));
  await engine.decideLeave(db, { requestId: within.id, decision: "approved", reason: "cover arranged", actorId: MANAGER });
  assert.equal(balance(sqlite, "EMP-A", "CL"), 1);

  // Beyond it: refused, purely because allow_negative is 0.
  await assert.rejects(() => engine.requestLeave(db, request(3)), /Insufficient leave balance/);
  assert.equal(count(sqlite, "leave_requests"), 1, "the refused request must not be recorded");

  // Change ONLY the configuration - same code, same balance, same request - and the refusal goes away.
  await engine.saveLeavePolicy(db, { name: "Casual leave", leaveCode: "CL", allowNegative: true, entitlementUnits: 4, effectiveFrom: Date.UTC(2026, 6, 1), actorId: MANAGER });
  const overdrawn = await engine.requestLeave(db, request(3));
  await engine.decideLeave(db, { requestId: overdrawn.id, decision: "approved", reason: "unpaid overflow agreed", actorId: MANAGER });
  assert.equal(balance(sqlite, "EMP-A", "CL"), -2, "1 remaining - 3 taken must be -2 once the policy permits it");

  // And back again: a third version that forbids negatives refuses the next approval on the same rule.
  await engine.saveLeavePolicy(db, { name: "Casual leave", leaveCode: "CL", allowNegative: false, entitlementUnits: 4, effectiveFrom: Date.UTC(2026, 9, 1), actorId: MANAGER });
  sqlite.prepare("INSERT INTO leave_requests (id,employee_id,leave_code,start_date,end_date,units,reason,status,requested_by,created_at) VALUES ('LVR-RAW','EMP-A','CL','2026-11-01','2026-11-01',1,'raised earlier','pending',?,?)").run(ASHA, NOW);
  await assert.rejects(() => engine.decideLeave(db, { requestId: "LVR-RAW", decision: "approved", reason: "no", actorId: MANAGER }), /Leave approval would create a negative balance/);
  assert.equal(balance(sqlite, "EMP-A", "CL"), -2, "a refused approval must not move the balance");

  // None of these numbers came from a built-in entitlement: with none configured, nothing can be granted.
  await engine.saveLeavePolicy(db, { name: "Sick leave", leaveCode: "SL", allowNegative: false, entitlementUnits: null, effectiveFrom: Date.UTC(2026, 3, 1), actorId: MANAGER });
  await assert.rejects(() => engine.grantLeaveEntitlement(db, { employeeId: "EMP-A", leaveCode: "SL", reason: "annual entitlement", actorId: MANAGER }), /Set entitlement units on the leave policy/);
});

test("every attendance and leave refusal reaches the caller as a governed 4xx, not a redacted 500", async () => {
  const { db } = await engineWorld();
  const surfaced = async (work) => {
    const thrown = await Promise.resolve().then(work).then(() => null, (error) => error);
    assert.ok(thrown instanceof Error, "the refusal must stay an Error so assert.rejects(/regex/) can pin it");
    const response = authError(thrown, "Attendance/leave update failed");
    return { status: response.status, error: (await response.json()).error };
  };
  const unconfigured = await surfaced(() => engine.requestLeave(db, { employeeId: "EMP-A", leaveCode: "CL", startDate: "2026-09-21", endDate: "2026-09-23", units: 3, reason: "family function", actorId: ASHA }));
  assert.equal(unconfigured.status, 409);
  assert.equal(unconfigured.error, "Active leave policy configuration is required");
  const badPeriod = await surfaced(() => engine.setPeriodLock(db, { periodStart: Date.UTC(2026, 8, 30), periodEnd: Date.UTC(2026, 8, 1), status: "locked", actorId: MANAGER }));
  assert.equal(badPeriod.status, 400);
  assert.equal(badPeriod.error, "A valid payroll period start and end are required");
  // Control: a genuine platform fault is still redacted to a 500.
  const fault = authError(new TypeError("db handle is undefined"), "Attendance/leave update failed");
  assert.equal(fault.status, 500);
  assert.equal((await fault.json()).error, "Attendance/leave update failed");
});

// -------------------------------------------------------------------------------------------------
// 5. The People RBAC catalogue, and system-role propagation into an initialized D1
// -------------------------------------------------------------------------------------------------

test("People RBAC defines attendance, leave, compensation, payroll, incentive and performance permissions", () => {
  const catalogue = new Set(permissionCatalog);
  for (const permission of ["attendance.view", "attendance.manage", "leave.view", "leave.manage", "compensation.view",
    "compensation.manage", "payroll.view", "payroll.manage", "payroll.approve", "incentives.view", "incentives.manage",
    "performance.view", "performance.manage"]) {
    assert.ok(catalogue.has(permission), `missing ${permission}`);
  }
  // A catalogue entry only matters if a role holds it. These are the grants the attendance route gates on.
  const role = (code) => parsePermissions(defaultRoles.find((r) => r.code === code).permissions);
  assert.ok(role("manager").includes("attendance.manage") && role("manager").includes("leave.manage"));
  assert.ok(role("associate").includes("attendance.view") && role("associate").includes("leave.view"));
  assert.ok(!role("associate").includes("attendance.manage") && !role("associate").includes("leave.manage"),
    "an associate must not be able to decide their own leave");
});

test("a system role's permissions re-propagate into an initialized D1; a custom role's are left alone", async () => {
  const { db, sqlite } = freshCountingD1();
  await ensureSecurityTables(db);
  const stored = () => parsePermissions(one(sqlite, "SELECT permissions_json p FROM role_definitions WHERE code='manager'").p);
  assert.ok(stored().includes("leave.manage"));

  // A stale deployment: the row in D1 predates the grant being added to the platform definition.
  sqlite.prepare("UPDATE role_definitions SET permissions_json=? WHERE code='manager'").run(JSON.stringify(["dashboard.view"]));
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('city_lead','City lead','Custom role',?,0,?)")
    .run(JSON.stringify(["dashboard.view"]), NOW);
  assert.deepEqual(stored(), ["dashboard.view"]);

  // A second D1 handle over the same database, because ensureSecurityTables memoises per handle.
  await ensureSecurityTables(makeCountingD1(sqlite).db);
  assert.ok(stored().includes("leave.manage"), "a system role must be restored to the platform definition on initialization");
  assert.deepEqual(parsePermissions(one(sqlite, "SELECT permissions_json p FROM role_definitions WHERE code='city_lead'").p), ["dashboard.view"],
    "a custom role must NOT be overwritten by the same upsert");
});

// -------------------------------------------------------------------------------------------------
// 6. The route: employee self-scope and manager permissions, executed
// -------------------------------------------------------------------------------------------------

test("the attendance route enforces employee self-scope and manager permissions", async () => {
  const { sqlite } = await routeWorld();
  await post(MANAGER, { action: "save_leave_policy", name: "Casual leave", leaveCode: "CL", allowNegative: true, entitlementUnits: 5, effectiveFrom: Date.UTC(2026, 3, 1) });
  await post(ASHA, { action: "check_in", employeeId: "EMP-A", occurredAt: NOW, idempotencyKey: "asha:in" });
  await post(BHAVNA, { action: "check_in", employeeId: "EMP-B", occurredAt: NOW, idempotencyKey: "bhavna:in" });

  // READ scope.
  const asha = await answer(await get(ASHA));
  assert.equal(asha.status, 200);
  assert.equal(asha.body.data.scope.mode, "self");
  assert.deepEqual([...new Set(asha.body.data.attendanceDays.map((r) => r.employee_id))], ["EMP-A"]);
  const manager = await answer(await get(MANAGER));
  assert.equal(manager.body.data.scope.mode, "manager");
  assert.equal(manager.body.data.attendanceDays.length, 2, "a manager sees the team a manager has to decide for");

  // MUTATION scope, with a readable reason rather than the route's generic catch-block fallback.
  const cross = await answer(await post(ASHA, { action: "check_in", employeeId: "EMP-B", occurredAt: NOW, idempotencyKey: "asha-as-bhavna" }));
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error, "Employee self-service scope denied");
  assert.equal(count(sqlite, "attendance_events"), 2, "the cross-employee write must not have happened");

  // Manager-only actions are gated on the permission, not on a screen hiding the button.
  const escalation = await answer(await post(ASHA, { action: "decide_leave", requestId: "LVR-ANY", decision: "approved", reason: "mine" }));
  assert.equal(escalation.status, 403);
  assert.equal(escalation.body.error, "Permission denied");

  // And the trail records the ones that did happen.
  assert.ok(Number(sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='leave.save_policy'").get().c) >= 1);
  assert.ok(Number(sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='attendance.check_in'").get().c) >= 2);
});

// -------------------------------------------------------------------------------------------------
// 7. No hard-coded grace, entitlement, overtime or GPS policy
// -------------------------------------------------------------------------------------------------

test("attendance and leave hard-code no grace, entitlement, overtime or GPS policy", async () => {
  const { db } = await engineWorld();
  const directory = await engine.attendanceLeaveDirectory(db);
  assert.deepEqual(directory.truth, {
    hardcodedGraceMinutes: false, hardcodedLeaveEntitlement: false, hardcodedOvertimeRate: false,
    gpsRequired: false, productionReady: false,
  });
  // The claim is only worth something if it is true of behaviour: with nothing configured, the engine
  // offers no leave code, no entitlement and no shift of its own.
  assert.deepEqual(directory.leavePolicies, []);
  assert.deepEqual(directory.leaveBalances, []);
  assert.deepEqual(directory.shiftPolicies, []);
  await assert.rejects(
    () => engine.requestLeave(db, { employeeId: "EMP-A", leaveCode: "CL", startDate: "2026-09-21", endDate: "2026-09-21", units: 1, reason: "family function", actorId: ASHA }),
    /Active leave policy configuration is required/,
    "with no configuration the engine must refuse, not fall back to a built-in entitlement",
  );
  // recordAttendance accepts no location and stores none: GPS is not a hidden requirement.
  const recorded = await engine.recordAttendance(db, { employeeId: "EMP-A", eventType: "check_in", occurredAt: IN, idempotencyKey: "asha:in", actorId: ASHA });
  assert.equal(recorded.duplicatePrevented, false);

  const html = renderToStaticMarkup(React.createElement(screen.TimeAndLeaveScreen, {
    data: null, busy: false, loading: false, error: "", message: "", onPost: async () => {}, onRefresh: () => {},
  }));
  assert.match(html, /<b>GPS required by code:<\/b> NO/);
  assert.match(html, /<b>Hard-coded leave\/grace\/OT policy:<\/b> NO/);
  assert.match(html, /<b>Production ready:<\/b> NO/);
});
