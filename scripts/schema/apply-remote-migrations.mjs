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

/**
 * D1 answers a batch of schema changes with {"D1_RESET_DO":true} when the Durable Object backing
 * the database has to restart to pick them up. wrangler surfaces that as a non-zero exit, but it is
 * a restart signal rather than a rejection — the first real run of this step died on it after
 * uploading the combined file.
 *
 * So: one file at a time rather than all 46 concatenated, which keeps each change set small enough
 * that a reset is rare, and a bounded retry for when one happens anyway. Every statement is
 * CREATE ... IF NOT EXISTS by this point, so a retry can only re-assert what is already there.
 */
const isResetSignal = (error) => {
  const text = `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ?? ""}`;
  return text.includes("D1_RESET_DO");
};

function wranglerWithRetry(sqlArgs, label, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return wrangler(sqlArgs);
    } catch (error) {
      if (!isResetSignal(error) || attempt === attempts) throw error;
      const waitMs = 2000 * attempt;
      console.log(`[schema]   ${label}: D1 asked for a Durable Object reset, retrying in ${waitMs}ms (${attempt}/${attempts - 1})`);
      execFileSync("sleep", [String(waitMs / 1000)]);
    }
  }
  throw new Error("unreachable");
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
const perFile = [];
const directives = [];

for (const file of files) {
  const raw = readFileSync(path.join(DIR, file), "utf8");
  for (const m of raw.matchAll(ADD_COLUMN)) {
    directives.push({ file, table: m[1], column: m[2], definition: m[3].trim() });
  }
  perFile.push({ file, sql: normalizeReplaySafeDdl(raw) });
}

console.log(`[schema] ${files.length} migration files, ${directives.length} add-column directives`);

const tmp = mkdtempSync(path.join(tmpdir(), "pawspace-schema-"));

if (DRY) {
  for (const { file, sql } of perFile) {
    writeFileSync(path.join(tmp, file), sql);
  }
  console.log(`[schema] DRY RUN — ${perFile.length} normalised files written to ${tmp}`);
  for (const d of directives) console.log(`[schema]   would check ${d.table}.${d.column}`);
  process.exit(0);
}

// Phase 1 — the replay-safe DDL, one migration at a time. Every CREATE is IF NOT EXISTS and every
// DROP is IF EXISTS after normalisation, so this is safe to re-run on every deploy.
console.log(`[schema] applying ${perFile.length} migrations to ${BINDING} (remote), one file at a time…`);
for (const { file, sql } of perFile) {
  const target = path.join(tmp, file);
  writeFileSync(target, sql);
  wranglerWithRetry(["--file", target], file);
  console.log(`[schema]   applied ${file}`);
}

// Phase 2 — the columns SQLite cannot add conditionally. Each is checked against the live table and
// added only when absent, which is exactly what the local runner does with PRAGMA table_info.
let added = 0, skipped = 0, deferred = 0;
for (const d of directives) {
  const columns = remoteColumns(d.table);
  if (columns === null) { deferred += 1; console.log(`[schema]   defer ${d.table}.${d.column} — table not present yet`); continue; }
  if (columns.has(d.column)) { skipped += 1; continue; }
  wranglerWithRetry(["--command", `ALTER TABLE ${ident(d.table)} ADD COLUMN ${ident(d.column)} ${d.definition}`], `${d.table}.${d.column}`);
  added += 1;
  console.log(`[schema]   added ${d.table}.${d.column}`);
}

console.log(`[schema] columns added ${added}, already present ${skipped}, deferred ${deferred}`);

/*
 * Phase 3 — prove it, rather than trust the exit codes above.
 *
 * These ten tables are declared by a migration and by no ensure*Tables() anywhere in lib/ or
 * app/api, so unlike the other 746 they cannot appear just by being used. They are the entire
 * reason this step exists: if the apply silently did nothing, DPDP consent, GST documents and the
 * tax rule ledger would still be missing and the deploy would carry on regardless. Asserting them
 * here turns that from a silent gap into a failed deploy.
 */
const MIGRATION_ONLY_TABLES = [
  "dpdp_consent_records", "gst_documents", "tax_rule_versions", "gateway_refunds",
  "service_proof_ledgers", "subscription_entitlements", "subscription_entitlement_events",
  "atlas_pending_approvals", "canonical_revenue_opportunity_context",
  "canonical_revenue_opportunity_service_history",
];

const quoted = MIGRATION_ONLY_TABLES.map((t) => `'${t}'`).join(",");
const verifyOut = wranglerWithRetry(
  ["--json", "--command", `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${quoted}) ORDER BY name`],
  "verification",
);
let present = [];
try {
  const parsed = JSON.parse(verifyOut);
  present = (parsed?.[0]?.results ?? parsed?.results ?? []).map((r) => String(r.name));
} catch {
  console.error("[schema] could not parse the verification result; treating as a failure");
  process.exit(1);
}

const missing = MIGRATION_ONLY_TABLES.filter((t) => !present.includes(t));
console.log(`[schema] verified ${present.length}/${MIGRATION_ONLY_TABLES.length} migration-only tables present`);
for (const t of present) console.log(`[schema]   ok ${t}`);
if (missing.length) {
  console.error(`[schema] MISSING after apply: ${missing.join(", ")}`);
  console.error("[schema] refusing to let the deploy continue against an incomplete schema");
  process.exit(1);
}

console.log("[schema] done — schema applied and verified");
