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

function wranglerWithResetRetry(sqlArgs, label, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return wrangler(sqlArgs);
    } catch (error) {
      const detail = `${error?.message ?? ""}\n${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      const reset = detail.includes("D1_RESET_DO");
      if (!reset || attempt === attempts) throw error;
      console.warn(`[schema] ${label} hit D1_RESET_DO; retrying ${attempt}/${attempts - 1}`);
      execFileSync("sleep", [String(attempt * 2)], { stdio: "ignore" });
    }
  }
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
const migrations = [];
const directives = [];

for (const file of files) {
  const raw = readFileSync(path.join(DIR, file), "utf8");
  for (const m of raw.matchAll(ADD_COLUMN)) {
    directives.push({ file, table: m[1], column: m[2], definition: m[3].trim() });
  }
  migrations.push({ file, sql: `-- ${file}\n${normalizeReplaySafeDdl(raw)}` });
}

const combined = migrations.map((migration) => migration.sql).join("\n\n");
console.log(`[schema] ${files.length} migration files, ${directives.length} add-column directives`);

// Phase 1 — the replay-safe DDL. Every CREATE is IF NOT EXISTS and every DROP is IF EXISTS after
// normalisation, so this is safe to re-run on every deploy.
const tmp = mkdtempSync(path.join(tmpdir(), "pawspace-schema-"));
const sqlFile = path.join(tmp, "migrations.sql");
writeFileSync(sqlFile, combined);

if (DRY) {
  console.log(`[schema] DRY RUN — ${combined.split("\n").length} lines written to ${sqlFile}`);
  for (const d of directives) console.log(`[schema]   would check ${d.table}.${d.column}`);
  process.exit(0);
}

console.log(`[schema] applying replay-safe DDL to ${BINDING} (remote), one migration at a time…`);
for (let index = 0; index < migrations.length; index += 1) {
  const migration = migrations[index];
  const migrationFile = path.join(tmp, `${String(index).padStart(4, "0")}-${migration.file}`);
  writeFileSync(migrationFile, migration.sql);
  wranglerWithResetRetry(["--file", migrationFile], `migration ${migration.file}`);
  console.log(`[schema]   applied ${migration.file}`);
}

// Phase 2 — the columns SQLite cannot add conditionally. Each is checked against the live table and
// added only when absent, which is exactly what the local runner does with PRAGMA table_info.
let added = 0, skipped = 0, deferred = 0;
for (const d of directives) {
  const columns = remoteColumns(d.table);
  if (columns === null) { deferred += 1; console.log(`[schema]   defer ${d.table}.${d.column} — table not present yet`); continue; }
  if (columns.has(d.column)) { skipped += 1; continue; }
  wranglerWithResetRetry(["--command", `ALTER TABLE ${ident(d.table)} ADD COLUMN ${ident(d.column)} ${d.definition}`], `add column ${d.table}.${d.column}`);
  added += 1;
  console.log(`[schema]   added ${d.table}.${d.column}`);
}

console.log(`[schema] done — columns added ${added}, already present ${skipped}, deferred ${deferred}`);
