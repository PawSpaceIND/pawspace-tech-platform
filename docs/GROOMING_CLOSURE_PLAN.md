# PawSpace Grooming Integration Closure

## Goal
Close one real Grooming transaction end-to-end using a single canonical booking record:

Customer -> Pet -> Package -> Slot -> Booking -> Payment -> Assignment -> Provider -> Service Proof -> Completion -> Invoice -> Finance -> Repeat/Subscription

## Current verified state
- The 4 Aug 2026 prototype is integration-ready but not production-connected.
- Grooming customer journey is substantially complete as a responsive prototype.
- Customer, Provider, CRM, Admin, Sales/Ops and Finance currently share a synthetic booking record in browser-local state.
- A backend/API prototype exists with canonical customer, pet, booking, subscription, provider, payment, refund, cash, invoice, payout, notification and audit models.
- The customer UI does not yet call the backend booking API.
- OTP, payments, notifications, maps/tracking, media upload, invoice delivery and refunds are sandbox/placeholder integrations.

## Closure sequence
1. Recover/import the latest prototype source into this repository. Do not rebuild from the older starter pack unless the latest source is unavailable.
2. Freeze Grooming catalogue, pricing, validity, add-ons and multi-pet rules as versioned fixtures.
3. Make one API-backed booking aggregate the source of truth for every surface.
4. Connect customer confirmation to the booking API with idempotency.
5. Persist booking/customer/pet/payment/subscription data server-side.
6. Connect Admin/CRM/Ops/Finance/Provider screens to the same booking/event stream.
7. Implement provider availability, assignment, acceptance/decline, travel, arrival, service start and completion.
8. Implement mandatory before/after proof, checklist and completion notes.
9. Implement payment state, cash collection, refund/reconciliation and GST invoice state.
10. Implement subscription reservation/consumption/reversal/expiry and repeat-booking triggers.
11. Complete role/ownership checks, audit trail and sensitive-data masking.
12. Add external integrations one at a time in sandbox: Razorpay, OTP/WhatsApp, Exotel, Maps/GPS, media storage.
13. Pass cross-role regression, mobile/device UAT and controlled employee pilot before production launch.

## Immediate blocker
The repository was created on 7 Aug 2026 and currently contains only the initial README/.gitignore. The latest 4 Aug prototype source itself has not yet been recovered into GitHub. The available Library contains audit documents, screenshots and an older 2 Aug Grooming starter-code pack, but not the later complete prototype source archive.

## Rule
Do not connect live customer data or live payment/communication integrations until the shared API-backed transaction passes synthetic regression and role/ownership tests.
