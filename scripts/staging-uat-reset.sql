-- ============================================================================
-- STAGING UAT RESET — wipe transactional test data, keep every seed/config.
-- Run MANUALLY, only against the ISOLATED STAGING D1, on the morning human
-- UAT starts (announce a test freeze first):
--
--   npx wrangler d1 execute pawspace-staging --remote --file scripts/staging-uat-reset.sql
--
-- KEEPS: provider capacity profiles + rosters, boarding host profiles,
-- commercial packages/terms/pricing, coupon campaigns, employees + payroll
-- structures, roles/users, statutory calendar config.
-- DELETES: bookings, reservations, stays, sessions/trips, orders, payments,
-- quotes, schedules, proofs, alerts, OTP/identity sessions, CRM test leads,
-- reviews, meet & greets, enquiries - everything testers generated.
-- ============================================================================

-- Booking core
DELETE FROM canonical_bookings;
DELETE FROM canonical_pets;
DELETE FROM canonical_customers;
DELETE FROM customer_addresses;
DELETE FROM customer_account_mutations;
DELETE FROM scheduling_reservations;
DELETE FROM scheduling_assignment_decisions;
DELETE FROM provider_assignment_offers;
DELETE FROM booking_payments;

-- Stays
DELETE FROM boarding_stays;
DELETE FROM boarding_stay_events;
DELETE FROM boarding_capacity_locks;
DELETE FROM boarding_commercial_quotes;
DELETE FROM boarding_booking_quote_links;
DELETE FROM sitting_commercial_quotes;
DELETE FROM sitting_booking_quote_links;
DELETE FROM sitting_quote_payment_attestations;
DELETE FROM stay_payment_schedules;
DELETE FROM stay_payment_events;

-- Sessions / trips / orders
DELETE FROM walking_sessions;
DELETE FROM taxi_trips;
DELETE FROM food_orders;

-- Customer identity (testers re-verify via sandbox OTP)
DELETE FROM customer_otp_challenges;
DELETE FROM platform_identity_sessions;
DELETE FROM identity_bindings;
DELETE FROM customer_identity_links;

-- Coupons: keep campaigns, clear tester redemptions/quotes
DELETE FROM coupon_redemptions;

-- Trust & enquiry surfaces
DELETE FROM host_reviews;
DELETE FROM host_review_replies;
DELETE FROM meet_greet_requests;
DELETE FROM meet_greet_events;
DELETE FROM relocation_enquiries;

-- Ops noise
DELETE FROM staff_alerts;
DELETE FROM security_audit_events;

-- NOTE: intentionally NOT touching payroll_runs / employee data / finance
-- invoices+bills (finance seeds power the statutory demo) or any *_packages,
-- *_terms, provider/host profile tables. Tables that do not exist yet on the
-- target DB will error individually - wrangler continues with the rest; that
-- is acceptable for a reset script.
