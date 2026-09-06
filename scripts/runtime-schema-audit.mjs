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
  const pattern = /\.(?:prepare|exec)\(\s*(`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gs;
  for (const match of source.matchAll(pattern)) {
    const literal = match[1];
    const body = literal.slice(1, -1);
    // Dynamic identifiers cannot be certified statically. Keep the constant parts for any ordinary
    // table references in the same statement, but erase interpolations so their contents are not
    // mistaken for SQL.
    values.push(body.replace(/\$\{[\s\S]*?\}/g, " "));
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
    // SQL snippets can include trigger grammar (`UPDATE OF`, `UPDATE ... SET`) and CTE aliases.
    // Those tokens are not schema objects. Single-letter identifiers are aliases in this repository,
    // not physical table names, so excluding them avoids turning ordinary `FROM ... r` CTE patterns
    // into fake missing-table findings.
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
