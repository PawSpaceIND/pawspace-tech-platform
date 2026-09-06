import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";

// The Diamond CRM build ships a source-text contract (tests/diamond-build-gap-source-contract.test.mjs)
// that greps the merge module for the right strings, but nothing EXECUTES the merge. A customer merge
// re-points pets, bookings, leads and conversations onto a survivor and closes a review - a destructive,
// irreversible relationship rewrite. This runs it against a real in-memory D1 so the behaviour, not the
// source, is what is pinned. lib modules import each other extensionlessly, so the resolver is required.
installWorkersHooks("__CRM_MERGE_EXEC_DB__");
const { executeTransactionalCustomerMerge } = await import("../lib/crm-transactional-merge.ts");

function seed(sqlite) {
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'test',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE canonical_pets (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed');
    CREATE TABLE lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL);
    CREATE TABLE customer_merge_reviews (id TEXT PRIMARY KEY, primary_customer_id TEXT NOT NULL, duplicate_customer_id TEXT NOT NULL, match_reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL);
    INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,created_at,updated_at) VALUES
      ('CUST-P','blr','Asha','9876500001',NULL,NULL,1,1),
      ('CUST-D','blr','Asha Rao','9876500001',NULL,'asha@example.com',1,1);
    INSERT INTO canonical_pets (id,customer_id,name) VALUES ('PET-1','CUST-D','Bruno'),('PET-2','CUST-D','Kaia');
    INSERT INTO canonical_bookings (id,customer_id,status) VALUES ('BKG-1','CUST-D','completed');
    INSERT INTO lead_work_items (id,customer_id,status,updated_at) VALUES ('LEAD-1','CUST-D','active',1);
    INSERT INTO customer_merge_reviews (id,primary_customer_id,duplicate_customer_id,match_reason,status,created_at) VALUES ('MREV-1','CUST-P','CUST-D','phone_match','open',1);
  `);
}
const count = (sqlite, sql) => Number(sqlite.prepare(sql).get().c);

test("transactional merge re-points every child relationship onto the survivor", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  const result = await executeTransactionalCustomerMerge(makeD1(sqlite), {
    primaryCustomerId: "CUST-P", duplicateCustomerId: "CUST-D", actorId: "ops@pawspace.in", reason: "manual duplicate review",
  });
  assert.equal(result.status, "completed");
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM canonical_pets WHERE customer_id='CUST-P'"), 2);
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM canonical_bookings WHERE customer_id='CUST-P'"), 1);
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM lead_work_items WHERE customer_id='CUST-P'"), 1);
  // No child is left stranded on the duplicate.
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM canonical_pets WHERE customer_id='CUST-D'"), 0);
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM canonical_bookings WHERE customer_id='CUST-D'"), 0);
});

test("the survivor inherits the duplicate's richer contact fields", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  await executeTransactionalCustomerMerge(makeD1(sqlite), {
    primaryCustomerId: "CUST-P", duplicateCustomerId: "CUST-D", actorId: "ops@pawspace.in", reason: "manual duplicate review",
  });
  const survivor = sqlite.prepare("SELECT name,email FROM canonical_customers WHERE id='CUST-P'").get();
  assert.equal(survivor.email, "asha@example.com"); // filled via COALESCE from the duplicate
  assert.equal(survivor.name, "Asha Rao"); // the longer of the two names wins
});

test("merge and review are recorded for audit", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  await executeTransactionalCustomerMerge(makeD1(sqlite), {
    primaryCustomerId: "CUST-P", duplicateCustomerId: "CUST-D", actorId: "ops@pawspace.in", reason: "manual duplicate review",
  });
  assert.equal(sqlite.prepare("SELECT status FROM customer_merge_reviews WHERE id='MREV-1'").get().status, "merged");
  const run = sqlite.prepare("SELECT status,actor_id FROM customer_merge_runs WHERE primary_customer_id='CUST-P' AND duplicate_customer_id='CUST-D'").get();
  assert.equal(run.status, "completed");
  assert.equal(run.actor_id, "ops@pawspace.in");
});

test("the merged loser row is neutralized so it can never be re-detected as a duplicate", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  await executeTransactionalCustomerMerge(makeD1(sqlite), {
    primaryCustomerId: "CUST-P", duplicateCustomerId: "CUST-D", actorId: "ops@pawspace.in", reason: "manual duplicate review",
  });
  const loser = sqlite.prepare("SELECT merged_into,primary_phone,secondary_phone,email FROM canonical_customers WHERE id='CUST-D'").get();
  assert.equal(loser.merged_into, "CUST-P", "the loser must point at the survivor");
  assert.notEqual(loser.primary_phone, "9876500001"); // no longer shares the survivor's phone
  assert.equal(loser.email, null);
  assert.equal(loser.secondary_phone, null);
  // The survivor still owns the real phone, and the dedup normalizer (digits-only, last 10) yields nothing
  // for the loser, so the pair can never re-collide.
  assert.equal(sqlite.prepare("SELECT primary_phone FROM canonical_customers WHERE id='CUST-P'").get().primary_phone, "9876500001");
  assert.equal(String(loser.primary_phone).replace(/\D/g, ""), "");
  // Originals are preserved for audit/reversal in the merge-run summary.
  const run = sqlite.prepare("SELECT summary_json FROM customer_merge_runs WHERE duplicate_customer_id='CUST-D'").get();
  assert.match(run.summary_json, /9876500001/);
  assert.match(run.summary_json, /asha@example\.com/);
});

test("merge is refused without an open duplicate review (governance gate)", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  sqlite.exec("UPDATE customer_merge_reviews SET status='dismissed'");
  await assert.rejects(
    executeTransactionalCustomerMerge(makeD1(sqlite), {
      primaryCustomerId: "CUST-P", duplicateCustomerId: "CUST-D", actorId: "ops@pawspace.in", reason: "manual duplicate review",
    }),
    /open duplicate review is required/,
  );
});

test("merge is refused for an unclear reason and for identical ids", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  await assert.rejects(
    executeTransactionalCustomerMerge(makeD1(sqlite), { primaryCustomerId: "CUST-P", duplicateCustomerId: "CUST-D", actorId: "ops@pawspace.in", reason: "dup" }),
    /clear merge reason/,
  );
  await assert.rejects(
    executeTransactionalCustomerMerge(makeD1(sqlite), { primaryCustomerId: "CUST-P", duplicateCustomerId: "CUST-P", actorId: "ops@pawspace.in", reason: "manual duplicate review" }),
    /must differ/,
  );
});
