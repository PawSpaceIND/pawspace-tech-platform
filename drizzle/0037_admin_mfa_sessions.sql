-- Privileged MFA/session controls. SQLite/D1 lacks ADD COLUMN IF NOT EXISTS, so
-- schema application must use the governed PRAGMA-backed directives below.
-- @add-column-if-missing app_users|mfa_secret|TEXT
-- @add-column-if-missing app_users|mfa_enabled|INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0,1))

CREATE TABLE IF NOT EXISTS active_sessions (
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

CREATE INDEX IF NOT EXISTS idx_active_sessions_user_validity
  ON active_sessions(user_id, revoked_at, expires_at);
