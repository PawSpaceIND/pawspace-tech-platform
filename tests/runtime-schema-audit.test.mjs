import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRuntimeSchemaCoverage } from "../scripts/runtime-schema-audit.mjs";

const MONEY_TABLE = /(?:payment|journal|partner|earning|payable|gateway|refund|settlement|tax|gst|invoice|outbox)/i;

test("production SQL references have a declared schema source", () => {
  const audit = auditRuntimeSchemaCoverage(".");
  assert.deepEqual(
    audit.missing,
    [],
    `production SQL references tables with no runtime creator and no drizzle creator:\n${JSON.stringify(audit.missing, null, 2)}`,
  );
});

test("critical money-path SQL is not migration-only", () => {
  const audit = auditRuntimeSchemaCoverage(".");
  const critical = audit.migrationOnly.filter((row) => MONEY_TABLE.test(row.table));
  assert.deepEqual(
    critical,
    [],
    `critical money tables are consumed at runtime but exist only in drizzle migrations:\n${JSON.stringify(critical, null, 2)}`,
  );
});

test("dynamic SQL sources do not turn the following ORDER keyword into a table", () => {
  const root = mkdtempSync(join(tmpdir(), "paw-schema-audit-"));
  try {
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib/query.ts"), 'db.prepare(`SELECT * FROM ${source} ${conditions} ORDER BY at DESC`);\n' + 'db.prepare("SELECT * FROM genuinely_missing");');
    const audit = auditRuntimeSchemaCoverage(root);
    assert.deepEqual(audit.missing.map(row => row.table), ["genuinely_missing"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
