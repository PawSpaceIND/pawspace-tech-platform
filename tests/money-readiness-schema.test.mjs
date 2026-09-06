import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  MONEY_READINESS_REQUIRED_TABLES,
  MONEY_READINESS_SCHEMA_CONFIG,
  MONEY_READINESS_SCHEMA_STATEMENTS,
  ensureMoneyReadinessTables,
  isMoneyReadinessStagingRuntime,
  renderMoneyReadinessSchemaSql,
} from "../lib/money-readiness-schema.ts";

function makeD1(sqlite) {
  return {
    prepare(sql) {
      return {
        async run() {
          sqlite.exec(sql);
          return { success: true };
        },
      };
    },
  };
}

test("money-readiness bootstrap is staging/test-only and production stays air-gapped", async () => {
  assert.equal(isMoneyReadinessStagingRuntime({ PAWSPACE_DEPLOYMENT_ENV: "staging" }), true);
  assert.equal(isMoneyReadinessStagingRuntime({ APP_ENV: "staging", FORBID_PRODUCTION: "true" }), true);
  assert.equal(isMoneyReadinessStagingRuntime({ APP_ENV: "production", FORBID_PRODUCTION: "true" }), false);
  assert.equal(isMoneyReadinessStagingRuntime({ PAWSPACE_DEPLOYMENT_ENV: "production" }), false);
  const sqlite = new DatabaseSync(":memory:");
  await assert.rejects(
    () => ensureMoneyReadinessTables(makeD1(sqlite), { APP_ENV: "production" }),
    /restricted to staging or isolated test runtimes/,
  );
  assert.throws(() => renderMoneyReadinessSchemaSql({ APP_ENV: "production" }), /restricted to staging or isolated test runtimes/);
});

test("canonical money-readiness journal is finance_journal_entries", () => {
  assert.equal(MONEY_READINESS_SCHEMA_CONFIG.canonicalJournalTable, "finance_journal_entries");
  assert.equal(MONEY_READINESS_SCHEMA_CONFIG.scope, "staging-and-test");
  assert.equal(MONEY_READINESS_SCHEMA_CONFIG.productionTelemetryRequired, false);
});

test("real SQLite execution creates all 16 missing Drizzle tables idempotently", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const runtime = { APP_ENV: "staging", NODE_ENV: "test", FORBID_PRODUCTION: "true" };
  await ensureMoneyReadinessTables(db, runtime);
  await ensureMoneyReadinessTables(db, runtime);
  const names = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => MONEY_READINESS_REQUIRED_TABLES.includes(name));
  assert.deepEqual(names, [...MONEY_READINESS_REQUIRED_TABLES].sort());
  assert.equal(names.length, 16);
});

test("rendered staging SQL carries exactly the 16 target CREATE TABLE statements", () => {
  const sql = renderMoneyReadinessSchemaSql({ APP_ENV: "staging", FORBID_PRODUCTION: "true" });
  const tableNames = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(tableNames, [...MONEY_READINESS_REQUIRED_TABLES].sort());
  assert.equal(tableNames.length, 16);
  assert.ok(MONEY_READINESS_SCHEMA_STATEMENTS.length > 16, "indexes/triggers must be included alongside table creators");
});
