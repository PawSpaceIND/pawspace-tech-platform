/*
 * Every column the Control Center names must exist in that table's canonical schema.
 *
 * lib/control-center-operations.ts is a pure reader with two helpers, and BOTH absorb
 * `no such column`: count() returns null (rendered "n/c · not connected") and recent() returns []
 * (rendered "No recent records in this source."). That tolerance keeps one drifted column from
 * 500-ing the whole console - but it also means a wrong column is INVISIBLE at runtime. It does not
 * look like an error; it looks like a calm, confident answer.
 *
 * Round 1 fixed exactly one such column (board_approvals.status, which that ledger never had) and
 * added a suite that pins recent()'s SELECT lists. That suite passed 17/17 while THREE count()
 * predicates on the same two lines still named columns their tables do not have:
 *
 *     payroll_approval_events.outcome                  (log is id,run_id,event_type,actor_id,...)
 *     partner_payout_instruction_approvals.status      (approval is level_1_by / level_2_at columns)
 *     communication_dead_letters.status                (resolution is resolved_at/resolved_by)
 *
 * The Payroll card is the one that mattered: it read "not connected" to the founder while payroll
 * runs sat unapproved behind it. So this suite covers count()'s PREDICATES as well as recent()'s
 * column lists, and it proves the contract by EXECUTING the real module against the real schemas
 * rather than by matching source text - a card that cannot connect is the actual symptom.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildControlCenterOperations } = await importLibModule("control-center-operations");
const MODES = ["approvals", "master", "inventory", "quality", "security", "health", "audit"];
const source = readFileSync(join(ROOT, "lib/control-center-operations.ts"), "utf8");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".wrangler"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|sql)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/* Collect each table's canonical CREATE TABLE. Parentheses are balanced deliberately: a nested
 * CHECK(...) truncates a naive match and turns a column that DOES exist into a false report - that
 * mistake cost a wrong accusation against elite_payment_approval_queue.status while writing this. */
function canonicalSchemas() {
  const found = new Map();
  for (const file of walk(join(ROOT, "lib")).concat(walk(join(ROOT, "drizzle")))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+) \(/gi)) {
      let i = match.index + match[0].length, depth = 1, body = "";
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (!depth) break; }
        body += ch; i++;
      }
      const prior = found.get(match[1]);
      if (!prior || prior.body.length < body.length) found.set(match[1], { body, file });
    }
  }
  return found;
}

/* Column names carry digits (level_1_by, level_2_at). A [a-z_]+ filter silently drops those and the
 * contract then passes by omission, which is worse than failing. */
function columnsOf(body) {
  const parts = []; let buf = "", depth = 0;
  for (const ch of body) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(buf); buf = ""; } else buf += ch;
  }
  parts.push(buf);
  return parts.map((c) => c.trim().split(/\s+/)[0])
    .filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c) && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(c));
}

const SQL_WORDS = new Set(["NOT","IN","IS","NULL","AND","OR","LIKE","SELECT","FROM","WHERE","ORDER","BY","DESC","ASC","LIMIT","CASE","WHEN","THEN","ELSE","END","COALESCE","COUNT","DISTINCT"]);
const identifiersIn = (predicate) =>
  [...new Set(predicate.replace(/'[^']*'/g, "").match(/[a-z_][a-z0-9_]*/gi) ?? [])]
    .filter((word) => !SQL_WORDS.has(word.toUpperCase()) && Number.isNaN(Number(word)));

const schemas = canonicalSchemas();
const countCalls = [...source.matchAll(/count\(db,"([a-z_]+)"(?:,"([^"]*)")?\)/g)]
  .map(([, table, predicate]) => ({ table, columns: predicate ? identifiersIn(predicate) : [], kind: "count" }));
const recentCalls = [...source.matchAll(/recent\(db,"([a-z_]+)","([^"]*)"/g)]
  .map(([, table, cols]) => ({ table, columns: cols === "*" ? [] : cols.split(",").map((c) => c.trim()), kind: "recent" }));
const allCalls = [...countCalls, ...recentCalls];

test("CC-1: the scan actually sees the module's queries", () => {
  assert.ok(countCalls.length >= 15, `expected many count() calls, found ${countCalls.length}`);
  assert.ok(recentCalls.length >= 4, `expected several recent() calls, found ${recentCalls.length}`);
  assert.ok(countCalls.some((c) => c.columns.length), "no count() predicate yielded a column - the identifier scan is broken");
  assert.ok(schemas.size > 100, `expected the repo to declare many tables, found ${schemas.size}`);
});

test("CC-2: every column the Control Center names exists in that table's canonical schema", () => {
  const wrong = [];
  for (const call of allCalls) {
    const schema = schemas.get(call.table);
    if (!schema) continue; // covered by CC-3
    const columns = columnsOf(schema.body);
    for (const named of call.columns) {
      if (!columns.includes(named)) {
        wrong.push(`${call.kind}("${call.table}") names "${named}" - that table has: ${columns.join(", ")}  [${schema.file.replace(ROOT + "/", "")}]`);
      }
    }
  }
  assert.deepEqual(wrong, [],
    "these columns do not exist, so the helper absorbs `no such column` and the card renders as a\n" +
    "calm 'not connected' / 'no recent records' instead of the number an operator is waiting on:\n  " + wrong.join("\n  "));
});

test("CC-3: every table the Control Center reads has a canonical definition in the repo", () => {
  const orphans = [...new Set(allCalls.map((c) => c.table))].filter((t) => !schemas.has(t));
  assert.deepEqual(orphans, [],
    `no CREATE TABLE found for: ${orphans.join(", ")}. Either the table is gone (the card is dead) or it is\n` +
    "declared somewhere this scan cannot see, in which case CC-2 is silently not covering it.");
});

test("CC-4: EXECUTED - with every canonical table present, no card reports itself unconnected", async () => {
  /* The runtime symptom, reproduced: a wrong column does not throw, it produces connected:false.
   * Creating each table from its canonical DDL means any card that still fails to connect is
   * failing on a column, which is exactly the defect this file exists to stop. */
  const { sqlite, db } = freshCountingD1();
  const needed = [...new Set(allCalls.map((c) => c.table))];
  const created = [];
  for (const table of needed) {
    const schema = schemas.get(table);
    if (!schema) continue;
    try { sqlite.exec(`CREATE TABLE IF NOT EXISTS ${table} (${schema.body})`); created.push(table); } catch { /* dialect edge; CC-2 still covers its columns */ }
  }
  assert.ok(created.length >= needed.length - 2, `created ${created.length} of ${needed.length} tables; too many failed to materialize for this to prove anything`);

  const unconnected = [];
  for (const mode of MODES) {
    const payload = await buildControlCenterOperations(db, mode);
    for (const card of payload.cards ?? []) {
      if (created.includes(card.source) && card.connected === false) unconnected.push(`${mode}/${card.label} (source ${card.source})`);
    }
  }
  assert.deepEqual(unconnected, [],
    "these cards could not read a table that EXISTS with its canonical schema, which means the\n" +
    "predicate names a column the table does not have:\n  " + unconnected.join("\n  "));
});
