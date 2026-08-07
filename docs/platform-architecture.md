# PawSpace Unified Pet-Care Platform

## Product principle

Every channel uses the same customer, pet, booking, subscription, provider, payment and communication records. Mobile apps, web, assisted sales, CRM, finance and reporting never maintain separate operational copies.

## Core records

- Customer and household
- Pet profile, health documents, preferences and lifetime timeline
- Address, zone, city and geofence
- Service catalogue, package, add-on and city price book
- Booking, appointment, job status and evidence
- Subscription contract, credit wallet, validity and scheduled sessions
- Provider, employment model, skills, zones, availability and attendance
- Payment, refund, cash collection, invoice, GST and payout ledger
- Consent, communication event, support ticket and immutable audit log

## Identity and access

- Customer authentication: mobile OTP at confirmation, not while browsing
- Staff authentication: enterprise SSO or OTP plus role and branch scope
- Provider authentication: verified device, OTP/PIN and optional biometric
- Roles: Super Admin, City Head, Operations, Sales, CRM, Support, Finance, HR, Provider and Read-only Auditor
- Field-level permissions for phone, address, medical data, prices, discounts, refunds and exports
- Number masking by role and booking state
- Time-limited supervisor reveal with reason, approval and audit event
- Encryption in transit and at rest, device/session revocation and configurable retention

## Multi-city engine

City configuration owns currency, taxes, service catalogue, package inclusions, prices, coupons, provider commissions, operational hours, booking windows, cancellation rules and support routing. Zones are geofenced polygons with capacity, travel buffers and eligible providers. A new city launches through configuration and approvals without forking application code.

## Provider assignment

1. Validate service, skill, pet type, zone, calendar, travel time and daily capacity.
2. Full-time provider: auto-assign the highest scoring eligible provider; no acceptance required.
3. Commission provider: send a time-bound offer; accept or decline with reason.
4. On expiry or decline, route to the next provider and inform Operations only on exception.
5. Re-evaluate automatically after cancellation, delay or customer reschedule.
6. Keep customer preference, repeat-provider affinity, quality, fairness and payout economics in the score.

## Subscription automation

- 3-session validity: 4 months
- 6-session validity: 8 months
- 12-session validity: 15 months
- Customer may schedule all sessions, schedule every 15 days, choose each date, or receive reminders only
- Reminder preferences: app push, WhatsApp, SMS, email or assisted call
- Session due, unused credit, validity expiry and renewal journeys
- Rescheduling changes one appointment without changing the subscription contract
- Credits, freezes, extensions and exception approvals remain in the subscription ledger

## MongoDB continuation

1. Profile the existing collections and identify duplicate customers, phones, pets and subscriptions.
2. Preserve every legacy `_id` in a `legacyIds` mapping; never overwrite historical identifiers.
3. Create canonical IDs and mapping tables for customers, pets, providers and bookings.
4. Backfill normalized phone numbers, city, zone, service, payment and status fields.
5. Run reconciliation reports before cutover: counts, GMV, open subscriptions, unused sessions and balances.
6. Use change-data capture or dual-write during transition.
7. Switch mobile, admin and CRM to versioned APIs only after reconciliation passes.
8. Keep the old database read-only for an agreed audit period; define rollback checkpoints.

MongoDB credentials and production data are not required for prototype work. Migration starts with a schema/sample export and a read-only connection in a controlled environment.

## Integration layer

- Payments and payouts: Razorpay, RazorpayX
- Communications: WhatsApp BSP, SMS, email, push notifications
- Voice: AI voice bot, autodialler and masked telephony
- Maps: geocoding, routing, ETA, geofencing and live location
- Marketing: campaign audiences, attribution, coupon and referral events
- Finance: GST invoices, cash reconciliation, refunds and accounting export
- Analytics: governed event stream and role-based dashboards
- Future partners: veterinary, insurance, relocation, marketplace and loyalty

All external systems connect through versioned adapters and webhooks. They do not write directly to operational collections.

## Reporting

- Daily bookings, fill rate, cancellations, delays, GMV and collections
- Service/city/zone/channel/package performance
- New, repeat, subscription and reactivated customers
- Cohort retention, 15/30/60/90-day repeat and lifetime value
- Subscription sold, used, expired, frozen, renewed and liability
- Provider utilization, attendance, acceptance, travel, quality, upgrades and payouts
- Sales/Operations assisted-booking conversion and audit trails
- Campaign attribution, cross-sell, coupon leakage and notification performance
- GST, cash, refunds, outstanding payments and reconciliation

## Release gates

Prototype → sandbox integrations → controlled migration rehearsal → employee pilot → invited-customer beta → one-zone production pilot → Bengaluru rollout → multi-city template.

No production launch proceeds without reconciliation, access-control testing, security review, backup/restore verification, app-store compliance and documented operational rollback.
