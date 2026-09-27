#!/usr/bin/env node
/**
 * Run a SQL file against a REMOTE D1 database WITHOUT taking the database offline.
 *
 * `wrangler d1 execute --remote --file` uses D1's import API; while an import runs, D1 refuses every
 * query the live Worker sends ("Currently processing a long-running import"), so customers booking
 * during a staging deploy got failures. This sends the same statements, in order, through
 * `--command` (D1's ordinary query API) in chunks of at most --max-chunk-bytes, which run alongside
 * live traffic. See scripts/schema/sql-statements.mjs for how statements are found.
 *
 * Every file this runs is replay-safe (CREATE … IF NOT EXISTS, INSERT OR IGNORE, upward-only
 * UPDATE), so a chunk refused before it ran - D1 busy with someone else's import, or overloaded -
 * is simply sent again. A chunk that fails for any other reason stops the run with that error.
 *
 * Usage:
 *   node scripts/schema/apply-remote-sql.mjs --binding DB --config dist/server/wrangler.json --file scripts/employee-seed.sql [--max-chunk-bytes 30000] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyRemoteD1Retry } from "../../lib/remote-d1-retry.mjs";
import { assertNoTransactionControl, chunkSqlStatements, splitSqlStatements } from "./sql-statements.mjs";

export const DEFAULT_MAX_CHUNK_BYTES = 30_000;
export const DEFAULT_ATTEMPTS = 12;
const retryDelaySeconds = (attempt) => Math.min(3 * attempt, 20);

/** wrangler d1 execute <binding> --remote [--config <config>] --command <sql> */
export function wranglerCommandArgs({ binding, config, sql }) {
  const args = ["wrangler", "d1", "execute", binding, "--remote"];
  if (config) args.push("--config", config);
  args.push("--command", sql);
  return args;
}

function runWrangler(args) {
  return execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function sleepSeconds(seconds) {
  execFileSync("sleep", [String(seconds)], { stdio: "ignore" });
}

/**
 * Send one piece of SQL, retrying only refusals that happened before it ran. `run` and `sleep` are
 * injectable so the retry policy is testable without a network.
 */
export function executeRemoteCommand({ binding, config, sql, label, run = runWrangler, sleep = sleepSeconds, attempts = DEFAULT_ATTEMPTS, log = console }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run(wranglerCommandArgs({ binding, config, sql }));
    } catch (error) {
      const detail = `${error?.message ?? ""}\n${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      const retry = classifyRemoteD1Retry(detail);
      if (!retry.retryable || attempt === attempts) throw error;
      const wait = retryDelaySeconds(attempt);
      log.warn(`[d1] ${label} hit ${retry.reason}; retry ${attempt}/${attempts - 1} in ${wait}s`);
      sleep(wait);
    }
  }
  throw new Error(`unreachable: ${label}`);
}

/** Split, chunk and send a whole SQL text. Returns the number of statements and chunks sent. */
export function executeRemoteSql({ binding, config, sql, label, maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES, dryRun = false, log = console, ...rest }) {
  const statements = splitSqlStatements(sql);
  assertNoTransactionControl(statements);
  const chunks = chunkSqlStatements(statements, maxChunkBytes);
  if (dryRun) {
    log.log(`[d1] DRY RUN ${label}: ${statements.length} statements in ${chunks.length} chunk(s) of at most ${maxChunkBytes} bytes`);
    return { statements: statements.length, chunks: chunks.length };
  }
  chunks.forEach((chunk, index) => {
    executeRemoteCommand({ binding, config, sql: chunk, label: `${label} chunk ${index + 1}/${chunks.length}`, log, ...rest });
  });
  log.log(`[d1] ${label}: ${statements.length} statements applied in ${chunks.length} chunk(s)`);
  return { statements: statements.length, chunks: chunks.length };
}

function main(argv) {
  const flag = (name, fallback = null) => {
    const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const file = flag("file");
  if (!file) throw new Error("--file is required");
  const maxChunkBytes = Number(flag("max-chunk-bytes", DEFAULT_MAX_CHUNK_BYTES));
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 1_000 || maxChunkBytes > 90_000) throw new Error("--max-chunk-bytes must be an integer between 1000 and 90000");
  executeRemoteSql({
    binding: flag("binding", "DB"),
    config: flag("config"),
    sql: readFileSync(file, "utf8"),
    label: file,
    maxChunkBytes,
    dryRun: argv.includes("--dry-run"),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
