import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";

// buildCustomer360 must exclude a duplicate that executeTransactionalCustomerMerge has neutralized
// (canonical_customers.merged_into set, and the legacy crm_contacts row marked stage='Merged'), so a
// merged "loser" never clutters the active customer list. lib/customer-360.ts imports d1-chunked-in
// extensionlessly, so the resolver is required.
installWorkersHooks("__C360_HIDE_DB__");
const { buildCustomer360 } = await import("../lib/customer-360.ts");

const NOW = Date.now();

test("a merged loser is hidden from the active customer list (canonical + legacy crm sources)", async () => {
  const sqlite = freshSqlite();
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'test',consent_json TEXT NOT NULL DEFAULT '{}',merged_into TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,area TEXT,stage TEXT,owner TEXT,source TEXT,lifetime_value REAL,updated_at INTEGER);
    INSERT INTO canonical_customers (id,city_id,name,primary_phone,merged_into,created_at,updated_at) VALUES
      ('CUST-P','blr','Asha','9876500001',NULL,1,${NOW}),
      ('CUST-D','blr','Asha','MERGED','CUST-P',1,${NOW});
    INSERT INTO crm_contacts (id,name,primary_phone,stage,updated_at) VALUES
      ('CUST-P','Asha','9876500001','Active customer',${NOW}),
      ('CUST-D','Asha','MERGED','Merged',${NOW});
  `);
  const ids = (await buildCustomer360(makeD1(sqlite))).map(record => record.customerId);
  assert.ok(ids.includes("CUST-P"), "the survivor is shown");
  assert.ok(!ids.includes("CUST-D"), "the merged loser is hidden");
});

test("filtering a single customer never returns a merged loser even when addressed by id", async () => {
  const sqlite = freshSqlite();
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'test',consent_json TEXT NOT NULL DEFAULT '{}',merged_into TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO canonical_customers (id,city_id,name,primary_phone,merged_into,created_at,updated_at) VALUES ('CUST-D','blr','Asha','MERGED','CUST-P',1,${NOW});
  `);
  assert.equal((await buildCustomer360(makeD1(sqlite), "CUST-D")).length, 0);
});

// The critical regression guard: on a database that predates the merged_into column, the filter must not
// silently hide everyone. ensureCustomer360Tables adds the column so the query resolves.
test("customers still return on a database that predates the merged_into column", async () => {
  const sqlite = freshSqlite();
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'test',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUST-X','blr','Ravi','9111100000',1,${NOW});
  `);
  assert.deepEqual((await buildCustomer360(makeD1(sqlite))).map(record => record.customerId), ["CUST-X"]);
});
