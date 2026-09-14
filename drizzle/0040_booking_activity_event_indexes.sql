-- Operations keeps scheduled-day capacity/revenue separate from event-day CRM activity.
-- These indexes let SQLite use either side of the activity query without scanning all bookings.
CREATE INDEX IF NOT EXISTS `idx_canonical_bookings_scheduled_start_zone`
  ON `canonical_bookings` (`scheduled_start`, `zone_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canonical_bookings_updated_at_zone`
  ON `canonical_bookings` (`updated_at`, `zone_id`);
