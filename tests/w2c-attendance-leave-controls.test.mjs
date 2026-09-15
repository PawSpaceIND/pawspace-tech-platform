/**
 * Time & leave, end to end: the request an employee makes, the decision a manager takes, the number
 * the balance lands on, and the only route through a locked payroll period.
 *
 * WHAT WAS BROKEN. `app/api/attendance-leave/route.ts` exposes nine actions. SEVEN of them were posted
 * by no .tsx file anywhere in the repository: request_leave, request_adjustment, approve_adjustment,
 * save_shift_policy, assign_shift, save_leave_policy and decide_leave. (A cross-app inventory credited
 * approve_adjustment to /team/people/incentives; that screen posts an identically-named INCENTIVE
 * action to a different route.) Four consequences, each proved below against the REAL handlers:
 *
 *   1. Nobody could publish a leave policy, and lib/attendance-leave.ts refuses every leave request
 *      with "Active leave policy configuration is required" until one exists - so the apply-for-leave
 *      form that /me does draw could only ever fail. [test: the lifecycle, first assertion]
 *   2. `leave_policies.entitlement_units` was written by saveLeavePolicy and READ BY NOTHING, and
 *      `employee_leave_balances` was only ever DEBITED. Every balance in the product was therefore 0
 *      and every request under a policy without allow_negative was refused for insufficient balance -
 *      the entitlement an operator typed in could not become a day off. grantLeaveEntitlement() is the
 *      missing credit half; the ledger's 'credit' event_type had been declared and never written.
 *   3. Nobody could DECIDE a request, so anything requested sat pending forever.
 *   4. `people_period_locks` was created and read (isLocked) and WRITTEN BY NO CODE PATH AT ALL, so
 *      the locked-period refusal could never fire and the adjustment workflow that is its documented
 *      remedy guarded a door nothing could shut. setPeriodLock() closes it.
 *
 * Everything here executes: the real GET/POST with a real Request against a real SQLite-backed D1,
 * real role definitions seeded from lib/platform-security.ts, and the shipped screen components
 * rendered with react-dom/server. Every request is posted to a NON-preview host, so the actor is the
 * genuine `manager`/`associate` role rather than the development-preview superuser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__W2C_TIME_DB__", "__W2C_TIME_ENV__");

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const route = await import("../app/api/attendance-leave/route.ts");
const screen = await import("../app/team/people/time/page.tsx");
const meRoute = await import("../app/api/me/route.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { ensurePeopleTables } = await import("../lib/people-foundation.ts");

const API = "https://uat.pawspace.in/api/attendance-leave";
const MANAGER = "meera.manager@pawspace.test";
const ASHA = "asha@pawspace.test";
const BHAVNA = "bhavna@pawspace.test";
const NOW = Date.UTC(2026, 8, 15, 6, 0, 0);
const EFFECTIVE = Date.UTC(2026, 3, 1);

const post = (email, body) => route.POST(new Request(API, {
  method: "POST",
  headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
  body: JSON.stringify(body),
}));
const get = (email) => route.GET(new Request(API, { headers: { "oai-authenticated-user-email": email } }));
const read = async (response) => ({ status: response.status, body: await response.json() });
const balance = (sqlite, employeeId, leaveCode) => {
  const row = sqlite.prepare("SELECT balance FROM employee_leave_balances WHERE employee_id=? AND leave_code=?").get(employeeId, leaveCode);
  return row === undefined ? null : Number(row.balance);
};
const count = (sqlite, table) => Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c);

/**
 * One manager (attendance.manage + leave.manage) and two associates (attendance.view + leave.view,
 * self-scope only), each linked to an active employee record - which is what the route's self-scope
 * check resolves an actor through.
 */
async function world() {
  const { db, sqlite } = freshCountingD1();
  globalThis.__W2C_TIME_DB__ = db;
  globalThis.__W2C_TIME_ENV__ = {};
  enterWorkersDbScope(db);
  await ensureSecurityTables(db);
  await ensurePeopleTables(db);
  const user = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  user.run("U-MGR", MANAGER, "Meera Manager", "manager", NOW, NOW);
  user.run("U-ASHA", ASHA, "Asha Associate", "associate", NOW, NOW);
  user.run("U-BHAVNA", BHAVNA, "Bhavna Associate", "associate", NOW, NOW);
  const employee = sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)");
  employee.run("EMP-MGR", MANAGER, "PS-MGR", "Meera Manager", MANAGER, NOW, NOW, NOW);
  employee.run("EMP-A", ASHA, "PS-A", "Asha Associate", ASHA, NOW, NOW, NOW);
  employee.run("EMP-B", BHAVNA, "PS-B", "Bhavna Associate", BHAVNA, NOW, NOW, NOW);
  return { db, sqlite };
}

const leaveDraft = (over = {}) => ({ leaveCode: "CL", startDate: "2026-09-21", endDate: "2026-09-23", units: "3", reason: "family function", ...over });

// =================================================================================================
// 1. The lifecycle, with the numbers asserted at every step
// =================================================================================================

test("leave lifecycle: policy -> entitlement -> request -> decision, and the balance lands on the right day count", async () => {
  const { sqlite } = await world();

  // (1) No policy exists. This is the state the product actually shipped in, and it is what the
  //     apply-for-leave form on /me hit every single time.
  const unconfigured = await read(await post(ASHA, { ...screen.leaveRequestBody("EMP-A", leaveDraft()) }));
  assert.equal(unconfigured.status, 409, "an unconfigured leave code must refuse with a client error, not a 500");
  assert.match(unconfigured.body.error, /Active leave policy configuration is required/);
  assert.equal(count(sqlite, "leave_requests"), 0, "a refused request must not leave a row behind");

  // (2) The manager publishes the policy - the control that existed on no screen.
  const policy = await read(await post(MANAGER, screen.leavePolicyBody({
    name: "Casual leave", leaveCode: "CL", allowNegative: false, entitlementUnits: "12", effectiveFrom: "2026-04-01",
  })));
  assert.equal(policy.status, 200);
  assert.equal(policy.body.data.version, 1);
  assert.equal(sqlite.prepare("SELECT entitlement_units u FROM leave_policies WHERE id=?").get(policy.body.data.id).u, 12);

  // (3) A policy alone is still not a day off: the balance is 0 until entitlement is granted.
  const noBalance = await read(await post(ASHA, screen.leaveRequestBody("EMP-A", leaveDraft())));
  assert.equal(noBalance.status, 422);
  assert.match(noBalance.body.error, /Insufficient leave balance/);

  // (4) Grant with NO units typed - the policy's own entitlement is what gets credited.
  const granted = await read(await post(MANAGER, screen.grantEntitlementBody({ employeeId: "EMP-A", leaveCode: "CL", units: "", reason: "annual entitlement" })));
  assert.equal(granted.status, 200);
  assert.equal(granted.body.data.granted, 12);
  assert.equal(granted.body.data.balance, 12);
  assert.equal(balance(sqlite, "EMP-A", "CL"), 12);

  // A double-click credits once. The ledger's UNIQUE idempotency_key is the guard, not the button.
  const again = await read(await post(MANAGER, screen.grantEntitlementBody({ employeeId: "EMP-A", leaveCode: "CL", units: "", reason: "annual entitlement" })));
  assert.equal(again.body.data.duplicatePrevented, true);
  assert.equal(again.body.data.granted, 0);
  assert.equal(balance(sqlite, "EMP-A", "CL"), 12, "a replayed grant must not credit a second entitlement");
  assert.equal(count(sqlite, "leave_ledger_events"), 1);

  // (5) The employee requests three days. A REQUEST must not move the balance; only a decision does.
  const requested = await read(await post(ASHA, screen.leaveRequestBody("EMP-A", leaveDraft())));
  assert.equal(requested.status, 200);
  assert.equal(requested.body.data.status, "pending");
  assert.equal(balance(sqlite, "EMP-A", "CL"), 12, "a pending request must not debit anything");

  // (6) The manager decides. The balance moves by exactly the requested day count.
  const decided = await read(await post(MANAGER, screen.leaveDecisionBody(requested.body.data.id, "approved", "cover arranged")));
  assert.equal(decided.status, 200);
  assert.equal(decided.body.data.status, "approved");
  assert.equal(balance(sqlite, "EMP-A", "CL"), 9, "12 entitled - 3 approved must be 9");
  const debit = sqlite.prepare("SELECT units,event_type FROM leave_ledger_events WHERE source_request_id=?").get(requested.body.data.id);
  assert.equal(debit.event_type, "debit");
  assert.equal(Number(debit.units), -3);
  assert.equal(sqlite.prepare("SELECT status,approved_by FROM leave_requests WHERE id=?").get(requested.body.data.id).approved_by, MANAGER);

  // (7) A rejection closes the request and moves nothing.
  const second = await read(await post(ASHA, screen.leaveRequestBody("EMP-A", leaveDraft({ units: "1", startDate: "2026-09-28", endDate: "2026-09-28" }))));
  const rejected = await read(await post(MANAGER, screen.leaveDecisionBody(second.body.data.id, "rejected", "peak week")));
  assert.equal(rejected.body.data.status, "rejected");
  assert.equal(balance(sqlite, "EMP-A", "CL"), 9, "a rejection must not debit the balance");
});

test("a negative balance is refused, and allowed only when the policy version in force says so", async () => {
  const { sqlite } = await world();
  await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: false, entitlementUnits: "2", effectiveFrom: "2026-04-01" }));
  await post(MANAGER, screen.grantEntitlementBody({ employeeId: "EMP-A", leaveCode: "CL", units: "", reason: "annual entitlement" }));
  assert.equal(balance(sqlite, "EMP-A", "CL"), 2);

  // Requesting more than the balance is refused at REQUEST time under a no-negative policy.
  const overdrawn = await read(await post(ASHA, screen.leaveRequestBody("EMP-A", leaveDraft({ units: "5", endDate: "2026-09-25" }))));
  assert.equal(overdrawn.status, 422);
  assert.match(overdrawn.body.error, /Insufficient leave balance/);
  assert.equal(count(sqlite, "leave_requests"), 0);

  // A second policy VERSION that permits a negative balance. Same code, later effective date.
  const v2 = await read(await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: true, entitlementUnits: "2", effectiveFrom: "2026-06-01" })));
  assert.equal(v2.body.data.version, 2, "saving the same policy name publishes the next version");

  const allowed = await read(await post(ASHA, screen.leaveRequestBody("EMP-A", leaveDraft({ units: "5", endDate: "2026-09-25" }))));
  assert.equal(allowed.status, 200, "the same request the previous version refused is accepted under the new one");
  const approved = await read(await post(MANAGER, screen.leaveDecisionBody(allowed.body.data.id, "approved", "unpaid overflow agreed")));
  assert.equal(approved.status, 200);
  assert.equal(balance(sqlite, "EMP-A", "CL"), -3, "2 entitled - 5 approved must be -3 when the policy allows it");

  // And the approval-time guard is the same configuration, not a second opinion: publish a third
  // version that forbids negatives and the next approval is refused with its own reason.
  await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: false, entitlementUnits: "2", effectiveFrom: "2026-07-01" }));
  sqlite.prepare("INSERT INTO leave_requests (id,employee_id,leave_code,start_date,end_date,units,reason,status,requested_by,created_at) VALUES ('LVR-RAW','EMP-A','CL','2026-10-01','2026-10-02',2,'raised before the policy changed','pending',?,?)").run(ASHA, NOW);
  const refusedApproval = await read(await post(MANAGER, screen.leaveDecisionBody("LVR-RAW", "approved", "no")));
  assert.equal(refusedApproval.status, 422);
  assert.match(refusedApproval.body.error, /Leave approval would create a negative balance/);
  assert.equal(balance(sqlite, "EMP-A", "CL"), -3, "a refused approval must not move the balance");
});

test("two policy versions published on the same effective date resolve to the newer one", async () => {
  // saveLeavePolicy only bumps `version`, so "fix the allow_negative flag we shipped this morning"
  // produces two rows with the SAME effective_from. requestLeave and decideLeave each carried their own
  // copy of the lookup ordered by effective_from alone, which leaves the winner up to the database -
  // and lets the request-time rule and the approval-time rule disagree about the same request.
  const { sqlite } = await world();
  const same = "2026-04-01";
  await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: false, entitlementUnits: "2", effectiveFrom: same }));
  const v2 = await read(await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: true, entitlementUnits: "2", effectiveFrom: same })));
  assert.equal(v2.body.data.version, 2);
  await post(MANAGER, screen.grantEntitlementBody({ employeeId: "EMP-A", leaveCode: "CL", units: "2", reason: "annual entitlement" }));

  const overdrawn = await read(await post(ASHA, screen.leaveRequestBody("EMP-A", leaveDraft({ units: "5", endDate: "2026-09-25" }))));
  assert.equal(overdrawn.status, 200, "version 2 permits the negative balance, so version 2 is what must be in force");
  const approved = await read(await post(MANAGER, screen.leaveDecisionBody(overdrawn.body.data.id, "approved", "unpaid overflow agreed")));
  assert.equal(approved.status, 200, "the approval must read the same version the request was judged against");
  assert.equal(balance(sqlite, "EMP-A", "CL"), -3);
});

test("maker/checker: the person who raised a leave request cannot approve it", async () => {
  const { sqlite } = await world();
  await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: true, entitlementUnits: "5", effectiveFrom: "2026-04-01" }));
  await post(MANAGER, screen.grantEntitlementBody({ employeeId: "EMP-MGR", leaveCode: "CL", units: "", reason: "annual entitlement" }));
  const own = await read(await post(MANAGER, screen.leaveRequestBody("EMP-MGR", leaveDraft({ units: "1", endDate: "2026-09-21" }))));
  assert.equal(own.status, 200);
  const selfApproval = await read(await post(MANAGER, screen.leaveDecisionBody(own.body.data.id, "approved", "mine")));
  assert.equal(selfApproval.status, 409);
  assert.match(selfApproval.body.error, /requester cannot approve their own leave request/);
  assert.equal(balance(sqlite, "EMP-MGR", "CL"), 5, "a refused self-approval must not debit anything");
});

// =================================================================================================
// 2. The locked payroll period, and the adjustment workflow that is the way through it
// =================================================================================================

test("a locked payroll period refuses the silent mutation and the adjustment workflow applies the correction", async () => {
  const { sqlite } = await world();
  const IN = Date.UTC(2026, 8, 14, 9, 0);   // 09:00 UTC
  const OUT = Date.UTC(2026, 8, 14, 17, 30); // 17:30 UTC -> 510 minutes

  // The period is open, so a check-in lands and a MISSING checkout becomes an exception - the engine
  // does not invent an end to the day.
  const open = await read(await post(ASHA, { action: "check_in", employeeId: "EMP-A", occurredAt: IN, idempotencyKey: "asha:2026-09-14:in" }));
  assert.equal(open.status, 200);
  assert.equal(open.body.data.exception, "missing_checkout");
  const beforeLock = sqlite.prepare("SELECT worked_minutes,exception_code FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'").get();
  assert.equal(beforeLock.worked_minutes, null, "hours must never be fabricated from a check-in alone");
  assert.equal(beforeLock.exception_code, "missing_checkout");

  // The manager locks the payroll period. Before this change nothing in the product could write this
  // row, so this refusal was unreachable.
  const lock = await read(await post(MANAGER, screen.periodLockBody({ periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "locked" })));
  assert.equal(lock.status, 200);
  assert.equal(lock.body.data.status, "locked");

  // The direct mutation is now refused - with a reason the operator can read, and the remedy named.
  const eventsBefore = count(sqlite, "attendance_events");
  const blocked = await read(await post(ASHA, { action: "check_out", employeeId: "EMP-A", occurredAt: OUT, idempotencyKey: "asha:2026-09-14:out" }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Payroll period is locked; use an attendance adjustment workflow/);
  assert.equal(count(sqlite, "attendance_events"), eventsBefore, "a refused check-out must not write an event");
  assert.equal(sqlite.prepare("SELECT worked_minutes FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'").get().worked_minutes, null);

  // The way through: the employee requests the correction from the screen...
  const requested = await read(await post(ASHA, screen.adjustmentRequestBody("EMP-A", {
    workDate: "2026-09-14", requestedStatus: "present",
    checkIn: new Date(IN).toISOString().slice(0, 16), checkOut: new Date(OUT).toISOString().slice(0, 16),
    reason: "forgot to check out before leaving site",
  })));
  assert.equal(requested.status, 200);
  assert.equal(requested.body.data.status, "pending");
  assert.equal(sqlite.prepare("SELECT worked_minutes FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'").get().worked_minutes, null,
    "a pending adjustment must not change attendance on its own");

  // ...and a manager holding attendance.manage approves it. THIS is the outcome that was impossible.
  const approved = await read(await post(MANAGER, screen.adjustmentApprovalBody(requested.body.data.id)));
  assert.equal(approved.status, 200);
  const corrected = sqlite.prepare("SELECT status,first_check_in,last_check_out,worked_minutes,exception_code FROM attendance_days WHERE employee_id='EMP-A' AND work_date='2026-09-14'").get();
  assert.equal(corrected.status, "present");
  assert.equal(Number(corrected.first_check_in), IN);
  assert.equal(Number(corrected.last_check_out), OUT);
  assert.equal(Number(corrected.worked_minutes), 510, "09:00 to 17:30 is 510 minutes");
  assert.equal(corrected.exception_code, null, "the approved correction clears the exception it was raised for");
  const trail = sqlite.prepare("SELECT status,approved_by FROM attendance_adjustment_requests WHERE id=?").get(requested.body.data.id);
  assert.equal(trail.status, "approved");
  assert.equal(trail.approved_by, MANAGER, "the correction carries the approver, which the silent mutation never did");

  // Unlocking is the same control, and check-in works again afterwards.
  await post(MANAGER, screen.periodLockBody({ periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "open" }));
  const reopened = await read(await post(ASHA, { action: "check_in", employeeId: "EMP-A", occurredAt: Date.UTC(2026, 8, 16, 9, 0), idempotencyKey: "asha:2026-09-16:in" }));
  assert.equal(reopened.status, 200);
});

// =================================================================================================
// 2b. The screen this unblocks somewhere else
// =================================================================================================

test("the apply-for-leave form already shipped on /me goes from always-failing to working", async () => {
  // /me HAS had an apply-for-leave form all along. It calls lib/employee-self-service.ts, which calls
  // the same requestLeave() - so with no screen able to publish a policy or grant entitlement, that
  // button could only ever return "Active leave policy configuration is required". Nothing on /me is
  // changed here; the two controls that were missing elsewhere are what make it work.
  const { sqlite } = await world();
  const mePost = (email, body) => meRoute.POST(new Request("https://uat.pawspace.in/api/me", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email, origin: "https://uat.pawspace.in", host: "uat.pawspace.in" },
    body: JSON.stringify(body),
  }));
  const meView = async (email) => (await (await meRoute.GET(new Request("https://uat.pawspace.in/api/me", { headers: { "oai-authenticated-user-email": email } }))).json()).data;
  const apply = { action: "apply_leave", leaveCode: "CL", startDate: "2026-09-21", endDate: "2026-09-23", units: 3, reason: "family function" };

  const before = await read(await mePost(ASHA, apply));
  assert.equal(before.status, 409);
  assert.match(before.body.error, /Active leave policy configuration is required/);

  await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: false, entitlementUnits: "12", effectiveFrom: "2026-04-01" }));
  await post(MANAGER, screen.grantEntitlementBody({ employeeId: "EMP-A", leaveCode: "CL", units: "", reason: "annual entitlement" }));

  const after = await read(await mePost(ASHA, apply));
  assert.equal(after.status, 200, "the same button, the same payload, now accepted");
  const pending = await meView(ASHA);
  assert.deepEqual(pending.leave.balances, [{ leaveCode: "CL", balance: 12 }], "/me's Balances panel had nothing to show before, because nothing could credit one");
  assert.equal(pending.leave.requests[0].status, "pending");

  const requestId = sqlite.prepare("SELECT id FROM leave_requests LIMIT 1").get().id;
  assert.equal((await read(await post(MANAGER, screen.leaveDecisionBody(requestId, "approved", "cover arranged")))).status, 200);
  const decided = await meView(ASHA);
  assert.deepEqual(decided.leave.balances, [{ leaveCode: "CL", balance: 9 }]);
  assert.equal(decided.leave.requests[0].status, "approved", "the employee finally sees a decision on their own request");
});

// =================================================================================================
// 3. The permission split the screen is drawn from
// =================================================================================================

test("employee self-scope: an associate cannot read or mutate another employee's attendance, and reads why", async () => {
  const { sqlite } = await world();
  await post(MANAGER, screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: true, entitlementUnits: "5", effectiveFrom: "2026-04-01" }));
  await post(ASHA, { action: "check_in", employeeId: "EMP-A", occurredAt: NOW, idempotencyKey: "asha:in" });
  await post(BHAVNA, { action: "check_in", employeeId: "EMP-B", occurredAt: NOW, idempotencyKey: "bhavna:in" });
  await post(ASHA, screen.leaveRequestBody("EMP-A", leaveDraft({ units: "1", endDate: "2026-09-21" })));
  await post(BHAVNA, screen.leaveRequestBody("EMP-B", leaveDraft({ units: "1", endDate: "2026-09-21" })));

  const mine = await read(await get(ASHA));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.scope.mode, "self");
  assert.equal(mine.body.data.scope.employeeId, "EMP-A");
  assert.equal(mine.body.data.scope.canManageLeave, false);
  assert.deepEqual([...new Set(mine.body.data.attendanceDays.map((r) => r.employee_id))], ["EMP-A"]);
  assert.deepEqual([...new Set(mine.body.data.leaveRequests.map((r) => r.employee_id))], ["EMP-A"]);
  assert.equal(mine.body.data.employees.length, 0, "an associate is never handed the roster");

  // The refusal must be READABLE. It used to be thrown as a bare Response, which lib/server-auth.ts
  // authError() distrusts - so it reached the operator as the route's generic catch-block fallback.
  const crossRead = await read(await post(ASHA, { action: "check_in", employeeId: "EMP-B", occurredAt: NOW, idempotencyKey: "asha-as-bhavna" }));
  assert.equal(crossRead.status, 403);
  assert.equal(crossRead.body.error, "Employee self-service scope denied");
  const crossLeave = await read(await post(ASHA, screen.leaveRequestBody("EMP-B", leaveDraft({ units: "1", endDate: "2026-09-21" }))));
  assert.equal(crossLeave.status, 403);
  assert.equal(crossLeave.body.error, "Employee self-service scope denied");
  assert.equal(count(sqlite, "leave_requests"), 2, "a scope refusal must not create a request for the other employee");

  const managerView = await read(await get(MANAGER));
  assert.equal(managerView.body.data.scope.mode, "manager");
  assert.equal(managerView.body.data.scope.canManageAttendance, true);
  assert.equal(managerView.body.data.scope.canManageLeave, true);
  assert.equal(managerView.body.data.leaveRequests.length, 2, "the queue a manager decides from holds the whole team");
  assert.ok(managerView.body.data.employees.some((e) => e.id === "EMP-A"));
});

test("an associate cannot reach a manager action, and is told it is a permission problem", async () => {
  await world();
  for (const body of [
    screen.leavePolicyBody({ name: "Casual leave", leaveCode: "CL", allowNegative: true, entitlementUnits: "5", effectiveFrom: "2026-04-01" }),
    screen.leaveDecisionBody("LVR-ANY", "approved", "x"),
    screen.grantEntitlementBody({ employeeId: "EMP-A", leaveCode: "CL", units: "5", reason: "self serve" }),
    screen.periodLockBody({ periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "locked" }),
    screen.shiftPolicyBody({ name: "General", timezone: "Asia/Kolkata", startTime: "", endTime: "", weeklyOff: "", locationRule: "not_required", effectiveFrom: "2026-04-01" }),
    screen.assignShiftBody({ employeeId: "EMP-A", shiftPolicyId: "SHP-X", effectiveFrom: "2026-04-01", reason: "moving to the general shift" }),
    screen.adjustmentApprovalBody("AAR-ANY"),
  ]) {
    const refused = await read(await post(ASHA, body));
    assert.equal(refused.status, 403, `${body.action} must be refused for an associate`);
    assert.equal(refused.body.error, "Permission denied", `${body.action} must say why`);
  }
});

// =================================================================================================
// 4. Shift configuration, which had no control either
// =================================================================================================

test("shift policy and assignment are reachable, versioned and reflected back to the screen", async () => {
  const { sqlite } = await world();
  const policy = await read(await post(MANAGER, screen.shiftPolicyBody({
    name: "General shift", timezone: "Asia/Kolkata", startTime: "09:30", endTime: "18:30",
    weeklyOff: "sun, sat", locationRule: "policy_required", effectiveFrom: "2026-04-01",
  })));
  assert.equal(policy.status, 200);
  assert.equal(policy.body.data.version, 1);
  const saved = sqlite.prepare("SELECT timezone,start_time,weekly_off_json,location_rule FROM shift_policies WHERE id=?").get(policy.body.data.id);
  assert.equal(saved.timezone, "Asia/Kolkata");
  assert.equal(saved.start_time, "09:30");
  assert.deepEqual(JSON.parse(saved.weekly_off_json), ["sun", "sat"]);
  assert.equal(saved.location_rule, "policy_required");

  const assigned = await read(await post(MANAGER, screen.assignShiftBody({ employeeId: "EMP-A", shiftPolicyId: policy.body.data.id, effectiveFrom: "2026-04-01", reason: "moved onto the general shift" })));
  assert.equal(assigned.status, 200);

  const view = await read(await get(MANAGER));
  assert.equal(view.body.data.shiftPolicies.length, 1);
  assert.equal(view.body.data.shiftAssignments.length, 1);
  assert.equal(view.body.data.shiftAssignments[0].employee_id, "EMP-A");

  // A shorter reason is refused by the engine, and the screen predicate says the same thing first.
  const thin = await read(await post(MANAGER, screen.assignShiftBody({ employeeId: "EMP-A", shiftPolicyId: policy.body.data.id, effectiveFrom: "2026-04-01", reason: "why" })));
  assert.equal(thin.status, 400);
  assert.match(thin.body.error, /Shift assignment reason is required/);
  assert.ok(screen.missingAssignShiftFields({ employeeId: "EMP-A", shiftPolicyId: policy.body.data.id, effectiveFrom: "2026-04-01", reason: "why" })
    .some((m) => /8 characters/.test(m)), "the screen must refuse the same input before spending a round trip");
});

// =================================================================================================
// 5. The screen itself: the controls exist, and only for the actor entitled to them
// =================================================================================================

const payload = (over = {}) => ({
  attendanceDays: [], pendingAdjustments: [], leaveRequests: [], leavePolicies: [], shiftPolicies: [],
  shiftAssignments: [], leaveBalances: [], periodLocks: [], employees: [],
  scope: { mode: "self", employeeId: "EMP-A", canManageAttendance: false, canManageLeave: false },
  truth: { hardcodedGraceMinutes: false, hardcodedLeaveEntitlement: false, hardcodedOvertimeRate: false, gpsRequired: false, productionReady: false },
  ...over,
});
const render = (data) => renderToStaticMarkup(React.createElement(screen.TimeAndLeaveScreen, {
  data, busy: false, loading: false, error: "", message: "", onPost: async () => {}, onRefresh: () => {},
}));

test("the employee sees their own request controls and balance; the manager surfaces stay hidden", () => {
  const html = render(payload({
    leavePolicies: [{ id: "LVP-1", name: "Casual leave", version: 1, leave_code: "CL", allow_negative: 0, entitlement_units: 12, effective_from: EFFECTIVE }],
    leaveBalances: [{ employee_id: "EMP-A", leave_code: "CL", balance: 9 }],
  }));
  assert.match(html, /Request leave/);
  assert.match(html, /Request an attendance correction/);
  assert.match(html, /CL 9/, "the employee must be able to see the balance their request is judged against");
  assert.doesNotMatch(html, /Leave approval queue/, "an employee must not be shown the decision queue");
  assert.doesNotMatch(html, /Payroll period lock/);
  assert.doesNotMatch(html, /Grant leave entitlement/);
});

test("the manager sees the queue, the policy controls and the period lock", () => {
  const html = render(payload({
    scope: { mode: "manager", employeeId: null, canManageAttendance: true, canManageLeave: true },
    employees: [{ id: "EMP-A", employee_code: "PS-A", display_name: "Asha Associate" }],
    leavePolicies: [{ id: "LVP-1", name: "Casual leave", version: 1, leave_code: "CL", allow_negative: 0, entitlement_units: 12, effective_from: EFFECTIVE }],
    leaveRequests: [{ id: "LVR-1", employee_id: "EMP-A", leave_code: "CL", start_date: "2026-09-21", end_date: "2026-09-23", units: 3, status: "pending", reason: "family function" }],
    pendingAdjustments: [{ id: "AAR-1", employee_id: "EMP-A", work_date: "2026-09-14", status: "pending", reason: "forgot to check out", requested_status: "present", requested_check_in: null, requested_check_out: null }],
    periodLocks: [{ id: "PPL-1", period_start: Date.UTC(2026, 8, 1), period_end: Date.UTC(2026, 8, 30), status: "locked" }],
  }));
  for (const control of ["Leave approval queue", "Approve", "Reject", "Leave policy", "Grant leave entitlement", "Attendance adjustment queue", "Approve correction", "Payroll period lock", "Shift policy", "Assign a shift"]) {
    assert.match(html, new RegExp(control), `the manager surface must offer "${control}"`);
  }
  assert.doesNotMatch(html, /Request leave/, "a manager with no employee record of their own gets no self-service form");
});

test("with no leave policy configured the screen says so instead of offering a request that must fail", () => {
  const html = render(payload());
  assert.match(html, /No active leave policy exists/);
  assert.match(html, /Active leave policy configuration is required/, "the screen names the refusal the engine would give");
  // The request button exists but is inert until a policy does.
  assert.match(html, /an active leave policy/);
  assert.match(html, /<button disabled=""[^>]*>Submit for approval<\/button>/);
});

test("the request controls go live exactly when the engine would accept them", () => {
  const policies = [{ id: "LVP-1", name: "Casual leave", version: 1, leave_code: "CL", allow_negative: 0, entitlement_units: 12, effective_from: EFFECTIVE }];
  assert.deepEqual(screen.missingLeaveRequestFields(leaveDraft(), policies), []);
  assert.ok(screen.missingLeaveRequestFields(leaveDraft({ reason: "no" }), policies).some((m) => /4 characters/.test(m)));
  assert.ok(screen.missingLeaveRequestFields(leaveDraft({ units: "0" }), policies).some((m) => /positive number of days/.test(m)));
  assert.ok(screen.missingLeaveRequestFields(leaveDraft(), []).some((m) => /active leave policy/.test(m)));
  assert.ok(screen.missingLeaveRequestFields(leaveDraft({ leaveCode: "SL" }), policies).some((m) => /active policy/.test(m)));
  assert.deepEqual(screen.missingAdjustmentFields({ workDate: "2026-09-14", requestedStatus: "present", checkIn: "", checkOut: "", reason: "forgot to check out" }), []);
  assert.ok(screen.missingAdjustmentFields({ workDate: "", requestedStatus: "present", checkIn: "", checkOut: "", reason: "forgot to check out" }).some((m) => /work date/.test(m)));
  assert.ok(screen.missingGrantFields({ employeeId: "EMP-A", leaveCode: "CL", units: "", reason: "annual" }, [{ ...policies[0], entitlement_units: null }]).some((m) => /carries no entitlement/.test(m)),
    "granting a blank amount against a policy with no entitlement must be refused before the round trip");
  assert.deepEqual(screen.missingPeriodLockFields({ periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "locked" }), []);
  assert.ok(screen.missingPeriodLockFields({ periodStart: "2026-09-30", periodEnd: "2026-09-01", status: "locked" }).some((m) => /on or after/.test(m)));
});
