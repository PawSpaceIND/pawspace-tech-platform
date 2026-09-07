import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { d1 } from "./helpers/execution-harness.mjs";
import { ensureFinancialRuntimeTables } from "../lib/financial-runtime-schema.ts";
import { LOGICAL_FOREIGN_KEYS } from "../lib/schema-governance-manifest.ts";

function assertLockedEnvironment() {
  assert.equal(process.env.PAWSPACE_PAYMENT_ENV, "sandbox");
  assert.equal(process.env.FORBID_PRODUCTION, "true");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.APP_ENV, "staging");
}

function tableExists(sqlite, table) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnExists(sqlite, table, column) {
  if (!tableExists(sqlite, table)) return false;
  return sqlite.prepare(`PRAGMA table_info("${table}")`).all().some((row) => String(row.name) === column);
}

function logicalOrphans(sqlite) {
  const violations = [];
  let checked = 0;
  for (const rel of LOGICAL_FOREIGN_KEYS) {
    if (!columnExists(sqlite, rel.childTable, rel.childColumn) || !columnExists(sqlite, rel.parentTable, rel.parentColumn)) continue;
    checked++;
    const row = sqlite.prepare(
      `SELECT c.rowid AS child_rowid, c."${rel.childColumn}" AS child_value
       FROM "${rel.childTable}" c
       LEFT JOIN "${rel.parentTable}" p ON p."${rel.parentColumn}" = c."${rel.childColumn}"
       WHERE c."${rel.childColumn}" IS NOT NULL AND p."${rel.parentColumn}" IS NULL
       LIMIT 1`,
    ).get();
    if (row) violations.push({ relation: rel.name, ...row });
  }
  return { checked, violations };
}

test("runtime schema bootstrap is replay-safe and foreign-key clean", async () => {
  assertLockedEnvironment();
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY);
    CREATE TABLE canonical_bookings (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY);
    INSERT INTO canonical_customers(id) VALUES ('C-1');
    INSERT INTO canonical_bookings(id,customer_id,status) VALUES ('B-1','C-1','completed');
    INSERT INTO provider_capacity_profiles(id) VALUES ('P-1');
  `);

  await ensureFinancialRuntimeTables(d1(sqlite));
  await ensureFinancialRuntimeTables(d1(sqlite));

  sqlite.prepare(`INSERT INTO payment_intents
    (id,booking_id,customer_id,payment_id,environment,idempotency_key,amount_paise,gross_service_value_paise,platform_fee_paise,partner_earning_paise,commission_rate_version,tax_rule_version,created_at,updated_at)
    VALUES ('PI-1','B-1','C-1','PAY-1','sandbox','IDEMP-1',10000,10000,2000,8000,'v1','v1',1,1)`).run();
  sqlite.prepare("INSERT INTO journal_transactions (id,source_type,source_id,source_event_id,narration,created_at) VALUES ('JT-1','test','SRC-1','EV-1','governance',1)").run();
  sqlite.prepare("INSERT INTO journal_entries (id,transaction_id,account_code,direction,amount_paise,booking_id,partner_id,created_at) VALUES ('JE-1','JT-1','cash','DEBIT',10000,'B-1','P-1',1)").run();
  sqlite.prepare(`INSERT INTO partner_earning_pending
    (id,booking_id,partner_id,payment_intent_id,gross_service_value_paise,platform_fee_paise,earning_paise,created_at,updated_at)
    VALUES ('PE-1','B-1','P-1','PI-1',10000,2000,8000,1,1)`).run();
  sqlite.prepare(`INSERT INTO partner_payable_released
    (id,booking_id,partner_id,pending_earning_id,release_type,amount_paise,released_at,updated_at)
    VALUES ('PR-1','B-1','P-1','PE-1','service',8000,2,2)`).run();

  const fkViolations = sqlite.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(fkViolations, []);

  const clean = logicalOrphans(sqlite);
  assert.ok(clean.checked >= 7, `expected at least 7 governed logical relationships, checked ${clean.checked}`);
  assert.deepEqual(clean.violations, []);

  sqlite.prepare("UPDATE payment_intents SET booking_id='B-MISSING' WHERE id='PI-1'").run();
  const broken = logicalOrphans(sqlite);
  assert.equal(broken.violations.some((v) => v.relation === "payment_intent_booking"), true, "logical FK checker must detect a real orphan");
  sqlite.prepare("UPDATE payment_intents SET booking_id='B-1' WHERE id='PI-1'").run();
  assert.deepEqual(logicalOrphans(sqlite).violations, []);
});
