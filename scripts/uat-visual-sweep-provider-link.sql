CREATE TABLE IF NOT EXISTS provider_identity_links (
  email TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  verified_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO provider_identity_links (email, provider_id, status, verified_at, updated_at)
VALUES ('asha.groomer1@tkpetcare.in', 'uatcap_groom_ft', 'active', 1789310000000, 1789310000000)
ON CONFLICT(email) DO UPDATE SET
  provider_id = excluded.provider_id,
  status = 'active',
  verified_at = excluded.verified_at,
  updated_at = excluded.updated_at;
