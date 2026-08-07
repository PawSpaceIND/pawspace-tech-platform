# PawSpace Grooming Integration Closure

## Goal
Close one real Grooming transaction end-to-end using a single canonical booking record:

Customer -> Pet -> Package -> Slot -> Booking -> Payment -> Assignment -> Provider -> Service Proof -> Completion -> Invoice -> Finance -> Repeat/Subscription

## Source recovery status
The latest deployed prototype source has now been recovered and independently checksum-verified.

- Source archive: `pawspace-tech-platform-current-source.zip`
- Deployed Site version: `67`
- Source commit provenance: `21cdff1509e7939b31dad760d24a2d6317504d01`
- SHA-256: `913876bed301e3ed03da656071219f1ab0b28c0b69b7a7056802177197fafcd1`
- Export date: 7 Aug 2026
- Customer, Partner, Team and Control experiences included
- Frontend, hosted API routes, standalone backend, D1/Drizzle migrations, RBAC/security helpers, tests, assets, mobile source and deployment configuration included
- Secrets excluded; `.env.example` files included
- Export README included

The source export README records 27/27 web tests and 28/28 backend tests passing at export time, plus lint/type-check success. The deployed Site was not modified by the export.

## Four-front-door architecture — locked
Do not create new standalone command centres. Preserve four unified experiences backed by one authentication system, one canonical database/event model and shared APIs:

1. `pawspace.in` — Customer experience
2. `partners.pawspace.in` — Partner/provider experience
3. `team.pawspace.in` — Employee Team OS
4. `control.pawspace.in` — Founder/super-admin governance

Existing CRM, Booking Command Center, CX, Operations, Finance, HR, Marketing, integrations, security and reporting modules should remain routes/modules inside the correct Team or Control shell. Legacy URLs may remain temporarily for UAT redirects.

## Current verified state
- Grooming is the lead launch vertical and the UI journey is substantially complete.
- Customer, Provider, CRM/Admin/Ops/Finance surfaces currently include a synchronized synthetic transaction path, but some projections remain browser-local or fixture-driven.
- Hosted D1/API routes and the standalone Fastify backend both exist; production needs one canonical persistence/cutover contract.
- OTP, Razorpay/refunds, WhatsApp/SMS, Exotel, Maps/GPS, media storage, payouts, notifications and scheduled automation still require controlled production integration.
- Real-device QA, role/ownership enforcement and production security hardening remain launch gates.

## Closure sequence
1. Import the recovered current source into this repository branch without redesigning or simplifying it.
2. Freeze Grooming catalogue, pricing, validity, add-ons and multi-pet rules as versioned fixtures.
3. Choose and enforce one canonical booking aggregate/event stream across Customer, Partner, Team and Control.
4. Connect customer booking confirmation to the canonical booking API with idempotency.
5. Persist customer, pet, booking, slot, payment and subscription state server-side.
6. Make Team/Ops/CRM/Finance and Partner views project the same booking/event record.
7. Complete provider availability, assignment, acceptance/decline, rerouting, travel, arrival, service start and completion.
8. Require before/after proof, checklist and completion notes before closure.
9. Complete online/cash payment state, refund/reconciliation and GST invoice state.
10. Complete subscription reservation, consumption, reversal, expiry and repeat-booking triggers.
11. Complete RBAC/ownership checks, audit trail and sensitive-data masking/reveal controls.
12. Add external integrations one at a time in sandbox: Razorpay, OTP/WhatsApp/SMS, Exotel, Maps/GPS, media storage, notifications and payouts.
13. Pass cross-role regression, real-device UAT, employee pilot and one-zone Bengaluru pilot before production launch.

## Immediate next milestone
Import Site v67 source into this branch, then trace one Grooming test booking end-to-end and remove every browser-local/fixture handoff in that path.

## Rule
Do not connect live customer data or live payment/communication integrations until the shared API-backed transaction passes synthetic regression, idempotency, role/ownership and reconciliation tests.
