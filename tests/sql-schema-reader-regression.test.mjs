import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { findDanglingColumnReferences } from "./helpers/sql-schema-contract.mjs";

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
