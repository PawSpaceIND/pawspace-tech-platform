import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const text = (value) => String(value ?? '').trim();
const safeTable = (name) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe table name: ${name}`); return `"${name}"`; };
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    out[key] = value; i += 1;
  }
  return out;
}

function assertBackupTarget(input, env = process.env) {
  const environment = text(input.environment || 'staging').toLowerCase();
  if (!['staging', 'production'].includes(environment)) throw new Error('Backup environment must be staging or production');
  const expectedName = environment === 'production' ? 'PRODUCTION_D1_ID' : 'STAGING_D1_ID';
  const expected = text(env[expectedName]);
  if (!expected) throw new Error(`${expectedName} is required`);
  if (text(input.databaseId) !== expected) throw new Error(`Target database id does not match ${expectedName}`);
  if (environment === 'staging' && text(env.PRODUCTION_D1_ID) === expected) throw new Error('Staging and production D1 ids must not match');
  const expectedDatabaseName = environment === 'production' ? 'pawspace-prod-bengaluru' : 'pawspace-staging';
  const databaseName = text(input.databaseName || expectedDatabaseName);
  if (databaseName !== expectedDatabaseName) throw new Error(`Database name must exactly equal ${expectedDatabaseName} for ${environment}`);
  return { environment, databaseId: expected, databaseName };
}

function wranglerJson(runner, databaseName, sql) {
  const result = runner('npx', ['wrangler', 'd1', 'execute', databaseName, '--remote', '--json', '--command', sql], { encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler d1 execute failed: ${text(result.stderr)}`);
  const parsed = JSON.parse(result.stdout || '[]');
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return Array.isArray(first?.results) ? first.results : [];
}

export function createD1Backup(input, env = process.env, runner = spawnSync, now = new Date()) {
  const target = assertBackupTarget(input, env);
  const root = resolve(input.outputDir || 'backups/d1');
  const dir = join(root, `${target.environment}-${stamp(now)}`);
  mkdirSync(dir, { recursive: false });
  const jsonName = 'database.json';
  const sqlName = 'database.sql';
  const jsonPath = join(dir, jsonName);
  const sqlPath = join(dir, sqlName);

  const tables = wranglerJson(runner, target.databaseName, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => text(row.name)).filter(Boolean);
  const data = {};
  const manifestTables = [];
  for (const table of tables) {
    const rows = wranglerJson(runner, target.databaseName, `SELECT * FROM ${safeTable(table)}`);
    data[table] = rows;
    manifestTables.push({ name: table, rowCount: rows.length });
  }
  const jsonArtifact = { format: 'pawspace-d1-json-v1', createdAt: now.toISOString(), environment: target.environment, databaseName: target.databaseName, databaseId: target.databaseId, tables: data };
  writeFileSync(jsonPath, `${JSON.stringify(jsonArtifact, null, 2)}\n`, { flag: 'wx', mode: 0o444 });

  const exported = runner('npx', ['wrangler', 'd1', 'export', target.databaseName, '--remote', `--output=${sqlPath}`], { encoding: 'utf8', env: process.env });
  if (exported.error) throw exported.error;
  if (exported.status !== 0) throw new Error(`wrangler d1 export failed: ${text(exported.stderr)}`);
  if (!statSync(sqlPath).size) throw new Error('D1 SQL export is empty');

  const manifest = {
    format: 'pawspace-d1-backup-v1',
    createdAt: now.toISOString(),
    environment: target.environment,
    databaseName: target.databaseName,
    databaseId: target.databaseId,
    tables: manifestTables,
    totalRows: manifestTables.reduce((sum, table) => sum + table.rowCount, 0),
    artifacts: {
      json: { filename: jsonName, size: statSync(jsonPath).size, sha256: sha256(jsonPath) },
      sql: { filename: sqlName, size: statSync(sqlPath).size, sha256: sha256(sqlPath) },
    },
  };
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  for (const path of [jsonPath, sqlPath, manifestPath]) { try { chmodSync(path, 0o444); } catch {} }
  try { chmodSync(dir, 0o555); } catch {}
  return { directory: dir, manifest };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const environment = args.environment || 'staging';
  const idName = environment === 'production' ? 'PRODUCTION_D1_ID' : 'STAGING_D1_ID';
  return createD1Backup({ environment, databaseId: args.databaseId || env[idName], databaseName: args.databaseName, outputDir: args.outputDir }, env);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((result) => console.log(JSON.stringify({ directory: result.directory, manifest: result.manifest }, null, 2))).catch((error) => {
    console.error(`D1 backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
