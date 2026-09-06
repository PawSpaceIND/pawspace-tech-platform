-- PawSpace Trust & Safety: anti-leakage, provider strikes, global customer blocklist.
ALTER TABLE provider_capacity_profiles ADD COLUMN trust_score INTEGER NOT NULL DEFAULT 100;
ALTER TABLE provider_capacity_profiles ADD COLUMN trust_strike_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_capacity_profiles ADD COLUMN suspended_until INTEGER;

CREATE TABLE IF NOT EXISTS trust_safety_events (
  id TEXT PRIMARY KEY,event_type TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,provider_id TEXT,customer_id TEXT,thread_id TEXT,message_id TEXT,channel TEXT NOT NULL,detection_types_json TEXT NOT NULL DEFAULT '[]',content_sha256 TEXT NOT NULL,source_reference TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',strike_applied INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(event_type, source_reference)
);
CREATE INDEX IF NOT EXISTS idx_trust_safety_events_provider ON trust_safety_events(provider_id,strike_applied,created_at);
CREATE TABLE IF NOT EXISTS provider_trust_state (provider_id TEXT PRIMARY KEY,trust_score INTEGER NOT NULL DEFAULT 100,strike_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',suspended_until INTEGER,last_event_id TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provider_trust_strikes (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,strike_number INTEGER NOT NULL,action TEXT NOT NULL,trust_score_before INTEGER NOT NULL,trust_score_after INTEGER NOT NULL,suspended_until INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_provider_trust_strikes_provider ON provider_trust_strikes(provider_id,created_at);
CREATE TABLE IF NOT EXISTS provider_chat_activity (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_provider_chat_activity_provider ON provider_chat_activity(provider_id,created_at);
CREATE TABLE IF NOT EXISTS trust_safety_provider_notifications (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,strike_id TEXT NOT NULL UNIQUE,strike_number INTEGER NOT NULL,channel TEXT NOT NULL DEFAULT 'whatsapp',template_key TEXT NOT NULL DEFAULT 'provider_trust_warning_v1',status TEXT NOT NULL DEFAULT 'queued',attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_error TEXT,provider_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_trust_safety_provider_notifications_due ON trust_safety_provider_notifications(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS global_blocklist (phone_e164 TEXT PRIMARY KEY,phone_key TEXT NOT NULL,customer_id TEXT,reason_code TEXT NOT NULL CHECK(reason_code IN ('mistreatment','non_payment','circumvention')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cleared')),flagged_by TEXT NOT NULL,flagged_by_type TEXT NOT NULL CHECK(flagged_by_type IN ('provider','staff')),booking_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,cleared_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_global_blocklist_e164_status ON global_blocklist(phone_e164,status);
CREATE INDEX IF NOT EXISTS idx_global_blocklist_phone_key ON global_blocklist(phone_key,status);
CREATE TABLE IF NOT EXISTS global_blocklist_customer_links (customer_id TEXT PRIMARY KEY,phone_e164 TEXT NOT NULL,linked_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_global_blocklist_links_phone ON global_blocklist_customer_links(phone_e164,customer_id);
CREATE TABLE IF NOT EXISTS trust_safety_sweep_runs (slot_key TEXT PRIMARY KEY,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT '{}');

CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_link_customers_insert AFTER INSERT ON global_blocklist WHEN NEW.status='active' BEGIN
  INSERT INTO global_blocklist_customer_links(customer_id,phone_e164,linked_at)
  SELECT c.id,NEW.phone_e164,NEW.updated_at FROM canonical_customers c
  WHERE substr(replace(replace(replace(replace(replace(COALESCE(c.primary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10)=NEW.phone_key
     OR substr(replace(replace(replace(replace(replace(COALESCE(c.secondary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10)=NEW.phone_key
  ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,linked_at=excluded.linked_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_link_customers_update AFTER UPDATE OF status,phone_key ON global_blocklist WHEN NEW.status='active' BEGIN
  INSERT INTO global_blocklist_customer_links(customer_id,phone_e164,linked_at)
  SELECT c.id,NEW.phone_e164,NEW.updated_at FROM canonical_customers c
  WHERE substr(replace(replace(replace(replace(replace(COALESCE(c.primary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10)=NEW.phone_key
     OR substr(replace(replace(replace(replace(replace(COALESCE(c.secondary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10)=NEW.phone_key
  ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,linked_at=excluded.linked_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_customer_insert AFTER INSERT ON canonical_customers BEGIN
  INSERT INTO global_blocklist_customer_links(customer_id,phone_e164,linked_at)
  SELECT NEW.id,g.phone_e164,NEW.updated_at FROM global_blocklist g WHERE g.status='active' AND g.phone_key IN (
    substr(replace(replace(replace(replace(replace(COALESCE(NEW.primary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10),
    substr(replace(replace(replace(replace(replace(COALESCE(NEW.secondary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10)) LIMIT 1
  ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,linked_at=excluded.linked_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_customer_phone_update AFTER UPDATE OF primary_phone,secondary_phone ON canonical_customers BEGIN
  DELETE FROM global_blocklist_customer_links WHERE customer_id=NEW.id;
  INSERT INTO global_blocklist_customer_links(customer_id,phone_e164,linked_at)
  SELECT NEW.id,g.phone_e164,NEW.updated_at FROM global_blocklist g WHERE g.status='active' AND g.phone_key IN (
    substr(replace(replace(replace(replace(replace(COALESCE(NEW.primary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10),
    substr(replace(replace(replace(replace(replace(COALESCE(NEW.secondary_phone,''),'+',''),' ',''),'-',''),'(',''),')',''),-10)) LIMIT 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_booking_insert BEFORE INSERT ON canonical_bookings WHEN EXISTS (
  SELECT 1 FROM global_blocklist_customer_links l JOIN global_blocklist g ON g.phone_e164=l.phone_e164 AND g.status='active' WHERE l.customer_id=NEW.customer_id
) BEGIN SELECT RAISE(ABORT,'global_customer_blocked'); END;
CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_booking_customer_update BEFORE UPDATE OF customer_id ON canonical_bookings WHEN EXISTS (
  SELECT 1 FROM global_blocklist_customer_links l JOIN global_blocklist g ON g.phone_e164=l.phone_e164 AND g.status='active' WHERE l.customer_id=NEW.customer_id
) BEGIN SELECT RAISE(ABORT,'global_customer_blocked'); END;
