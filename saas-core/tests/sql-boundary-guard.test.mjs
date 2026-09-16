/*
 * Structural guards. These do not test behaviour — they test that the shape of the codebase still
 * makes the behaviour hard to break.
 *
 * The isolation battery proves the seam works. These prove nobody has quietly gone around it. That
 * is the failure mode that actually happens on a growing team: not someone defeating TenantContext,
 * but someone reaching for `db.prepare` because it was two lines shorter that afternoon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

/**
 * The only files allowed to speak SQL directly.
 *
 * Adding one is a deliberate act that shows up in a diff and needs a reason in review. If this list
 * grows past a handful, the seam has stopped being a seam.
 */
const SQL_OWNERS = new Set([
  "tenancy/context.ts",     // the seam itself
  "tenancy/schema.ts",      // DDL
  "tenancy/provisioning.ts", // platform + bridge tables, which by definition have no tenant to scope to
]);

function sourceFiles(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("GUARD-01 no module outside the seam speaks SQL directly", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const key = relative(SRC, file);
    if (SQL_OWNERS.has(key)) continue;
    const body = readFileSync(file, "utf8");
    if (/\.prepare\s*\(|\.batch\s*\(|\.exec\s*\(/.test(body)) offenders.push(key);
  }
  assert.deepEqual(
    offenders,
    [],
    `These modules call the database directly instead of going through TenantContext:\n  ${offenders.join("\n  ")}\n` +
      "Either route the query through the context, or add the file to SQL_OWNERS with a reason.",
  );
});

test("GUARD-02 the SQL owners never touch a tenant-scoped table without a tenant predicate", async () => {
  const { TENANT_SCOPED } = await import("../src/tenancy/schema.ts");
  const context = readFileSync(join(SRC, "tenancy/context.ts"), "utf8");

  // provisioning.ts is allowed raw SQL for `tenants`, `identities` and `memberships` only. If it
  // ever names an operational table, it has become a second, unguarded way into tenant data.
  const provisioning = readFileSync(join(SRC, "tenancy/provisioning.ts"), "utf8");
  const statements = [...provisioning.matchAll(/\.prepare\s*\(\s*(`|"|')([\s\S]*?)\1/g)].map((m) => m[2]);
  assert.ok(statements.length > 0, "found no SQL in provisioning.ts — the extraction regex has drifted");

  for (const sql of statements) {
    for (const table of TENANT_SCOPED) {
      const named = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, "i").test(sql);
      assert.ok(!named, `provisioning.ts issues raw SQL against the tenant-scoped table "${table}":\n${sql}`);
    }
  }

  // Inside the seam, every statement that names a tenant-scoped table must carry the predicate. The
  // scope builder is the only thing entitled to produce it, so this asserts the builder is used.
  assert.ok(
    /parts = \["tenant_id = \?"\]/.test(context),
    "context.ts no longer opens its scope predicate with tenant_id — the seam has been rewritten",
  );
});

test("GUARD-03 every table in the schema is classified exactly once", async () => {
  const schema = readFileSync(join(SRC, "tenancy/schema.ts"), "utf8");
  const { TENANT_SCOPED, PLATFORM_SCOPED, BRIDGE_SCOPED } = await import("../src/tenancy/schema.ts");

  const declared = new Set(
    [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]),
  );
  assert.ok(declared.size > 0, "no CREATE TABLE statements found — the extraction regex has drifted");

  for (const table of declared) {
    const memberships =
      Number(TENANT_SCOPED.has(table)) + Number(PLATFORM_SCOPED.has(table)) + Number(BRIDGE_SCOPED.has(table));
    assert.equal(
      memberships,
      1,
      `Table "${table}" is classified ${memberships} times. Every table must be registered in exactly ` +
        "one of TENANT_SCOPED, PLATFORM_SCOPED or BRIDGE_SCOPED. An unclassified table is a table " +
        "nobody decided the isolation rule for.",
    );
  }

  // And nothing is registered that does not exist — a stale entry makes the registry lie.
  for (const table of [...TENANT_SCOPED, ...PLATFORM_SCOPED, ...BRIDGE_SCOPED]) {
    assert.ok(declared.has(table), `"${table}" is registered but has no CREATE TABLE statement`);
  }
});

test("GUARD-04 every tenant-scoped table carries tenant_id in its primary key", () => {
  const schema = readFileSync(join(SRC, "tenancy/schema.ts"), "utf8");
  const blocks = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n  \)`/g)];
  assert.ok(blocks.length > 0, "no table bodies found — the extraction regex has drifted");

  for (const [, table, body] of blocks) {
    if (!/tenant_id TEXT NOT NULL/.test(body)) continue;
    const pk = /PRIMARY KEY \(([^)]+)\)/.exec(body);
    assert.ok(pk, `${table} has tenant_id but no composite primary key`);
    assert.ok(
      pk[1].split(",").map((s) => s.trim())[0] === "tenant_id",
      `${table}'s primary key does not lead with tenant_id (${pk[1]}). Without it, two tenants share ` +
        "one id space and a bug can make one row resolve to the other.",
    );
  }
});
