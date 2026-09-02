import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const text = (value) => String(value ?? '').trim();

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertRestoreTarget(input, env = process.env) {
  const environment = text(input.environment || 'staging').toLowerCase();
  if (environment !== 'staging') throw new Error('D1 restore is staging-only; production restores are refused by this tool');
  const expected = text(env.STAGING_D1_ID);
  const target = text(input.databaseId);
  if (!expected) throw new Error('STAGING_D1_ID is required');
  if (!target) throw new Error('A staging database id is required');
  if (target !== expected) throw new Error('Target database id does not match STAGING_D1_ID');
  for (const name of ['PRODUCTION_D1_ID', 'RELEASE_PREVIEW_D1_ID', 'SHARED_STAGING_D1_ID']) {
    const other = text(env[name]);
    if (other && other === target) throw new Error(`Staging restore target must not match ${name}`);
  }
  const confirmation = text(input.confirm);
  const required = `restore-staging:${target}`;
  if (confirmation !== required) throw new Error(`Restore confirmation must exactly equal ${required}`);
  const databaseName = text(input.databaseName || 'pawspace-staging');
  if (databaseName !== 'pawspace-staging') throw new Error('Staging restore database name must exactly equal pawspace-staging');
  return { environment, databaseId: target, databaseName };
}

export function verifyBackupArtifacts(backupDir, expectedEnvironment = 'staging') {
  const dir = resolve(backupDir);
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'pawspace-d1-backup-v1') throw new Error('Unsupported D1 backup manifest format');
  if (text(manifest.environment).toLowerCase() !== text(expectedEnvironment).toLowerCase()) throw new Error('Backup environment does not match restore environment');
  if (!manifest.artifacts || typeof manifest.artifacts !== 'object') throw new Error('Backup manifest has no artifacts');
  for (const [kind, artifact] of Object.entries(manifest.artifacts)) {
    const filename = text(artifact?.filename);
    const expectedHash = text(artifact?.sha256).toLowerCase();
    if (!filename || !/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error(`Invalid ${kind} artifact filename`);
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error(`Invalid ${kind} SHA-256 in manifest`);
    const path = join(dir, filename);
    const size = statSync(path).size;
    if (Number(artifact.size) !== size) throw new Error(`${kind} artifact size mismatch`);
    const actualHash = sha256File(path);
    if (actualHash !== expectedHash) throw new Error(`${kind} artifact SHA-256 mismatch`);
  }
  return manifest;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    out[key] = value;
    i += 1;
  }
  return out;
}

export function restoreD1Backup(input, env = process.env, runner = spawnSync) {
  const target = assertRestoreTarget(input, env);
  const manifest = verifyBackupArtifacts(input.backupDir, target.environment);
  if (text(manifest.databaseId) !== target.databaseId) throw new Error('Backup database id does not match the requested restore target');
  const sql = manifest.artifacts.sql;
  if (!sql?.filename) throw new Error('Backup manifest has no SQL artifact');
  const sqlPath = join(resolve(input.backupDir), sql.filename);
  const result = runner('npx', ['wrangler', 'd1', 'execute', target.databaseName, '--remote', `--file=${sqlPath}`], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler d1 execute failed with exit code ${result.status}`);
  return { restored: true, environment: target.environment, databaseId: target.databaseId, databaseName: target.databaseName, manifestCreatedAt: manifest.createdAt };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args.backupDir) throw new Error('--backup-dir is required');
  return restoreD1Backup({
    backupDir: args.backupDir,
    environment: args.environment || 'staging',
    databaseId: args.databaseId || env.STAGING_D1_ID,
    databaseName: args.databaseName || 'pawspace-staging',
    confirm: args.confirm,
  }, env);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(`D1 restore refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
