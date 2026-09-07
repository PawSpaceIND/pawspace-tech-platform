/*
 * This codebase does NOT migrate its schema. It creates it at runtime: every module owns
 * `ensure*Tables(db)` functions full of CREATE TABLE IF NOT EXISTS, and the Worker calls them on
 * the request and scheduled paths before anything reads or writes.
 *
 * That is a legitimate architecture for D1, but it has one failure mode with no safety net: a route
 * that writes to a table nobody creates. It typecheck-passes, lints clean, and fails in production
 * on the first request with "no such table". No migration ledger will catch it, because there is no
 * migration ledger - the 27 files in drizzle/ are drizzle-kit output that no workflow applies (see
 * drizzle/README.md).
 *
 * This test is that safety net. It reads the real source, collects every table production code
 * WRITES to and every table production code CREATES, and requires the first set to be covered by
 * the second.
 *
 * It is deliberately a source-level check, and the filename says so. The alternative - booting
 * every route against a blank database - is what tests/e2e-platform-scale.test.mjs does for the
 * money path, and it cannot be made exhaustive across ~200 routes. This one is exhaustive by
 * construction instead.
 *
 * The file is NOT named "runtime-*": scripts/evidence-class-audit.mjs classifies this suite as
 * source_contract, and EXECUTION_CLAIMING_NAME would flag a name promising execution that only
 * reads source. That audit is right - this reads source - so the name matches the evidence class.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sourceFiles = execFileSync("git", ["ls-files", "lib", "app", "worker"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts"));

/* Comments describe SQL constantly ("UPDATE ON ...", "insert into the ledger"). Strip them, or the
 * prose becomes the finding - an earlier draft of this check reported "AI", "OF" and "ON" as
 * missing tables, all of them English. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Lowercase snake_case only: real table names here are lowercase, English words in prose are not.
const WRITE = /(?:INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO|UPDATE)\s+([a-z][a-z0-9_]*)/g;
const CREATE = /CREATE TABLE IF NOT EXISTS\s+([a-z][a-z0-9_]*)/g;

const created = new Set();
const written = new Map();
for (const file of sourceFiles) {
  const src = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
  for (const m of src.matchAll(CREATE)) created.add(m[1]);
  for (const m of src.matchAll(WRITE)) {
    if (!written.has(m[1])) written.set(m[1], new Set());
    written.get(m[1]).add(file);
  }
}

test("SCHEMA-1: every table production code writes to is created at runtime", () => {
  const orphans = [...written.entries()]
    .filter(([table]) => !created.has(table))
    .map(([table, files]) => `${table}  <- written by ${[...files].sort()[0]}`);

  assert.deepEqual(orphans, [],
    `These tables are written but never created by any ensure*Tables. On a fresh D1 the first ` +
    `request that touches one fails with "no such table":\n  ${orphans.join("\n  ")}`);
});

test("SCHEMA-2: the check is not vacuous - it sees the real schema surface", () => {
  // If a refactor moves table creation somewhere this scanner cannot see, SCHEMA-1 would pass by
  // finding nothing rather than by finding everything. These floors make that failure loud.
  assert.ok(created.size > 400, `only ${created.size} CREATE TABLE statements found - the scanner has gone blind`);
  assert.ok(written.size > 400, `only ${written.size} written tables found - the scanner has gone blind`);
  assert.ok(sourceFiles.length > 300, `only ${sourceFiles.length} source files scanned`);
});

test("SCHEMA-3: the money path's tables are among those covered", () => {
  // A spot-check with named tables, so a scanner that silently matched nothing still fails here.
  for (const table of ["canonical_bookings", "booking_payments", "payment_intents",
                       "financial_outbox", "journal_entries", "journal_transactions"]) {
    assert.ok(created.has(table), `${table} has no runtime creator`);
  }
});
