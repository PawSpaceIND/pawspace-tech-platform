CREATE TABLE IF NOT EXISTS dpdp_consent_records (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  consent_type TEXT NOT NULL CHECK (length(trim(consent_type)) > 0),
  status TEXT NOT NULL CHECK (status IN ('granted','withdrawn')),
  ip_hash TEXT NOT NULL CHECK (length(trim(ip_hash)) > 0),
  timestamp INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dpdp_consent_customer_type_time
  ON dpdp_consent_records(customer_id, consent_type, timestamp DESC);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS dpdp_consent_records_append_only_update
BEFORE UPDATE ON dpdp_consent_records
BEGIN
  SELECT RAISE(ABORT, 'dpdp_consent_records is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS dpdp_consent_records_append_only_delete
BEFORE DELETE ON dpdp_consent_records
BEGIN
  SELECT RAISE(ABORT, 'dpdp_consent_records is append-only');
END;
