# PawSpace Revenue Mission Control + Lead Assignment UAT Specification

## Status

**Implementation/UAT specification only. PRODUCTION READY = FALSE.**

The initial business objective is a **₹2,00,000 revenue mission target**, but the target period is intentionally configuration-required. The system must support an explicit start/end period or configured cadence and must not assume that ₹2 lakh is daily, weekly or monthly.

## Current repo truth

The existing Revenue CRM already has useful UAT concepts:

- revenue opportunity records
- lead work items and lead attempts
- owners/managers
- first-action SLA fields
- lead recycling/reopening
- communication delivery records
- CX escalation on SLA breach
- daily performance rows
- command reports
- audit events

However, the current UAT engine also contains hard-coded employee names, hard-coded opportunity values, a synthetic daily-100 generator, fixed SLA assumptions and a provisional incentive formula. Those must remain test scaffolds only and must not become canonical operating or payroll truth.

## Design principles

1. **Canonical commercial truth.** Revenue credited to the mission must derive from canonical bookings/orders, payments/collections, refunds and approved subscription/service events.
2. **Target is explicit and versioned.** Amount, currency, period, scope and attribution basis are configured and approved.
3. **Booked, collected and net revenue are separate.** The dashboard must never collapse them into one number.
4. **Refund-adjusted truth.** Refunds and reversals reduce eligible net revenue according to configured reporting policy; they are never hidden.
5. **No fabricated opportunities.** Opportunity value must be derived from real catalogue/quote/customer history or marked estimated with source/confidence.
6. **Assignment is governed, not round-robin-by-name in code.** Rules use employee/team/shift/zone/service/language/workload/continuity and configured fallback.
7. **Productivity is outcome-based.** Measure useful customer/business outcomes, not invasive surveillance.
8. **No incentive authority.** Revenue Mission Control may produce performance facts; final incentive computation belongs to the versioned People/Payroll incentive engine.
9. **Consent and CX suppression.** Marketing/outbound work respects consent, opt-out, complaint/safety/payment/refund suppression rules.
10. **Human ownership.** Every actionable lead/opportunity has an accountable current owner and next action.

## Canonical objects

### `revenue_missions`
- mission ID
- name
- target amount
- currency
- period start
- period end
- scope: company / city / team / service
- revenue basis: booked / collected / net collected / configured mix
- status: draft / active_uat / closed
- approval reference
- created/updated audit fields

### `revenue_mission_events`
Immutable source-derived facts:
- event ID
- mission ID
- customer ID
- lead ID optional
- booking/order/subscription ID
- payment/refund ID optional
- service
- event type: booked / collected / refunded / reversed / cancelled / credited adjustment
- gross amount
- refund amount
- eligible amount
- source timestamp
- source version/reference
- attribution owner/team snapshot
- created at

A unique source-event key prevents duplicate crediting.

### `lead_assignment_policies`
Versioned rules:
- service coverage
- city/zone
- working hours/shift
- language capability
- team/role
- max active workload
- continuity preference for prior owner
- priority tiers
- fallback queue
- effective dates
- approval state

### `lead_assignments`
- lead ID
- owner employee/user ID
- team
- policy version
- assignment reason
- assigned at
- accepted/acknowledged at
- first-action due at
- next action due at
- reassignment history

### `lead_actions`
- lead/customer/booking reference
- channel
- action type
- outcome
- customer response
- note/evidence
- next action
- actor
- timestamp
- provider delivery/call reference when available

### `revenue_opportunity_snapshots`
- customer ID
- opportunity type
- canonical signals
- recommended service/action
- estimated value
- estimate source
- confidence
- suppression state/reason
- generated at
- model/rule version

Opportunity snapshots do not create revenue credit by themselves.

### `sales_productivity_facts`
Source-derived facts by employee/team/period:
- leads assigned
- leads acted within SLA
- meaningful contacts
- qualified leads
- quotes created
- bookings converted
- collected revenue attributable under policy
- refunds/reversals
- renewal conversions
- cross-sell conversions
- assisted-order conversions
- customer opt-outs/complaints associated with outreach
- CX escalations
- data-quality exceptions

No mouse/keyboard/activity surveillance metrics are required.

## Mission dashboard

The ₹2 lakh mission view must show at minimum:

- target amount
- configured period
- elapsed time / remaining time
- booked revenue
- collected revenue
- refunds
- net collected revenue
- percentage to target using the configured basis
- gap to target
- pipeline weighted/unweighted separately from achieved revenue
- today/period conversion counts
- renewal revenue
- repeat revenue
- cross-sell revenue
- new-customer revenue
- assisted-order revenue
- service mix
- city/team/owner breakdown
- overdue leads
- SLA breaches
- unassigned leads
- blocked/suppressed opportunities
- reconciliation/data-quality warnings

Forecast may be displayed only as a forecast, never as achieved revenue.

## Lead lifecycle

Recommended canonical states:

`new -> assigned -> attempted -> connected -> qualified -> quoted -> booked -> won`

Alternate terminal/recycle states:

`not_interested`, `invalid`, `duplicate`, `opted_out`, `unreachable`, `cold`, `recycled`, `lost`, `suppressed`.

Every transition stores actor, reason, timestamp and next action where applicable.

## Lead assignment rules

Assignment should evaluate, in order defined by versioned policy:

- customer/lead ownership continuity
- service skill/coverage
- city/zone
- employee active status
- shift/availability
- language where relevant
- current workload
- priority/tier
- manager/team boundary
- fallback pool

The system must not assign work to inactive/off-shift employees unless an explicitly configured override exists.

Reassignment requires a reason and preserves history.

## SLA governance

SLA values are configuration, not constants.

Support:
- first response SLA
- follow-up SLA
- quote follow-up SLA
- high-intent/priority SLA
- manager escalation threshold
- reassignment threshold

SLA clocks may use configured business-hours/calendar logic. The system must display whether the clock is running, paused or breached and why.

## Existing-customer revenue plays

Canonical opportunity types may include:

- subscription renewal
- service repeat-due
- cross-sell
- dormant/win-back
- abandoned booking/quote
- payment due
- incomplete assisted order
- seasonal/occasion-based opportunity only when policy/data supports it

Each requires source signals and suppression checks.

## New-customer funnel

Track source -> lead -> first action -> qualified -> quote -> booking -> collection.

Source attribution must retain original source and may also retain latest/assisted source without overwriting history.

## Suppression and safety

An opportunity/action must be suppressed or require review when configured signals include:

- marketing consent absent/withdrawn
- opt-out
- unresolved complaint/safety case
- unresolved refund/payment dispute
- duplicate/customer identity review
- invalid contact data
- frequency cap reached
- quiet-hours restriction
- fraud/risk hold where applicable

Suppression reason is visible to staff and audited.

## Productivity model

### Individual view
- owned lead queue
- overdue actions
- SLA adherence
- contact/qualification/conversion counts
- booked/collected/net-attributed revenue
- renewals / cross-sells
- refund-adjusted outcomes
- customer-quality/CX guardrails

### Manager view
- team queue and load balance
- unassigned/overdue leads
- conversion funnel
- target contribution
- workload imbalance
- SLA breaches
- coaching/review cases
- suppression/data-quality issues

### Founder/leadership view
- mission progress
- service/channel/team contribution
- pipeline quality
- cash/collection truth
- refunds and leakage
- top blockers
- data/integration health

Leaderboard ranking must be optional/configurable and cannot be used as payroll/incentive authority without the People/Payroll policy engine.

## UAT Gate 1 — Mission configuration

- [ ] Create ₹2,00,000 UAT mission with explicit period start/end.
- [ ] Missing period is rejected.
- [ ] Mission basis is explicitly selected.
- [ ] Unauthorized user cannot activate/change mission.
- [ ] Mission changes are versioned/audited.
- [ ] Closing a mission freezes its target/config snapshot.

## UAT Gate 2 — Revenue truth

- [ ] Canonical booking creates one booked event where policy permits.
- [ ] Canonical payment creates one collected event.
- [ ] Duplicate webhook/event does not double-credit mission.
- [ ] Refund creates explicit negative/refund event.
- [ ] Partial refund adjusts only eligible portion.
- [ ] Cancelled/unpaid booking does not appear as collected revenue.
- [ ] Booked, collected, refund and net totals reconcile to source records.
- [ ] Manual adjustment requires Finance/authorized reason + audit.

## UAT Gate 3 — Lead assignment

- [ ] New lead is assigned using active policy.
- [ ] Inactive employee is excluded.
- [ ] Off-shift employee is excluded when policy requires shift availability.
- [ ] Workload cap is respected.
- [ ] Prior-owner continuity works when configured.
- [ ] No eligible owner sends lead to visible fallback/unassigned queue.
- [ ] Reassignment preserves full history/reason.
- [ ] Duplicate lead does not generate duplicate active work items.

## UAT Gate 4 — SLA / next action

- [ ] First-action due time derives from policy.
- [ ] Action stops/updates first-response SLA correctly.
- [ ] Breach creates manager-visible escalation.
- [ ] Duplicate SLA runner is idempotent.
- [ ] Business-hour pause works if configured.
- [ ] Next action is required for configured non-terminal outcomes.
- [ ] Reopened/recycled lead receives new policy-derived SLA, not a hard-coded constant.

## UAT Gate 5 — Opportunity governance

- [ ] Opportunity derives from canonical customer history/signals.
- [ ] Estimated value has source and confidence.
- [ ] No synthetic customer/opportunity enters live operational truth.
- [ ] Consent/CX/refund/dispute suppression works.
- [ ] Same signal snapshot does not create uncontrolled duplicates.
- [ ] Booking conversion links opportunity -> lead -> booking.

## UAT Gate 6 — Productivity

- [ ] Employee performance is derived from source actions/bookings/payments.
- [ ] Refunds reduce net-attributed outcome according to configured policy.
- [ ] Employee name is resolved from People/user identity, not hard-coded arrays.
- [ ] Manager sees only authorized team scope.
- [ ] Employee cannot manipulate own revenue/performance facts.
- [ ] Ranking and incentive fields are not treated as payroll authority.
- [ ] Every metric can drill to supporting source records.

## UAT Gate 7 — Mission Command Center

- [ ] ₹2 lakh target + period visible.
- [ ] Achieved revenue uses configured basis only.
- [ ] Pipeline is visually separated from achieved revenue.
- [ ] Gap-to-target recalculates after collection/refund.
- [ ] Team/owner/service/channel breakdown totals reconcile.
- [ ] Unassigned/overdue/SLA breach queue is actionable.
- [ ] Data-quality/reconciliation warnings prevent misleading green status.

## UAT Gate 8 — Reporting

- [ ] Daily/weekly/monthly reports use configured mission period rather than inventing target cadence.
- [ ] Report run is idempotent.
- [ ] Snapshot records metric-definition/config version.
- [ ] Failed delivery does not change metric truth.
- [ ] Leadership report separates booked, collected, refund, net and pipeline.

## Permissions to add/refine

Recommended:
- `revenue.view`
- `revenue.manage_mission`
- `leads.view`
- `leads.manage_assigned`
- `leads.reassign`
- `sales.performance.view_self`
- `sales.performance.view_team`
- `sales.performance.view_company`

Managers may manage their authorized team; Finance validates collection/refund truth; People/Payroll owns incentive authority.

## Explicitly not production-complete

- production CRM communication providers
- final lead-assignment/SLA policy approval
- final mission period/cadence beyond the explicit configured test period
- final attribution policy
- approved incentive plan
- production identity/People directory linkage
- live telephony/WhatsApp/SMS delivery evidence
- production analytics/marketing source attribution
- controlled staff UAT and real operating data rehearsal

Passing this specification means **Revenue Mission Control ready for controlled staff UAT**, not production launch approval.