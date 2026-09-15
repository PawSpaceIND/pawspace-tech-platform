/*
 * The read-side companion to schema-creation-source-contract.test.mjs.
 *
 * That test asks: is every table production code WRITES to created somewhere? It is a good test and
 * it passes. It is also only half the surface, and the missing half shipped a real defect:
 * /api/booking-command-center/stream reads canonical_bookings, provider_work_orders and
 * booking_payments, creates none of them, and returned 500 with "no such table: booking_payments"
 * while the Booking Command Center sat at zero. A browser sweep found it; no test did, because the
 * route never writes anything and so was invisible to the write-side contract.
 *
 * Reads are not exempt from provisioning here. "Whoever wrote the rows must have created the table"
 * holds on a warm database and fails on every cold one: a fresh preview branch, a rebuilt D1, a
 * restored backup, a rollback. On those, the first request to a read-only surface is the first
 * request of any kind.
 *
 * Fixing all 68 remaining routes at once would be a very large, very risky diff, so this test is a
 * RATCHET rather than a gate: the known set is frozen in schema-read-coverage-baseline.json, and the
 * test fails if a NEW route joins it. The list may shrink freely — shrinking it is the point.
 * Delete an entry from the baseline as you fix it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = JSON.parse(readFileSync(path.join(ROOT, "tests/schema-read-coverage-baseline.json"), "utf8"));

const sourceFiles = execFileSync("git", ["ls-files", "lib", "app", "worker"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts"));

// Same comment stripping as the write-side contract: prose describes SQL constantly, and without
// this the English in a comment becomes the finding.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CREATE = /CREATE TABLE IF NOT EXISTS\s+([a-z][a-z0-9_]*)/g;
const READ = /\b(?:FROM|JOIN)\s+([a-z][a-z0-9_]*)/g;
// SQL keywords and pseudo-tables that follow FROM/JOIN without naming a real table.
const NOT_A_TABLE = new Set(["select", "where", "dual", "sqlite_master", "json_each", "pragma"]);

const creates = new Map(), reads = new Map(), imports = new Map();
for (const file of sourceFiles) {
  const src = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
  creates.set(file, new Set([...src.matchAll(CREATE)].map((m) => m[1])));
  reads.set(file, new Set([...src.matchAll(READ)].map((m) => m[1])));
  const resolved = new Set();
  // The repo writes relative imports in BOTH spellings - `from "./x"` (643 sites) and the minified
  // `from"./x"` (1296 sites). A `\s+` here saw only the spaced third, so a route that imported its
  // provisioner in the minified style read as importing nothing: app/api/funeral-memorial/route.ts
  // was reported for provider_identity_links, which lib/server-auth.ts (which it imports) creates.
  // 32 of the 69 baseline entries were the same false positive. SCHEMA-READ-5 guards the fix.
  for (const m of src.matchAll(/from\s*"([^"]+)"/g)) {
    if (!m[1].startsWith(".")) continue;
    const base = path.normalize(path.join(path.dirname(file), m[1]));
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (sourceFiles.includes(candidate)) resolved.add(candidate);
  }
  imports.set(file, resolved);
}

/** Tables a file can rely on: those it creates, plus those anything it imports creates. */
function provisionable(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const out = new Set(creates.get(file) || []);
  for (const dep of imports.get(file) || []) for (const table of provisionable(dep, seen)) out.add(table);
  return out;
}

const uncovered = sourceFiles
  .filter((file) => file.startsWith("app/api/"))
  .filter((file) => {
    const have = provisionable(file);
    return [...(reads.get(file) || [])].some((table) => !have.has(table) && !NOT_A_TABLE.has(table));
  })
  .sort();

test("SCHEMA-READ-1: no NEW route reads a table nothing on its import path creates", () => {
  const added = uncovered.filter((file) => !BASELINE.includes(file));
  assert.deepEqual(added, [],
    `These routes read tables that nothing they import creates. On a cold D1 the first request ` +
    `fails with "no such table". Call an ensure*Tables for what you read, as ` +
    `app/api/booking-command-center/stream/route.ts now does:\n  ${added.join("\n  ")}`);
});

test("SCHEMA-READ-2: the baseline only shrinks", () => {
  const fixed = BASELINE.filter((file) => !uncovered.includes(file));
  assert.deepEqual(fixed, [],
    `These routes no longer need to be in the baseline. Delete them from ` +
    `tests/schema-read-coverage-baseline.json so the ratchet cannot slip back:\n  ${fixed.join("\n  ")}`);
});

test("SCHEMA-READ-3: the scanner is not blind", () => {
  // If a refactor hides the SQL from this scanner, the two tests above would pass by seeing nothing.
  const totalCreates = [...creates.values()].reduce((sum, set) => sum + set.size, 0);
  const totalReads = [...reads.values()].reduce((sum, set) => sum + set.size, 0);
  assert.ok(totalCreates > 400, `only ${totalCreates} CREATE TABLE statements seen - the scanner has gone blind`);
  assert.ok(totalReads > 400, `only ${totalReads} table reads seen - the scanner has gone blind`);
  assert.ok(sourceFiles.length > 300, `only ${sourceFiles.length} source files scanned`);
});

test("SCHEMA-READ-5: the import resolver is not blind", () => {
  // The companion to SCHEMA-READ-3. That one guards the SQL scan; this guards the import graph,
  // which is the other way these tests can pass by seeing nothing: if `provisionable` resolves no
  // edges, every route looks fully provisioned and SCHEMA-READ-1 can never fail. Both relative
  // import spellings the repo uses must resolve.
  const edges = [...imports.values()].reduce((sum, set) => sum + set.size, 0);
  assert.ok(edges > 1500, `only ${edges} relative import edges resolved - the import resolver has gone blind`);
  const spacedImporter = sourceFiles.find((file) => /from\s+"\.[^"]+"/.test(readFileSync(path.join(ROOT, file), "utf8")));
  const minifiedImporter = sourceFiles.find((file) => /from"\.[^"]+"/.test(readFileSync(path.join(ROOT, file), "utf8")));
  for (const [style, file] of [["spaced", spacedImporter], ["minified", minifiedImporter]]) {
    assert.ok(file, `no ${style} relative importer found to sample`);
    assert.ok((imports.get(file) || new Set()).size > 0, `${style} relative imports in ${file} resolved to nothing`);
  }
  // The concrete regression: this route reads provider_identity_links and reaches its creator
  // (lib/server-auth.ts) only through a minified import.
  assert.ok(provisionable("app/api/funeral-memorial/route.ts").has("provider_identity_links"),
    "app/api/funeral-memorial/route.ts must resolve provider_identity_links through lib/server-auth");
});

test("SCHEMA-READ-4: the shared booking DDL has not drifted from the writer's copy", () => {
  // lib/canonical-booking-core-schema.ts exists so a read-only surface can provision the three core
  // booking tables. CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so if these
  // statements ever diverge from the writer's, whichever ran first would silently win and the
  // mismatch would surface later as a confusing column error.
  const shared = readFileSync(path.join(ROOT, "lib/canonical-booking-core-schema.ts"), "utf8");
  const writer = readFileSync(path.join(ROOT, "app/api/canonical-bookings/route.ts"), "utf8");
  const statements = [...shared.matchAll(/"(CREATE TABLE IF NOT EXISTS [^"]+)"/g)].map((m) => m[1]);
  assert.equal(statements.length, 3, "expected the three canonical booking core tables");
  for (const statement of statements) {
    assert.ok(writer.includes(statement),
      `this statement no longer matches app/api/canonical-bookings/route.ts byte for byte:\n  ${statement.slice(0, 120)}...`);
  }
});
