import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {applyIdempotentMigrationFile} from '../scripts/schema/apply-idempotent-drizzle.mjs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {makeD1} from './helpers/taxi-harness.mjs';
installWorkersHooks('__ATLAS_REVIEW_MIGRATION_DB__');
const atlas=await import('../lib/intelligence/atlas-business-snapshot.ts');
test('Atlas legacy reviews survive migration without invented authority evidence',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE atlas_proposal_reviews(id TEXT PRIMARY KEY,proposal_id TEXT,decision TEXT,reviewer_id TEXT,reviewed_at INTEGER,reviewed_decision_fingerprint TEXT,basis_code TEXT,review_note TEXT,review_sequence INTEGER,previous_review_hash TEXT,review_hash TEXT); INSERT INTO atlas_proposal_reviews (id,proposal_id,decision,reviewer_id,reviewed_at,reviewed_decision_fingerprint,basis_code,review_note) VALUES('legacy','p1','approved','founder',1,NULL,'human','keep this note')");
 const runtime=makeD1(db);
 await atlas.ensureAtlasProposalJournal(runtime);
 await assert.rejects(()=>atlas.listAtlasProposals(runtime),/no such column.*reviewer_role_code/);
 for(let i=0;i<2;i++){applyIdempotentMigrationFile(db,'drizzle/0042_atlas_review_audit_columns.sql');applyIdempotentMigrationFile(db,'drizzle/0043_atlas_legacy_review_columns.sql');}
 const r=db.prepare('SELECT * FROM atlas_proposal_reviews').get();
 assert.equal(r.id,'legacy');assert.equal(r.review_note,'keep this note');assert.equal(r.decision,'approved');
 for(const key of ['reviewer_role_code','reviewer_authority_source','review_auth_assurance_type','review_auth_session_id','review_mfa_verified_at','review_hash_version','review_sequence','previous_review_hash','review_hash'])assert.equal(r[key],null,key);
 assert.deepEqual(await atlas.listAtlasProposals(runtime),[]);
 db.close();
});
