CREATE TABLE IF NOT EXISTS communication_consent (
  customer_id TEXT PRIMARY KEY,
  global_opt_out INTEGER NOT NULL DEFAULT 0,
  whatsapp_allowed INTEGER,
  email_allowed INTEGER,
  voice_allowed INTEGER,
  sms_allowed INTEGER,
  source TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS communication_frequency_reservations (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  reserved_at INTEGER NOT NULL,
  UNIQUE(channel,message_id)
);
CREATE INDEX IF NOT EXISTS communication_frequency_identity_idx ON communication_frequency_reservations(customer_id,channel,reserved_at);
UPDATE communication_policies SET quiet_start_hour=21,quiet_end_hour=9,version=version+1,updated_at=unixepoch()*1000 WHERE quiet_start_hour!=21 OR quiet_end_hour!=9;
