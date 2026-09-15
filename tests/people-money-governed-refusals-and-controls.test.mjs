/**
 * People money engines: the refusal reaches the operator, the remedy is reachable, and the company
 * view counts the company.
 *
 * Four defects, all executed against the real engines over a real SQLite-backed D1 and the real
 * page component rendered with react-dom/server. Nothing here matches on source text.
 *
 *   1. EVERY business-rule refusal in the People money engines was a plain `new Error`, and
 *      lib/server-auth.ts authError() trusts only a WeakSet-registered Response or the
 *      GOVERNED_CLIENT_ERROR brand - so "you tried to claw back Rs999,999 against an approved Rs550"
 *      and "the server is broken" arrived at /team/people/incentives as the same 500 "Incentive
 *      update failed". Same for payroll maker/checker, attendance/leave and the compensation step of
 *      onboarding. These tests pin the real reason, the 4xx, the absence of writes on the refused
 *      path, and - as a CONTROL - that a genuine platform fault is still a redacted 500.
 *   2. The Incentives screen had no Adjust control, so the engine's documented remedy for a wrong
 *      `calculated` amount (addIncentiveAdjustment + a second approver) was reachable from no screen.
 *   3. The screen never showed how much had already been clawed back, so a partial reversal was
 *      invisible and the next attempt was refused against a balance nobody had been shown.
 *   4. lib/manager-dashboard.ts required an OPEN employment version to be "in scope", so a founder
 *      saw 4 employees where People reports (and payroll) saw 44.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__PEOPLE_MONEY_ENGINE_DB__");

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const screen = await import("../app/team/people/incentives/page.tsx");
const incentive = await import("../lib/incentive-engine.ts");
const payroll = await import("../lib/payroll-engine.ts");
const attendance = await import("../lib/attendance-leave.ts");
const onboarding = await import("../lib/employee-journey-onboarding.ts");
const managerDashboard = await import("../lib/manager-dashboard.ts");
const peopleReports = await import("../lib/people-reports.ts");
const peopleFoundation = await import("../lib/people-foundation.ts");
const { authError } = await import("../lib/server-auth.ts");
const { isGovernedHttpError, GOVERNED_CLIENT_ERROR } = await import("../lib/governed-http-error.ts");

const NOW = Date.UTC(2026, 8, 15);
const PERIOD_START = Date.UTC(2026, 7, 1);
const PERIOD_END = Date.UTC(2026, 7, 31);
const CALCULATOR = "finance@pawspace.in";
const MANAGER = "manager@pawspace.in";
const SECOND = "cfo@pawspace.in";
const MAKER = "payroll.maker@pawspace.in";
const REVIEWER = "payroll.reviewer@pawspace.in";

// The exact catch-block fallbacks of the four routes these engines sit behind.
const INCENTIVE_FALLBACK = "Incentive update failed";
const PAYROLL_FALLBACK = "Payroll update failed";
const ATTENDANCE_FALLBACK = "Attendance/leave update failed";
const PEOPLE_FALLBACK = "People update failed";

/** Run a refusal exactly the way its route does: catch it, hand it to the real authError(). */
async function surfaced(work, fallback) {
  const thrown = await Promise.resolve().then(work).then(() => null, (error) => error);
  assert.ok(thrown, "the call was expected to be refused but resolved");
  const response = authError(thrown, fallback);
  return { thrown, response, status: response.status, error: (await response.json()).error };
}
const count = (sqlite, table) => Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c);

// ---------------------------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------------------------

async function incentiveWorld() {
  const { db, sqlite } = freshCountingD1();
  await incentive.ensureIncentiveTables(db);
  sqlite.prepare("INSERT INTO incentive_scheme_versions (id,scheme_code,version,status,role_code,team_code,effective_from,formula_json,quality_rules_json,created_by,created_at) VALUES ('ISV-1','SALES_BLR',1,'active_uat','sales_associate','sales_blr',?,?,'[]',?,?)")
    .run(PERIOD_START, JSON.stringify({ metric: "net_collected_revenue", target: 0, payoutType: "flat_on_target", payoutValue: 550 }), CALCULATOR, NOW);
  sqlite.prepare("INSERT INTO employee_incentive_periods (id,idempotency_key,scheme_id,period_start,period_end,status,calculated_by,created_at) VALUES ('IPER-1','key-1','ISV-1',?,?,'calculated',?,?)")
    .run(PERIOD_START, PERIOD_END, CALCULATOR, NOW);
  const result = (id, employee, status, calculated, approved) =>
    sqlite.prepare("INSERT INTO employee_incentive_results (id,period_id,employee_id,employee_email,source_fact_run_id,metric_value,calculated_amount,approved_amount,status,evidence_json,approved_by,approved_at) VALUES (?,'IPER-1',?,?,'RUN-1',120,?,?,?,'{}',?,?)")
      .run(id, `EMP-${id}`, employee, calculated, approved, status, status === "approved" || status === "reversed" ? MANAGER : null, status === "approved" || status === "reversed" ? NOW : null);
  result("IRES-APPROVED", "priya@pawspace.in", "approved", 550, 550);   // the Rs550 approved result
  result("IRES-CALC", "neha@pawspace.in", "calculated", 550, 0);        // the wrong `calculated` amount
  result("IRES-BIG", "asha@pawspace.in", "approved", 2100, 2100);       // the Rs2,100 fully reversed later
  return { db, sqlite };
}

async function payrollWorld() {
  const { db, sqlite } = freshCountingD1();
  await payroll.ensurePayrollTables(db);
  sqlite.prepare("INSERT INTO payroll_runs (id,idempotency_key,period_start,period_end,status,input_snapshot_json,created_by,created_at) VALUES ('PAYRUN-1','pk-1',?,?,'calculated','{}',?,?)")
    .run(PERIOD_START, PERIOD_END, MAKER, NOW);
  return { db, sqlite };
}

async function attendanceWorld() {
  const { db, sqlite } = freshCountingD1();
  await attendance.ensureAttendanceLeaveTables(db);
  sqlite.prepare("INSERT INTO leave_policies (id,name,version,status,leave_code,allow_negative,entitlement_units,effective_from,created_by,created_at) VALUES ('LVP-1','Casual',1,'active_uat','CL',0,12,?,?,?)")
    .run(PERIOD_START, MANAGER, NOW);
  sqlite.prepare("INSERT INTO employee_leave_balances (employee_id,leave_code,balance,updated_at) VALUES ('EMP-1','CL',5,?)").run(NOW);
  sqlite.prepare("INSERT INTO leave_requests (id,employee_id,leave_code,start_date,end_date,units,reason,status,requested_by,created_at) VALUES ('LVR-1','EMP-1','CL','2026-08-20','2026-08-21',2,'Family visit','pending',?,?)")
    .run("employee@pawspace.in", NOW);
  return { db, sqlite };
}

// ---------------------------------------------------------------------------------------------
// 1. Defect 1 - the money reason survives, at a 4xx, and the refused path writes nothing.
// ---------------------------------------------------------------------------------------------

test("every incentive refusal on the clawback screen reaches the operator with its own reason", async () => {
  const { db, sqlite } = await incentiveWorld();
  // Rs200 of the approved Rs550 is legitimately clawed back first, so Rs350 remains.
  await incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: 200, reason: "Refund settled against this payout", effectiveAt: PERIOD_END, actorId: MANAGER });
  const reversalsBefore = count(sqlite, "incentive_reversals");
  const eventsBefore = count(sqlite, "incentive_approval_events");

  const cases = [
    { name: "reverse Rs999,999 against an approved Rs550", status: 422,
      message: "Reversal amount must be positive and cannot exceed the remaining approved incentive",
      run: () => incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: 999999, reason: "Trying to over-reverse the payout", effectiveAt: PERIOD_END, actorId: MANAGER }) },
    { name: "reverse Rs-100 when Rs350 remains", status: 422,
      message: "Reversal amount must be positive and cannot exceed the remaining approved incentive",
      run: () => incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: -100, reason: "A negative clawback is not a clawback", effectiveAt: PERIOD_END, actorId: MANAGER }) },
    { name: "reverse Rs0 when Rs350 remains", status: 422,
      message: "Reversal amount must be positive and cannot exceed the remaining approved incentive",
      run: () => incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: 0, reason: "A zero clawback is not a clawback", effectiveAt: PERIOD_END, actorId: MANAGER }) },
    { name: "reverse Rs400 when only Rs350 remains", status: 422,
      message: "Reversal amount must be positive and cannot exceed the remaining approved incentive",
      run: () => incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: 400, reason: "Second clawback beyond the remaining balance", effectiveAt: PERIOD_END, actorId: MANAGER }) },
    { name: "reverse a calculated result", status: 409,
      message: "Approved incentive result is required for reversal",
      run: () => incentive.reverseIncentiveResult(db, { resultId: "IRES-CALC", amount: 100, reason: "Nothing approved to claw back", effectiveAt: PERIOD_END, actorId: MANAGER }) },
    { name: "approve one's own calculation", status: 409,
      message: "Incentive calculator cannot approve their own result",
      run: () => incentive.approveIncentiveResult(db, { resultId: "IRES-CALC", actorId: CALCULATOR }) },
  ];

  for (const item of cases) {
    const seen = await surfaced(item.run, INCENTIVE_FALLBACK);
    assert.notEqual(seen.status, 500, `${item.name}: a client-input refusal must never be reported as a server fault`);
    assert.equal(seen.status, item.status, `${item.name}: wrong status (body ${JSON.stringify(seen.error)})`);
    assert.equal(seen.error, item.message, `${item.name}: the real reason did not survive authError()`);
    assert.notEqual(seen.error, INCENTIVE_FALLBACK, `${item.name}: the operator still reads the route's generic fallback`);
    assert.ok(isGovernedHttpError(seen.response), `${item.name}: the response must be a governed 4xx`);
  }

  assert.equal(count(sqlite, "incentive_reversals"), reversalsBefore, "a refused reversal writes no reversal row");
  assert.equal(count(sqlite, "incentive_approval_events"), eventsBefore, "a refused reversal writes no approval event");
  assert.equal(Number(sqlite.prepare("SELECT status FROM employee_incentive_results WHERE id='IRES-CALC'").get().status === "calculated"), 1, "a refused self-approval leaves the result calculated");
  assert.equal(Number(sqlite.prepare("SELECT approved_amount FROM employee_incentive_results WHERE id='IRES-CALC'").get().approved_amount), 0, "a refused self-approval approves no money");
});

test("payroll maker/checker refusals are the reviewer's answer, not 500 'Payroll update failed'", async () => {
  const { db, sqlite } = await payrollWorld();

  const own = await surfaced(() => payroll.reviewPayroll(db, { runId: "PAYRUN-1", actorId: MAKER }), PAYROLL_FALLBACK);
  assert.equal(own.status, 409);
  assert.equal(own.error, "Payroll maker cannot review their own run");
  assert.equal(count(sqlite, "payroll_approval_events"), 0, "a refused review records no approval event");
  assert.equal(sqlite.prepare("SELECT status FROM payroll_runs WHERE id='PAYRUN-1'").get().status, "calculated");

  await payroll.reviewPayroll(db, { runId: "PAYRUN-1", actorId: REVIEWER });
  await payroll.approvePayroll(db, { runId: "PAYRUN-1", actorId: SECOND });
  const eventsAfterApproval = count(sqlite, "payroll_approval_events");

  const again = await surfaced(() => payroll.approvePayroll(db, { runId: "PAYRUN-1", actorId: SECOND }), PAYROLL_FALLBACK);
  assert.equal(again.status, 409);
  assert.equal(again.error, "Only reviewed payroll can be approved", "approving an already-approved run says so");
  assert.equal(count(sqlite, "payroll_approval_events"), eventsAfterApproval, "a refused second approval writes no second event");
});

test("an attendance/leave refusal names the request instead of 500 'Attendance/leave update failed'", async () => {
  const { db, sqlite } = await attendanceWorld();

  const unknown = await surfaced(() => attendance.decideLeave(db, { requestId: "LVR-DOES-NOT-EXIST", decision: "approved", reason: "Approved", actorId: MANAGER }), ATTENDANCE_FALLBACK);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.error, "Pending leave request not found");

  const self = await surfaced(() => attendance.decideLeave(db, { requestId: "LVR-1", decision: "approved", reason: "Approving my own leave", actorId: "employee@pawspace.in" }), ATTENDANCE_FALLBACK);
  assert.equal(self.status, 409);
  assert.equal(self.error, "Maker/checker: the requester cannot approve their own leave request");

  assert.equal(count(sqlite, "leave_ledger_events"), 0, "a refused decision debits nothing");
  assert.equal(Number(sqlite.prepare("SELECT balance FROM employee_leave_balances WHERE employee_id='EMP-1' AND leave_code='CL'").get().balance), 5, "the balance is untouched");
  assert.equal(sqlite.prepare("SELECT status FROM leave_requests WHERE id='LVR-1'").get().status, "pending");
});

test("the compensation step of onboarding refuses with its reason, and onboarding's own refusals stay governed Responses", async () => {
  const { db, sqlite } = freshCountingD1();
  await onboarding.ensureEmployeeJourneyTables(db);
  sqlite.prepare("INSERT INTO employees (id,employee_code,display_name,work_email,user_email,employment_status,joined_at,created_at,updated_at) VALUES ('EMP-1','E1','Asha','asha@pawspace.in','asha@pawspace.in','active',?,?,?)")
    .run(PERIOD_START, NOW, NOW);

  // The hole in the onboarding path: assignCompensation lives in lib/payroll-engine.ts and threw a
  // plain Error, so this refusal reached /api/people-foundation as 500 "People update failed".
  const seen = await surfaced(() => payroll.assignCompensation(db, { employeeId: "EMP-1", structureId: "SAL-RETIRED", effectiveFrom: PERIOD_START, reason: "Structure retired between preflight and write", actorId: MANAGER }), PEOPLE_FALLBACK);
  assert.notEqual(seen.status, 500);
  assert.equal(seen.status, 409);
  assert.equal(seen.error, "Active employee and active salary structure are required");
  assert.equal(count(sqlite, "employee_compensation_assignments"), 0, "a refused assignment writes nothing");

  // REGRESSION GUARD. lib/employee-journey-onboarding.ts refuses by THROWING a governed Response and
  // tests/employee-journey-activation-atomicity.test.mjs asserts `error instanceof Response`. That
  // module must not be "unified" onto the branded-Error mechanism used by the engines above.
  const future = await Promise.resolve()
    .then(() => onboarding.onboardEmployeeJourney(db, { employeeCode: "E2", displayName: "Later", workEmail: "later@pawspace.in", joinedAt: Date.now() + 86_400_000, structureId: "SAL-1", roleCode: "people_ops", reason: "Starts next week", actorId: MANAGER }))
    .then(() => null, (error) => error);
  assert.ok(future instanceof Response, "onboarding refusals must stay thrown Responses");
  assert.ok(isGovernedHttpError(future));
  assert.equal(future.status, 422);
});

test("REQUIREMENT PIN: these refusals stay Error objects, which assert.rejects(/regex/) requires", async () => {
  /*
   * The pre-existing suites - which must not be edited - pin these rejections with
   * `assert.rejects(fn, /regex/)`, and node:assert matches a RegExp against String(thrown):
   * "Error: <message>" for an Error, the literal "[object Response]" for a Response.
   *   tests/incentive-hardening.test.mjs      /cannot approve their own result/, /cannot exceed the remaining/, ...
   *   tests/people-partner-hardening.test.mjs /Maker\/reviewer cannot approve their own payroll run/,
   *                                           /requester cannot approve their own leave request/
   *   tests/people-money-screen-governance.test.mjs compares String(error?.message) to
   *                                           "Approved incentive result is required for reversal"
   * So governedJsonError() CANNOT be reused in these engines; the refusal has to remain an Error and
   * reach the caller through the GOVERNED_CLIENT_ERROR bridge. This test fails first if anyone
   * "unifies" the two mechanisms.
   */
  const incentives = await incentiveWorld();
  const payrollStack = await payrollWorld();
  const leave = await attendanceWorld();

  const pinned = [
    { label: "incentive self-approval", regex: /cannot approve their own result/,
      run: () => incentive.approveIncentiveResult(incentives.db, { resultId: "IRES-CALC", actorId: CALCULATOR }) },
    { label: "over-reversal", regex: /cannot exceed the remaining/,
      run: () => incentive.reverseIncentiveResult(incentives.db, { resultId: "IRES-APPROVED", amount: 999999, reason: "Trying to over-reverse the payout", effectiveAt: PERIOD_END, actorId: MANAGER }) },
    { label: "nothing approved to reverse", regex: /Approved incentive result is required for reversal/,
      message: "Approved incentive result is required for reversal",
      run: () => incentive.reverseIncentiveResult(incentives.db, { resultId: "IRES-CALC", amount: 100, reason: "Nothing approved to claw back", effectiveAt: PERIOD_END, actorId: MANAGER }) },
    { label: "payroll maker review", regex: /Payroll maker cannot review their own run/,
      run: () => payroll.reviewPayroll(payrollStack.db, { runId: "PAYRUN-1", actorId: MAKER }) },
    { label: "leave self-approval", regex: /requester cannot approve their own leave request/,
      run: () => attendance.decideLeave(leave.db, { requestId: "LVR-1", decision: "approved", reason: "self", actorId: "employee@pawspace.in" }) },
  ];

  for (const item of pinned) {
    const thrown = await Promise.resolve().then(item.run).then(() => null, (error) => error);
    assert.ok(thrown instanceof Error, `${item.label}: a Response here would make String(thrown) '[object Response]'`);
    assert.match(String(thrown), item.regex, `${item.label}: String(thrown) is what a RegExp assertion is matched against`);
    if (item.message) assert.equal(thrown.message, item.message, `${item.label}: an existing suite compares .message exactly`);
    assert.equal(thrown[GOVERNED_CLIENT_ERROR], true, `${item.label}: the brand is what authError() trusts`);
    assert.ok(Number.isInteger(thrown.statusCode) && thrown.statusCode >= 400 && thrown.statusCode < 500, `${item.label}: a 4xx statusCode`);
    assert.ok(isGovernedHttpError(authError(thrown, INCENTIVE_FALLBACK)), `${item.label}: still a governed 4xx on the wire`);
  }
});

test("CONTROL: a D1 failure inside a reversal is still a redacted 500, not a caller-safe message", async () => {
  const { db } = await incentiveWorld();
  const failing = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!/^INSERT INTO incentive_reversals /.test(sql)) return statement;
      return { ...statement, bind: (...args) => ({ ...statement.bind(...args), run: async () => { throw new Error("D1_ERROR: database is locked at offset 41"); } }) };
    },
  };
  const seen = await surfaced(() => incentive.reverseIncentiveResult(failing, { resultId: "IRES-APPROVED", amount: 100, reason: "A perfectly valid clawback", effectiveAt: PERIOD_END, actorId: MANAGER }), INCENTIVE_FALLBACK);
  assert.equal(seen.status, 500, "an unexpected write failure is not the operator's input");
  assert.equal(seen.error, INCENTIVE_FALLBACK, "and its message is not shown to the caller");
});

test("CONTROL: an unbranded Error with a 4xx-looking statusCode is still a redacted 500", async () => {
  const response = authError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:5432"), { statusCode: 409 }), PAYROLL_FALLBACK);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, PAYROLL_FALLBACK);
});

// ---------------------------------------------------------------------------------------------
// 2. Defect 2 - the Adjust remedy is reachable, and offered exactly where the engine accepts it.
// ---------------------------------------------------------------------------------------------

const CARD_CALLBACKS = { onApprove: () => {}, onSubmitDispute: () => {}, onSubmitResolve: () => {}, onSubmitReverse: () => {} };
const renderCard = (props) => renderToStaticMarkup(React.createElement(screen.IncentiveResultCard, {
  dispute: undefined, busy: false, disputeDraft: null, setDisputeDraft: () => {},
  resolveDraft: null, setResolveDraft: () => {}, reverseDraft: null, setReverseDraft: () => {},
  ...CARD_CALLBACKS, ...props,
}));
const baseResult = (over = {}) => ({
  id: "IRES-APPROVED", employee_id: "EMP-1", employee_email: "priya@pawspace.in", metric_value: 120,
  calculated_amount: 550, approved_amount: 550, status: "approved", scheme_code: "SALES_BLR",
  version: 1, period_start: PERIOD_START, period_end: PERIOD_END, ...over,
});
const STATUSES = ["calculated", "held", "disputed", "approved", "reversed"];

test("Adjust is offered for exactly the statuses lib/incentive-engine.ts accepts", async () => {
  const { db, sqlite } = freshCountingD1();
  await incentive.ensureIncentiveTables(db);
  for (const status of STATUSES) {
    sqlite.prepare("INSERT INTO employee_incentive_results (id,period_id,employee_id,employee_email,source_fact_run_id,metric_value,calculated_amount,approved_amount,status,evidence_json) VALUES (?,'IPER-1',?,?,'RUN-1',120,550,550,?,'{}')")
      .run(`IRES-${status}`, `EMP-${status}`, `${status}@pawspace.in`, status);
  }
  const accepted = [];
  for (const status of STATUSES) {
    let engineAccepts;
    try {
      await incentive.addIncentiveAdjustment(db, { resultId: `IRES-${status}`, amount: 200, reason: "Correcting a wrong calculated amount", actorId: MANAGER });
      engineAccepts = true;
    } catch (error) {
      if (String(error?.message) !== "Finalized incentive cannot be silently adjusted") throw error;
      engineAccepts = false;
    }
    if (engineAccepts) accepted.push(status);
    assert.equal(screen.canAdjustResult(status), engineAccepts, `the screen and the engine must agree about adjusting a '${status}' result`);
  }
  assert.deepEqual(accepted, ["calculated", "held", "disputed"], "the engine's own rule, executed");
  for (const status of STATUSES) {
    assert.equal(/>Adjust</.test(renderCard({ result: baseResult({ status }) })), screen.canAdjustResult(status), `the rendered Adjust button follows that rule for '${status}'`);
  }
});

test("a wrong calculated amount is corrected by adjustment - and never by the same person alone", async () => {
  const { db, sqlite } = await incentiveWorld();

  const adjustment = await incentive.addIncentiveAdjustment(db, { resultId: "IRES-CALC", amount: 200, reason: "Two conversions were missing from the fact run", actorId: MANAGER });
  assert.equal(adjustment.status, "pending", "an adjustment is a request, not an edit");
  assert.equal(Number(sqlite.prepare("SELECT calculated_amount FROM employee_incentive_results WHERE id='IRES-CALC'").get().calculated_amount), 550, "the calculated figure itself is never rewritten");

  const self = await surfaced(() => incentive.approveIncentiveAdjustment(db, { adjustmentId: adjustment.id, actorId: MANAGER }), INCENTIVE_FALLBACK);
  assert.equal(self.status, 409);
  assert.equal(self.error, "Adjustment requester cannot approve their own change", "the maker/checker rule reaches the operator too");
  assert.equal(sqlite.prepare("SELECT status FROM incentive_adjustments WHERE id=?").get(adjustment.id).status, "pending", "a refused approval leaves it pending");

  await incentive.approveIncentiveAdjustment(db, { adjustmentId: adjustment.id, actorId: SECOND });
  const approved = await incentive.approveIncentiveResult(db, { resultId: "IRES-CALC", actorId: SECOND });
  assert.equal(approved.approvedAmount, 750, "Rs550 calculated + a Rs200 approved adjustment is what gets approved");

  // ...and the screen can now see the adjustment trail it just drove.
  const directory = await incentive.incentiveDirectory(db);
  const row = directory.adjustments.find((a) => a.id === adjustment.id);
  assert.ok(row, "the directory carries the adjustment the screen renders");
  assert.equal(row.status, "approved");
  assert.equal(String(row.requested_by), MANAGER);
  assert.equal(String(row.approved_by), SECOND);
  const html = renderCard({ result: baseResult({ id: "IRES-CALC", status: "approved", approved_amount: 750 }), adjustments: directory.adjustments });
  assert.match(html, /Adjustments/);
  assert.ok(html.includes(MANAGER) && html.includes(SECOND), "the card names who asked and who approved");
});

// ---------------------------------------------------------------------------------------------
// 3. Defect 3 - a clawback is visible: how much, how much is left, by whom and when.
// ---------------------------------------------------------------------------------------------

test("a partial clawback is visible on the card, with the remaining reversible balance", async () => {
  const { db } = await incentiveWorld();
  await incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: 200, reason: "Refund settled against this payout", effectiveAt: PERIOD_END, actorId: MANAGER });

  const directory = await incentive.incentiveDirectory(db);
  const result = directory.results.find((r) => r.id === "IRES-APPROVED");
  assert.equal(Number(result.reversed_amount), 200, "the directory reports what has gone back");
  assert.equal(Number(result.remaining_reversible), 350, "and what is still reversible - the number the engine enforces");
  assert.equal(Number(result.reversal_count), 1);
  assert.equal(directory.reversals.filter((row) => row.result_id === "IRES-APPROVED").length, 1);

  const html = renderCard({ result, reversals: directory.reversals });
  assert.match(html, /Clawed back: ₹200/, "the operator sees the clawback that already happened");
  assert.match(html, /Still reversible: ₹350/, "and the balance the next attempt is measured against");
  assert.match(html, /Clawback history/);
  assert.ok(html.includes(MANAGER), "the history names the actor");
  assert.ok(html.includes("Refund settled against this payout"), "and the reason");
  assert.ok(html.includes(new Date(PERIOD_END).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })), "and the effective date");
  assert.ok(/>Reverse</.test(html), "a partially reversed result can still be reversed further");
});

test("a fully reversed result says so, instead of showing the money as if it were still paid", async () => {
  const { db, sqlite } = await incentiveWorld();
  await incentive.reverseIncentiveResult(db, { resultId: "IRES-BIG", amount: 2100, reason: "Entire payout clawed back after audit", effectiveAt: PERIOD_END, actorId: MANAGER });
  assert.equal(sqlite.prepare("SELECT status FROM employee_incentive_results WHERE id='IRES-BIG'").get().status, "reversed");

  const directory = await incentive.incentiveDirectory(db);
  const result = directory.results.find((r) => r.id === "IRES-BIG");
  assert.equal(Number(result.reversed_amount), 2100);
  assert.equal(Number(result.remaining_reversible), 0);

  const html = renderCard({ result, reversals: directory.reversals });
  assert.match(html, /Clawed back: ₹2,100/, "the card no longer reads 'Approved: ₹2,100' with no sign the money went back");
  assert.match(html, /Still reversible: ₹0/);
  assert.equal(/>Reverse</.test(html), false, "and nothing is left to reverse");
});

test("the remaining-balance figure is the one the engine enforces, end to end", async () => {
  const { db } = await incentiveWorld();
  await incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: 200, reason: "First partial clawback", effectiveAt: PERIOD_END, actorId: MANAGER });
  const remaining = Number((await incentive.incentiveDirectory(db)).results.find((r) => r.id === "IRES-APPROVED").remaining_reversible);

  const over = await surfaced(() => incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: remaining + 0.01, reason: "One paisa past the displayed balance", effectiveAt: PERIOD_END, actorId: MANAGER }), INCENTIVE_FALLBACK);
  assert.equal(over.status, 422, "a rupee more than the screen shows is refused");
  const exact = await incentive.reverseIncentiveResult(db, { resultId: "IRES-APPROVED", amount: remaining, reason: "Exactly the displayed remaining balance", effectiveAt: PERIOD_END, actorId: MANAGER });
  assert.equal(exact.amount, remaining, "and exactly the displayed balance is accepted");
  assert.equal(Number((await incentive.incentiveDirectory(db)).results.find((r) => r.id === "IRES-APPROVED").remaining_reversible), 0);
});

// ---------------------------------------------------------------------------------------------
// 4. Defect 4 - the company view counts the company.
// ---------------------------------------------------------------------------------------------

const FOUNDER = { actorEmail: "founder@pawspace.in", permissions: ["people.manage"], asOf: NOW };

async function headcountWorld() {
  const { db, sqlite } = freshCountingD1();
  await peopleFoundation.ensurePeopleTables(db);
  const employee = (id, email) => sqlite.prepare("INSERT INTO employees (id,employee_code,display_name,work_email,user_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(id, id, `Name ${id}`, email, email, PERIOD_START, NOW, NOW);
  const openVersion = (id, team) => sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'direct_employee',?,?,'fixture','test',?)")
    .run(`V-${id}`, id, PERIOD_START, `${team} lead`, team, NOW);
  // Two demo employees with an open employment version, four seeded ones without - the real shape:
  // 44 active employees, 4 with an open version.
  employee("WITH-1", "with1@pawspace.in"); openVersion("WITH-1", "sales");
  employee("WITH-2", "with2@pawspace.in"); openVersion("WITH-2", "grooming");
  for (const n of [1, 2, 3]) employee(`SEED-${n}`, `seed${n}@pawspace.in`);
  // ...and one whose only employment version has been CLOSED: still an active employee, still paid.
  employee("CLOSED-1", "closed1@pawspace.in");
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES ('V-CLOSED-1','CLOSED-1',1,?,?,'direct_employee','Former title','sales','fixture','test',?)")
    .run(PERIOD_START, PERIOD_START + 1000, NOW);
  return { db, sqlite };
}

test("the founder's 'Scope: Everyone' counts every active employee, the way payroll and People reports do", async () => {
  const { db, sqlite } = await headcountWorld();
  const active = Number(sqlite.prepare("SELECT COUNT(*) c FROM employees WHERE employment_status='active'").get().c);
  const withOpenVersion = Number(sqlite.prepare("SELECT COUNT(*) c FROM employees e JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL WHERE e.employment_status='active'").get().c);
  assert.equal(active, 6);
  assert.equal(withOpenVersion, 2, "the fixture reproduces the gap: most active employees have no open version");

  const result = await managerDashboard.buildManagerDashboard(db, FOUNDER);
  assert.equal(result.scope, "all");
  assert.equal(result.employeeCount, active, "the dashboard counts every active employee, not only those with an open employment version");
  assert.notEqual(result.employeeCount, withOpenVersion, "the inner join used to show this smaller number while claiming a complete company view");

  const report = await peopleReports.peopleReports(db, { actorEmail: FOUNDER.actorEmail, roleCode: "founder", permissions: FOUNDER.permissions });
  assert.equal(result.employeeCount, report.headcount.active, "the same persona at the same moment sees one headcount, not two");
});

test("the employees with no open employment version are named as a data gap, not silently dropped", async () => {
  const { db } = await headcountWorld();
  const result = await managerDashboard.buildManagerDashboard(db, FOUNDER);
  assert.equal(result.employmentVersionGap.employeesWithoutOpenEmploymentVersion, 4, "three never-versioned employees plus the one whose version was closed");
  assert.deepEqual(result.employmentVersionGap.employeeIds.sort(), ["CLOSED-1", "SEED-1", "SEED-2", "SEED-3"]);
  assert.match(result.employmentVersionGap.effect, /no title, team or manager on record/, "the dashboard says what the gap costs");
  assert.match(result.scopeNote, /every ACTIVE employee/, "and what 'in scope' means");
  // app/team/people/manager-dashboard/page.tsx renders `note` verbatim under "a real, complete
  // company view", so the gap has to reach that sentence or the SCREEN is still silent about it.
  assert.match(result.note, /4 of the 6 shown have no open employment version/, "the note the screen renders names the gap");
  assert.match(result.note, /cannot be classified into a vertical/);
  // They are counted AND classified honestly: with no title or team they cannot be placed in a
  // vertical, so they appear under "other" rather than being deleted from the company view.
  const others = result.verticals.other.map((row) => row.employeeEmail);
  for (const email of ["closed1@pawspace.in", "seed1@pawspace.in", "seed2@pawspace.in", "seed3@pawspace.in"]) {
    assert.ok(others.includes(email), `${email} must be visible in the dashboard, not dropped from it`);
  }
  assert.equal(result.verticals.other.filter((row) => row.title === "").length, 4, "and their missing title is shown as missing, not invented");
});

test("an all-versioned company reports no gap at all", async () => {
  const { db, sqlite } = freshCountingD1();
  await peopleFoundation.ensurePeopleTables(db);
  sqlite.prepare("INSERT INTO employees (id,employee_code,display_name,work_email,user_email,employment_status,joined_at,created_at,updated_at) VALUES ('E1','E1','One','one@pawspace.in','one@pawspace.in','active',?,?,?)").run(PERIOD_START, NOW, NOW);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES ('V-E1','E1',1,?,NULL,'direct_employee','Sales lead','sales','fixture','test',?)").run(PERIOD_START, NOW);
  const result = await managerDashboard.buildManagerDashboard(db, FOUNDER);
  assert.equal(result.employeeCount, 1);
  assert.equal(result.employmentVersionGap.employeesWithoutOpenEmploymentVersion, 0);
  assert.deepEqual(result.employmentVersionGap.employeeIds, []);
  assert.match(result.employmentVersionGap.effect, /Every employee in scope has an open employment version/);
  assert.doesNotMatch(result.note, /no open employment version/, "with no gap the note does not invent one");
});

test("manager scope is unchanged: a manager still sees only their real direct reports", async () => {
  const { db, sqlite } = await headcountWorld();
  // WITH-1 manages WITH-2 only; the version-less employees report to nobody, so they stay out of a
  // manager's scope - that relationship genuinely lives on an open employment version.
  sqlite.prepare("UPDATE employee_employment_versions SET manager_employee_id='WITH-1' WHERE employee_id='WITH-2'").run();
  const result = await managerDashboard.buildManagerDashboard(db, { actorEmail: "with1@pawspace.in", permissions: ["people.view"], asOf: NOW });
  assert.equal(result.scope, "manager");
  assert.equal(result.employeeCount, 1, "one direct report, exactly as before the join was relaxed");
  assert.equal(result.employmentVersionGap.employeesWithoutOpenEmploymentVersion, 0);
});
