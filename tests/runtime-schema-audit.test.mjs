import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

// Execute the exact declared isolated migration, never a synthetic runtime creator.
test("isolated Atlas schema certification rejects omission, extra consumers/writers and seed authority",()=>{
 const root=mkdtempSync(join(tmpdir(),"paw-isolated-schema-audit-"));
 const sql=readFileSync("migrations/atlas-text-test-isolated.sql","utf8");
 try{
  mkdirSync(join(root,"lib"));mkdirSync(join(root,"migrations"));
  writeFileSync(join(root,"lib/atlas-text-test-admission.ts"),'db.prepare("INSERT INTO atlas_text_test_requests (id) VALUES (?)");');
  const migration=join(root,"migrations/atlas-text-test-isolated.sql");
  assert.throws(()=>auditRuntimeSchemaCoverage(root));
  writeFileSync(migration,"");assert.throws(()=>auditRuntimeSchemaCoverage(root));
  writeFileSync(migration,sql);const row=auditRuntimeSchemaCoverage(root).rows.find(r=>r.table==="atlas_text_test_requests");assert.equal(row.classification,"explicitly_provisioned_isolated");assert.equal(row.provisionedSchemaSource,"migrations/atlas-text-test-isolated.sql");
  writeFileSync(join(root,"lib/unrelated.ts"),'db.prepare("UPDATE atlas_text_test_requests SET status=\'unknown\'");');assert.throws(()=>auditRuntimeSchemaCoverage(root));
  rmSync(join(root,"lib/unrelated.ts"));
  writeFileSync(join(root,"lib/unrelated.ts"),'db.exec("CREATE TABLE IF NOT EXISTS atlas_text_test_requests (id TEXT)");');assert.throws(()=>auditRuntimeSchemaCoverage(root));rmSync(join(root,"lib/unrelated.ts"));
  writeFileSync(migration,sql+"\nCREATE TABLE authority(id TEXT);INSERT INTO authority VALUES ('seed');");assert.throws(()=>auditRuntimeSchemaCoverage(root));

  writeFileSync(migration,sql+"\nINSERT INTO atlas_text_test_requests VALUES ('seed','job','rate','thread',1,1,1,'reserved',NULL,0);");assert.throws(()=>auditRuntimeSchemaCoverage(root));
 }finally{rmSync(root,{recursive:true,force:true});}
});
