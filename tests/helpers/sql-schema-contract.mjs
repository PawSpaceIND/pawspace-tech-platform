/**
 * A static reader for "does every column this SQL names actually exist?".
 *
 * WHY THIS EXISTS. Two real defects in this repository were a column referenced in a SQL string
 * that the schema never created:
 *
 *   lib/payout-beneficiary-verification.ts  SELECT ...,verified_at,... FROM provider_verifications
 *                                           The column existed nowhere. That function gates BOTH
 *                                           level-2 money approvals, so no partner payout and no
 *                                           order commission could ever be approved - and it
 *                                           surfaced as a server error, not a governance refusal.
 *
 *   lib/field-productivity.ts               read provider_daily_travel_legs with no ensure
 *                                           (a table, not a column, but the same blind spot)
 *
 * Neither the build, `tsc --noEmit`, nor 5,500 passing tests can see inside a SQL string literal.
 * Only something that reads the strings can.
 *
 * DELIBERATELY CONSERVATIVE. A checker that cries wolf gets switched off, so this only inspects
 * shapes it can attribute to one table with no ambiguity:
 *
 *   INSERT INTO t (a,b,c)     every listed column
 *   UPDATE t SET a=?,b=?      every assigned column, single-table only
 *   SELECT a,b FROM t         bare column names only, single table, no JOIN, no alias
 *
 * Anything with a join, an alias, a subquery, a function call or a qualified name is skipped
 * rather than guessed at. A table with no CREATE we can find is skipped too - absence of a schema
 * is not evidence of a missing column.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * A table-level constraint, not a column. `key TEXT PRIMARY KEY` is a COLUMN named `key`, so a
 * bare first word is never enough - the shape has to look like a constraint clause too.
 */
const isTableConstraint = (part) =>
  /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT\b|CHECK\s*\(|UNIQUE\s*\(|KEY\s*\()/i.test(part);
/** Columns SQLite provides that no CREATE TABLE lists. */
const IMPLICIT_COLUMNS = new Set(["rowid", "oid", "_rowid_"]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(full, out); }
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Split a parenthesised body on top-level commas only, so CHECK(x IN (1,2)) stays one part. */
function topLevelParts(body) {
  const parts = [];
  let depth = 0, current = "";
  for (const char of body) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Read the parenthesised body that starts at `open`, respecting nesting. */
function balancedBody(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") { depth--; if (depth === 0) return source.slice(open + 1, i); }
  }
  return null;
}

/**
 * Tables this repository widens at runtime with a templated ALTER, e.g.
 *
 *   for (const [column, def] of [["pos_state","TEXT"], ...])
 *     await ensureColumn(db, "tcs_collections", column, def);
 *
 * The column names are loop variables, so no static reader can know the full column set. Such a
 * table is OPEN: we cannot prove a column missing, so we prove nothing and say so, rather than
 * reporting a reference we merely failed to resolve.
 */
function openTablesIn(source, open) {
  // `ALTER TABLE literal_name ADD COLUMN ${expr}`
  for (const m of source.matchAll(/ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+\$\{/gi)) open.add(m[1].toLowerCase());
  // ensureColumn(db, "literal_name", <non-literal column>, ...)
  for (const m of source.matchAll(/\b(?:ensureColumn|addColumn)\s*\(\s*\w+\s*,\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*(?!")/g)) open.add(m[1].toLowerCase());
}

/** Columns added through a helper call with a literal name: ensureColumn(db,"t","c","TEXT"). */
function helperColumnsIn(source, add) {
  for (const m of source.matchAll(/\b(?:ensureColumn|addColumn)\s*\(\s*\w+\s*,\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) add(m[1], m[2]);
}

/** { schema: table -> Set(columns), open: Set(tables whose column set cannot be known statically) } */
export function buildSchema(roots) {
  const schema = new Map();
  const open = new Set();
  const add = (table, column) => {
    const key = table.toLowerCase(), name = column.toLowerCase();
    if (!schema.has(key)) schema.set(key, new Set());
    schema.get(key).add(name);
  };

  for (const file of roots.flatMap((root) => walk(root))) {
    const source = fs.readFileSync(file, "utf8");

    for (const match of source.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(/gi)) {
      const body = balancedBody(source, match.index + match[0].length - 1);
      if (!body) continue;
      if (!schema.has(match[1].toLowerCase())) schema.set(match[1].toLowerCase(), new Set());
      for (const part of topLevelParts(body)) {
        const first = part.trim().split(/\s+/)[0]?.replace(/["`]/g, "");
        if (!first || isTableConstraint(part) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) continue;
        add(match[1], first);
      }
    }
    for (const match of source.matchAll(/ALTER\s+TABLE\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+ADD\s+COLUMN\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi)) {
      add(match[1], match[2]);
    }
    helperColumnsIn(source, add);
    openTablesIn(source, open);
  }
  return { schema, open };
}

const isPlainColumn = (token) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(token);

/** Every SQL-looking string literal in a source file. */
function sqlLiterals(source) {
  const found = [];
  for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const text = match[2];
    if (/\b(SELECT|INSERT\s+INTO|UPDATE)\b/i.test(text)) found.push({ text, index: match.index });
  }
  return found;
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

/**
 * Columns referenced against a single, unambiguous table.
 * Returns [{ table, column, kind }]; shapes it cannot attribute are skipped, not guessed.
 */
export function referencedColumns(sql) {
  const refs = [];
  const flat = sql.replace(/\s+/g, " ");

  for (const match of flat.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(/gi)) {
    const body = balancedBody(flat, match.index + match[0].length - 1);
    if (!body || /\bSELECT\b/i.test(body)) continue;
    for (const part of topLevelParts(body)) {
      const token = part.trim().replace(/["`]/g, "");
      if (isPlainColumn(token)) refs.push({ table: match[1], column: token, kind: "insert" });
    }
  }

  for (const match of flat.matchAll(/UPDATE\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+SET\s+([\s\S]*?)(?:\sWHERE\s|\sRETURNING\s|$)/gi)) {
    if (/\bJOIN\b|\bFROM\b/i.test(match[2])) continue;
    for (const part of topLevelParts(match[2])) {
      const token = part.trim().split("=")[0].trim().replace(/["`]/g, "");
      if (isPlainColumn(token)) refs.push({ table: match[1], column: token, kind: "update" });
    }
  }

  for (const match of flat.matchAll(/SELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\sFROM\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?(\s|$|\))/gi)) {
    const [, columns, table] = match;
    const rest = flat.slice(match.index + match[0].length);
    // One table, plainly named, with nothing that could re-attribute a column elsewhere.
    if (/^\s*(?:AS\s+)?[A-Za-z_][A-Za-z0-9_]*/i.test(rest) && !/^\s*(WHERE|ORDER|GROUP|LIMIT|HAVING|\)|$)/i.test(rest)) continue;
    if (/\bJOIN\b|,/.test(rest.split(/\bWHERE\b|\bORDER\b|\bGROUP\b|\bLIMIT\b/i)[0] ?? "")) continue;
    if (/\bJOIN\b/i.test(flat) || /\bSELECT\b[\s\S]*\bSELECT\b/i.test(flat)) continue;
    for (const part of topLevelParts(columns)) {
      const token = part.trim().replace(/["`]/g, "");
      if (isPlainColumn(token)) refs.push({ table, column: token, kind: "select" });
    }
  }
  return refs;
}

/** Every reference to a column the schema does not have, for a table the schema knows. */
export function findDanglingColumnReferences({ schemaRoots, scanRoots }) {
  const { schema, open } = buildSchema(schemaRoots);
  const violations = [];
  for (const file of scanRoots.flatMap((root) => walk(root))) {
    if (/\.sql$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const literal of sqlLiterals(source)) {
      for (const ref of referencedColumns(literal.text)) {
        const table = ref.table.toLowerCase();
        const columns = schema.get(table);
        if (!columns || columns.size === 0) continue;           // unknown table: not evidence
        if (open.has(table)) continue;                          // widened at runtime: unprovable
        const column = ref.column.toLowerCase();
        if (columns.has(column) || IMPLICIT_COLUMNS.has(column)) continue;
        violations.push({
          file: path.relative(process.cwd(), file), line: lineOf(source, literal.index),
          table: ref.table, column: ref.column, kind: ref.kind,
        });
      }
    }
  }
  return { schema, open, violations };
}
