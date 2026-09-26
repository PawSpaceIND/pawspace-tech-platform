-- The Booking Command Center reads every booking child table by booking_id. Six of them had no index on
-- it, so each read was a full table scan (master E2E run 36243387701 row 40). The same statements run in
-- ensureTables of app/api/booking-command-center/route.ts; booking_lifecycle_events repeats the index
-- app/api/canonical-bookings/route.ts already creates, so it exists whichever route runs first.
CREATE INDEX IF NOT EXISTS `idx_booking_lifecycle_events_booking`
  ON `booking_lifecycle_events` (`booking_id`, `occurred_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_booking_operational_events_booking`
  ON `booking_operational_events` (`booking_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_booking_customer_notifications_booking`
  ON `booking_customer_notifications` (`booking_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_booking_rebooking_cases_booking`
  ON `booking_rebooking_cases` (`booking_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_booking_refund_cases_booking`
  ON `booking_refund_cases` (`booking_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_customer_experience_tickets_booking`
  ON `customer_experience_tickets` (`booking_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_booking_admin_actions_booking`
  ON `booking_admin_actions` (`booking_id`, `created_at`);
