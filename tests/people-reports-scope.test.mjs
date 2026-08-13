/**
 * Manager scope on People reports, executed rather than grepped.
 *
 * The scoped reads built `scope.employeeIds.map(() => "?")` straight from the manager's roster
 * (lib/people-reports.ts:18 on main). Past 100 direct reports that exceeds D1's bound-parameter cap,
 * and the `all` helper there does not swallow - so the whole People report 500'd rather than
 * degrading. It survived the platform's IN-list sweep because that sweep exempted any file importing
 * d1-chunked-in, and this file already chunked its approval-event reads.
 *
 * The invariant these hold: a manager sees exactly their own reports, however many there are.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PSCOPE_DB__", "__PSCOPE_ENV__");

const D1_MAX_BOUND_PARAMS = 100;

function makeD1(sqlite) {
  function statement(sql, args) {
    const guard = () => {
      if (args.length > D1_MAX_BOUND_PARAMS) throw new Error("D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR");
    };
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { guard(); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { guard(); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { guard(); return { results: sqlite.prepare(sql).all(...args) }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const item of statements) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function seed(directReports) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PSCOPE_DB__ = db;
  globalThis.__PSCOPE_ENV__ = {};
  const { peopleReports } = await import("../lib/people-reports.ts");
  // One call creates every table the report reads, through the module's own ensure* chain.
  await peopleReports(db, { actorEmail: "nobody@pawspace.test", roleCode: "manager", permissions: ["attendance.view"] });

  const now = Date.now();
  const addEmployee = (id, email, managerId) => {
    sqlite.prepare("INSERT INTO employees (id,employee_code,display_name,work_email,user_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
      .run(id, id, `Person ${id}`, email, email, now, now, now);
    sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,manager_employee_id,team_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,?,'ops','seed','seed',?)")
      .run(`V-${id}`, id, now, managerId, now);
  };
  addEmployee("EMP-MGR", "manager@pawspace.test", null);
  for (let index = 0; index < directReports; index += 1) addEmployee(`EMP${String(index).padStart(4, "0")}`, `person${index}@pawspace.test`, "EMP-MGR");
  return { sqlite, db, peopleReports };
}

test("real execution: a manager with more direct reports than D1 allows bound parameters still gets a report", async () => {
  const { db, peopleReports } = await seed(120);
  const report = await peopleReports(db, { actorEmail: "manager@pawspace.test", roleCode: "manager", permissions: ["attendance.view"] });
  // Before chunking this threw "too many SQL variables" straight out of the module - a 500 on the
  // People console for exactly the managers who most need it.
  assert.equal(report.scope.employeeCount, 120, "the manager sees every one of their reports");
  assert.equal(report.headcount.active, 120);
  assert.equal(report.scope.mode, "manager");
});

test("real execution: the roster is exactly the manager's own reports, not the org", async () => {
  const { sqlite, db, peopleReports } = await seed(120);
  const now = Date.now();
  // Somebody else's report, under a different manager - it must not appear.
  sqlite.prepare("INSERT INTO employees (id,employee_code,display_name,work_email,user_email,employment_status,joined_at,created_at,updated_at) VALUES ('EMP-OTHER','EMP-OTHER','Other','other@pawspace.test','other@pawspace.test','active',?,?,?)").run(now, now, now);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,manager_employee_id,team_code,reason,actor_id,created_at) VALUES ('V-OTHER','EMP-OTHER',1,?,NULL,'EMP-SOMEONE-ELSE','ops','seed','seed',?)").run(now, now);

  const report = await peopleReports(db, { actorEmail: "manager@pawspace.test", roleCode: "manager", permissions: ["attendance.view"] });
  // 120, not 121 and not 122: chunking must not widen the scope to the org, and the manager is not
  // their own direct report.
  assert.equal(report.scope.employeeCount, 120, "another manager's report must never appear");
  assert.equal(report.headcount.total, 120);
});

test("real execution: a manager with no direct reports sees nobody", async () => {
  // What the old `AND 1=0` sentinel bought. The empty scope now short-circuits instead, so this is
  // asserted as behaviour rather than as a string in the source.
  const { db, peopleReports } = await seed(0);
  const report = await peopleReports(db, { actorEmail: "manager@pawspace.test", roleCode: "manager", permissions: ["attendance.view"] });
  assert.equal(report.scope.employeeCount, 0, "an empty scope is empty, never a broad fallback to the org");
  assert.equal(report.headcount.active, 0);
  assert.equal(report.headcount.total, 0);
});

test("real execution: an actor with no employee record gets nothing rather than everything", async () => {
  const { db, peopleReports } = await seed(120);
  const report = await peopleReports(db, { actorEmail: "ghost@pawspace.test", roleCode: "manager", permissions: ["attendance.view"] });
  assert.equal(report.scope.employeeCount, 0, "an unrecognised actor must not fall back to the whole org");
  assert.equal(report.scope.mode, "manager", "and is never silently promoted to org-wide scope");
});
