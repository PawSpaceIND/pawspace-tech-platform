# PawSpace Technology Platform — Four-Vertical Closure Audit

**Audit date:** 4 August 2026  
**Scope:** Doorstep Dog & Cat Grooming, Doorstep Dog Training, Home Boarding and Pet Sitting  
**Release state:** Responsive, test-data-only prototype. Not production-connected.

## Executive closure position

The four customer journeys are substantially designed and usable as a responsive prototype. They are not production-ready yet. The largest closure risk was that the polished `/mobile-app` journeys and the operating modules did not create or consume the same test booking record. This audit pass connected new Grooming, Training, Boarding and Sitting confirmations to the shared synthetic booking ledger and exposed that record in Customer, Provider, CRM, Admin, Sales/Ops and Finance surfaces.

This is still browser-local synchronization, deliberately using test data only. It proves the record contract and cross-surface behaviour in one browser; it does not replace the future versioned API and production database.

## Status by area

| Area | Status | Audit finding |
| --- | --- | --- |
| Grooming customer journey | Complete prototype | Dog, cat, puppy and kitten packages; 1–4 pets; published two-pet pricing; subscriptions and validity; add-ons; dates/slots; preferred groomer; two contacts; OTP-positioned confirmation; pay-online/pay-after; confirmation, status, photos and payment views. |
| Training customer journey | Complete prototype | Assessment, goals, safety notes, seven plans, trainer matching, recurring calendar, 50% split payment, consent, programme dashboard, session tracking, homework, progress, feedback, refund wording and complimentary grooming for eligible plans. |
| Home Boarding | Complete prototype | Area/dates, 1–4 pets, needs, verified host matching, capacity, Care Card, contacts, Meet & Greet, optional taxi, protection, consent, confirmation, updates and safety/support views. |
| Pet Sitting | Complete prototype | Same stay lifecycle adapted for in-home sitter selection, secure access, multi-pet care, Care Card, protected confirmation, updates and support. |
| Common booking record | Partially complete | New bookings from all four customer journeys now create the same synthetic record used by Customer, Provider, CRM, Admin, Sales/Ops and Finance panels. It is localStorage test state, not server persistence. |
| Admin / CRM / Sales-Ops / Finance | Partially complete | Rich prototypes exist, with synchronized test-record panels. Most surrounding tables, counters and buttons still use independent static arrays or toast-only actions. |
| Provider applications | Partially complete | Unified partner app plus groomer, trainer, host and sitter surfaces exist. Shared record progression works in the partner panel; most specialist screens still display separate fixture data. |
| Platform API | Partially complete | Canonical customer, pet, booking, subscription, provider, payment, refund, cash, invoice, payout, notification and audit models exist. Twenty backend tests pass. The customer UI is not yet calling this API. |
| Regression centre | Partially complete | 100 synthetic customers and 1,000 rule checks exist. Full browser interaction, viewport and cross-role automation is still missing. |
| Mobile responsiveness | Partially complete | The customer app has phone-first layouts at <=950 px and full-screen treatment at <=480 px; account and operating modules have mobile breakpoints. Real iOS Safari, Android Chrome, tablet, keyboard and safe-area regression has not been completed. |

## Fixes completed in this audit pass

1. Connected Grooming, Training, Boarding and Pet Sitting confirmations to the shared synthetic booking ledger.
2. Added the shared booking panel to the customer mobile Activity view, Customer Account, Sales/Ops and Finance surfaces.
3. Added Sales/Ops and Accounts events to the shared booking audit trail.
4. Corrected the cat three-session subscription mismatch: the displayed ₹2,999 and confirmed total now use the same value.
5. Replaced the fixed three-night Boarding/Sitting calculation with controlled start/end dates, positive-night validation and dynamically recalculated totals.
6. Made Training and Stay consent checkboxes enforce confirmation eligibility.
7. Replaced hard-coded customer confirmation references with the shared synthetic booking ID.
8. Extended rendered-surface regression coverage to Sales/Ops and Customer Account.

## Partially complete or disconnected flows

- The common booking record synchronizes only inside the same browser profile. Another device or browser will not see it.
- Customer, Admin, CRM, Provider, Sales/Ops and Finance screens show the synchronized record in a dedicated panel, but their larger fixture tables are not yet projections of that record.
- The backend API and front-end Site are separate prototypes; booking confirmation does not call `/v1/bookings`.
- OTP, payment, notifications, maps, tracking, chat, media upload, invoice delivery and refunds are labelled interactions or sandbox adapters, not live integrations.
- Several buttons intentionally open toasts or visual states only: profile edit, secure chat, live tracking, media upload, support tickets, payout export and cross-sell actions.
- Training category does not yet constrain plan eligibility; safety selections do not yet trigger mandatory specialist review.
- Grooming subscription credit consumption is demonstrated in the test ledger but is not yet tied to every mobile subscription selection and multi-pet credit rule.
- Caregiver calendars and provider capacity are fixture data; date selection recalculates price but does not query real availability.
- Meet & Greet time is fixed fixture data and is not yet a selectable calendar booking.
- Specialist provider pages and the unified partner app overlap; they need one final role-routing decision before production implementation.

## Missing before closure sign-off

### Product and operational gaps

- One API-backed booking aggregate used directly by every surface.
- Server-side catalogue and price-book validation for every package, add-on, subscription and multi-pet combination.
- Booking-on-behalf flow that writes the same record and preserves actor/channel attribution.
- Subscription reservation, consumption, reversal, freeze, extension and expiry ledger with concurrency protection.
- Real provider availability, capacity, travel buffer, acceptance expiry, decline rerouting and replacement handling.
- Real support-ticket, reschedule, cancellation, refund and exception workflows.
- Training session objects, attendance, proof, homework, milestone, balance-payment and complimentary-grooming linkage.
- Boarding/Sitting capacity rules, Meet & Greet appointments, secure home-access reveal, incident workflow and caregiver payout linkage.
- Customer history, Admin queues, CRM timeline, Ops and Finance tables generated from the same booking/event stream.

### Security and access-control gaps

- The Site itself is restricted to the PawSpace workspace, which is appropriate for this prototype.
- Individual routes are not role-protected: a workspace viewer can open Admin, CRM, Finance and Provider screens directly.
- Prototype screens do not use server-enforced field permissions for phone, address, medical notes, pricing, refunds or exports.
- The synthetic ledger is editable browser storage and must never be treated as trusted evidence.
- The API supports signed token mode and role checks, but non-token mode trusts development headers. Production must force token authentication and reject header-based identities.
- Customer-to-record ownership checks need full coverage on booking, pet, subscription, payment, media and support endpoints.
- Number masking is inconsistent across static screens; reveal actions, reason capture, supervisor approval and audit expiry are not implemented.
- Secure home-access instructions must be encrypted, time-limited, minimally exposed and purged according to retention policy.
- Audit records are modelled but not yet immutable, tamper-evident or protected by retention/export controls.
- Session revocation, device binding, rate limiting, CSRF strategy, upload scanning, webhook replay protection and secret rotation require production review.

## Mobile usability findings

- Customer booking content is correctly constrained to a phone shell on desktop and becomes full-screen on small devices.
- Phone navigation remains fixed and booking content scrolls independently, which is suitable for long package and Care Card screens.
- Boarding/Sitting contact fields collapse to one column at <=480 px.
- Admin, CRM, Account and Ops pages include responsive breakpoints, but dense tables still require device testing for horizontal overflow and tap-target size.
- Native safe-area inset handling is incomplete; the prototype removes the device frame at <=480 px but does not consistently apply `env(safe-area-inset-*)` to headers and bottom navigation.
- The date picker, selects, textareas and keyboard-driven form flow require iOS and Android testing for zoom, focus visibility and bottom-navigation overlap.
- Minimum 44 px touch targets, landscape tablets, dynamic text/font scaling and reduced-motion behaviour are not fully verified.
- Visual browser QA could not be completed in this audit session because the internal test preview was blocked before page load. Source, responsive rules, lint and build gates remain available; physical-device and cloud-device screenshots are still required.

## Required regression tests

### Grooming

- Dog, cat, puppy and kitten × every package × 1, 2, 3 and 4 pets.
- Exact price assertions for published single and two-pet rules, Just Trim, puppy/kitten pricing and add-ons.
- Three-, six- and twelve-session display/checkout parity and 4/8/15-month validity.
- Subscription credit reservation, multi-pet credit count, completion consumption, cancellation release and expiry.
- Full/unavailable slot, preferred-groomer available/unavailable, reassignment, 15/30-minute wait and reschedule.
- OTP failure/expiry/retry, online success/failure, pay-after recovery, refund and GST invoice.

### Training

- Every plan, price, session count and validity; category/age eligibility and complimentary-grooming rules.
- Empty goals, aggression/medical review, trainer accept/decline/timeout/cancel, replacement and schedule regeneration.
- Split-payment reminders, session attendance/proof, homework, feedback cadence, pause/expiry, cancellation and prorated refund.

### Boarding and Sitting

- Same-day/invalid dates, one night, long stay, date change and price recalculation.
- 1–4 pets, mixed species, caregiver capacity, resident-pet conflicts, medication and senior-care filters.
- Meet & Greet book/reschedule/skip, taxi only for Boarding, sitter home-access controls, caregiver accept/decline/cancel.
- Care Card updates, missed update escalation, early pickup, incident, replacement, refund and payout release.

### Cross-platform and non-functional

- Create from Customer, Sales and Ops; verify identical ID, price, status, contacts, pet links and audit events in every module.
- Provider status progression, customer cancellation, Ops reassignment, CRM follow-up and Finance reconciliation on the same record.
- Refresh, two tabs, browser restart, offline/retry and idempotent double-submit behaviour.
- Role matrix and city/branch scope; object ownership; masked/revealed fields; audit creation.
- 320, 360, 375, 390, 412, 768 and 1024 px widths; iOS Safari, Android Chrome and common tablets in portrait/landscape.
- Keyboard-only navigation, screen reader names, contrast, text scaling, focus order and 44 px touch targets.
- Performance, error boundaries, rate limits, backup/restore, rollback and observability.

## Required integrations before launch

Integrations must progress through test/sandbox, webhook and failure testing, employee pilot and controlled production approval. None should be connected to live customer data during prototype regression.

1. Identity: customer OTP provider; staff SSO/OTP; provider verified-device OTP/PIN; session and role service.
2. Canonical persistence: approved database schema, migration rehearsal, reconciliation and rollback. MongoDB remains deferred until sample-schema review and regression approval.
3. Payments: Razorpay orders, payment links/QR, webhooks, refunds and GST receipt mapping; RazorpayX only after payout approvals and reconciliation pass.
4. Communications: WhatsApp BSP/Cloud API, SMS, email, push and masked calling with consent, templates, opt-outs, retries and delivery status.
5. Maps and tracking: geocoding, serviceability, route/ETA, geofences and time-bounded provider location.
6. Media: secure upload, malware scanning, size/type rules, signed access, retention and deletion for service proof and Training/Stay videos.
7. Finance: GST invoice/credit note, cash reconciliation, accounting export and bank/payout reconciliation.
8. Support and observability: ticketing, logs, metrics, error/crash reporting, alerting and incident response.
9. Mobile release: native-wrapper decision, Firebase/APNs, privacy disclosures, permissions, store compliance and release controls.

## Recommended closure sequence

1. Freeze the approved catalogue, pricing, validity and multi-pet rules as versioned regression fixtures.
2. Finish cross-surface synthetic booking projection so every list/detail screen reads the shared test ledger.
3. Complete the regression matrix and mobile/device QA with no live integrations.
4. Connect the customer UI to the in-memory/sandbox API and pass idempotency, ownership and role tests.
5. Run a controlled database migration rehearsal with synthetic/sample exports only.
6. Add integrations one at a time in sandbox, with failure and rollback tests.
7. Run employee pilot, invited-customer beta, one-zone Bengaluru pilot and only then wider launch.

