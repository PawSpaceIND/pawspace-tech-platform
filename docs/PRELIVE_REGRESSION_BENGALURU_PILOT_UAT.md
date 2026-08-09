# PawSpace Full Pre-Live Regression + Controlled Bengaluru Pilot UAT Plan

## Status

**Pre-live / controlled-pilot specification only. PRODUCTION READY = FALSE.**

This is the cross-company gate above individual module UAT. A module passing its own tests is necessary but not sufficient: the integrated customer → provider → Operations → CX → Finance → Analytics flow must be proven on one exact release candidate before any public launch decision.

Taxi is outside the active scope of this plan unless explicitly resumed.

## Core rule

No public launch is approved by this document.

The progression is:

1. module exact-head CI green
2. module staff UAT closed with evidence
3. integrated regression candidate built
4. full cross-module regression passed
5. real-device staff rehearsal passed
6. required external integrations sandbox-verified
7. production configuration reviewed
8. bounded controlled Bengaluru pilot
9. pilot exit review
10. separate public-launch approval

Skipping a stage requires an explicit risk decision; the application must never infer launch approval from CI, a PR merge, credential presence or one successful live transaction.

---

# 1. Entry gate for integrated pre-live regression

Before a module enters the integrated regression candidate:

- exact-head CI is green
- its staff UAT checklist is closed with evidence
- canonical identity/ownership rules are proven
- negative-permission tests pass
- idempotency/replay tests pass
- cancellation/reversal/recovery tests pass where applicable
- no static/synthetic fixture is treated as live operating truth
- policy-dependent behaviour is either approved/configured or explicitly disabled / `configuration_required`
- unresolved P0/P1 defects are recorded and assessed

The current UAT Master Gate remains the source of module-level readiness and already states that CI green alone is insufficient and that production readiness additionally requires integration, migration, security/privacy, backup/restore, device and controlled-pilot gates.

## Candidate service scope

The pilot service set is configuration/approval driven. A service may be included only if its own UAT gate is closed.

Initial non-Taxi candidates:
- Grooming
- Sitting
- Boarding
- Training
- Walking only after its own exact-head workflow and UAT gate are closed

Optional business modules may join only after their own gate closes:
- Assisted Orders
- Subscription Wallet
- Coupon Governance
- Referral Management

No pilot dependency may be silently pulled in because another module references it.

---

# 2. Integrated release candidate

Create one dedicated pre-live integration candidate from approved module heads.

Required controls:
- exact commit SHA recorded
- source PR/module versions recorded
- conflict resolutions reviewed
- full repository build/typecheck/tests/lint/artifact validation green on the exact candidate
- database/schema migration plan recorded
- test data reset/seed procedure recorded
- feature flags/environment mode recorded
- production/live-money flags remain disabled until the specific controlled-live stage
- rollback commit/deployment reference prepared

Any code change after certification creates a new candidate and requires re-certification appropriate to its blast radius.

---

# 3. Canonical cross-role regression matrix

Every included service must prove that all roles see the same booking/commercial identity rather than maintaining competing state.

## Customer → Booking

- customer identity resolves correctly
- pet belongs to customer
- quote/package comes from server-owned catalogue/policy
- availability is canonical
- booking/reservation/work order/payment intent share one identity chain
- duplicate submit/retry does not duplicate booking or capacity
- customer cannot access/change another customer's booking
- success screen uses canonical IDs/state

## Booking → Provider

- assigned provider is eligible for service/zone/time
- provider sees only assigned work
- accept/decline/timeout rules are respected
- service-specific prerequisites are enforced
- provider cannot complete another provider's work
- completion evidence gates apply where required

## Provider → Operations

- late/unavailable/no-show/decline/recovery generates one owned case
- replacement is capacity/collision safe
- completed history is preserved during reassignment
- same canonical booking/customer context survives recovery
- no replacement available becomes visible Ops escalation

## Operations → CX

- customer-impacting exception is visible to CX when policy requires it
- CX thread/ticket links to canonical customer + booking + recovery case
- customer updates are not duplicated on replay
- sensitive provider/customer information remains role-safe
- escalation/reopen history is preserved

## CX/Operations → Finance

- cancellation/refund request never silently changes money
- approved refund is bounded by eligible paid amount
- duplicate refund/payment webhook does not double-post
- provider settlement waits for its configured completion/payment prerequisites
- adjustments require reason/audit
- financial period lock is respected

## Finance → Analytics / Revenue

- booked, collected, refunded and net revenue remain separate
- subscription/coupon/referral adjustments are traceable to source
- provider settlement/adjustment is traceable to source
- GST/accounting projection is configuration-aware
- reports/mission dashboards drill to canonical records
- forecast/pipeline is never counted as achieved revenue

---

# 4. Cross-module customer journeys

For each service included in the candidate, run at least these journey classes.

## Happy path

Lead/customer → quote → booking → assignment → provider fulfilment → evidence/completion → payment state → invoice/accounting projection → CX history → analytics/reporting.

## Cancellation path

Customer/staff cancellation request → capacity release → subscription/coupon/referral consequence where configured → refund review/payment reversal → provider settlement adjustment → customer communication → Finance reconciliation.

## Reschedule path

Fresh capacity/quote where required → same canonical booking lineage → provider/work-order update → notifications → pricing/refund/credit policy boundary → audit.

## Provider failure path

Provider decline/timeout/unavailable/no-show → recovery case → replacement or Ops escalation → customer update → completion or reschedule/cancel → Finance consequences.

## Payment failure path

Payment initiation/provider failure → no false paid state → retry/idempotency → webhook reconciliation → unmatched queue when needed → customer/CX visibility.

## Customer support path

Customer issue → canonical conversation/ticket → assignment/SLA/escalation → booking/Finance context → resolution evidence → reopen test.

---

# 5. Commercial adjustment regression

When included and UAT-closed:

## Subscription Wallet
- reserve once
- insufficient-credit rejection
- completion consumes once
- eligible cancellation releases correctly
- no negative wallet

## Coupon Governance
- server eligibility only
- frozen quote/policy snapshot
- booking-bound consumption once
- campaign/customer limit enforcement
- refund/cancellation consequence follows approved policy or remains blocked

## Referral Management
- no self-referral
- qualification from canonical completed/paid event according to approved policy
- reward pending/released/reversed ledger is immutable
- duplicate event is safe
- no live cash payout in ordinary UAT

---

# 6. Identity, RBAC and privacy regression

Run a least-privilege matrix for:

- founder/superuser
- admin/manager
- associate/sales/CX
- Finance
- auditor
- customer
- service provider
- People/Payroll roles when implemented

Required tests:
- anonymous privileged API rejected
- unauthorized permission rejected server-side
- cross-customer ownership denied
- cross-provider ownership denied
- masked contact behaviour
- privileged reveal audited
- user deactivation removes access
- role change takes effect as designed
- founder protection rules
- sensitive Finance/People/GPS/media fields inaccessible to unrelated roles
- export/delete actions independently governed

No pilot begins until privileged identity/MFA/session/access lifecycle is sufficiently proven for the chosen pilot environment.

---

# 7. External integration regression

The Integration Readiness Register is authoritative for integration stage.

For each required pilot-path integration:

- code boundary exists
- sandbox is configured
- sandbox verification evidence exists
- invalid auth/signature tested
- duplicate/replay tested
- timeout/provider failure tested
- rate limit/retry/dead-letter tested where applicable
- reconciliation tested
- monitoring alert proven
- kill switch proven

Before a controlled-live event, production configuration must be separately reviewed.

Credential presence by itself never satisfies this gate.

Typical pilot-path integrations:
- customer payment gateway
- refund/payout rail where exercised
- WhatsApp/SMS/email/push as selected
- Exotel if call tracking is in pilot scope
- Maps/GPS for applicable services
- private object storage/scanning for required evidence
- bank/accounting/statutory adapters only to the level included in the pilot
- identity/MFA
- monitoring/error tracking
- backup/restore

---

# 8. Fault-injection / recovery regression

The integrated candidate must deliberately test failures, not only happy paths.

Inject or simulate:
- duplicate customer submit
- browser/network retry after unknown response
- scheduler conflict/concurrent booking
- provider declines
- provider times out
- provider unavailable/no-show
- replacement shortlist exhausted
- stale/low-accuracy/missing GPS
- Maps API unavailable
- communication provider unavailable
- payment provider returns error
- webhook duplicated
- webhook arrives out of order
- webhook signature invalid
- payment cannot match booking
- refund replay
- object storage upload fails
- scanner returns blocked/failed/pending
- Finance period locked
- report/scheduler job runs twice
- external AI provider unavailable if included
- database/API transient failure where safely testable

Every scenario needs:
- expected customer-facing state
- expected internal owner
- retry/recovery path
- audit trail
- no duplicate money/capacity/credit/reward side effect

---

# 9. Data migration / opening-state rehearsal

Before controlled pilot using real operating identities/data:

- source datasets identified
- field mapping/version recorded
- duplicate strategy recorded
- customer/provider/employee ownership identity mapping rehearsed
- opening subscription/wallet balances reconciled if applicable
- opening provider/Finance balances reconciled if applicable
- invalid/quarantined rows reported rather than silently coerced
- dry run output reviewed
- re-run idempotency verified
- rollback/reset procedure proven

Production migration remains a separate approved run.

---

# 10. Finance / GST / accounting regression

For the candidate's chosen Finance scope:

- bookings/revenue source reconciles to invoicing projection
- collections reconcile to payment provider/sandbox ledger
- refunds reconcile to credit/reversal records
- provider liabilities/settlements reconcile
- expenses/vendor bills are independent from customer revenue
- GST/tax calculation uses approved/configured policy or blocks with `configuration_required`
- journals remain balanced
- period lock prevents retroactive mutation
- accounting/statutory exports are reproducible

No live statutory filing or tax payment is implied by successful UAT.

---

# 11. People / payroll regression when enabled

Before People/Payroll joins pilot operations:

- employee identity links to platform user
- team/manager/cost-centre scope correct
- shift/attendance/leave policies versioned
- corrections preserve audit history
- salary structure versioned
- payroll run idempotent
- maker/checker approval
- no hard-coded statutory/incentive rates
- Revenue productivity facts flow into incentive review without becoming payroll authority directly
- Finance journal integration reconciles

---

# 12. Real-device acceptance

Required device matrix is configuration based on supported platforms, but must include representative physical devices for each actual pilot-facing surface.

Test:
- customer mobile browser/app surface
- provider/partner surface
- staff desktop/laptop
- relevant Android/iOS physical devices
- poor/mobile network behaviour
- permission prompts (location/camera/notifications where applicable)
- safe areas/keyboard/text scaling
- session expiry/login recovery
- back/refresh/double-submit behaviour
- file/media capture/upload
- deep links/notifications where enabled

Record device/OS/browser/app version with every sign-off.

---

# 13. Monitoring, backup and operational readiness

Before controlled pilot:

## Monitoring
- server/API error alerting
- payment/webhook failure alerting
- queue/dead-letter alerting
- communication failure alerting
- scheduler/job failure alerting
- provider/Maps integration health
- authentication anomalies
- data-reconciliation exceptions

## Backup / restore
- backup exists
- restore runbook exists
- actual restore rehearsal completed
- recovery point/time evidence recorded
- object/document recovery included where required

## Support / incident SOP
- incident severity definitions
- named on-duty owner roles
- customer communication authority
- Finance escalation
- provider safety escalation
- security/privacy escalation
- rollback/kill-switch authority
- defect capture and post-incident evidence

---

# 14. Controlled Bengaluru pilot design

The pilot is deliberately bounded.

Required configuration before start:
- Bengaluru pilot zone(s)
- service set
- pilot start/end dates
- customer cohort/eligibility
- provider cohort
- staff/manager coverage
- operating hours
- maximum booking/order/payment exposure
- enabled production integrations
- disabled features
- support contacts
- escalation rota
- stop/kill criteria

Do not hard-code cohort size, revenue exposure or number of days in application logic; these are approval-time pilot parameters.

## Recommended rollout stages

### Stage P0 — Staff-only rehearsal
PawSpace staff use pilot configuration with no public customer exposure and no uncontrolled live money.

### Stage P1 — Invited controlled users
A bounded invited cohort uses selected service(s) in the configured Bengaluru zone, with active Operations/CX/Engineering monitoring.

### Stage P2 — Expanded controlled cohort
Expand only after P1 evidence shows no unresolved critical defects, money/reconciliation defects, safety failures or identity/privacy issues.

Public launch is not Stage P3 of this document; it requires a separate decision.

---

# 15. Pilot no-go / automatic stop conditions

Pause new pilot traffic when any of these occurs until reviewed:

- customer/provider identity or authorization breach
- material privacy/security incident
- unexplained payment/refund duplication or money mismatch
- provider assignment/capacity corruption
- repeated service-safety failure
- unrecoverable canonical data inconsistency
- backup/restore failure affecting recoverability confidence
- critical integration failure without working fallback
- monitoring unavailable for a critical dependency
- unresolved P0 defect

Configurable business stop thresholds may be added, but the platform must not invent them.

---

# 16. Evidence pack

Every integrated regression/pilot run must preserve:

- release candidate SHA
- environment/config versions
- service/pilot scope
- test-case IDs
- customer/provider/employee synthetic or pilot IDs
- booking/order/payment/refund IDs
- assignment/recovery IDs
- wallet/coupon/referral IDs where applicable
- communication/call/provider references
- GPS/route evidence references where applicable
- invoice/journal/reconciliation references
- audit-event IDs
- screenshots/video only where useful and privacy-safe
- device/OS/browser versions
- defect IDs
- sign-off actor/timestamp

Evidence must be referenced, not embedded as uncontrolled sensitive data in public issue text.

---

# 17. Exit criteria: integrated regression closed

The integrated regression gate can be labelled **REGRESSION CLOSED / READY FOR CONTROLLED PILOT REVIEW** only when:

- exact release-candidate CI is green
- all included module UAT gates are closed
- all required cross-role journeys pass
- no unresolved P0 defect
- P1 defects have explicit accepted disposition
- permission/ownership matrix passes
- replay/idempotency/fault-injection passes
- Finance reconciliation passes for the test period
- migration rehearsal passes for included data
- real-device acceptance passes
- required integrations are at least sandbox-verified
- monitoring/alerting is proven
- backup restore rehearsal is proven
- operational/support runbooks are reviewed
- evidence pack is complete

This status is **not production ready**.

---

# 18. Exit criteria: controlled pilot complete

A separate leadership review may consider public-launch readiness only after the controlled pilot demonstrates:

- no unresolved critical safety/security/privacy issue
- no unexplained financial reconciliation variance
- canonical booking/provider/customer truth remained consistent
- recovery/escalation workflow operated successfully
- production integrations used in pilot reconciled successfully
- support/incident operations were workable
- monitoring and backups remained healthy
- device experience was acceptable
- all material defects have owner/disposition
- Finance, Operations, CX, Product/Engineering and Security/Privacy sign-offs are recorded as applicable

Public launch approval still remains a separate explicit action.