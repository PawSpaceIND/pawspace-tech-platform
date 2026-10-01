import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {d1} from './helpers/execution-harness.mjs';
import {ensureGroomingRevisionPrerequisiteTables} from '../lib/grooming-revision-schema.ts';
import {assertGroomingRevisionInstallation} from '../lib/grooming-revision-installation.ts';
test('explicit revision prerequisites preserve durable state and do not activate authority',async()=>{
 const sqlite=new DatabaseSync(':memory:');const db=d1(sqlite);
 try {
  await ensureGroomingRevisionPrerequisiteTables(db);
  for(const table of ['conversation_ownership_revisions','grooming_effective_control_revision','grooming_revision_installation','grooming_revision_installation_epoch'])assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  await assert.rejects(()=>assertGroomingRevisionInstallation(db),error=>error.status===409);
  sqlite.exec("INSERT INTO conversation_ownership_revisions VALUES('THREAD',17); INSERT INTO grooming_effective_control_revision VALUES(1,23,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); INSERT INTO grooming_revision_installation_epoch VALUES(1,9,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'); INSERT INTO grooming_revision_installation VALUES(1,2)");
  await ensureGroomingRevisionPrerequisiteTables(db);
  assert.equal(sqlite.prepare('SELECT revision FROM conversation_ownership_revisions').get().revision,17);
  assert.equal(sqlite.prepare('SELECT revision FROM grooming_effective_control_revision').get().revision,23);
  assert.equal(sqlite.prepare('SELECT epoch FROM grooming_revision_installation_epoch').get().epoch,9);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sqlite_master WHERE type=\'trigger\'').get().n,0);
  await assert.rejects(()=>assertGroomingRevisionInstallation(db),error=>error.status===409);
  assert.throws(()=>sqlite.exec("INSERT INTO conversation_ownership_revisions VALUES('BAD',0)"),/CHECK/);
  assert.throws(()=>sqlite.exec("UPDATE grooming_effective_control_revision SET database_incarnation='short'"),/CHECK/);
 } finally {sqlite.close();}
});
