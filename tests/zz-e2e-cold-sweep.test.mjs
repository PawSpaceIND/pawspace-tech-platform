/**
 * E2E PRE-HUMAN-TESTING SWEEP — cold database, every API route.
 *
 * tests/cold-db-surfaces.test.mjs pins exactly three routes (manager-dashboard, walking-ops,
 * taxi-ops) because those three were caught crashing on a fresh database with "no such table".
 * There are ~197. A human tester on a freshly provisioned or partially seeded environment reaches
 * any of them, so this drives EVERY route that exports GET against an empty database and reports
 * which ones fail with a schema error rather than an empty result.
 *
 * Authenticated as the development-preview superuser on purpose: the target here is the DATA layer,
 * not authorisation, so every route must be reachable. A 400 for a missing query parameter is a
 * correct answer and is not counted. What is counted is a 500 whose message is a schema error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__E2ECOLD_DB__", "__E2ECOLD_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes), last_row_id: Number(info.lastInsertRowid ?? 0) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args), meta: {} }),
      raw: async () => sqlite.prepare(sql).all(...args).map((row) => Object.values(row)),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    withSession: undefined,
  };
}

/** A route's answer is only a defect if the failure is about the SCHEMA, not about missing input. */
const SCHEMA_ERROR = /no such table|no such column|has no column named|no such function/i;

const routeDirs = readdirSync("app/api", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`app/api/${entry.name}/route.ts`))
  .map((entry) => entry.name)
  .sort();

test(`cold database: every one of the ${routeDirs.length} API routes answers without a schema error`, async () => {
  assert.ok(routeDirs.length > 150, `expected the full route surface, found ${routeDirs.length}`);

  const broken = [];
  const skipped = [];
  const okCount = { get: 0, noGet: 0, badInput: 0 };

  for (const name of routeDirs) {
    // A cold database PER ROUTE: a route that creates its own tables must not make the next one pass.
    const sqlite = new DatabaseSync(":memory:");
    globalThis.__E2ECOLD_DB__ = makeD1(sqlite);
    globalThis.__E2ECOLD_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.in" };

    let route;
    try {
      route = await import(`../app/api/${name}/route.ts?cold=${name}`);
    } catch (error) {
      skipped.push(`${name}: import failed — ${error.message.slice(0, 120)}`);
      continue;
    }
    if (typeof route.GET !== "function") { okCount.noGet += 1; continue; }

    // localhost + non-production NODE_ENV resolves the preview superuser, so authorisation cannot be
    // what stops the request: the data layer is the thing under test.
    let response;
    try {
      response = await route.GET(new Request(`http://localhost/api/${name}`));
    } catch (thrown) {
      const message = thrown instanceof Response ? `Response ${thrown.status}` : String(thrown?.message ?? thrown);
      if (SCHEMA_ERROR.test(message)) broken.push({ name, status: "threw", message: message.slice(0, 160) });
      else skipped.push(`${name}: threw non-schema — ${message.slice(0, 100)}`);
      continue;
    }

    const body = await response.text();
    if (response.status >= 500) {
      let message = body.slice(0, 200);
      try { message = String(JSON.parse(body).error ?? message); } catch {}
      if (SCHEMA_ERROR.test(message)) broken.push({ name, status: response.status, message: message.slice(0, 160) });
      else skipped.push(`${name}: HTTP ${response.status} non-schema — ${message.slice(0, 100)}`);
      continue;
    }
    if (response.status === 400) { okCount.badInput += 1; continue; }
    okCount.get += 1;
  }

  console.error(`\n=== COLD DATABASE SWEEP: ${routeDirs.length} routes ===`);
  console.error(`  answered cleanly:            ${okCount.get}`);
  console.error(`  400 (missing input, fine):   ${okCount.badInput}`);
  console.error(`  no GET handler:              ${okCount.noGet}`);
  console.error(`  non-schema 5xx / threw:      ${skipped.length}`);
  console.error(`  SCHEMA ERRORS (defects):     ${broken.length}`);
  if (broken.length) {
    console.error(`\n--- routes that crash on a fresh database ---`);
    for (const item of broken) console.error(`  ${item.name.padEnd(38)} ${String(item.status).padEnd(6)} ${item.message}`);
  }
  if (skipped.length) {
    console.error(`\n--- other failures, for triage (not asserted here) ---`);
    for (const item of skipped.slice(0, 40)) console.error(`  ${item}`);
  }

  assert.deepEqual(broken.map((item) => `${item.name}: ${item.message}`), [],
    `these routes crash with a schema error on a fresh database, which is what a human tester meets on a new environment`);
});
