-- Derive payment reconciliation records from captured payments so "collected" revenue is real.
--
-- The seeds create 319 booking_payments (219 captured) but ZERO payment_reconciliation_records — and
-- every collected-revenue surface reads captured_amount from that table: the Revenue Mission command
-- centre (via backfill_canonical_sources -> revenue_mission_events) and the sales leaderboard. So
-- "achieved / collected" read ~0 against ₹90k+ booked, making the mission look ~1% complete.
--
-- One reconciliation record per CAPTURED payment, captured_amount = the full paid amount. Idempotent
-- (PK payment_id + INSERT OR IGNORE); the CREATE guard lets it load standalone. Load AFTER the seeds
-- that create booking_payments (staging-seed.sql / uat-demo-seed.sql).
--
-- NOTE: the Revenue Mission caches its own event log, so after this loads, rebuild it once from the
-- mission — POST /api/revenue-mission-control {action:"backfill_canonical_sources", missionId} (founder
-- has customers.manage), or re-activate the mission — to turn these captures into collected events.

CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT NOT NULL,environment TEXT NOT NULL,expected_amount REAL NOT NULL,captured_amount REAL NOT NULL DEFAULT 0,refunded_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,gateway_status TEXT NOT NULL DEFAULT 'not_started',reconciliation_status TEXT NOT NULL DEFAULT 'pending',variance_amount REAL NOT NULL DEFAULT 0,last_event_id TEXT,updated_at INTEGER NOT NULL);

INSERT OR IGNORE INTO payment_reconciliation_records
  (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at)
SELECT p.id,p.booking_id,p.gateway,'uat_sandbox',p.amount,p.amount,0,p.currency,'captured','matched',0,'seed-recon:'||p.id,p.updated_at
FROM booking_payments p
WHERE p.status='captured';

-- Turn those captures into COLLECTED revenue_mission_events for every active mission, so the Revenue
-- Mission command centre (which reads pre-built events, never live) shows real "achieved / collected"
-- without needing the backfill action re-run. The mission id is resolved by JOIN, and the mission's
-- scope_json + period gate which bookings count (company / city / service). eligible_amount = captured.
--
-- Double-count safe: recordMissionCollectionDelta computes delta = captured - SUM(prior collected for
-- the payment); once this row exists, prior == captured, so a later real backfill adds 0. Idempotent via
-- UNIQUE(mission_id, source_event_key).
INSERT OR IGNORE INTO revenue_mission_events
  (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at)
SELECT 'RME-SEEDCOL-'||substr(m.id,1,10)||'-'||p.id, m.id, 'collection:'||p.id||':seed-recon', 'collected',
       b.customer_id, b.id, p.id, NULL, b.service_code, b.city_id, p.amount, 0, p.amount, p.currency,
       p.updated_at, 'payment_reconciliation:v1', '{"seed":true}', p.updated_at
FROM revenue_missions m
JOIN canonical_bookings b
  ON b.currency=m.currency
 AND b.status NOT IN ('cancelled','draft')
 AND b.created_at>=m.period_start AND b.created_at<=m.period_end
 AND ( json_extract(m.scope_json,'$.type')='company'
    OR (json_extract(m.scope_json,'$.type')='city' AND json_extract(m.scope_json,'$.value')=b.city_id)
    OR (json_extract(m.scope_json,'$.type')='service' AND json_extract(m.scope_json,'$.value')=b.service_code) )
JOIN booking_payments p ON p.booking_id=b.id AND p.status='captured'
WHERE m.status='active_uat';
