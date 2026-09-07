import { readFileSync } from "node:fs";

const addColumnDirective = /^\s*--\s*@add-column-if-missing\s+([a-zA-Z0-9_]+)\|([a-zA-Z0-9_]+)\|(.+)\s*$/gm;

function quoteIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

export function normalizeReplaySafeDdl(sql) {
  return sql
    .replace(/\bCREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replace(/\bCREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE INDEX IF NOT EXISTS ")
    .replace(/\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE TABLE IF NOT EXISTS ")
    .replace(/\bCREATE\s+TRIGGER\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE TRIGGER IF NOT EXISTS ")
    .replace(/\bCREATE\s+VIEW\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE VIEW IF NOT EXISTS ")
    .replace(/\bDROP\s+INDEX\s+(?!IF\s+EXISTS)/gi, "DROP INDEX IF EXISTS ")
    .replace(/\bDROP\s+TABLE\s+(?!IF\s+EXISTS)/gi, "DROP TABLE IF EXISTS ");
}

function columnNames(sqlite, table) {
  return new Set(sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((row) => String(row.name)));
}

export function applyIdempotentSqlMigration(sqlite, sql, source = "migration") {
  const directives = [];
  for (const match of sql.matchAll(addColumnDirective)) {
    directives.push({ table: match[1], column: match[2], definition: match[3].trim() });
  }

  for (const directive of directives) {
    const columns = columnNames(sqlite, directive.table);
    if (!columns.has(directive.column)) {
      sqlite.exec(`ALTER TABLE ${quoteIdent(directive.table)} ADD COLUMN ${quoteIdent(directive.column)} ${directive.definition}`);
    }
  }

  const executable = normalizeReplaySafeDdl(sql.replace(addColumnDirective, ""));
  try {
    sqlite.exec(executable);
  } catch (error) {
    error.message = `${source}: ${error.message}`;
    throw error;
  }
}

export function applyIdempotentMigrationFile(sqlite, path) {
  applyIdempotentSqlMigration(sqlite, readFileSync(path, "utf8"), path);
}
