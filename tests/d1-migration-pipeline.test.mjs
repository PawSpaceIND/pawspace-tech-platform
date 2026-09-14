/**
 * The D1 migration set is safe to apply, and safe to re-apply — EXECUTED.
 *
 * WHAT THIS GUARDS. 45 migration files existed with nothing applying them to staging or production.
 * Before wiring an apply step into the deploy, the set has to be proved: no destructive statements,
 * every file syntactically valid in sequence, and the whole run repeatable without error. This
 * suite runs the real runner (scripts/schema/apply-idempotent-drizzle.mjs) over the real migration
 * directory against an in-memory SQLite database, which is the same engine D1 runs.
 *
 * It also pins the two findings the audit turned up, so neither can be reintroduced quietly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1 } from "./helpers/taxi-harness.mjs";
import {
  applyIdempotentMigrationFile,
  normalizeReplaySafeDdl,
} from "../scripts/schema/apply-idempotent-drizzle.mjs";

installWorkersHooks("__MIGRATION_DB__", "__MIGRATION_ENV__");

const capacity = await import("../lib/provider-capacity-governance.ts");

const DIR = "drizzle";
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

/*
 * Migration 0025 attaches triggers to provider_capacity_profiles, a table created at runtime by
 * lib/provider-capacity-governance.ts and by no migration. Staging and production have had it for
 * weeks; a brand-new database would not.
 *
 * The prerequisite is created by calling the REAL owning module rather than by copying its DDL in
 * here. A hand-written copy would drift the moment that module changes a column, and this test
 * would then prove the migrations apply against a table shape that no longer exists anywhere.
 */
async function deploymentShapedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  await capacity.ensureProviderCapacityTables(makeD1(sqlite));
  return sqlite;
}

function applyAll(db) {
  const failures = [];
  for (const file of FILES) {
    try { applyIdempotentMigrationFile(db, path.join(DIR, file)); }
    catch (error) { failures.push(`${file}: ${error.message}`); }
  }
  return failures;
}
const count = (db, type) =>
  Number(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='${type}'`).get().n);

// ---------------------------------------------------------------------------------------------
test("the whole migration set applies to a deployment-shaped database with no failures", async () => {
  /*
   * A floor, not an exact count. Every file in drizzle/ is applied below, so a migration added
   * tomorrow is covered the moment it lands — pinning an exact number only breaks this suite on
   * somebody else's unrelated migration, which is what it did the first time main moved. The floor
   * still catches the case that matters: the set silently losing files.
   */
  assert.ok(FILES.length >= 45, `the migration set has not shrunk, found ${FILES.length}`);

  const db = await deploymentShapedDatabase();

  const failures = applyAll(db);
  assert.deepEqual(failures, [], "every migration applies cleanly in sequence");

  // The set really did build a schema, rather than silently no-opping.
  assert.ok(count(db, "table") > 170, `migrations create the expected table count, got ${count(db, "table")}`);
  assert.ok(count(db, "trigger") >= 33, "the trust-and-safety triggers are installed");
});

// ---------------------------------------------------------------------------------------------
test("re-applying the set on every deploy changes nothing and fails nothing", async () => {
  const db = await deploymentShapedDatabase();
  assert.deepEqual(applyAll(db), []);

  const after = [count(db, "table"), count(db, "index"), count(db, "trigger")];

  // THE PROPERTY THE DEPLOY STEP DEPENDS ON. The apply runs on every push; if it were not
  // idempotent, the second deploy of the day would break the pipeline.
  for (const pass of [2, 3]) {
    assert.deepEqual(applyAll(db), [], `pass ${pass} re-applies without error`);
  }
  assert.deepEqual([count(db, "table"), count(db, "index"), count(db, "trigger")], after,
    "replaying the set creates nothing new and drops nothing");
});

// ---------------------------------------------------------------------------------------------
test("no migration carries a statement that could destroy data or lock a live table", () => {
  const offenders = { alter: [], dropTable: [], deleteOutsideTrigger: [], truncate: [] };

  for (const file of FILES) {
    const sql = readFileSync(path.join(DIR, file), "utf8").replace(/--.*/g, "");
    if (/\bALTER\s+TABLE\b/i.test(sql)) offenders.alter.push(file);
    if (/\bDROP\s+TABLE\b/i.test(sql)) offenders.dropTable.push(file);
    if (/\bTRUNCATE\b/i.test(sql)) offenders.truncate.push(file);

    // A DELETE inside a trigger body is the trigger's own logic, not a migration-time wipe.
    const withoutTriggers = sql.replace(/CREATE\s+TRIGGER[\s\S]*?END\s*;/gi, "");
    if (/\bDELETE\s+FROM\b/i.test(withoutTriggers)) offenders.deleteOutsideTrigger.push(file);
  }

  assert.deepEqual(offenders.alter, [],
    "column changes go through @add-column-if-missing directives, never a bare ALTER TABLE");
  assert.deepEqual(offenders.dropTable, [], "no migration drops a table");
  assert.deepEqual(offenders.truncate, [], "no migration truncates");
  assert.deepEqual(offenders.deleteOutsideTrigger, [], "no migration deletes rows at apply time");
});

// ---------------------------------------------------------------------------------------------
test("normalisation makes every create replay-safe, which is what lets the deploy re-run it", () => {
  /*
   * THE HAZARD THIS CLOSES. 62 CREATE TABLE and 7 CREATE INDEX statements in migrations 0000-0016
   * carry no IF NOT EXISTS. Applied verbatim — which is what `wrangler d1 migrations apply` does —
   * they abort against staging, where the tables already exist. The runner rewrites them first.
   */
  let bareCreates = 0;
  for (const file of FILES) {
    const raw = readFileSync(path.join(DIR, file), "utf8").replace(/--.*/g, "");
    bareCreates += (raw.match(/\bCREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|TRIGGER|VIEW)\s+(?!IF\s+NOT\s+EXISTS)/gi) || []).length;

    const safe = normalizeReplaySafeDdl(raw);
    assert.equal(
      (safe.match(/\bCREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|TRIGGER|VIEW)\s+(?!IF\s+NOT\s+EXISTS)/gi) || []).length,
      0,
      `${file} has no unguarded CREATE after normalisation`,
    );
    assert.equal(
      (safe.match(/\bDROP\s+(TABLE|INDEX)\s+(?!IF\s+EXISTS)/gi) || []).length,
      0,
      `${file} has no unguarded DROP after normalisation`,
    );
  }
  assert.ok(bareCreates > 50,
    `the raw set really does carry unguarded creates (${bareCreates}) — this is why verbatim apply is unsafe`);
});

// ---------------------------------------------------------------------------------------------
test("the objects only a migration can create are the ones the deploy step exists for", async () => {
  const db = await deploymentShapedDatabase();
  assert.deepEqual(applyAll(db), []);

  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)),
  );

  /*
   * These ten exist in no ensure*Tables() anywhere in lib/ or app/api, so unlike the other 746
   * tables they cannot appear by being used. If the deploy does not apply migrations, they are
   * simply absent — which is why DPDP consent, GST documents and the tax rule ledger were at risk.
   */
  for (const table of [
    "dpdp_consent_records", "gst_documents", "tax_rule_versions", "gateway_refunds",
    "service_proof_ledgers", "subscription_entitlements", "subscription_entitlement_events",
    "atlas_pending_approvals", "canonical_revenue_opportunity_context",
    "canonical_revenue_opportunity_service_history",
  ]) {
    assert.ok(tables.has(table), `${table} is created by the migration set`);
  }
});
