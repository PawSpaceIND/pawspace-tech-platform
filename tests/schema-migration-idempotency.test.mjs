import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyIdempotentSqlMigration, normalizeReplaySafeDdl } from "../scripts/schema/apply-idempotent-drizzle.mjs";

function assertLockedEnvironment() {
  assert.equal(process.env.PAWSPACE_PAYMENT_ENV, "sandbox");
  assert.equal(process.env.FORBID_PRODUCTION, "true");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.APP_ENV, "staging");
}

function stripSqlComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\r\n]*/g, "");
}

test("0025 uses PRAGMA-governed add-column directives and replays safely", () => {
  assertLockedEnvironment();
  const sql = readFileSync("drizzle/0025_trust_safety_anti_leakage.sql", "utf8");
  assert.doesNotMatch(stripSqlComments(sql), /^\s*ALTER\s+TABLE\s+provider_capacity_profiles\s+ADD\s+COLUMN/gmi);
  assert.match(sql, /@add-column-if-missing provider_capacity_profiles\|trust_score\|INTEGER NOT NULL DEFAULT 100/);

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY);
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, primary_phone TEXT, secondary_phone TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT);
  `);
  applyIdempotentSqlMigration(sqlite, sql, "0025 first pass");
  applyIdempotentSqlMigration(sqlite, sql, "0025 replay");

  const columns = sqlite.prepare("PRAGMA table_info(provider_capacity_profiles)").all().map((row) => String(row.name));
  assert.equal(columns.filter((name) => name === "trust_score").length, 1);
  assert.equal(columns.filter((name) => name === "trust_strike_count").length, 1);
  assert.equal(columns.filter((name) => name === "suspended_until").length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='trust_safety_events'").get().n, 1);
});

test("historical generated DDL is normalized to replay-safe CREATE/DROP forms", () => {
  assertLockedEnvironment();
  const files = readdirSync("drizzle").filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.ok(files.length >= 27, `expected the full Drizzle archive, found ${files.length}`);
  for (const file of files) {
    const source = readFileSync(join("drizzle", file), "utf8");
    const executableSql = stripSqlComments(source);
    assert.doesNotMatch(executableSql, /\bALTER\s+TABLE\b[^;]*\bADD\s+COLUMN\b/i, `${file} contains an ungoverned ADD COLUMN`);
    const normalized = normalizeReplaySafeDdl(source);
    assert.doesNotMatch(normalized, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, `${file} leaves an unsafe CREATE INDEX after normalization`);
    assert.doesNotMatch(normalized, /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, `${file} leaves an unsafe CREATE TABLE after normalization`);
  }
});
