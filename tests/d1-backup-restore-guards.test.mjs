import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRestoreTarget, verifyBackupArtifacts, restoreD1Backup } from '../scripts/d1-restore.mjs';

const STAGING = '11111111-1111-4111-8111-111111111111';
const PROD = '22222222-2222-4222-8222-222222222222';
const env = { STAGING_D1_ID: STAGING, PRODUCTION_D1_ID: PROD, RELEASE_PREVIEW_D1_ID: '33333333-3333-4333-8333-333333333333' };
const valid = { environment: 'staging', databaseId: STAGING, databaseName: 'pawspace-staging', confirm: `restore-staging:${STAGING}` };
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');

function backupDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pawspace-d1-'));
  const sql = Buffer.from('CREATE TABLE proof(id TEXT);\n');
  const json = Buffer.from('{"proof":[]}\n');
  writeFileSync(join(dir, 'database.sql'), sql);
  writeFileSync(join(dir, 'database.json'), json);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    format: 'pawspace-d1-backup-v1', createdAt: '2026-09-02T00:00:00.000Z', environment: 'staging', databaseId: STAGING, databaseName: 'pawspace-staging', tables: [{ name: 'proof', rowCount: 0 }], totalRows: 0,
    artifacts: { sql: { filename: 'database.sql', size: sql.length, sha256: hash(sql) }, json: { filename: 'database.json', size: json.length, sha256: hash(json) } },
  }));
  return dir;
}

test('wrong D1 id fails closed before restore', () => {
  assert.throws(() => assertRestoreTarget({ ...valid, databaseId: PROD }, env), /does not match STAGING_D1_ID/);
});

test('environment mismatch and production restore fail closed', () => {
  assert.throws(() => assertRestoreTarget({ ...valid, environment: 'production' }, env), /staging-only/);
  assert.throws(() => assertRestoreTarget(valid, { ...env, PRODUCTION_D1_ID: STAGING }), /must not match PRODUCTION_D1_ID/);
  assert.throws(() => assertRestoreTarget({ ...valid, databaseName: 'some-other-d1' }, env), /must exactly equal pawspace-staging/);
});

test('confirmation is exact and bound to the target id', () => {
  assert.throws(() => assertRestoreTarget({ ...valid, confirm: 'restore-staging' }, env), /must exactly equal/);
  assert.equal(assertRestoreTarget(valid, env).databaseId, STAGING);
});

test('tampered SQL hash fails closed', () => {
  const dir = backupDir();
  verifyBackupArtifacts(dir, 'staging');
  writeFileSync(join(dir, 'database.sql'), 'DROP TABLE proof;\n');
  assert.throws(() => verifyBackupArtifacts(dir, 'staging'), /size mismatch|SHA-256 mismatch/);
});

test('manifest environment mismatch fails closed', () => {
  const dir = backupDir();
  assert.throws(() => verifyBackupArtifacts(dir, 'production'), /environment does not match/);
});

test('valid staging restore verifies everything before invoking wrangler', () => {
  const dir = backupDir();
  const calls = [];
  const runner = (...args) => { calls.push(args); return { status: 0 }; };
  const result = restoreD1Backup({ ...valid, backupDir: dir }, env, runner);
  assert.equal(result.restored, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], 'npx');
  assert.ok(calls[0][1].includes('execute'));
});
