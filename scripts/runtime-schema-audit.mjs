import fs from "node:fs";
import path from "node:path";

const SOURCE_ROOTS = ["lib", "app", "worker"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const INTERNAL_TABLES = new Set(["sqlite_master", "sqlite_schema", "pragma_table_info", "pragma_index_list", "json_each", "json_tree"]);
const NON_TABLE_TOKENS = new Set(["set", "where", "on", "of"]);

function walk(root, relative) {
  const start = path.join(root, relative);
  if (!fs.existsSync(start)) return [];
  const out = [];
  for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
    const absolute = path.join(start, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, path.relative(root, absolute)));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(path.relative(root, absolute));
  }
  return out;
}

function sqlArguments(source) {
  const values = [];
  const push = (literal) => values.push(literal.slice(1, -1).replace(/\$\{[\s\S]*?\}/g, " "));
  const LITERAL = "`(?:\\\\.|[^`])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'";

  // SQL written inline at the call site.
  for (const match of source.matchAll(new RegExp(`\\.(?:prepare|exec)\\(\\s*(${LITERAL})`, "gs"))) push(match[1]);

  // SQL held in a named constant and passed by identifier - e.g. lib/document-series.ts's
  // DOCUMENT_SERIES_V2_DDL, or lib/canonical-booking-core-schema.ts's array of statements. That
  // pattern is BETTER than inlining (it is what lets a test pin one copy byte-for-byte against the
  // writer's), and this scanner could not see it: finance_document_series_v2 read as having no
  // schema source at all while the module that creates it sat two lines above the INSERT.
  // A string literal that begins with CREATE TABLE is DDL by construction, so collect it wherever
  // it is declared. Only lib/app/worker are walked, so no test fixture reaches this.
  for (const match of source.matchAll(new RegExp(`(${LITERAL})`, "gs"))) {
    const body = match[1].slice(1, -1);
    if (/^\s*CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b/i.test(body)) push(match[1]);
  }
  return values;
}

function createdTables(sql) {
  return [...sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1].toLowerCase());
}

function cteNames(sql) {
  return new Set([...sql.matchAll(/(?:\bWITH|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi)].map((match) => match[1].toLowerCase()));
}

function referencedTables(sql) {
  const ctes = cteNames(sql);
  const names = [];
  const pattern = /\b(?:DELETE\s+FROM|REPLACE\s+INTO|INSERT\s+INTO|FROM|JOIN|UPDATE)\s+[`"\[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (name.length === 1 || ctes.has(name) || INTERNAL_TABLES.has(name) || NON_TABLE_TOKENS.has(name)) continue;
    names.push(name);
  }
  return names;
}

function migrationFiles(root) {
  const dir = path.join(root, "drizzle");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => path.join("drizzle", name));
}

export function auditRuntimeSchemaCoverage(root = ".") {
  const sources = SOURCE_ROOTS.flatMap((dir) => walk(root, dir));
  const runtimeCreators = new Map();
  const consumers = new Map();

  for (const file of sources) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const sql of sqlArguments(source)) {
      for (const table of createdTables(sql)) {
        const files = runtimeCreators.get(table) || new Set();
        files.add(file);
        runtimeCreators.set(table, files);
      }
      for (const table of referencedTables(sql)) {
        const files = consumers.get(table) || new Set();
        files.add(file);
        consumers.set(table, files);
      }
    }
  }

  const migrationCreators = new Map();
  for (const file of migrationFiles(root)) {
    const sql = fs.readFileSync(path.join(root, file), "utf8");
    for (const table of createdTables(sql)) {
      const files = migrationCreators.get(table) || new Set();
      files.add(file);
      migrationCreators.set(table, files);
    }
  }

  const rows = [...consumers.keys()].sort().map((table) => {
    const runtime = [...(runtimeCreators.get(table) || [])].sort();
    const migrations = [...(migrationCreators.get(table) || [])].sort();
    return {
      table,
      consumers: [...consumers.get(table)].sort(),
      runtimeCreators: runtime,
      migrationCreators: migrations,
      classification: runtime.length ? "runtime_created" : migrations.length ? "migration_only" : "missing_schema_source",
    };
  });

  return {
    rows,
    migrationOnly: rows.filter((row) => row.classification === "migration_only"),
    missing: rows.filter((row) => row.classification === "missing_schema_source"),
  };
}

if (process.argv[1] && process.argv[1].endsWith("runtime-schema-audit.mjs")) {
  const result = auditRuntimeSchemaCoverage(process.cwd());
  const printable = result.rows.filter((row) => row.classification !== "runtime_created");
  console.log(JSON.stringify({ migrationOnly: result.migrationOnly.length, missing: result.missing.length, rows: printable }, null, 2));
  if (process.argv.includes("--fail-on-missing") && result.missing.length) process.exitCode = 1;
}
