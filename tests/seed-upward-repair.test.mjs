/*
 * Seeds that repair what is already on staging, not only what is missing.
 *
 * INSERT OR IGNORE does exactly nothing to a row that already exists. Every seed in this repository is
 * written that way, and a redeploy therefore cannot correct a staging database that carries an OLDER
 * version of a seeded row — which is the state staging is actually in, because it has been seeded
 * before. #968 established the fix for the provider acceptance windows; this suite pins that the same
 * shape now covers the rows the owner decisions of 2026-09-22 depend on.
 *
 * Two properties, both asserted for every repair: it raises a stale seeded row, and it leaves a row a
 * person configured completely alone. A repair that overruled people would be worse than no repair.
 *
 * The seed files are executed, statement by statement, against a real database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SEED_REPAIR_DB__", "__SEED_REPAIR_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql), batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Runs the statements of `sql` that mention `table`, in file order, against a fresh database.
 *
 * `also` names further tables whose statements must come along: the balance repair asks
 * leave_ledger_events whether the leave has ever been used, so that table has to exist for it to run.
 */
function runSeed(sql, table, seedExisting = () => {}, also = []) {
  const sqlite = new DatabaseSync(":memory:");
  const wanted = [table, ...also];
  const statements = sql.split(";\n").map((line) => line.trim()).filter(Boolean).filter((line) => wanted.some((name) => line.includes(name)));
  // The pre-existing rows go in after EVERY CREATE has run, not after the first one: the balance repair
  // reads leave_ledger_events, so a fixture row for it cannot be written while that table is still two
  // statements away from existing.
  let created = false;
  const isDdl = (statement) => /(^|\n)\s*CREATE\s/i.test(statement);
  const ddl = statements.filter(isDdl);
  for (const statement of ddl) { sqlite.exec(`${statement};`); created = true; }
  assert.ok(created, `the seed must create ${table} before it writes to it`);
  seedExisting(sqlite);
  for (const statement of statements) if (!isDdl(statement)) sqlite.exec(`${statement};`);
  return sqlite;
}

test("the leave seed raises a stale seeded policy instead of walking past it", () => {
  const seed = read("scripts/employee-seed.sql");
  const stale = runSeed(seed, "leave_policies", (sqlite) => {
    // What an earlier seed left behind: drafted, and a smaller allowance than /me advertises.
    sqlite.prepare("INSERT INTO leave_policies (id,name,version,status,leave_code,allow_negative,entitlement_units,approval_reference,effective_from,created_by,created_at) VALUES ('SEED-LVP-CL','UAT Casual Leave',1,'draft','CL',0,3,'UAT-ONLY-NOT-PRODUCTION',1,'founder@pawspace.in',1)").run();
  });
  const cl = stale.prepare("SELECT status,entitlement_units FROM leave_policies WHERE id='SEED-LVP-CL'").get();
  assert.equal(cl.status, "active_uat", "a drafted seed policy cannot be applied for, so the form promises what the database refuses");
  assert.equal(cl.entitlement_units, 12, "and the allowance is raised to what /me advertises");

  for (const code of ["CL", "SL", "EL"]) {
    assert.equal(stale.prepare("SELECT status FROM leave_policies WHERE leave_code=?").get(code).status, "active_uat", `${code} must be usable`);
  }
});

test("the leave seed does not overrule a policy a person configured", () => {
  const seed = read("scripts/employee-seed.sql");
  const human = runSeed(seed, "leave_policies", (sqlite) => {
    sqlite.prepare("INSERT INTO leave_policies (id,name,version,status,leave_code,allow_negative,entitlement_units,approval_reference,effective_from,created_by,created_at) VALUES ('SEED-LVP-CL','Casual Leave',1,'retired','CL',0,3,'HR-APPROVAL-2026',1,'hr.manager@pawspace.in',1)").run();
  });
  const cl = human.prepare("SELECT status,entitlement_units,created_by FROM leave_policies WHERE id='SEED-LVP-CL'").get();
  assert.equal(cl.status, "retired", "a seed must never re-activate a policy a person retired");
  assert.equal(cl.entitlement_units, 3);
  assert.equal(cl.created_by, "hr.manager@pawspace.in");
});

test("a leave balance left at zero is raised, and one already larger is not reset", () => {
  const seed = read("scripts/employee-seed.sql");
  const employeeId = /INSERT OR IGNORE INTO employee_leave_balances \(employee_id,leave_code,balance,updated_at\) VALUES \('([^']+)','CL'/.exec(seed)?.[1];
  assert.ok(employeeId, "the seed must carry at least one employee balance");

  const emptied = runSeed(seed, "employee_leave_balances", (sqlite) => {
    sqlite.prepare("INSERT INTO employee_leave_balances (employee_id,leave_code,balance,updated_at) VALUES (?,'CL',0,1)").run(employeeId);
  }, ["leave_ledger_events"]);
  assert.equal(emptied.prepare("SELECT balance FROM employee_leave_balances WHERE employee_id=? AND leave_code='CL'").get(employeeId).balance, 12,
    "an untouched seeded balance left at zero cannot apply for the leave the form offers");

  const generous = runSeed(seed, "employee_leave_balances", (sqlite) => {
    sqlite.prepare("INSERT INTO employee_leave_balances (employee_id,leave_code,balance,updated_at) VALUES (?,'CL',30,1)").run(employeeId);
  }, ["leave_ledger_events"]);
  assert.equal(generous.prepare("SELECT balance FROM employee_leave_balances WHERE employee_id=? AND leave_code='CL'").get(employeeId).balance, 30,
    "the repair only ever raises: a larger balance someone granted is not taken away");
});

test("the trainer rate is published if a stale seeded row left it unpublished", () => {
  const seed = read("scripts/uat-staging-provider-capacity.sql");
  const stale = runSeed(seed, "training_compensation_rules", (sqlite) => {
    sqlite.prepare("INSERT INTO training_compensation_rules (id,city_id,provider_id,package_code,rate_type,rate_value,currency,status,version,effective_from,effective_to,updated_by,reason,updated_at) VALUES ('UAT-TRAINER-RATE-BLR','blr',NULL,NULL,'per_completed_session',1000,'INR','draft',1,'2026-01-01',NULL,'uat_staging_seed','UAT-ONLY-NOT-PRODUCTION: placeholder',1)").run();
  });
  const rule = stale.prepare("SELECT status,rate_value FROM training_compensation_rules WHERE id='UAT-TRAINER-RATE-BLR'").get();
  assert.equal(rule.status, "published", "an unpublished rule holds every completed session at 'pending rate configuration'");
  assert.equal(rule.rate_value, 1000, "the rate itself is untouched: raising a commercial figure automatically would be inventing policy");
});

test("the trainer-rate repair leaves Finance's own rule alone", () => {
  const seed = read("scripts/uat-staging-provider-capacity.sql");
  const human = runSeed(seed, "training_compensation_rules", (sqlite) => {
    sqlite.prepare("INSERT INTO training_compensation_rules (id,city_id,provider_id,package_code,rate_type,rate_value,currency,status,version,effective_from,effective_to,updated_by,reason,updated_at) VALUES ('UAT-TRAINER-RATE-BLR','blr',NULL,NULL,'per_completed_session',1500,'INR','superseded',2,'2026-01-01',NULL,'finance.manager@pawspace.in','Replaced by the approved rule',1)").run();
  });
  const rule = human.prepare("SELECT status,rate_value,updated_by FROM training_compensation_rules WHERE id='UAT-TRAINER-RATE-BLR'").get();
  assert.equal(rule.status, "superseded", "a seed must not republish a rule Finance superseded");
  assert.equal(rule.updated_by, "finance.manager@pawspace.in");
});

test("the AI rollout seed carries its repair too", () => {
  // Covered in full by tests/ai-customer-rollout-uat-only.test.mjs; asserted here so the three seeded
  // rows this release depends on are checked for the repair in one place.
  const seed = read("scripts/uat-staging-provider-capacity.sql");
  assert.match(seed, /UPDATE ai_audience_rollout SET stage='customers'/);
  assert.match(seed, /UPDATE training_compensation_rules SET status='published'/);
  assert.match(read("scripts/employee-seed.sql"), /UPDATE leave_policies SET status='active_uat'/);
  assert.match(read("scripts/employee-seed.sql"), /UPDATE employee_leave_balances SET balance=/);
});

test("employee-seed.sql is still exactly what the generator produces", async () => {
  // The repairs above were added to the GENERATOR, never to the .sql by hand. Hand-editing the file is
  // how four employee_employment_versions rows once diverged from it and were silently deleted by the
  // next regeneration, stripping every manager's organisational scope.
  const { execFileSync } = await import("node:child_process");
  const committed = read("scripts/employee-seed.sql");
  execFileSync(process.execPath, [new URL("../scripts/employee-seed-gen.mjs", import.meta.url).pathname], { stdio: "pipe" });
  assert.equal(read("scripts/employee-seed.sql"), committed, "regenerating the seed must change nothing");
});

test("after the repair, the real leave module accepts the request the /me form offers", async () => {
  /*
   * The point of the repair, stated as the thing a tester actually does.
   *
   * lib/attendance-leave.ts requestLeave looks the policy up as
   * `WHERE leave_code=? AND status='active_uat'` and refuses 409 "Active leave policy configuration is
   * required" when it finds none — which is exactly what a drafted seed row produces. Reading the rows
   * back with SQL proves the UPDATE ran; driving the real module proves the UPDATE fixed the thing the
   * tester was blocked on.
   */
  const seed = read("scripts/employee-seed.sql");
  const employeeId = /INSERT OR IGNORE INTO employee_leave_balances \(employee_id,leave_code,balance,updated_at\) VALUES \('([^']+)','CL'/.exec(seed)?.[1];
  assert.ok(employeeId, "the seed must carry at least one employee balance");

  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__SEED_REPAIR_DB__ = db;
  globalThis.__SEED_REPAIR_ENV__ = {};
  const leave = await import("../lib/attendance-leave.ts");
  await leave.ensureAttendanceLeaveTables(db);

  // The staging state the repair exists for: a seeded CL policy left drafted, with a token allowance,
  // and the tester's balance emptied.
  sqlite.prepare("INSERT INTO leave_policies (id,name,version,status,leave_code,allow_negative,entitlement_units,approval_reference,effective_from,created_by,created_at) VALUES ('SEED-LVP-CL','UAT Casual Leave',1,'draft','CL',0,1,'UAT-ONLY-NOT-PRODUCTION',1,'founder@pawspace.in',1)").run();
  sqlite.prepare("INSERT INTO employee_leave_balances (employee_id,leave_code,balance,updated_at) VALUES (?,'CL',0,1)").run(employeeId);

  const apply = () => leave.requestLeave(db, { employeeId, leaveCode: "CL", startDate: "2026-10-01", endDate: "2026-10-02", units: 2, reason: "Family function", actorId: "tester@pawspace.in" });

  let blocked = null;
  try { await apply(); } catch (error) { blocked = error; }
  assert.ok(blocked instanceof Response, "without the repair the tester is refused, which is the defect");
  assert.equal(blocked.status, 409);

  // Now run the seed's own leave statements over that same database, exactly as a redeploy would.
  for (const statement of seed.split(";\n").map((line) => line.trim()).filter((line) => /leave_policies|employee_leave_balances/.test(line))) {
    if (/^CREATE /i.test(statement)) continue;
    sqlite.exec(`${statement};`);
  }

  const granted = await apply();
  assert.equal(granted.status, "pending", "after the repair the leave the /me form advertises can actually be applied for");
  assert.ok(granted.id);

  // And an unknown code is still refused, per the decision: seeding CL/SL/EL does not open everything.
  let unknown = null;
  try { await leave.requestLeave(db, { employeeId, leaveCode: "ZZ", startDate: "2026-10-01", endDate: "2026-10-02", units: 1, reason: "Unknown code", actorId: "tester@pawspace.in" }); }
  catch (error) { unknown = error; }
  assert.ok(unknown instanceof Response);
  assert.equal(unknown.status, 409, "an unknown leave code still answers 409");
});

test("a redeploy never hands back leave somebody already took", () => {
  /*
   * "balance below the seeded figure" was not a safe test on its own. A tester who had taken 5 of their
   * 12 days sits at 7, which is below 12, so every redeploy restored those 5 days and let them apply for
   * leave they had already spent. leave_ledger_events is the record of what was actually used, and its
   * presence is what makes a balance untouchable.
   */
  const seed = read("scripts/employee-seed.sql");
  const employeeId = /INSERT OR IGNORE INTO employee_leave_balances \(employee_id,leave_code,balance,updated_at\) VALUES \('([^']+)','CL'/.exec(seed)?.[1];

  const spent = runSeed(seed, "employee_leave_balances", (sqlite) => {
    sqlite.prepare("INSERT INTO employee_leave_balances (employee_id,leave_code,balance,updated_at) VALUES (?,'CL',7,1)").run(employeeId);
    sqlite.prepare("INSERT INTO leave_ledger_events (id,idempotency_key,employee_id,leave_code,event_type,units,source_request_id,actor_id,created_at) VALUES ('LLE-1','leave:LVR-1:approved',?,'CL','debit',-5,'LVR-1','hr@pawspace.in',2)").run(employeeId);
  }, ["leave_ledger_events"]);

  assert.equal(spent.prepare("SELECT balance FROM employee_leave_balances WHERE employee_id=? AND leave_code='CL'").get(employeeId).balance, 7,
    "five days taken stay taken; a seed must never credit leave back");
});
