#!/usr/bin/env node
/**
 * Apply the drizzle migration set to a REMOTE D1 database, idempotently.
 *
 * WHY THIS EXISTS INSTEAD OF `wrangler d1 migrations apply`.
 * Wrangler's migration runner executes each .sql file verbatim and records it in a ledger. That is
 * the wrong tool for this repository, and a dry run proves it:
 *
 *   1. 62 `CREATE TABLE` and 7 `CREATE INDEX` statements in migrations 0000-0016 carry no
 *      IF NOT EXISTS. Staging and production already hold those tables — 746 of the platform's 857
 *      tables are created at runtime by ensure*Tables(), not by any migration — so a verbatim
 *      apply aborts on the first collision.
 *   2. 0038 carries `-- @add-column-if-missing` directives in COMMENTS, because SQLite has no
 *      ADD COLUMN IF NOT EXISTS. Wrangler cannot read them, so the columns are never added and the
 *      index that follows fails with "no such column: aad_agent_id".
 *
 * scripts/schema/apply-idempotent-drizzle.mjs already solves both for a local node:sqlite handle.
 * This wraps that same normalisation for a remote D1 over `wrangler d1 execute`.
 *
 * The statements go through `--command` (D1's ordinary query API) in chunks, never `--file`: a file
 * import makes D1 refuse every live query until it finishes ("Currently processing a long-running
 * import"), and this runs on every staging deploy - it used to be 50 imports in a row, each one a
 * window in which customers' bookings failed. See scripts/schema/apply-remote-sql.mjs.
 * tests/remote-sql-chunked-apply.test.mjs executes planMigrationSteps() against SQLite and proves it
 * builds exactly the schema the file-by-file runner builds.
 *
 * Usage:
 *   node scripts/schema/apply-remote-migrations.mjs --binding DB --config dist/server/wrangler.json [--dry-run]
 *
 * --dry-run prints what it would apply and touches nothing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeReplaySafeDdl } from "./apply-idempotent-drizzle.mjs";
import { DEFAULT_MAX_CHUNK_BYTES, executeRemoteCommand } from "./apply-remote-sql.mjs";
import { assertNoTransactionControl, chunkSqlStatements, splitSqlStatements } from "./sql-statements.mjs";

const ADD_COLUMN = /^\s*--\s*@add-column-if-missing\s+([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\|(.+)\s*$/gm;
export const ident = (v) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`Unsafe SQLite identifier: ${v}`);
  return `"${v}"`;
};

/** Every migration file in order, normalised to replay-safe DDL and split into statements. */
export function loadMigrations(dir = "drizzle") {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((file) => {
    const raw = readFileSync(path.join(dir, file), "utf8");
    const directives = [...raw.matchAll(ADD_COLUMN)].map((m) => ({ file, table: m[1], column: m[2], definition: m[3].trim() }));
    // Split up front, so a statement the splitter cannot place fails the deploy before any SQL runs.
    const statements = splitSqlStatements(normalizeReplaySafeDdl(raw));
    assertNoTransactionControl(statements);
    return { file, directives, statements };
  });
}

/**
 * The ordered work: statements in migration order, chunked, with each file's governed ADD COLUMN
 * directives placed after every earlier file's statements and before that file's own, because the
 * same migration may create an index/trigger that references those new columns
 * (0038_atlas_mas_audit_remediation.sql is the canonical example).
 */
export function planMigrationSteps(migrations, maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES) {
  const steps = [];
  let pending = [];
  const flush = () => {
    for (const sql of chunkSqlStatements(pending, maxChunkBytes)) steps.push({ type: "sql", sql });
    pending = [];
  };
  for (const migration of migrations) {
    if (migration.directives.length) {
      flush();
      for (const directive of migration.directives) steps.push({ type: "directive", directive });
    }
    pending.push(...migration.statements);
  }
  flush();
  return steps;
}

export const addColumnSql = (directive) => `ALTER TABLE ${ident(directive.table)} ADD COLUMN ${ident(directive.column)} ${directive.definition}`;

function main(args) {
  const flag = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
  };
  const BINDING = flag("binding", "DB");
  const CONFIG = flag("config");
  const DRY = args.includes("--dry-run");
  const migrations = loadMigrations(flag("dir", "drizzle"));
  const steps = planMigrationSteps(migrations);
  const directives = steps.filter((step) => step.type === "directive");
  const chunks = steps.filter((step) => step.type === "sql");
  console.log(`[schema] ${migrations.length} migration files, ${migrations.reduce((n, m) => n + m.statements.length, 0)} statements, ${directives.length} add-column directives, ${chunks.length} chunk(s)`);

  if (DRY) {
    for (const { directive: d } of directives) console.log(`[schema]   would check ${d.table}.${d.column} before ${d.file}`);
    return;
  }

  /** Columns a remote table already has, via PRAGMA over wrangler's JSON output. */
  const remoteColumns = (table) => {
    try {
      const base = ["wrangler", "d1", "execute", BINDING, "--remote"];
      if (CONFIG) base.push("--config", CONFIG);
      const out = execFileSync("npx", [...base, "--json", "--command", `PRAGMA table_info(${ident(table)})`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const parsed = JSON.parse(out);
      const rows = parsed?.[0]?.results ?? parsed?.results ?? [];
      return new Set(rows.map((r) => String(r.name)));
    } catch {
      // A table the runtime has not created yet has no columns to add to. Reported, never fatal:
      // ensure*Tables() will create it on first use and the directive re-runs on the next deploy.
      return null;
    }
  };

  let added = 0, skipped = 0, deferred = 0, sent = 0;
  console.log(`[schema] applying replay-safe DDL to ${BINDING} (remote) through the query API…`);
  for (const step of steps) {
    if (step.type === "sql") {
      sent += 1;
      executeRemoteCommand({ binding: BINDING, config: CONFIG, sql: step.sql, label: `migration chunk ${sent}/${chunks.length}` });
      continue;
    }
    const { directive } = step;
    const columns = remoteColumns(directive.table);
    if (columns === null) {
      deferred += 1;
      console.log(`[schema]   defer ${directive.table}.${directive.column} — table not present yet`);
    } else if (columns.has(directive.column)) {
      skipped += 1;
    } else {
      executeRemoteCommand({ binding: BINDING, config: CONFIG, sql: addColumnSql(directive), label: `add column ${directive.table}.${directive.column}` });
      added += 1;
      console.log(`[schema]   added ${directive.table}.${directive.column}`);
    }
  }
  console.log(`[schema] done — ${sent} chunk(s) sent, columns added ${added}, already present ${skipped}, deferred ${deferred}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
