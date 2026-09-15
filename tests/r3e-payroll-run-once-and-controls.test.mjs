/**
 * Payroll: one run per period, and a screen that can actually run one.
 *
 * Round-3 runtime audit R3-E, reproduced here against the REAL engine, the REAL route handler and the
 * SHIPPED screen - never against the source text.
 *
 *  E1  THE SAME PAYROLL PERIOD COULD BE RUN, APPROVED, PAID AND POSTED TWICE. calculatePayroll guarded
 *      only on the caller-supplied idempotencyKey and looked at no other run's PERIOD, so two calls
 *      for the identical month with two different keys produced two runs, two sets of payslips and two
 *      Finance journals - 6,38,000 booked for one month's 3,19,000 payroll, while the employee's own
 *      /me payslip table listed the period twice and "latest net-pay variance" read 0.00 because it
 *      was comparing the duplicate against itself.
 *  E2  PAYROLL HAD NO WRITE UI AT ALL. app/team/people/payroll/page.tsx was nine lines and read-only,
 *      and the only fetch("/api/payroll") calls in the product were that page's GET and the onboarding
 *      structure dropdown. save_structure, assign_compensation, calculate, review, approve and
 *      prepare_payment were posted by no .tsx in the repository.
 *  E9  authorize_live_disbursement threw bare Responses, so every refusal reached the caller as
 *      "Payroll update failed", and the record it wrote was read by nothing.
 *
 * Every assertion below is on a stored row, a status code, a number, or rendered HTML.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__R3E_PAYROLL_DB__", "__R3E_PAYROLL_ENV__");

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const route = await import("../app/api/payroll/route.ts");
const screen = await import("../app/team/people/payroll/page.tsx");
const payroll = await import("../lib/payroll-engine.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
const { issuePrivilegedSession } = await import("../lib/admin-mfa.ts");

const API = "https://uat.pawspace.in/api/payroll";
const MAKER = "payroll.maker@pawspace.test";      // finance -> payroll.manage + payroll.approve
const REVIEWER = "payroll.reviewer@pawspace.test"; // finance
const APPROVER = "ada.admin@pawspace.test";        // admin   -> payroll.approve, NOT payroll.manage
const COMP = "comp.owner@pawspace.test";           // custom role holding compensation.manage
const NOW = Date.UTC(2026, 8, 15, 6, 0, 0);

const post = (email, body, cookie = "") => route.POST(new Request(API, {
  method: "POST",
  headers: { "content-type": "application/json", "oai-authenticated-user-email": email, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
}));
const get = (email, query = "") => route.GET(new Request(`${API}${query}`, { headers: { "oai-authenticated-user-email": email } }));
const read = async (response) => ({ status: response.status, body: await response.json() });
const count = (sqlite, table, where = "1=1", ...args) => Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args).c);

/** Real roles, real identities, two employees on one salary structure. */
async function world() {
  const { db, sqlite } = freshCountingD1();
  globalThis.__R3E_PAYROLL_DB__ = db;
  globalThis.__R3E_PAYROLL_ENV__ = {};
  enterWorkersDbScope(db);
  await ensureSecurityTables(db);
  await ensurePeopleTables(db);
  await payroll.ensurePayrollTables(db);
  const user = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  user.run("U-MAKER", MAKER, "Mira Maker", "finance", NOW, NOW);
  user.run("U-REVIEWER", REVIEWER, "Raj Reviewer", "finance", NOW, NOW);
  user.run("U-APPROVER", APPROVER, "Ada Admin", "admin", NOW, NOW);
  // A CUSTOM role, so this suite does not depend on whether compensation.manage is granted to any
  // shipped role - which is an open owner decision, not something a payroll test should assume.
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('compensation_owner','Compensation owner','Holds compensation.manage.',?,0,?)")
    .run(JSON.stringify(["dashboard.view", "payroll.view", "compensation.view", "compensation.manage"]), NOW);
  user.run("U-COMP", COMP, "Cara Compensation", "compensation_owner", NOW, NOW);

  const employee = sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)");
  employee.run("EMP-1", "emp1@pawspace.test", "PS-1", "Employee One", "emp1@pawspace.test", Date.UTC(2026, 0, 1), NOW, NOW);
  employee.run("EMP-2", "emp2@pawspace.test", "PS-2", "Employee Two", "emp2@pawspace.test", Date.UTC(2026, 0, 1), NOW, NOW);
  return { db, sqlite };
}

/** BASIC 40000 + HRA 20000, PF -1800, TRAVEL +2000 reimbursement: the R3-E structure, exactly. */
const COMPONENTS = [
  { code: "BASIC", label: "Basic", kind: "earning", amount: 40_000 },
  { code: "HRA", label: "House rent allowance", kind: "earning", amount: 20_000 },
  { code: "PF", label: "Provident fund", kind: "deduction", amount: 1_800 },
  { code: "TRAVEL", label: "Travel reimbursement", kind: "reimbursement", amount: 2_000 },
  { code: "EPF", label: "Employer provident fund", kind: "employer_cost", amount: 1_800 },
];

async function compensate(db, { effectiveFrom = Date.UTC(2026, 0, 1) } = {}) {
  const structure = await payroll.saveSalaryStructure(db, { structureCode: "R3E-STD", effectiveFrom, components: COMPONENTS, actorId: COMP });
  for (const employeeId of ["EMP-1", "EMP-2"]) {
    await payroll.assignCompensation(db, { employeeId, structureId: String(structure.id), effectiveFrom, reason: "Initial compensation assignment", actorId: COMP });
  }
  return structure;
}

// The period R3-E actually ran, as IST month bounds: 1 Sep 2026 00:00 IST -> 1 Oct 2026 00:00 IST.
const SEPT = screen.payrollMonthBounds("2026-09");
const OCT = screen.payrollMonthBounds("2026-10");

// =================================================================================================
// E1. One period, one run.
// =================================================================================================

test("E1: a second payroll run over the same period is refused, with the run that already covers it named", async () => {
  const { db, sqlite } = await world();
  await compensate(db);

  const first = await read(await post(MAKER, { action: "calculate", periodStart: SEPT.periodStart, periodEnd: SEPT.periodEnd, idempotencyKey: "r3e-sept-A" }));
  assert.equal(first.status, 200);
  assert.equal(first.body.data.results.length, 2);
  assert.equal(Number(first.body.data.results[0].net_pay), 60_200, "40,000 + 20,000 - 1,800 + 2,000");

  // The R3-E reproduction, verbatim: the identical period under a second key.
  const second = await read(await post(MAKER, { action: "calculate", periodStart: SEPT.periodStart, periodEnd: SEPT.periodEnd, idempotencyKey: "r3e-sept-B-DOUBLE" }));
  assert.equal(second.status, 409, "a second run of the same month must be refused, not calculated");
  assert.match(second.body.error, /duplicate_period/);
  assert.match(second.body.error, new RegExp(String(first.body.data.run.id)), "the refusal must name the run that already covers those days");
  assert.notEqual(second.body.error, "Payroll update failed", "the reason must survive authError(), not be redacted");

  // The outcome that matters: nobody is paid twice, and there is nothing for Finance to post twice.
  assert.equal(count(sqlite, "payroll_runs"), 1);
  assert.equal(count(sqlite, "employee_payroll_results"), 2);
  assert.equal(count(sqlite, "payslips"), 2);
  assert.equal(Number(sqlite.prepare("SELECT COALESCE(SUM(net_pay),0) t FROM employee_payroll_results").get().t), 120_400, "one month's payroll, once");

  // A partially overlapping period is the same refusal - the rule is the days, not the exact pair.
  const overlapping = await read(await post(MAKER, { action: "calculate", periodStart: SEPT.periodStart + 86_400_000, periodEnd: SEPT.periodEnd + 86_400_000, idempotencyKey: "r3e-sept-C" }));
  assert.equal(overlapping.status, 409);
  assert.match(overlapping.body.error, /duplicate_period/);
  assert.equal(count(sqlite, "payroll_runs"), 1);
});

test("E1: the same key still replays into the same run, and the next month still runs", async () => {
  const { db, sqlite } = await world();
  await compensate(db);

  const first = await read(await post(MAKER, { action: "calculate", ...SEPT }));
  assert.equal(first.status, 200);
  assert.equal(first.body.data.duplicatePrevented, false);

  // A double-clicked button sends the SAME derived key: an idempotent replay, which is the only thing
  // an idempotency key was ever protecting against.
  const replay = await read(await post(MAKER, { action: "calculate", ...SEPT }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(String(replay.body.data.run.id), String(first.body.data.run.id));

  // October begins exactly where September ends, so the guard must not touch it.
  const october = await read(await post(MAKER, { action: "calculate", ...OCT }));
  assert.equal(october.status, 200, "adjacent months must not be refused as overlapping");
  assert.equal(october.body.data.duplicatePrevented, false);
  assert.equal(count(sqlite, "payroll_runs"), 2);
});

test("E1: the calculate control refuses the month before it is sent, and derives a stable key", async () => {
  // IST month bounds, not UTC ones: 1 Sep 2026 00:00 IST is 31 Aug 18:30Z, which is what makes the
  // downstream Finance period code read back as 2026-09 rather than 2026-10.
  assert.equal(SEPT.periodStart, Date.parse("2026-09-01T00:00:00.000+05:30"));
  assert.equal(SEPT.periodEnd, Date.parse("2026-10-01T00:00:00.000+05:30"));
  assert.equal(new Date(SEPT.periodEnd).toISOString().slice(0, 7), "2026-09", "the Finance period code derived from period_end must be the month the payroll is FOR");
  assert.equal(SEPT.idempotencyKey, "payroll-month:2026-09");
  assert.equal(screen.payrollMonthBounds("2026-12").periodEnd, Date.parse("2027-01-01T00:00:00.000+05:30"), "December must roll into the next year");

  const runs = [{ id: "PAYRUN-EXISTING", period_start: SEPT.periodStart, period_end: SEPT.periodEnd, status: "approved", created_by: MAKER }];
  const blocked = screen.calculatePayrollPayload("2026-09", runs);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /already been calculated as payroll run PAYRUN-EXISTING/);
  const open = screen.calculatePayrollPayload("2026-10", runs);
  assert.equal(open.ok, true);
  assert.deepEqual(open.body, { action: "calculate", ...OCT });

  // Two presses of the same button send the same key, which is what makes a double click harmless.
  assert.equal(screen.calculatePayrollPayload("2026-10", runs).body.idempotencyKey, open.body.idempotencyKey);
});

// =================================================================================================
// E2. The whole payroll journey, driven through the screen's own controls.
// =================================================================================================

test("E2: the payroll journey completes through the screen's controls, with maker/checker enforced", async () => {
  const { sqlite } = await world();

  // 1. Compensation, from the screen's builders.
  const structureBody = screen.saveStructurePayload({
    structureCode: "R3E-STD", effectiveFrom: "2026-01-01", approvalReference: "BOARD-2026-01",
    components: COMPONENTS.map((c) => ({ code: c.code, label: c.label, kind: c.kind, amount: String(c.amount) })),
  });
  assert.equal(structureBody.ok, true, structureBody.ok ? "" : structureBody.error);
  const structure = await read(await post(COMP, structureBody.body));
  assert.equal(structure.status, 200, JSON.stringify(structure.body));
  assert.equal(Number(structure.body.data.version), 1);

  for (const employeeId of ["EMP-1", "EMP-2"]) {
    const assign = screen.assignCompensationPayload({ employeeId, structureId: String(structure.body.data.id), effectiveFrom: "2026-01-01", reason: "Initial compensation assignment" });
    assert.equal(assign.ok, true, assign.ok ? "" : assign.error);
    assert.equal((await read(await post(COMP, assign.body))).status, 200);
  }

  // 2. Calculate, as the maker.
  const calculate = screen.calculatePayrollPayload("2026-09", []);
  assert.equal(calculate.ok, true);
  const run = await read(await post(MAKER, calculate.body));
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const runId = String(run.body.data.run.id);
  assert.equal(run.body.data.results.length, 2);

  // 3. Review. The maker cannot review their own run, and the screen says so before the click.
  const directoryAsMaker = (await read(await get(MAKER))).body.data;
  const makerGates = screen.runGates(directoryAsMaker.runs.find((r) => r.id === runId), directoryAsMaker.scope);
  assert.equal(makerGates.review.visible, true);
  assert.equal(makerGates.review.enabled, false, "the maker's own Review button must be dead");
  assert.match(makerGates.review.reason, /somebody else has to review it/);
  const selfReview = await read(await post(MAKER, screen.reviewPayload(runId)));
  assert.equal(selfReview.status, 409, "and the engine refuses it anyway");
  assert.match(selfReview.body.error, /maker cannot review their own run/);

  const directoryAsReviewer = (await read(await get(REVIEWER))).body.data;
  assert.equal(screen.runGates(directoryAsReviewer.runs.find((r) => r.id === runId), directoryAsReviewer.scope).review.enabled, true);
  assert.equal((await read(await post(REVIEWER, screen.reviewPayload(runId)))).status, 200);

  // 4. Approve. Neither the maker nor the reviewer may.
  for (const actor of [MAKER, REVIEWER]) {
    const refused = await read(await post(actor, screen.approvePayload(runId)));
    assert.equal(refused.status, 409, `${actor} must not be able to approve`);
    assert.match(refused.body.error, /Maker\/reviewer cannot approve their own payroll run/);
  }
  const directoryAsApprover = (await read(await get(APPROVER))).body.data;
  const approverGates = screen.runGates(directoryAsApprover.runs.find((r) => r.id === runId), directoryAsApprover.scope);
  assert.equal(approverGates.approve.visible, true);
  assert.equal(approverGates.approve.enabled, true);
  assert.equal((await read(await post(APPROVER, screen.approvePayload(runId)))).status, 200);

  // 5. Prepare the sandbox payment batch, and nothing is transmitted.
  const batch = await read(await post(MAKER, screen.preparePaymentPayload(runId)));
  assert.equal(batch.status, 200);
  assert.equal(batch.body.data.externalTransmission, false);
  assert.equal(Number(sqlite.prepare("SELECT external_transmission e FROM payroll_payment_batches WHERE run_id=?").get(runId).e), 0);
  assert.equal(Number(sqlite.prepare("SELECT total_amount t FROM payroll_payment_batches WHERE run_id=?").get(runId).t), 120_400);
  assert.equal(sqlite.prepare("SELECT status FROM payroll_runs WHERE id=?").get(runId).status, "payment_prepared");

  // 6. The payslip register, which no screen could read at all.
  const register = await read(await get(MAKER, `?mode=register&runId=${runId}`));
  assert.equal(register.status, 200);
  assert.equal(register.body.data.register.length, 2);
  assert.deepEqual(register.body.data.register.map((r) => r.employee_code).sort(), ["PS-1", "PS-2"]);
  assert.equal(Number(register.body.data.register[0].net_pay), 60_200);
  assert.equal(Number(register.body.data.register[0].reimbursements), 2_000);

  // The trail the whole journey left.
  assert.deepEqual(
    sqlite.prepare("SELECT event_type FROM payroll_approval_events WHERE run_id=? ORDER BY created_at").all(runId).map((r) => String(r.event_type)),
    ["reviewed", "approved", "payment_prepared"],
  );
});

test("E2: the screen draws the controls the actor's permissions can actually use", async () => {
  const { db } = await world();
  await compensate(db);
  await post(MAKER, { action: "calculate", ...SEPT });

  const render = async (email) => {
    const data = (await read(await get(email))).body.data;
    return {
      data,
      html: renderToStaticMarkup(React.createElement(screen.PayrollScreen, {
        data, busy: false, loading: false, error: "", message: "", selectedRunId: "", register: [],
        onSelect: () => {}, onPost: async () => {}, onRefresh: () => {},
      })),
    };
  };

  const maker = await render(MAKER);
  assert.equal(maker.data.scope.canManagePayroll, true);
  assert.match(maker.html, /Calculate payroll<\/button>/, "payroll.manage must get the calculate control the product never had");
  assert.match(maker.html, /Payslip register<\/button>/);
  // The maker cannot review their own run: the button is rendered DISABLED with the reason beside it.
  assert.match(maker.html, /<button disabled=""[^>]*>Review<\/button>/);
  assert.match(maker.html, /somebody else has to review it/);

  const approver = await render(APPROVER);
  assert.equal(approver.data.scope.canManagePayroll, false, "admin holds payroll.approve, not payroll.manage");
  assert.doesNotMatch(approver.html, /Calculate payroll<\/button>/, "a control the route would refuse must not be drawn");

  // compensation.manage is the one that is NOT held by every payroll role: when the actor lacks it the
  // screen says so in words instead of silently omitting half the journey.
  assert.equal(maker.data.scope.canManageCompensation === true || maker.data.scope.canManageCompensation === false, true);
  if (!maker.data.scope.canManageCompensation) {
    assert.match(maker.html, /Compensation controls are out of reach/);
    assert.doesNotMatch(maker.html, /Publish structure version<\/button>/);
  }

  const comp = await render(COMP);
  assert.equal(comp.data.scope.canManageCompensation, true);
  assert.match(comp.html, /Publish structure version<\/button>/);
  assert.match(comp.html, /Assign compensation<\/button>/);
});

test("E2: the structure and compensation builders refuse what the engine would refuse", async () => {
  assert.equal(screen.saveStructurePayload({ structureCode: "", effectiveFrom: "2026-01-01", approvalReference: "", components: [] }).ok, false);
  assert.match(screen.saveStructurePayload({ structureCode: "STD", effectiveFrom: "", approvalReference: "", components: [] }).error, /effective date/);
  assert.match(screen.saveStructurePayload({ structureCode: "STD", effectiveFrom: "2026-01-01", approvalReference: "", components: [] }).error, /At least one explicit salary component/);
  assert.match(screen.saveStructurePayload({ structureCode: "STD", effectiveFrom: "2026-01-01", approvalReference: "", components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: "-1" }] }).error, /zero or more/);
  const good = screen.saveStructurePayload({ structureCode: "STD", effectiveFrom: "2026-01-01", approvalReference: "", components: [{ code: " BASIC ", label: " Basic ", kind: "earning", amount: "40000" }] });
  assert.equal(good.ok, true);
  assert.equal(good.body.effectiveFrom, Date.parse("2026-01-01T00:00:00.000+05:30"), "effective dates are IST days");
  assert.deepEqual(good.body.components, [{ code: "BASIC", label: "Basic", kind: "earning", amount: 40_000 }]);

  assert.match(screen.assignCompensationPayload({ employeeId: "", structureId: "S", effectiveFrom: "2026-01-01", reason: "a valid reason" }).error, /Choose the employee/);
  assert.match(screen.assignCompensationPayload({ employeeId: "E", structureId: "S", effectiveFrom: "2026-01-01", reason: "short" }).error, /8 characters/);
  assert.equal(screen.assignCompensationPayload({ employeeId: "E", structureId: "S", effectiveFrom: "2026-01-01", reason: "a valid reason" }).ok, true);
});

// =================================================================================================
// E9. The live-disbursement control: a refusal that keeps its reason, and a record something reads.
// =================================================================================================

test("E9: every live-disbursement refusal reaches the caller with its own reason", async () => {
  const { db, sqlite } = await world();
  await compensate(db);
  const run = await read(await post(MAKER, { action: "calculate", ...SEPT }));
  const runId = String(run.body.data.run.id);
  await post(REVIEWER, { action: "review", runId });
  await post(APPROVER, { action: "approve", runId });

  // No MFA-backed privileged session: 401 with the reason, not 401 "Payroll update failed".
  const noMfa = await read(await post(APPROVER, screen.authorizeLiveDisbursementPayload(runId)));
  assert.equal(noMfa.status, 401);
  assert.match(noMfa.body.error, /Fresh MFA-backed privileged session is required/);
  assert.notEqual(noMfa.body.error, "Payroll update failed");

  // The maker, with a real MFA session: refused on maker/checker, and told which rule refused them.
  const session = await issuePrivilegedSession(db, "U-MAKER");
  const makerAttempt = await read(await post(MAKER, screen.authorizeLiveDisbursementPayload(runId), `pawspace_admin_mfa=${session.token}`));
  assert.equal(makerAttempt.status, 409);
  assert.match(makerAttempt.body.error, /Payroll maker\/reviewer cannot authorize live disbursement/);
  assert.notEqual(makerAttempt.body.error, "Payroll update failed", "R3-E read exactly this as 409 'Payroll update failed'");
  assert.equal(count(sqlite, "payroll_live_disbursement_approvals"), 0, "a refused authorization must record nothing");
});

test("E9: an authorization that succeeds is read back by the product, and still transmits nothing", async () => {
  const { db, sqlite } = await world();
  await compensate(db);
  const run = await read(await post(MAKER, { action: "calculate", ...SEPT }));
  const runId = String(run.body.data.run.id);
  await post(REVIEWER, { action: "review", runId });
  await post(APPROVER, { action: "approve", runId });

  const session = await issuePrivilegedSession(db, "U-APPROVER");
  const authorized = await read(await post(APPROVER, screen.authorizeLiveDisbursementPayload(runId), `pawspace_admin_mfa=${session.token}`));
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  assert.equal(authorized.body.data.approved, true);
  assert.equal(authorized.body.data.transmitsPayment, false, "the control must say what it does NOT do");
  assert.match(authorized.body.data.effect, /authorization_record_only/);
  assert.equal(count(sqlite, "payroll_live_disbursement_approvals", "run_id=?", runId), 1);

  // R3-E: "the record is read by nothing - a control that reports success and does nothing." It is
  // read now, by the directory the screen renders.
  const directory = (await read(await get(APPROVER))).body.data;
  const recorded = directory.liveDisbursementAuthorizations.find((a) => a.run_id === runId);
  assert.ok(recorded, "the recorded authorization must reach the screen");
  assert.equal(recorded.actor_email, APPROVER);
  const html = renderToStaticMarkup(React.createElement(screen.PayrollScreen, {
    data: directory, busy: false, loading: false, error: "", message: "", selectedRunId: "", register: [],
    onSelect: () => {}, onPost: async () => {}, onRefresh: () => {},
  }));
  assert.match(html, /Live-disbursement authorisation recorded by/);
  assert.match(html, /nothing is transmitted/);

  // And the property that must never regress.
  assert.equal(directory.truth.bankTransmissionEnabled, false);
  const batch = await read(await post(MAKER, screen.preparePaymentPayload(runId)));
  assert.equal(batch.body.data.externalTransmission, false);
  assert.equal(count(sqlite, "payroll_payment_batches", "external_transmission<>0"), 0, "no batch may ever be marked as transmitted");
});
