/**
 * Every column a SQL string names must exist in the schema that creates its table.
 *
 * This closes a blind spot that produced three real defects in this repository: a column name lives
 * inside a string literal, so neither the build, `tsc --noEmit`, nor thousands of passing tests can
 * see it. The reference only fails when that exact line runs against a real database - which, for a
 * rarely-taken branch, can be in production.
 *
 *   lib/payout-beneficiary-verification.ts  read provider_verifications.verified_at, a column that
 *                                           existed nowhere. It gates every level-2 money approval.
 *   lib/trust-safety-governance.ts          wrote communication_preferences.sms and five siblings
 *                                           that the table has never had, half-applying a block.
 *   lib/field-productivity.ts               read a table with no ensure (the same blind spot, one
 *                                           level up).
 *
 * See tests/helpers/sql-schema-contract.mjs for exactly which SQL shapes are inspected and why the
 * reader refuses to guess at the rest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findDanglingColumnReferences } from "./helpers/sql-schema-contract.mjs";

test("no SQL in lib/ names a column its table does not have", () => {
  const { schema, violations } = findDanglingColumnReferences({
    schemaRoots: ["lib", "app", "worker", "db", "drizzle", "migrations", "scripts"],
    scanRoots: ["lib"],
  });

  assert.ok(schema.size > 500, `the reader must actually find the schema, saw ${schema.size} tables`);
  assert.deepEqual(
    violations.map(v => `${v.file}:${v.line} ${v.table}.${v.column} (${v.kind})`),
    [],
    "each line names a column written or read in SQL that its table's CREATE/ALTER never defines",
  );
});

// Regression coverage for the schema reader itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function fixture(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pawspace-sql-reader-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "fixture.mjs"), source);
  return dir;
}

test("SQL reader retains missing-column detection across quotes and escapes", (t) => {
  const dir = fixture(t, [
    'const ddl = "CREATE TABLE sample (valid TEXT)";',
    String.raw`const a = "SELECT missing_select FROM sample WHERE valid = \'quoted\'";`,
    "const b = 'INSERT INTO sample (missing_insert, valid) VALUES (?, ?)';",
    'const c = `UPDATE sample SET missing_update=? WHERE valid=?`;',
    'const d = "SELECT valid FROM sample";',
    'const e = "SELECT unknown FROM absent_table";',
  ].join("\n"));
  const { schema, violations } = findDanglingColumnReferences({ schemaRoots: [dir], scanRoots: [dir] });
  assert.equal(schema.size, 1);
  assert.deepEqual(violations.map(({ column, kind, line }) => ({ column, kind, line })), [
    { column: "missing_select", kind: "select", line: 2 },
    { column: "missing_insert", kind: "insert", line: 3 },
    { column: "missing_update", kind: "update", line: 4 },
  ]);
});

test("unfinished literal with many escapes completes and still detects missing columns", (t) => {
  const dir = fixture(t, 'const ddl = "CREATE TABLE sample (valid TEXT)";\nconst query = "SELECT missing FROM sample";\n// unfinished quote ' + "'" + "\\x".repeat(2000));
  const helper = new URL("./helpers/sql-schema-contract.mjs", import.meta.url).href;
  const script = `import { findDanglingColumnReferences } from ${JSON.stringify(helper)};
    const result = findDanglingColumnReferences({schemaRoots:[process.argv[1]],scanRoots:[process.argv[1]]});
    console.log(JSON.stringify({tables:result.schema.size,columns:result.violations.map(v=>v.column)}));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, dir], { timeout: 2000, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { tables: 1, columns: ["missing"] });
});
