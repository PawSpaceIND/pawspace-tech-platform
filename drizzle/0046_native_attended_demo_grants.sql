-- Inactive by default: no grants are seeded or issued by this migration.
CREATE TABLE IF NOT EXISTS native_attended_demo_grants (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
 customer_id TEXT NOT NULL, recipient_hash TEXT NOT NULL, release_sha TEXT NOT NULL,
 database_id TEXT NOT NULL, version_id TEXT NOT NULL, issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','claimed','revoked')),
 call_id TEXT UNIQUE, claimed_at INTEGER, stream_claimed_at INTEGER,
 UNIQUE(recipient_hash,release_sha),
 CHECK(expires_at > issued_at AND expires_at-issued_at<=60000)
);
CREATE TABLE IF NOT EXISTS native_attended_demo_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, grant_id TEXT NOT NULL, call_id TEXT,
 event TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS native_attended_demo_claim_audit AFTER UPDATE OF state ON native_attended_demo_grants
 WHEN NEW.state='claimed' AND OLD.state='ready'
 BEGIN INSERT INTO native_attended_demo_audit(grant_id,call_id,event,created_at) VALUES(NEW.id,NEW.call_id,'claimed',NEW.claimed_at); END;

CREATE TRIGGER IF NOT EXISTS native_attended_demo_issue_audit AFTER INSERT ON native_attended_demo_grants
 BEGIN INSERT INTO native_attended_demo_audit(grant_id,call_id,event,created_at) VALUES(NEW.id,NEW.call_id,'issued',NEW.issued_at); END;
CREATE TRIGGER IF NOT EXISTS native_attended_demo_revoke_audit AFTER UPDATE OF state ON native_attended_demo_grants
 WHEN NEW.state='revoked' AND OLD.state!='revoked'
 BEGIN INSERT INTO native_attended_demo_audit(grant_id,call_id,event,created_at) VALUES(NEW.id,NEW.call_id,'revoked',CAST(strftime('%s','now') AS INTEGER)*1000); END;

CREATE TRIGGER IF NOT EXISTS native_attended_demo_no_rearm BEFORE UPDATE OF state ON native_attended_demo_grants
 WHEN NEW.state='ready' AND OLD.state!='ready'
 BEGIN SELECT RAISE(ABORT,'Attended demo grants cannot be rearmed'); END;
CREATE TRIGGER IF NOT EXISTS native_attended_demo_no_delete BEFORE DELETE ON native_attended_demo_grants
 BEGIN SELECT RAISE(ABORT,'Attended demo grants retain their one-use receipt'); END;
