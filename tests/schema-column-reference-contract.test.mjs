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
