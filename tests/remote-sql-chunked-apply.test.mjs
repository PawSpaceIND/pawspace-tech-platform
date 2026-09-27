/**
 * A staging deploy must not take the database offline, and a busy database must not reach the
 * customer as a server error.
 *
 * Round 2 (26 Sep 2026): POST /api/sitting-bookings and POST /api/taxi-ride-bookings answered
 * HTTP 500 {"error":"D1_ERROR: Currently processing a long-running import."}. Every staging deploy
 * ran `wrangler d1 execute --remote --file` 54 times (50 migrations, 4 seeds). A file import goes
 * through D1's import API, and until it finishes D1 refuses every query the live Worker sends.
 *
 * The deploy now sends the same statements through `--command` (the ordinary query API) in chunks.
 * These tests EXECUTE that path against SQLite, the engine D1 runs:
 *   - the splitter ends statements exactly where SQLite does (quotes, comments, triggers, CASE);
 *   - the real migration set, planned as chunks with its ADD COLUMN directives, builds exactly the
 *     schema the file-by-file runner builds, and re-running it changes nothing;
 *   - every seed the staging workflows load leaves exactly the rows the whole-file load leaves;
 *   - the runner only ever sends --command, retries only refusals that happened before anything ran;
 *   - the Worker turns a refusal into a plain 503 the screens can show, instead of a raw 500.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";
import { classifyRemoteD1Retry } from "../lib/remote-d1-retry.mjs";
import { assertNoTransactionControl, chunkSqlStatements, splitSqlStatements } from "../scripts/schema/sql-statements.mjs";
import { executeRemoteCommand, executeRemoteSql, wranglerCommandArgs } from "../scripts/schema/apply-remote-sql.mjs";
import { addColumnSql, loadMigrations, planMigrationSteps, resolveTriggerSteps, triggerStatement } from "../scripts/schema/apply-remote-migrations.mjs";
import { applyIdempotentMigrationFile } from "../scripts/schema/apply-idempotent-drizzle.mjs";

installWorkersHooks("__REMOTE_SQL_DB__", "__REMOTE_SQL_ENV__");

const capacity = await import("../lib/provider-capacity-governance.ts");
const { ensureBoardingStayLifecycleTables } = await import("../lib/boarding-stay-lifecycle.ts");
const { ensureTaxiFleetTables } = await import("../lib/taxi-fleet-governance.ts");
const transient = await import("../lib/d1-transient.ts");

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const IMPORT_REFUSAL = "✘ [ERROR] A request to the Cloudflare API failed.\n  D1_ERROR: Currently processing a long-running import. [code: 7500]";

// ---------------------------------------------------------------------------------------------
test("the splitter ends a statement only where SQLite does", () => {
  assert.deepEqual(
    splitSqlStatements("INSERT INTO t VALUES ('a;b', 'it''s; fine'); SELECT \"odd;name\", [x;y], `z;w` FROM t;\nSELECT 3"),
    ["INSERT INTO t VALUES ('a;b', 'it''s; fine')", "SELECT \"odd;name\", [x;y], `z;w` FROM t", "SELECT 3"],
  );
  assert.deepEqual(splitSqlStatements("-- one; two\nSELECT 1; /* three;\nfour */ SELECT 2;"), ["SELECT 1", "SELECT 2"]);

  const trigger = `CREATE TRIGGER IF NOT EXISTS guard AFTER UPDATE OF v ON t
    WHEN CASE WHEN NEW.v = 'END;' THEN 0 ELSE 1 END = 1
  BEGIN
    SELECT CASE WHEN NEW.v < 0 THEN RAISE(ABORT, 'no; END here') END;
    UPDATE t SET note = CASE WHEN NEW.v > 1 THEN 'x;' ELSE 'y' END WHERE id = NEW.id;
  END`;
  assert.deepEqual(splitSqlStatements(`${trigger};\nCREATE INDEX i ON t(v);`), [trigger, "CREATE INDEX i ON t(v)"]);
  assert.deepEqual(splitSqlStatements("UPDATE backend SET ended = CASE WHEN x THEN 1 END; SELECT 1"), ["UPDATE backend SET ended = CASE WHEN x THEN 1 END", "SELECT 1"],
    "words that merely contain END/CASE/BEGIN do not open or close a block");

  assert.throws(() => splitSqlStatements("SELECT 'open"), /Unterminated ' quote/);
  assert.throws(() => assertNoTransactionControl(splitSqlStatements("BEGIN TRANSACTION; SELECT 1; COMMIT;")), /transaction control/);

  // What SQLite itself makes of it: the trigger body runs as one statement and works.
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER, note TEXT)");
  for (const statement of splitSqlStatements(`${trigger};`)) sqlite.exec(statement);
  sqlite.exec("INSERT INTO t (id, v) VALUES (1, 0)");
  sqlite.exec("UPDATE t SET v = 2 WHERE id = 1");
  assert.equal(sqlite.prepare("SELECT note FROM t WHERE id = 1").get().note, "x;");
  assert.throws(() => sqlite.exec("UPDATE t SET v = -1 WHERE id = 1"), /no; END here/, "the whole body, RAISE included, is one trigger");
});

test("chunks keep statement order and stay under the size limit", () => {
  const statements = Array.from({ length: 50 }, (_, i) => `INSERT INTO t VALUES (${i}, '${"x".repeat(900)}')`);
  const chunks = chunkSqlStatements(statements, 5_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk) <= 5_000, "every chunk respects the limit");
  assert.deepEqual(chunks.flatMap((chunk) => splitSqlStatements(chunk)), statements, "nothing is lost, duplicated or reordered");
  const huge = `INSERT INTO t VALUES ('${"y".repeat(8_000)}')`;
  assert.deepEqual(chunkSqlStatements(["SELECT 1", huge, "SELECT 2"], 5_000), ["SELECT 1;\n", `${huge};\n`, "SELECT 2;\n"], "an oversize statement travels alone");
});

// ---------------------------------------------------------------------------------------------
async function deploymentShapedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  await capacity.ensureProviderCapacityTables(makeD1(sqlite));
  return sqlite;
}
const schemaOf = (sqlite) => sqlite.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();

/** planMigrationSteps() executed locally, doing exactly what the remote runner does for each step. */
const liveTriggers = (sqlite) => new Map(sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all().map((row) => [row.name, row.sql]));
/** Returns the trigger statements it had to send, as the remote runner decides them from the live triggers. */
function applyPlan(sqlite, steps) {
  const decisions = resolveTriggerSteps(steps, liveTriggers(sqlite));
  const sent = [];
  steps.forEach((step, index) => {
    if (step.type === "sql") { sqlite.exec(step.sql); return; }
    if (step.type === "trigger") {
      if (decisions[index] === "drop") sqlite.exec(`DROP TRIGGER IF EXISTS "${step.name}"`);
      if (decisions[index] === "create") sqlite.exec(step.sql);
      if (decisions[index] !== "skip") sent.push(`${decisions[index]} ${step.name}`);
      return;
    }
    const columns = sqlite.prepare(`PRAGMA table_info("${step.directive.table}")`).all().map((row) => row.name);
    if (columns.length && !columns.includes(step.directive.column)) sqlite.exec(addColumnSql(step.directive));
  });
  return sent;
}

test("the migration set sent as chunks builds exactly the schema the file-by-file runner builds, and re-sending it changes nothing", async () => {
  const files = fs.readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort();
  const reference = await deploymentShapedDatabase();
  for (const file of files) applyIdempotentMigrationFile(reference, path.join("drizzle", file));

  const migrations = loadMigrations("drizzle");
  assert.equal(migrations.length, files.length);
  const steps = planMigrationSteps(migrations);
  const chunks = steps.filter((step) => step.type === "sql");
  assert.ok(chunks.length < files.length / 2, `${files.length} imports became ${chunks.length} ordinary queries`);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk.sql) <= 30_000);

  // 0038's directives run after every earlier file and before 0038's own index on the new column.
  const firstDirective = steps.findIndex((step) => step.type === "directive");
  assert.ok(firstDirective > 0, "0038's directives follow the chunks that create their tables");
  assert.ok(steps.slice(firstDirective).some((step) => step.type === "sql" && /aad_agent_id/.test(step.sql)), "the index on the added column is sent after the directive");

  // D1's query API splits some trigger bodies apart ("incomplete input", first staging deploy), so no
  // chunk may carry one: every trigger statement is its own step.
  for (const chunk of chunks) assert.equal(chunk.sql.split(";\n").filter((statement) => triggerStatement(statement.trim())).length, 0, "a chunk carries no trigger");
  assert.ok(steps.filter((step) => step.type === "trigger").length >= 30);

  const chunked = await deploymentShapedDatabase();
  const firstDeploy = applyPlan(chunked, steps);
  assert.deepEqual(schemaOf(chunked), schemaOf(reference));
  assert.ok(firstDeploy.length >= 30, "a new database gets every trigger");

  assert.deepEqual(applyPlan(chunked, steps), [], "a database that is up to date imports nothing");
  assert.deepEqual(schemaOf(chunked), schemaOf(reference), "a second deploy is a no-op");
});

test("the triggers of the chunk that failed the first chunked staging deploy each travel alone and whole", () => {
  // Staging deploy of ff6ab2e (job 108573654969): migration chunk 2 of 8 (0017..0023) was refused with
  // "incomplete input: SQLITE_ERROR [code: 7500]". It carried these 13 triggers; 0017's
  // journal_transactions_post_balanced has CASE ... END; inside BEGIN ... END, which D1's own
  // statement splitter cuts apart.
  const failedChunkTriggers = ["gateway_webhook_events_immutable_delete", "journal_entries_no_update", "journal_entries_no_delete",
    "journal_transactions_post_balanced", "journal_transactions_posted_immutable", "journal_transactions_no_delete",
    "partner_release_requires_completed_booking", "tax_rule_versions_no_update", "tax_rule_versions_no_delete", "gst_documents_no_update",
    "gst_documents_no_delete", "payment_settlement_reconciliations_no_update", "payment_settlement_reconciliations_no_delete"];
  const steps = planMigrationSteps(loadMigrations("drizzle"));
  for (const step of steps.filter((s) => s.type === "sql")) assert.doesNotMatch(step.sql, /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i, "no --command chunk carries a trigger");
  const sqlite = freshSqlite();
  for (const name of failedChunkTriggers) {
    const step = steps.find((s) => s.type === "trigger" && s.action === "create" && s.name === name);
    assert.ok(step, `${name} is its own step`);
    assert.equal(splitSqlStatements(`${step.sql};`).length, 1, `${name} is one whole statement`);
    assert.match(step.sql, /\bEND$/, `${name} keeps its closing END`);
  }
  const balanced = steps.find((s) => s.type === "trigger" && s.name === "journal_transactions_post_balanced").sql;
  assert.equal((balanced.match(/\bCASE\b/g) || []).length, 2, "the CASE ... END; body that D1's splitter cut is intact");
  // The exact statement SQLite accepts and enforces as one trigger.
  sqlite.exec("CREATE TABLE journal_transactions (id TEXT PRIMARY KEY, status TEXT); CREATE TABLE journal_entries (transaction_id TEXT, direction TEXT, amount_paise INTEGER)");
  sqlite.exec(balanced);
  sqlite.exec("INSERT INTO journal_transactions VALUES ('T1','DRAFT'); INSERT INTO journal_entries VALUES ('T1','DEBIT',100),('T1','CREDIT',90)");
  assert.throws(() => sqlite.exec("UPDATE journal_transactions SET status='POSTED' WHERE id='T1'"), /journal is not balanced/);
});

test("a trigger is sent only when the database lacks exactly that trigger", () => {
  const create = (name, body) => ({ type: "trigger", action: "create", name, sql: `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE UPDATE ON t BEGIN ${body}; END` });
  const drop = (name) => ({ type: "trigger", action: "drop", name, sql: `DROP TRIGGER IF EXISTS ${name}` });
  // 0017 defines the trigger, 0030 drops it and defines it again: staging already holds 0030's version.
  const steps = [create("g", "SELECT 1"), { type: "sql", sql: "SELECT 1;\n" }, drop("g"), create("g", "SELECT 2")];
  assert.deepEqual(resolveTriggerSteps(steps, new Map([["g", "CREATE TRIGGER g  BEFORE UPDATE ON t BEGIN SELECT 2; END"]])), ["skip", null, "skip", "skip"]);
  // Staging still holds 0017's version: 0030 replaces it.
  assert.deepEqual(resolveTriggerSteps(steps, new Map([["g", "CREATE TRIGGER g BEFORE UPDATE ON t BEGIN SELECT 1; END"]])), ["skip", null, "drop", "create"]);
  // A new database: 0017 creates it, 0030 drops and re-creates it.
  assert.deepEqual(resolveTriggerSteps(steps, new Map()), ["create", null, "drop", "create"]);
  assert.deepEqual(triggerStatement("CREATE TEMP TRIGGER IF NOT EXISTS \"x_y\" AFTER INSERT ON t BEGIN SELECT 1; END"), { action: "create", name: "x_y" });
  assert.equal(triggerStatement("CREATE INDEX i ON t(v)"), null);
});

// ---------------------------------------------------------------------------------------------
/** Every table's rows, with the values the seeds stamp from 'now' replaced so two loads compare. */
function dump(sqlite, since, until) {
  const nowish = (value) => {
    if (typeof value === "number" || typeof value === "bigint") {
      const n = Number(value);
      if (n >= since / 1000 - 5 && n <= until / 1000 + 5) return "<now:s>";
      if (n >= since - 5_000 && n <= until + 5_000) return "<now:ms>";
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
      const t = Date.parse(value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
      if (t >= since - 5_000 && t <= until + 5_000) return "<now:iso>";
    }
    return value;
  };
  const out = {};
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    out[name] = sqlite.prepare(`SELECT * FROM "${name}"`).all()
      .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, nowish(v)])), (_, v) => typeof v === "bigint" ? String(v) : v))
      .sort();
  }
  return out;
}

async function stagingWorld(preload = []) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  await ensureBoardingStayLifecycleTables(db);
  await ensureTaxiFleetTables(db);
  for (const file of preload) sqlite.exec(read(file));
  return sqlite;
}

// Every file a staging workflow now sends through apply-remote-sql.mjs, with what must load first.
const SEEDS = [
  ["scripts/employee-seed.sql", []],
  ["scripts/uat-staging-provider-capacity.sql", []],
  ["scripts/uat-staging-citywide-groomers.sql", ["scripts/uat-staging-provider-capacity.sql"]],
  ["scripts/uat-staging-training-policies.sql", []],
  ["scripts/staging-seed.sql", []],
  ["scripts/uat-demo-seed.sql", []],
];

/*
 * Seeds stamp rows relative to the database clock ("unixepoch() * 1000 - 604800000"). Two loads a second apart
 * would then differ, so both loads read one fixed instant instead. Values the runtime setup stamps from
 * Date.now() are masked by dump().
 */
const FROZEN = "'2026-09-27 00:00:00'";
const freezeNow = (sql) => sql
  .replace(/unixepoch\(\s*\)/gi, `unixepoch(${FROZEN})`)
  .replace(/'now'/gi, FROZEN)
  .replace(/\bCURRENT_TIMESTAMP\b/g, FROZEN);

for (const [file, preload] of SEEDS) {
  test(`${file} sent as chunks leaves exactly the rows the whole-file load leaves`, async () => {
    const sql = freezeNow(read(file));
    const since = Date.now();
    const whole = await stagingWorld(preload);
    whole.exec(sql);
    const chunked = await stagingWorld(preload);
    const chunks = chunkSqlStatements(splitSqlStatements(sql));
    for (const chunk of chunks) chunked.exec(chunk);
    const until = Date.now();
    assert.deepEqual(schemaOf(chunked), schemaOf(whole));
    assert.deepEqual(dump(chunked, since, until), dump(whole, since, until));
  });
}

// ---------------------------------------------------------------------------------------------
test("the runner sends only --command, in order, to the verified binding and config", () => {
  const calls = [];
  const sql = read("scripts/employee-seed.sql");
  const result = executeRemoteSql({ binding: "DB", config: "dist/server/wrangler.json", sql, label: "employee-seed", run: (args) => { calls.push(args); return ""; }, log: { log() {}, warn() {} } });
  assert.equal(calls.length, result.chunks);
  assert.ok(calls.length > 1 && calls.length < 20, `${calls.length} queries for ${Buffer.byteLength(sql)} bytes`);
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 8), ["wrangler", "d1", "execute", "DB", "--remote", "--config", "dist/server/wrangler.json", "--command"]);
    assert.equal(args.length, 9);
    assert.ok(!args.includes("--file"), "never the import API");
    assert.ok(Buffer.byteLength(args[8]) <= 30_000, "far below D1's 100 KB statement limit and Linux's 128 KB argument limit");
  }
  assert.deepEqual(calls.flatMap((args) => splitSqlStatements(args[8])), splitSqlStatements(sql));
  assert.deepEqual(wranglerCommandArgs({ binding: "pawspace-staging", sql: "SELECT 1" }), ["wrangler", "d1", "execute", "pawspace-staging", "--remote", "--command", "SELECT 1"]);
});

test("a chunk refused before it ran is sent again; any other failure stops the run", () => {
  let attempts = 0;
  const waits = [];
  const refusedTwice = () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("Command failed: npx wrangler d1 execute"), { stderr: IMPORT_REFUSAL });
    return "ok";
  };
  assert.equal(executeRemoteCommand({ binding: "DB", sql: "SELECT 1", label: "t", run: refusedTwice, sleep: (s) => waits.push(s), log: { warn() {} } }), "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [3, 6]);

  let calls = 0;
  const broken = () => { calls += 1; throw Object.assign(new Error("Command failed"), { stderr: "SQLITE_ERROR: no such column: missing" }); };
  assert.throws(() => executeRemoteCommand({ binding: "DB", sql: "SELECT 1", label: "t", run: broken, sleep: () => {}, log: { warn() {} } }), /Command failed/);
  assert.equal(calls, 1, "a real SQL error is never retried");

  assert.deepEqual(classifyRemoteD1Retry(IMPORT_REFUSAL), { retryable: true, reason: "D1 busy with another import" });
  assert.equal(classifyRemoteD1Retry("D1 DB is overloaded. Too many requests queued.").retryable, true);
  assert.equal(classifyRemoteD1Retry("D1_ERROR: Network connection lost.").retryable, false, "a lost connection may have run the SQL, so it is not assumed safe");
});

test("the staging workflows no longer import SQL files into the live staging database", () => {
  const deploy = read(".github/workflows/deploy-staging.yml");
  assert.doesNotMatch(deploy, /d1 execute[^\n]*--file/, "no step of a staging deploy uses the import API");
  for (const seed of ["employee-seed", "uat-staging-provider-capacity", "uat-staging-citywide-groomers", "uat-staging-training-policies"]) {
    assert.match(deploy, new RegExp(`node scripts/schema/apply-remote-sql\\.mjs --binding DB --config dist/server/wrangler\\.json --file scripts/${seed}\\.sql`));
  }
  assert.match(deploy, /node scripts\/schema\/apply-remote-migrations\.mjs/);
  assert.doesNotMatch(read("scripts/schema/apply-remote-migrations.mjs"), /"--file"/, "migrations go through the query API too");
  for (const workflow of ["seed-staging", "automated-human-sweep"]) {
    assert.doesNotMatch(read(`.github/workflows/${workflow}.yml`), /d1 execute[^\n]*--file[= ]scripts\/(employee-seed|uat-staging-provider-capacity|uat-staging-citywide-groomers|staging-seed|uat-demo-seed)\.sql/, workflow);
  }
});

// ---------------------------------------------------------------------------------------------
test("a busy database reaches the customer as a plain 503 to retry, never as a raw 500", async () => {
  const refusal = new Error("D1_ERROR: Currently processing a long-running import.");
  assert.equal(transient.isTransientD1Refusal(refusal), true);
  assert.equal(transient.isTransientD1Refusal(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.")), true);
  assert.equal(transient.isTransientD1Refusal(new Error("wrapped", { cause: refusal })), true);
  assert.equal(transient.isTransientD1Refusal(new Error("D1_ERROR: no such table: bookings")), false);
  assert.equal(transient.isTransientD1Refusal(new Error("D1_ERROR: Network connection lost.")), false);

  // The round-2 response, exactly as app/api/sitting-bookings answered it.
  const raw = Response.json({ error: "D1_ERROR: Currently processing a long-running import." }, { status: 500 });
  const replaced = await transient.replaceTransientD1Failure(raw);
  assert.equal(replaced.status, 503);
  assert.equal(replaced.headers.get("retry-after"), "5");
  assert.equal(transient.isServiceBusyResponse(replaced), true);
  const body = await replaced.json();
  assert.equal(body.code, "SERVICE_BUSY");
  assert.doesNotMatch(body.error, /D1|import|SQL/i, "no database wording reaches the screen");

  const unrelated = Response.json({ error: "Sitting booking failed" }, { status: 500 });
  assert.equal(await transient.replaceTransientD1Failure(unrelated), unrelated, "other failures pass through untouched");
  const ok = Response.json({ data: 1 });
  assert.equal(await transient.replaceTransientD1Failure(ok), ok);

  // worker/index.ts cannot be imported in-process (see canonical-bookings-gateway-authorization); its
  // composition is pinned instead: both API return paths and the catch use the helper, and a GET is retried once.
  const worker = read("worker/index.ts");
  assert.equal((worker.match(/observeApiResponse\(request,await replaceTransientD1Failure\(response\)\)/g) || []).length, 2);
  assert.match(worker, /isTransientD1Refusal\(error\)\)\{emitStructuredError\("api_service_busy"[^}]*\}\);return secureApiResponse\(serviceBusyResponse\(\)\);\}/);
  assert.match(worker, /if\(request\.method!=="GET"\|\|!isServiceBusyResponse\(response\)\)return response;\s*await new Promise\(resolve=>setTimeout\(resolve,1_500\)\);\s*return worker\.handle\(request,env,ctx\);/);
});
