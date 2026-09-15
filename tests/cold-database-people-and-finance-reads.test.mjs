/*
 * Two more screens that answered 500 on a cold database, found by probing every GET endpoint as an
 * admin against a freshly created D1:
 *
 *   /api/attendance-leave      -> "no such table: employees"
 *   /api/finance-intelligence  -> "no such table: finance_journal_entries"
 *
 * Same shape as the /api/training-ops defect beside this file: a route reads tables another module
 * owns and assumes whoever writes the rows has already created them. That holds on a warm database
 * and fails on exactly the databases that matter - a fresh preview branch, a rebuilt D1, a restored
 * backup, a rollback, and the first day of any new environment.
 *
 * What the operator saw was not an error they could act on. Attendance rendered "Unable to load
 * attendance and leave" over the whole screen; Finance Intelligence rendered "Unable to load finance
 * intelligence" where the anomaly list goes - both indistinguishable from the platform being down.
 *
 * Fixed by ensuring the tables through their OWNERS (lib/people-foundation.ts, lib/finance-accounts.ts
 * and lib/gst-accounting.ts), so there is still exactly one definition of each. Not by catching the
 * missing table: the attendance route already did that on two of its three reads, and a catch that
 * swallows a missing table swallows a real read failure too, then renders it as an empty roster.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__COLD_PEOPLE_FINANCE_DB__");

const staffRequest = (url) => new Request(url, { headers: { "oai-authenticated-user-email": "founder@pawspace.in" } });

/** A database on which nothing but the security tables any authenticated request needs has been created. */
async function coldWorld() {
  const harness = freshCountingD1();
  globalThis.__COLD_PEOPLE_FINANCE_DB__ = harness.db;
  enterWorkersDbScope(harness.db);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(harness.db);
  const now = Date.now();
  await harness.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .bind("USR-COLD-FOUNDER", "founder@pawspace.in", "founder", "founder", now, now).run();
  return harness;
}

const tableNames = async (harness) => new Set((await harness.db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map((row) => row.name));

test("COLD-1: attendance and leave loads on a database where People has never been opened", async () => {
  const harness = await coldWorld();
  const cold = await tableNames(harness);
  assert.equal(cold.has("employees"), false, "fixture: the employees table must not exist yet, or this proves nothing");

  const route = await import("../app/api/attendance-leave/route.ts");
  const response = await route.GET(staffRequest("http://localhost/api/attendance-leave"));
  const body = await response.json();
  assert.equal(response.status, 200, `cold read must not be a server error: ${JSON.stringify(body).slice(0, 300)}`);
  assert.ok(body.data, "and it must answer with a directory, not an error envelope");

  assert.equal((await tableNames(harness)).has("employees"), true,
    "the route must ensure the table through its owner rather than tolerate its absence");
});

test("COLD-2: finance intelligence loads on a database where no journal has been posted", async () => {
  const harness = await coldWorld();
  const cold = await tableNames(harness);
  for (const table of ["finance_journal_entries", "finance_bills"]) {
    assert.equal(cold.has(table), false, `fixture: ${table} must not exist yet`);
  }

  const route = await import("../app/api/finance-intelligence/route.ts");
  const anomalies = await route.GET(staffRequest("http://localhost/api/finance-intelligence"));
  const anomalyBody = await anomalies.json();
  assert.equal(anomalies.status, 200, `cold anomaly scan must not be a server error: ${JSON.stringify(anomalyBody).slice(0, 300)}`);
  // An EMPTY finding list is the correct answer on an empty ledger, and it has to be reachable: the
  // alternative the defect produced was a 500, which reads as "broken", not as "nothing is wrong".
  assert.deepEqual(anomalyBody.data.anomalies, [], "no journal means no anomalies, stated rather than refused");
  assert.equal(anomalyBody.data.anomalyCount, 0);

  const forecast = await route.GET(staffRequest("http://localhost/api/finance-intelligence?mode=cashflow-forecast"));
  const forecastBody = await forecast.json();
  assert.equal(forecast.status, 200, `cold forecast must not be a server error: ${JSON.stringify(forecastBody).slice(0, 300)}`);
  assert.ok(Array.isArray(forecastBody.data.forecast) && forecastBody.data.forecast.length > 0,
    "the forecast must still project forward, from a zero baseline");
  assert.equal(forecastBody.data.basisPeriods, 0, "and say plainly that it had no history to project from");

  const after = await tableNames(harness);
  for (const table of ["finance_journal_entries", "finance_bills"]) {
    assert.equal(after.has(table), true, `${table} must be ensured through its owner`);
  }
});

test("COLD-3: the guard is the table, not a swallowed error", async () => {
  /*
   * The attendance route used to wrap two of its three `employees` reads in
   * .catch(() => ({ results: [] })). With the table ensured those catches could only ever hide a
   * genuine read failure and render it as an empty roster - the refused-read-as-a-clean-zero shape
   * this codebase has already had to fix once (R3-G / F6). They are gone, and this keeps them gone.
   */
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../app/api/attendance-leave/route.ts", import.meta.url), "utf8");
  assert.match(source, /await ensurePeopleTables\(db\)/, "the route must ensure the table it reads");
  assert.doesNotMatch(source, /FROM employees[^\n]*catch\(\(\)=>\(\{results:\[\]/,
    "an employees read must not fall back to an empty list - that is a broken screen reporting a clean one");
});

test("COLD-4: the cash-flow forecast stands up on its own, not behind the anomaly scan", async () => {
  /*
   * COLD-2 calls the anomaly scan first, which ensures the journal - so it passes whether or not the
   * forecast ensures anything itself. The screen does not always call them in that order: `mode` is a
   * query parameter, and a deep link straight to the forecast reaches this entry point cold.
   */
  const harness = await coldWorld();
  assert.equal((await tableNames(harness)).has("finance_journal_entries"), false, "fixture: cold");

  const route = await import("../app/api/finance-intelligence/route.ts");
  const response = await route.GET(staffRequest("http://localhost/api/finance-intelligence?mode=cashflow-forecast"));
  const body = await response.json();
  assert.equal(response.status, 200, `the forecast alone must not be a server error: ${JSON.stringify(body).slice(0, 300)}`);
  assert.ok(Array.isArray(body.data.forecast) && body.data.forecast.length > 0);
});

test("COLD-5: the founder's approval queue tells a cold table apart from a broken read", async () => {
  /*
   * Seven money queues, one per owning module, were each read as `.catch(() => ({ results: [] }))`.
   * That is right for exactly one failure - a table no module has created yet, which cannot hold a
   * pending approval because nothing has written one. It is wrong for every other failure: the
   * founder is shown "nothing needs approval" about money that is waiting and unreadable.
   */
  const harness = await coldWorld();
  const route = await import("../app/api/admin/executive-cockpit/route.ts");

  // Cold: all seven tables absent, and the cockpit still answers with an empty queue rather than 500.
  const cold = await route.GET(staffRequest("http://localhost/api/admin/executive-cockpit"));
  const coldBody = await cold.json();
  assert.equal(cold.status, 200, `a cold database must still open the cockpit: ${JSON.stringify(coldBody).slice(0, 200)}`);
  assert.deepEqual(coldBody.approvals, [], "no module has written an approval, so the queue is genuinely empty");

  // Broken: one queue's table EXISTS but the query cannot run. That must not read as "nothing pending".
  await harness.db.prepare("CREATE TABLE booking_refund_cases (wrong_shape TEXT)").run();
  const broken = await route.GET(staffRequest("http://localhost/api/admin/executive-cockpit"));
  assert.notEqual(broken.status, 200,
    "a queue the founder cannot read must not be rendered as a queue with nothing in it");
});
