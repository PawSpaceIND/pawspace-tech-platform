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
 * Usage:
 *   node scripts/schema/apply-remote-migrations.mjs --binding DB --config dist/server/wrangler.json [--dry-run]
 *
 * --dry-run prints the SQL it would apply and touches nothing.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeReplaySafeDdl } from "./apply-idempotent-drizzle.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BINDING = flag("binding", "DB");
const CONFIG = flag("config");
const DRY = args.includes("--dry-run");
const DIR = flag("dir", "drizzle");

const ADD_COLUMN = /^\s*--\s*@add-column-if-missing\s+([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\|(.+)\s*$/gm;
const ident = (v) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(`Unsafe SQLite identifier: ${v}`);
  return `"${v}"`;
};

function wrangler(sqlArgs) {
  const base = ["wrangler", "d1", "execute", BINDING, "--remote"];
  if (CONFIG) base.push("--config", CONFIG);
  return execFileSync("npx", [...base, ...sqlArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Columns a remote table already has, via PRAGMA over wrangler's JSON output. */
function remoteColumns(table) {
  try {
    const out = wrangler(["--json", "--command", `PRAGMA table_info(${ident(table)})`]);
    const parsed = JSON.parse(out);
    const rows = parsed?.[0]?.results ?? parsed?.results ?? [];
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    // A table the runtime has not created yet has no columns to add to. Reported, never fatal:
    // ensure*Tables() will create it on first use and the directive re-runs on the next deploy.
    return null;
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const migrations = files.map((file) => {
  const raw = readFileSync(path.join(DIR, file), "utf8");
  const directives = [...raw.matchAll(ADD_COLUMN)].map((m) => ({
    file,
    table: m[1],
    column: m[2],
    definition: m[3].trim(),
  }));
  const ddl = normalizeReplaySafeDdl(raw.replace(ADD_COLUMN, ""));
  return { file, directives, ddl };
});
const directiveCount = migrations.reduce((n, migration) => n + migration.directives.length, 0);
console.log(`[schema] ${files.length} migration files, ${directiveCount} add-column directives`);

const tmp = mkdtempSync(path.join(tmpdir(), "pawspace-schema-"));
if (DRY) {
  for (const migration of migrations) {
    for (const d of migration.directives) console.log(`[schema]   would check ${d.table}.${d.column} before ${migration.file}`);
    console.log(`[schema]   would apply ${migration.file}`);
  }
  process.exit(0);
}

// Match the local idempotent runner: each migration's governed column additions must exist before
// that same migration's indexes/triggers/views are executed. Applying the full DDL set first makes
// migrations such as 0038 fail when an index references a newly governed column (aad_agent_id).
let added = 0, skipped = 0, deferred = 0;
for (const migration of migrations) {
  for (const d of migration.directives) {
    const columns = remoteColumns(d.table);
    if (columns === null) {
      deferred += 1;
      console.log(`[schema]   defer ${d.table}.${d.column} — table not present before ${migration.file}`);
      continue;
    }
    if (columns.has(d.column)) { skipped += 1; continue; }
    wrangler(["--command", `ALTER TABLE ${ident(d.table)} ADD COLUMN ${ident(d.column)} ${d.definition}`]);
    added += 1;
    console.log(`[schema]   added ${d.table}.${d.column}`);
  }

  const sqlFile = path.join(tmp, `${migration.file}.sql`);
  writeFileSync(sqlFile, `-- ${migration.file}\n${migration.ddl}`);
  console.log(`[schema] applying ${migration.file} to ${BINDING} (remote)…`);
  wrangler(["--file", sqlFile]);
}

console.log(`[schema] done — columns added ${added}, already present ${skipped}, deferred ${deferred}`);
