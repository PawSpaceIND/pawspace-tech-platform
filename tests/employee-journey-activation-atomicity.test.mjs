/*
 * A refused employee activation must leave NOTHING behind.
 *
 * onboardEmployeeJourney used to write in this order:
 *
 *     upsertEmployee -> addEmploymentVersion -> assignCompensation -> INSERT app_users
 *                    -> employeeJourneyReadiness()  <- evaluated LAST, throws if not ready
 *
 * with no transaction and no compensating delete. The readiness gate it throws from includes
 * `compensation_assignment`, which requires `a.effective_from<=now` - and effective_from is derived
 * from joinedAt. So ANY joined date in the future is a GUARANTEED throw AFTER all four writes have
 * committed. The operator saw HTTP 500 "People update failed" and a red alert; the database was left
 * holding an active employees row, an active app_users row (a working staff login), an open
 * employment version and an open compensation assignment. Only employee_journey_activations - the one
 * row nobody pays from - was missing. The ghost then appeared on /team/people and was PAID by the
 * next payroll run, and because re-submitting the form failed identically the operator never learned
 * it existed.
 *
 * These tests EXECUTE the real function against a real SQLite-backed D1 rather than reading source,
 * because the property at stake is what the database holds after the refusal, not what the code says.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const { onboardEmployeeJourney, ensureEmployeeJourneyTables, employeeJourneyReadiness } = await importLibModule("employee-journey-onboarding");
const { saveSalaryStructure, calculatePayroll } = await importLibModule("payroll-engine");
const { isGovernedHttpError } = await importLibModule("governed-http-error");
const { authError } = await importLibModule("server-auth");

const DAY = 86_400_000;

async function world() {
  const w = freshCountingD1();
  await ensureEmployeeJourneyTables(w.db);
  const structure = await saveSalaryStructure(w.db, {
    structureCode: "STD",
    effectiveFrom: Date.now() - 90 * DAY,
    components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 52_200 }],
    actorId: "hr@pawspace.test",
  });
  return { ...w, structureId: String(structure.id) };
}

const activation = (w, overrides = {}) => ({
  employeeCode: "EMP-GHOST",
  displayName: "Ghost Employee",
  workEmail: "ghost@pawspace.test",
  joinedAt: Date.now() - 30 * DAY,
  employmentType: "direct_employee",
  teamCode: "sales",
  locationCode: "blr",
  structureId: w.structureId,
  roleCode: "associate",
  reason: "Employee activation test",
  actorId: "hr@pawspace.test",
  ...overrides,
});

/** Every row a refused activation must NOT leave behind, keyed by the column that identifies it. */
function residue(sqlite, { employeeCode = "EMP-GHOST", email = "ghost@pawspace.test" } = {}) {
  const employee = sqlite.prepare("SELECT id FROM employees WHERE employee_code=? OR work_email=?").get(employeeCode, email);
  const employeeId = employee ? String(employee.id) : "__none__";
  const count = (sql, ...args) => Number(sqlite.prepare(sql).get(...args).n);
  return {
    employees: count("SELECT COUNT(*) n FROM employees WHERE employee_code=? OR work_email=?", employeeCode, email),
    app_users: count("SELECT COUNT(*) n FROM app_users WHERE lower(email)=lower(?)", email),
    employee_employment_versions: count("SELECT COUNT(*) n FROM employee_employment_versions WHERE employee_id=?", employeeId),
    employee_compensation_assignments: count("SELECT COUNT(*) n FROM employee_compensation_assignments WHERE employee_id=?", employeeId),
    employee_journey_activations: count("SELECT COUNT(*) n FROM employee_journey_activations WHERE employee_id=?", employeeId),
  };
}

async function refused(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("activation was expected to be refused, but it succeeded");
}

test("P0: a future joined date is refused BEFORE any write, leaving no employee, no login, no employment version and no compensation row", async () => {
  const w = await world();
  const error = await refused(onboardEmployeeJourney(w.db, activation(w, { joinedAt: Date.now() + 7 * DAY })));

  assert.deepEqual(residue(w.sqlite), {
    employees: 0,
    app_users: 0,
    employee_employment_versions: 0,
    employee_compensation_assignments: 0,
    employee_journey_activations: 0,
  }, "a refused activation must leave the database exactly as it found it - anything here is a payable ghost employee and a working staff login");

  assert.ok(error instanceof Response, `the refusal must be a governed Response, got ${error?.constructor?.name}: ${error?.message ?? ""}`);
});

test("P0: the refusal reaches the operator as a 4xx carrying the real reason, not 500 'People update failed'", async () => {
  const w = await world();
  const error = await refused(onboardEmployeeJourney(w.db, activation(w, { joinedAt: Date.now() + 7 * DAY })));

  assert.ok(error instanceof Response, "must throw a Response so the route can surface it");
  assert.ok(isGovernedHttpError(error), "must be registered with governedJsonError - a bare thrown Response has its body replaced by the route fallback");

  // Exactly what app/api/people-foundation/route.ts does in its catch block.
  const response = authError(error, "People update failed");
  assert.ok(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`);
  const body = await response.json();
  assert.notEqual(body.error, "People update failed", "the operator must be told the real reason, not the route's generic fallback");
  assert.match(String(body.error), /future|joined/i, `the reason must name the joined date, got: ${body.error}`);
});

test("a valid activation still works end to end and still records employee_journey_activations", async () => {
  const w = await world();
  const result = await onboardEmployeeJourney(w.db, activation(w, { employeeCode: "EMP-OK", workEmail: "ok@pawspace.test" }));

  assert.equal(result.status, "active");
  assert.equal(result.readiness.ready, true);
  assert.ok(result.readiness.checks.every((c) => c.passed), JSON.stringify(result.readiness.checks));

  const rows = residue(w.sqlite, { employeeCode: "EMP-OK", email: "ok@pawspace.test" });
  assert.deepEqual(rows, {
    employees: 1,
    app_users: 1,
    employee_employment_versions: 1,
    employee_compensation_assignments: 1,
    employee_journey_activations: 1,
  });

  const stored = await employeeJourneyReadiness(w.db, result.employeeId);
  assert.equal(stored.ready, true);

  const run = await calculatePayroll(w.db, { periodStart: Date.now() - 30 * DAY, periodEnd: Date.now() - 1, idempotencyKey: "valid-activation", actorId: "payroll@pawspace.test" });
  assert.deepEqual(run.results.map((r) => String(r.employee_id)), [result.employeeId]);
});

test("a refused activation never becomes payable: payroll sees no ghost employee afterwards", async () => {
  const w = await world();
  await refused(onboardEmployeeJourney(w.db, activation(w, { joinedAt: Date.now() + 7 * DAY })));

  const run = await calculatePayroll(w.db, { periodStart: Date.now() - 30 * DAY, periodEnd: Date.now() + 30 * DAY, idempotencyKey: "post-refusal", actorId: "payroll@pawspace.test" });
  assert.deepEqual(run.results, [], "a refused activation must not produce a payroll result");
});

test("the operator can correct the date and complete the activation - a refusal does not wedge the form", async () => {
  const w = await world();
  await refused(onboardEmployeeJourney(w.db, activation(w, { joinedAt: Date.now() + 7 * DAY })));
  const result = await onboardEmployeeJourney(w.db, activation(w, { joinedAt: Date.now() - 1 * DAY }));
  assert.equal(result.readiness.ready, true);
  assert.equal(residue(w.sqlite).employee_journey_activations, 1);
});

test("a late refusal (the salary structure is retired mid-activation) is compensated: no partial employee survives", async () => {
  const w = await world();
  // A concurrent actor retires the structure after preflight has already accepted it. The readiness
  // gate then fails for real, after writes have happened - the case a preflight alone cannot cover.
  const retireOnCompensationWrite = {
    ...w.db,
    prepare(sql) {
      const statement = w.db.prepare(sql);
      if (!/INSERT INTO employee_compensation_assignments/.test(sql)) return statement;
      const wrap = (s) => ({
        ...s,
        bind: (...args) => wrap(s.bind(...args)),
        run: async () => {
          const out = await s.run();
          w.sqlite.prepare("UPDATE salary_structure_versions SET status='retired'").run();
          return out;
        },
      });
      return wrap(statement);
    },
  };

  const error = await refused(onboardEmployeeJourney(retireOnCompensationWrite, activation(w)));
  assert.ok(error instanceof Response && isGovernedHttpError(error), "a late refusal must also reach the operator as a governed 4xx");
  assert.deepEqual(residue(w.sqlite), {
    employees: 0,
    app_users: 0,
    employee_employment_versions: 0,
    employee_compensation_assignments: 0,
    employee_journey_activations: 0,
  }, "a late failure must be compensated - the writes are rolled back explicitly");
});

test("the onboarding form cannot offer a joined date the server will always refuse", async () => {
  const fs = await import("node:fs");
  const page = fs.readFileSync("app/team/people/onboarding/page.tsx", "utf8");
  assert.match(page, /type="date"[^>]*max=/, "the joined-date input must carry a max so a future date is not selectable");
});
