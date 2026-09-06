-- STAGING-ONLY pilot baseline hygiene.
-- Archive incomplete legacy/demo canonical bookings before removing them from the active staging baseline.
-- A canonical booking is considered incomplete if its customer, work order or payment row is missing.
-- The pilot certification runs this only against pawspace-staging after an isolation probe.

CREATE TABLE IF NOT EXISTS pilot_staging_orphan_booking_archive (
  booking_id TEXT PRIMARY KEY,
  service_code TEXT,
  status TEXT,
  customer_id TEXT,
  provider_id TEXT,
  total_amount REAL,
  scheduled_start TEXT,
  scheduled_end TEXT,
  reason TEXT NOT NULL,
  archived_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO pilot_staging_orphan_booking_archive
(booking_id,service_code,status,customer_id,provider_id,total_amount,scheduled_start,scheduled_end,reason,archived_at)
SELECT b.id,b.service_code,b.status,b.customer_id,b.provider_id,b.total_amount,b.scheduled_start,b.scheduled_end,
       CASE WHEN c.id IS NULL THEN 'missing_customer'
            WHEN w.booking_id IS NULL THEN 'missing_work_order'
            WHEN p.booking_id IS NULL THEN 'missing_payment'
            ELSE 'unknown' END,
       CAST(strftime('%s','now') AS INTEGER)*1000
FROM canonical_bookings b
LEFT JOIN canonical_customers c ON c.id=b.customer_id
LEFT JOIN provider_work_orders w ON w.booking_id=b.id
LEFT JOIN booking_payments p ON p.booking_id=b.id
WHERE c.id IS NULL OR w.booking_id IS NULL OR p.booking_id IS NULL;

DELETE FROM canonical_bookings
WHERE id IN (SELECT booking_id FROM pilot_staging_orphan_booking_archive);
