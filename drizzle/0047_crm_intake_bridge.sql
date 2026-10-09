-- Forward additive bridge schema. Unapplied here; existing migration history retained.
CREATE TABLE IF NOT EXISTS crm_intake_bridge_inquiries (
 inquiry_key TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, source_inquiry_id TEXT NOT NULL,
 external_inquiry_id TEXT NOT NULL, external_customer_id TEXT NOT NULL, phone_normalized TEXT,
 service_code TEXT NOT NULL, canonical_customer_id TEXT, canonical_lead_id TEXT,
 state TEXT NOT NULL, review_reason TEXT, created_at INTEGER NOT NULL, linked_at INTEGER,
 UNIQUE(source,account_id,source_inquiry_id)
);
CREATE TABLE IF NOT EXISTS crm_intake_bridge_events (
 event_key TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL, source_event_id TEXT NOT NULL,
 inquiry_key TEXT NOT NULL REFERENCES crm_intake_bridge_inquiries(inquiry_key), fingerprint TEXT NOT NULL,
 envelope_json TEXT NOT NULL, received_at INTEGER NOT NULL,
 UNIQUE(source,account_id,source_event_id)
);
CREATE TRIGGER IF NOT EXISTS crm_intake_bridge_event_immutable_v2 BEFORE UPDATE ON crm_intake_bridge_events
 WHEN OLD.event_key IS NOT NEW.event_key
 OR OLD.source IS NOT NEW.source
 OR OLD.account_id IS NOT NEW.account_id
 OR OLD.source_event_id IS NOT NEW.source_event_id
 OR OLD.inquiry_key IS NOT NEW.inquiry_key
 OR OLD.fingerprint IS NOT NEW.fingerprint
 OR OLD.envelope_json IS NOT NEW.envelope_json
 OR OLD.received_at IS NOT NEW.received_at
 BEGIN SELECT RAISE(ABORT,'source_event_payload_conflict'); END;
CREATE TRIGGER IF NOT EXISTS crm_intake_bridge_identity_collision BEFORE UPDATE ON crm_intake_bridge_inquiries
 WHEN OLD.external_inquiry_id<>NEW.external_inquiry_id OR OLD.external_customer_id<>NEW.external_customer_id
 OR COALESCE(OLD.phone_normalized,'')<>COALESCE(NEW.phone_normalized,'')
 BEGIN SELECT RAISE(ABORT,'source_inquiry_identity_conflict'); END;
CREATE UNIQUE INDEX IF NOT EXISTS crm_intake_bridge_one_canonical_lead ON crm_intake_bridge_inquiries(canonical_lead_id);
