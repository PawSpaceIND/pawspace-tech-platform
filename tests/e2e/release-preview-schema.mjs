/**
 * Fresh-D1 schema bootstrap for the release preview.
 *
 * THE BLOCKER THIS EXISTS FOR. The preview D1 is a brand new, empty database, and the candidate has no
 * migrations directory. The gate's very first actions are INSERTs into role_definitions, app_users,
 * customer_identity_links and the two scheduling tables, followed by COUNT(*) snapshots of the five
 * booking tables — all of them before any product code has run. On an empty database every one of those
 * is "no such table", so the first real dispatch would die during setup, before it proved anything.
 *
 * "The route creates its own tables on first request" is only half true: the route creates the tables
 * the ROUTE touches, on a request the gate cannot make until the support tables it signs in through
 * already exist. The bootstrap closes that gap.
 *
 * WHERE THE DDL COMES FROM. Not from here. A schema copied into infrastructure is a second source of
 * truth that drifts silently — the preview would then be exercising a schema no deployed Worker ever
 * creates, and the drift would show up as passing tests. So the statements are READ OUT OF THE
 * CANDIDATE CHECKOUT at run time, from the product's own `CREATE TABLE IF NOT EXISTS` text, and this
 * file contains no table definition of its own. tests/release-preview-empty-d1.test.mjs enforces that.
 *
 * FAIL CLOSED. A table that cannot be found, that is defined two different ways, or whose statement
 * does not parse cleanly is an error that stops the run. Guessing would put an invented schema on a
 * real database.
 */

/**
 * Every table the gate touches before the product does, in dependency order.
 *
 * The first five are the support tables — roles, users, the customer binding and the two scheduling
 * tables — which the gate writes during setup. The rest are the booking tables it snapshots and
 * reconciles. `providers` is deliberately absent: the gate only ever reads it, behind a catch, to
 * confirm nothing went live.
 */
export const REQUIRED_TABLES = [
  "role_definitions",
  "app_users",
  "customer_identity_links",
  "scheduling_assignment_decisions",
  "scheduling_reservations",
  "canonical_customers",
  "canonical_pets",
  "canonical_bookings",
  "booking_payments",
  "provider_work_orders",
  "booking_lifecycle_events",
];

/**
 * The candidate directories that count as PRODUCT source.
 *
 * tests/ and scripts/ are excluded on purpose, and this is the single most important line in the file.
 * The candidate's test fixtures define these same tables several different ways — seven variants of
 * canonical_bookings, five of scheduling_reservations — because each fixture creates only the columns
 * its own test needs. Including them would make almost every table "ambiguous", and picking one anyway
 * would seed the preview with a fixture's abbreviated schema instead of the product's.
 */
export const PRODUCT_SOURCE_ROOTS = ["app", "lib", "worker", "db", "src", "components", "types"];

/**
 * The route the gate exercises, used ONLY to break a tie.
 *
 * Where the product defines a table two ways, the definition that matters is the one the route under
 * test would itself execute — that is the schema the preview will really be running against. This is
 * narrow by design: if the tie cannot be broken this way the extraction still fails closed, and every
 * table resolved by tie-break is reported so a reviewer sees the product inconsistency rather than
 * having it swallowed.
 */
export const PRIMARY_SOURCE = "app/api/canonical-bookings/route.ts";

const SOURCE_FILE = /\.(ts|tsx|mjs|cjs|js|jsx)$/;

/**
 * Pull every complete `CREATE TABLE IF NOT EXISTS <table> ( … )` statement for one table out of a file.
 *
 * Parentheses are balanced rather than matched with a regex, because column definitions nest them
 * (`DEFAULT (0)`, `CHECK (x IN (…))`). Quoted text is skipped so a parenthesis inside a string literal
 * or a quoted identifier cannot move the depth. A statement whose parentheses never close is reported
 * as malformed instead of being silently dropped.
 *
 * @param {string} text
 * @param {string} table
 * @returns {{ statements: string[], malformed: number }}
 */
export function extractCreateTables(text, table) {
  const opener = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+["'\`]?${table}["'\`]?\\s*\\(`, "gi");
  const statements = [];
  let malformed = 0;
  let match;
  while ((match = opener.exec(text))) {
    const start = match.index;
    let depth = 0;
    let end = -1;
    for (let i = start + match[0].length - 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || ch === "`") {
        // Skip the quoted run. Both SQL's doubled quote and JavaScript's backslash escape appear here,
        // since the DDL is embedded in source, so both are honoured.
        const quote = ch;
        i++;
        while (i < text.length) {
          if (text[i] === "\\") { i += 2; continue; }
          if (text[i] === quote) {
            if (text[i + 1] === quote) { i += 2; continue; }
            break;
          }
          i++;
        }
        if (i >= text.length) break;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) { malformed++; continue; }
    statements.push(text.slice(start, end));
  }
  return { statements, malformed };
}

/** Whitespace-insensitive, case-insensitive form, so the same schema written two ways compares equal. */
export function normalizeStatement(sql) {
  return sql.replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim().toLowerCase();
}

/**
 * Refuse anything that is not exactly one bare CREATE TABLE IF NOT EXISTS statement.
 *
 * This is the last thing standing between text found in a source file and text sent to a real
 * database, so it is deliberately narrow: one statement, no terminator, no comment sequence that could
 * hide the rest of a line, and at least one column.
 */
export function assertCreateTableOnly(sql, table) {
  const shape = new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+["'\`]?${table}["'\`]?\\s*\\(`, "i");
  if (!shape.test(sql)) throw new Error(`Extracted statement for ${table} is not a CREATE TABLE IF NOT EXISTS for that table.`);
  // The terminator is checked first because it is the most dangerous shape — anything after it is a
  // second statement — and reporting "does not end at a parenthesis" for it would describe a symptom.
  if (sql.includes(";")) throw new Error(`Extracted statement for ${table} contains a statement terminator; only a single CREATE TABLE may be executed.`);
  if (!sql.trimEnd().endsWith(")")) throw new Error(`Extracted statement for ${table} does not end at a closing parenthesis.`);
  if (sql.includes("--") || sql.includes("/*")) throw new Error(`Extracted statement for ${table} contains a comment sequence.`);
  const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")")).trim();
  if (!body) throw new Error(`Extracted statement for ${table} declares no columns.`);
  return sql;
}

/**
 * Read the candidate checkout and resolve one CREATE TABLE statement per required table.
 *
 * `listFiles` and `readFile` are injected so this can be driven against a virtual checkout in tests
 * without writing a fixture tree to disk.
 *
 * @param {object} io
 * @param {() => string[]} io.listFiles   candidate-relative paths, POSIX separators
 * @param {(path:string) => string} io.readFile
 * @param {string[]} [io.tables]
 * @returns {{ statements: Array<{table:string, sql:string, sources:string[], tieBreak:boolean}>, scanned:number }}
 */
export function collectSchema({ listFiles, readFile, tables = REQUIRED_TABLES }) {
  const files = listFiles().filter((path) =>
    SOURCE_FILE.test(path) && PRODUCT_SOURCE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)));

  const statements = [];
  const problems = [];

  for (const table of tables) {
    /** @type {Map<string, {sql:string, sources:string[]}>} */
    const variants = new Map();
    let malformed = 0;
    for (const path of files) {
      let text;
      try { text = readFile(path); } catch { continue; }
      if (!text.includes(table)) continue;
      const found = extractCreateTables(text, table);
      malformed += found.malformed;
      for (const sql of found.statements) {
        const key = normalizeStatement(sql);
        if (!variants.has(key)) variants.set(key, { sql, sources: [] });
        variants.get(key).sources.push(path);
      }
    }

    if (malformed) {
      problems.push(`${table}: ${malformed} CREATE TABLE statement(s) could not be parsed — unbalanced parentheses in the candidate source.`);
      continue;
    }
    if (variants.size === 0) {
      problems.push(`${table}: no CREATE TABLE IF NOT EXISTS found anywhere in the candidate's product source (${PRODUCT_SOURCE_ROOTS.join(", ")}).`);
      continue;
    }

    let chosen = null;
    let tieBreak = false;
    if (variants.size === 1) {
      chosen = [...variants.values()][0];
    } else {
      const fromRoute = [...variants.values()].filter((v) => v.sources.includes(PRIMARY_SOURCE));
      if (fromRoute.length === 1) { chosen = fromRoute[0]; tieBreak = true; }
      else {
        problems.push(`${table}: ${variants.size} different definitions in the candidate's product source and none of them is the one ${PRIMARY_SOURCE} executes — refusing to guess which schema the preview should have.`);
        continue;
      }
    }

    try { assertCreateTableOnly(chosen.sql, table); }
    catch (error) { problems.push(`${table}: ${error.message}`); continue; }

    statements.push({ table, sql: chosen.sql, sources: chosen.sources.slice().sort(), tieBreak });
  }

  if (problems.length) {
    throw new Error(`Cannot bootstrap the preview schema from the candidate checkout:\n  - ${problems.join("\n  - ")}`);
  }
  return { statements, scanned: files.length };
}

/**
 * Execute the resolved statements. Every one is re-validated immediately before it is sent, so a
 * statement mutated between resolution and execution still cannot reach the database.
 *
 * The `d1` adapter is the gate's own, which addresses the preview database BY ID — no identifier is
 * handled here and none is logged.
 *
 * @param {object} io
 * @param {(sql:string) => Promise<any>} io.d1
 * @param {Array<{table:string, sql:string}>} io.statements
 * @param {(line:string)=>void} [io.log]
 */
export async function bootstrapSchema({ d1, statements, log = () => {} }) {
  const created = [];
  for (const { table, sql } of statements) {
    assertCreateTableOnly(sql, table);
    await d1(sql);
    created.push(table);
  }
  log(`  schema bootstrap: ${created.length} table(s) ensured — ${created.join(", ")}`);
  return created;
}

/** Filesystem access for the real candidate checkout. Kept out of collectSchema so tests can inject. */
export async function candidateSource(root) {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, relative, sep } = await import("node:path");
  const walk = (dir, acc) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else acc.push(relative(root, full).split(sep).join("/"));
    }
    return acc;
  };
  const files = [];
  for (const dirName of PRODUCT_SOURCE_ROOTS) {
    try { walk(join(root, dirName), files); } catch { /* a candidate need not have every root */ }
  }
  return {
    listFiles: () => files,
    readFile: (path) => readFileSync(join(root, ...path.split("/")), "utf8"),
  };
}
