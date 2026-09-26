import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {applyIdempotentMigrationFile} from '../scripts/schema/apply-idempotent-drizzle.mjs';
test('Atlas legacy reviews survive migration without invented authority evidence',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE atlas_proposal_reviews(id TEXT PRIMARY KEY,proposal_id TEXT,decision TEXT,reviewer_id TEXT,reviewed_at INTEGER,reviewed_decision_fingerprint TEXT,basis_code TEXT,review_note TEXT); INSERT INTO atlas_proposal_reviews VALUES('legacy','p1','approved','founder',1,NULL,'human','keep this note')");
 for(let i=0;i<2;i++){applyIdempotentMigrationFile(db,'drizzle/0042_atlas_review_audit_columns.sql');applyIdempotentMigrationFile(db,'drizzle/0043_atlas_legacy_review_columns.sql');}
 const r=db.prepare('SELECT * FROM atlas_proposal_reviews').get();
 assert.equal(r.id,'legacy');assert.equal(r.review_note,'keep this note');assert.equal(r.decision,'approved');
 for(const key of ['reviewer_role_code','reviewer_authority_source','review_auth_assurance_type','review_auth_session_id','review_mfa_verified_at','review_hash_version','review_sequence','previous_review_hash','review_hash'])assert.equal(r[key],null,key);
 db.close();
});
