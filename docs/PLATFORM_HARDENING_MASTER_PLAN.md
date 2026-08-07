# PawSpace Pre-Integration Platform Hardening Master Plan

## Objective
Make every PawSpace core service and operating module internally complete, permission-safe, canonical-data-backed and regression-tested **before** connecting live leads, live customers, live partners/vendors or production credentials.

The standard is not “screen exists”. A module is closed only when its data ownership, state transitions, permissions, audit trail, failure/retry behavior, finance effect, analytics effect and cross-module projections are proven.

> We can drive defect risk down with explicit invariants, automated regression and staged UAT, but no engineering process can honestly guarantee that software has zero defects. The release gate is therefore evidence-based: no known P0/P1 gaps, all defined invariants pass, and all critical workflows have automated + human UAT evidence.

## Locked architecture
Four front doors, one platform, one identity/RBAC system, one canonical database/event model:

1. `pawspace.in` — customer
2. `partners.pawspace.in` — groomers, trainers, sitters, hosts and other delivery partners
3. `team.pawspace.in` — Sales, CX, Operations, Finance, HR, Marketing
4. `control.pawspace.in` — founder/super-admin governance

No new standalone command centres unless they are temporary developer/UAT tools.

## Closure order

### P0 — Service engines
Close each vertical end to end before strengthening shared commercial modules.

1. **Grooming**
   - canonical booking and work order
   - server-side catalogue/pricing validation
   - real ownership/RBAC boundaries
   - provider lifecycle and service proof
   - cancellation/reschedule/refund rules
   - subscription reserve/consume/reverse/expiry semantics
   - invoice/tax readiness
   - provider earnings/payout readiness
   - secure media abstraction
   - customer/partner/ops/finance projections
   - failure, retry and idempotency tests

2. **Training**
   - programme/session package model
   - meet-and-greet path
   - multi-session calendar and trainer ownership
   - per-pet duration/travel rules
   - attendance, homework/video/evidence and outcomes
   - reschedule/cancel/no-show/session-consumption rules
   - invoice/payment/trainer payout readiness
   - canonical customer/partner/ops/finance projections

3. **Boarding**
   - stay aggregate, check-in/out and per-night capacity
   - host-home profile/eligibility/capacity
   - trial/meet rules, long-stay payment schedule
   - pet requirements, feeding/medication/emergency instructions
   - daily proof/update cadence
   - cancellation/refund/date-change rules
   - host settlement/autopay readiness
   - canonical customer/partner/ops/finance projections

4. **Pet Sitting**
   - visit/overnight aggregate and sitter capacity/travel
   - meet-and-greet, access/key instructions and emergency protocol
   - visit proof, GPS-ready timestamps, care checklist
   - cancellation/reschedule/replacement/no-show handling
   - sitter settlement/autopay readiness
   - canonical customer/partner/ops/finance projections

### P1 — CRM, Revenue and Customer Intelligence
5. **Customer 360 / CRM**
   - one customer household and pet history
   - consent and contact policy
   - leads, enquiries, bookings, tickets, refunds, subscriptions and communications linked
   - owner/SLA/RNR state machine
   - duplicate/merge/data-quality controls

6. **Maximum Revenue / Existing Customer Intelligence**
   - one governed “Maximum Revenue” work queue
   - rank existing customers by next-best action using actual signals: recency, frequency, monetary value, contribution margin, service gaps, subscription state, unused credits, pet age/profile, cancellation/refund risk, contactability and consent
   - expected incremental revenue + expected margin + confidence + reason
   - suppression: opt-out, recent complaint, unresolved refund, contact fatigue, duplicate offer, unsafe/ineligible service
   - human approval/override and measurable conversion attribution

7. **CRM automation**
   - lead SLA and escalation
   - 30/60/90-day reopening with limits
   - repeat-service reminders
   - renewal, unused-credit, payment recovery and service-recovery journeys
   - retry/dead-letter, quiet hours, frequency caps, consent and audit

### P1 — Communication, AI and automation platform
8. **Unified conversation model**
   - customer conversation/thread, participants, channel, messages, attachments, delivery/read state, consent and linked customer/lead/booking/ticket
   - provider conversations separated from customer PII
   - agent assignment, SLA, handoff and audit

9. **AI assistant/intelligence layer**
   - summarization and next-best-action suggestions only from authorized canonical records
   - no autonomous refunds, price changes, payments, payouts or sensitive customer outreach without policy approval
   - prompt/output audit, confidence, human approval and rollback
   - evaluation suite for hallucination, PII leakage, bad recommendations and unsafe automation

10. **Communication integrations — sandbox first**
   - WhatsApp provider adapter
   - SMS adapter
   - email/push adapters
   - **LimeChat adapter readiness** for chat/conversation sync
   - telephony adapter + **autodialer readiness**
   - Exotel/masked calling where selected
   - provider-independent outbox, webhook inbox, idempotency, retries, dead-letter and reconciliation

### P1 — Partner finance
11. **Partner earnings and autopayment readiness**
   - groomer, trainer, sitter and host earnings rules
   - completion/quality/refund holds
   - incentive/deduction adjustments
   - settlement statement
   - payout approval and idempotent payout instruction
   - failed/reversed payout recovery
   - sandbox payout adapter first; no production payout credentials until sign-off

### P2 — Marketing intelligence
12. **Marketing command centre**
   - canonical segments and consent
   - campaign definition, audience snapshot and holdout/control
   - attribution from source -> lead -> booking -> collection -> contribution margin
   - CAC, ROAS, LTV:CAC, payback, incrementality and channel saturation
   - suppression/frequency caps
   - AI-assisted copy/audience ideas require human approval

### P2 — Business analytics
13. **Company analytics / metric layer**
   Build all dashboards from canonical facts rather than static UI arrays.
   - bookings and funnel
   - GMV/revenue/collections/refunds
   - direct cost/contribution margin
   - provider utilisation/productivity/quality
   - service completion/SLA/cancellation/no-show
   - subscriptions: sales, utilisation, breakage, expiry, renewal
   - customer: new/repeat/reactivation/churn/LTV/cohorts
   - CRM: lead response, RNR, conversion, sales productivity
   - marketing: spend, CAC, ROAS, incrementality
   - CX: tickets, FRT, resolution, reopen, CSAT/NPS when connected
   - finance: reconciliation, payout liability, aging, tax/invoice readiness
   - data quality, security and integration health
   - city/zone/service/package/provider/channel drill-down

### P0 before any live data/integration
14. **Pre-live regression and migration rehearsal**
   - synthetic customers/leads/providers only
   - deterministic end-to-end service tests
   - permission-negative tests for every privileged action
   - idempotency/retry/concurrency tests
   - webhook replay/signature tests
   - outage/degraded-provider tests
   - refund/payout reversal tests
   - data import dry run with sample exports
   - backup/restore rehearsal
   - mobile/device/browser UAT
   - security/privacy review
   - employee pilot

## Definition of Done for every module
A module is not closed until all apply:

- canonical source of truth identified
- no fixture/static operational counters presented as live facts
- explicit state machine with allowed/forbidden transitions
- server-side validation for prices, eligibility and ownership
- least-privilege RBAC
- customer/provider ownership boundaries where applicable
- immutable/auditable event trail
- idempotent writes and webhook handling
- retry + dead-letter for async work
- cancellation/refund/reversal behavior defined
- finance/settlement impact defined
- analytics events/facts defined
- consent/PII boundaries defined
- empty/error/degraded states implemented
- automated positive + negative tests
- cross-role projection test
- no live credential required to pass UAT

## Current priority
**Grooming hardening Gate 1: security and ownership.**

1. Explicit API gateway permission mapping for Grooming lifecycle/change/finance/partner jobs.
2. Provider lifecycle actions must prove the authenticated provider owns the work order; staff override must require a stronger permission and audit reason.
3. Finance-only payment reconciliation.
4. Customer booking changes must prove customer identity/ownership through a trusted identity mapping, not only a body field.
5. Negative regression tests for anonymous, wrong-role and wrong-provider actions.

Only after Gate 1 is green do we move to Grooming Gate 2: governed catalogue/pricing + subscription master + secure proof/media + payout/tax readiness.
