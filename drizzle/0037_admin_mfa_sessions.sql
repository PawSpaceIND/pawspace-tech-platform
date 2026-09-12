ALTER TABLE app_users ADD COLUMN mfa_secret TEXT;
ALTER TABLE app_users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0,1));

CREATE TABLE active_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  mfa_verified_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES app_users(id)
);

CREATE INDEX idx_active_sessions_user_validity
  ON active_sessions(user_id, revoked_at, expires_at);
