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
import { DEFAULT_MAX_CHUNK_BYTES, executeRemoteCommand, executeRemoteFile } from "./apply-remote-sql.mjs";
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
    for (const statement of migration.statements) {
      const trigger = triggerStatement(statement);
      if (!trigger) { pending.push(statement); continue; }
      flush();
      steps.push({ type: "trigger", ...trigger, sql: statement, file: migration.file });
    }
  }
  flush();
  return steps;
}

/*
 * TRIGGERS NEVER TRAVEL IN A --command CHUNK. D1's query API splits multi-statement text itself and
 * cuts some trigger bodies (BEGIN ... CASE ... END; ... END) apart: the first staging deploy of the
 * chunked runner failed with "incomplete input: SQLITE_ERROR" on the chunk holding 13 of them. The
 * import API (--file) parses them correctly but takes the database offline while it runs, so a
 * trigger is sent only when the database does not already hold exactly that trigger:
 *   - CREATE TRIGGER IF NOT EXISTS for a name that exists is a no-op, as the SQL itself says;
 *   - a DROP TRIGGER followed by the CREATE that replaces it (0030 re-defines 0017's
 *     gateway_webhook_events_immutable_update) is skipped as a pair when the live definition
 *     already equals the replacement.
 * On a database that is up to date, a deploy therefore imports nothing.
 */
const TRIGGER = /^\s*(CREATE|DROP)\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`\[]?([A-Za-z_][A-Za-z0-9_]*)/i;
export function triggerStatement(statement) {
  const match = TRIGGER.exec(statement);
  return match ? { action: match[1].toLowerCase(), name: match[2] } : null;
}
/** A trigger's definition as SQLite stores it in sqlite_master (IF NOT EXISTS dropped), whitespace-insensitive. */
export const triggerDefinition = (sql) => String(sql ?? "").replace(/\bIF\s+NOT\s+EXISTS\s+/i, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim();

/**
 * For each trigger step, what the deploy must do given the triggers the database holds now
 * (name -> stored sql): "skip", "drop" (a --command without a body, safe for the query API) or
 * "create" (a single-statement --file import). Other steps map to null.
 */
export function resolveTriggerSteps(steps, existing) {
  const live = new Map([...existing].map(([name, sql]) => [name, triggerDefinition(sql)]));
  const decisions = steps.map(() => null);
  const pairedCreate = new Set();
  steps.forEach((step, index) => {
    if (step.type !== "trigger") return;
    if (step.action === "drop") {
      const next = steps.findIndex((later, at) => at > index && later.type === "trigger" && later.name === step.name);
      const replacement = next >= 0 && steps[next].action === "create" ? steps[next] : null;
      if (replacement && live.get(step.name) === triggerDefinition(replacement.sql)) {
        decisions[index] = "skip";
        decisions[next] = "skip";
        pairedCreate.add(next);
        return;
      }
      decisions[index] = live.has(step.name) ? "drop" : "skip";
      live.delete(step.name);
      return;
    }
    if (pairedCreate.has(index)) return;
    if (live.has(step.name)) { decisions[index] = "skip"; return; }
    decisions[index] = "create";
    live.set(step.name, triggerDefinition(step.sql));
  });
  return decisions;
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
  const triggers = steps.filter((step) => step.type === "trigger");
  console.log(`[schema] ${migrations.length} migration files, ${migrations.reduce((n, m) => n + m.statements.length, 0)} statements, ${directives.length} add-column directives, ${chunks.length} chunk(s), ${triggers.length} trigger statement(s)`);

  if (DRY) {
    for (const { directive: d } of directives) console.log(`[schema]   would check ${d.table}.${d.column} before ${d.file}`);
    return;
  }

  const remoteQuery = (sql) => {
    const base = ["wrangler", "d1", "execute", BINDING, "--remote"];
    if (CONFIG) base.push("--config", CONFIG);
    const parsed = JSON.parse(execFileSync("npx", [...base, "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    return parsed?.[0]?.results ?? parsed?.results ?? [];
  };
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

  // The triggers the database holds now decide which trigger statements still have to be sent.
  const existingTriggers = new Map(remoteQuery("SELECT name, sql FROM sqlite_master WHERE type='trigger'").map((row) => [String(row.name), String(row.sql ?? "")]));
  const decisions = resolveTriggerSteps(steps, existingTriggers);

  let added = 0, skipped = 0, deferred = 0, sent = 0, triggersSent = 0;
  console.log(`[schema] applying replay-safe DDL to ${BINDING} (remote) through the query API…`);
  for (const [index, step] of steps.entries()) {
    if (step.type === "trigger") {
      const decision = decisions[index];
      if (decision === "drop") executeRemoteCommand({ binding: BINDING, config: CONFIG, sql: `DROP TRIGGER IF EXISTS ${ident(step.name)}`, label: `drop trigger ${step.name}` });
      if (decision === "create") executeRemoteFile({ binding: BINDING, config: CONFIG, sql: `${step.sql};\n`, label: `trigger ${step.name} (${step.file})` });
      if (decision !== "skip") { triggersSent += 1; console.log(`[schema]   ${decision} trigger ${step.name}`); }
      continue;
    }
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
  console.log(`[schema] done — ${sent} chunk(s) sent, ${triggersSent} trigger statement(s) sent (${triggers.length - triggersSent} already in place), columns added ${added}, already present ${skipped}, deferred ${deferred}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
