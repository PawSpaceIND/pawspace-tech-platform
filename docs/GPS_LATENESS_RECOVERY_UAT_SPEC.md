# PawSpace Universal GPS, ETA, Lateness, Recovery & Penalty Governance UAT Specification

## Status

**Implementation/UAT specification only. PRODUCTION READY = FALSE.**

This specification turns provider location and route evidence into a governed operational recovery system. It does **not** define any production financial penalty amount, grace period, deduction formula, compensation amount or provider-liability rule.

Those commercial/HR/partner-policy values are configuration-required and need explicit PawSpace approval before production use.

Taxi remains outside the active scope of this workstream.

## Current repo truth

PawSpace already has useful foundations for Grooming:

- booking-bound provider GPS capture
- provider ownership checks
- GPS capture restricted to active travel states
- location accuracy and captured-at timestamps
- Google Routes sandbox adapter
- traffic-aware duration/distance snapshots
- route history
- provider assignment offers
- timeout / unavailable / no-show recovery
- replacement-provider selection
- customer recovery notifications
- provider performance events

The existing implementation is service-specific in places and contains UAT defaults/impact scores. Provider performance impact scores are operational signals only and must not become money deductions or payroll/settlement truth.

## Operating principles

1. **Customer recovery comes before blame.** Lateness detection first protects the booking/customer; financial or performance consequences are a later governed decision.
2. **Evidence, not assumption.** A provider is not marked late solely because GPS is missing or a map provider fails.
3. **No automatic financial penalty.** The system may create a `penalty_candidate`; an authorized reviewer decides applicability under an approved policy.
4. **Location minimisation.** GPS is booking/session scoped and collected only when required for an active operational purpose.
5. **Server-owned timestamps.** Client-reported capture time may be stored as evidence, but server receive time and provenance are also preserved.
6. **Stale/unreliable GPS is explicit.** Low-accuracy, stale, spoof-risk or unavailable data cannot silently become trusted ETA evidence.
7. **ETA is a forecast.** Route-provider duration is not a guarantee and must carry timestamp/provider/status.
8. **Service applicability is configured.** Grooming, Training, Sitting or future on-site services can enable route tracking independently. Do not force GPS onto services where it is unnecessary.
9. **Replacement is capacity-safe.** Recovery uses canonical provider skill/zone/availability/collision controls.
10. **All decisions are reversible/auditable.** Disputes, exemptions and reversals preserve the original event history.

## Canonical data model

### `provider_location_sessions`
- session ID
- booking ID
- provider ID
- service code
- tracking purpose
- status: pending / active / ended / suspended
- consent/policy reference where required
- starts at / ends at
- created by / created at

### `provider_location_events`
Extend/unify existing location evidence:
- event ID
- session ID
- booking ID
- provider ID
- latitude / longitude
- accuracy metres
- provider/device source
- client captured at
- server received at
- trust state: accepted / stale / low_accuracy / unverified / rejected
- rejection/review reason

### `route_eta_snapshots`
- snapshot ID
- booking ID
- provider ID
- origin location event
- destination/service location snapshot
- map provider
- route provider status
- distance
- duration
- predicted arrival time
- traffic/routing mode
- calculated at
- expires/stale after
- provider request/reference if available

### `booking_punctuality_policies`
Versioned/configured policy:
- service / city / provider model scope
- when tracking should begin
- ETA freshness threshold
- allowed accuracy threshold
- grace rule
- customer alert threshold
- Ops escalation threshold
- recovery/reassignment threshold
- evidence requirements
- excluded/exempt reason catalogue
- effective dates
- approval state

No production values are hard-coded.

### `booking_punctuality_events`
Immutable events:
- booking ID
- provider ID
- type: tracking_started / eta_updated / predicted_late / customer_alerted / provider_contacted / ops_escalated / arrived / actual_late / recovered / no_show / evidence_insufficient
- scheduled time snapshot
- ETA snapshot ID
- lateness minutes if determinable
- policy version
- reason/evidence
- created at

### `provider_recovery_cases`
Unify with existing recovery case model:
- case ID
- booking ID
- failed/current provider
- reason: predicted_late / actual_late / unavailable / no_show / provider_decline / route_failure / other
- recovery state
- replacement provider
- customer impact state
- compensation-review state
- opened/resolved timestamps
- owner

### `provider_accountability_cases`
Separate operational recovery from consequences:
- accountability ID
- booking ID
- provider ID
- punctuality/recovery event IDs
- policy version
- evidence completeness
- candidate type: coaching / quality_review / penalty_candidate / no_action
- proposed consequence reference (not amount unless approved policy supplies it)
- review status: pending / approved / rejected / exempted / disputed / reversed
- reviewer
- reason
- dispute evidence
- approved consequence ID
- created/updated timestamps

### `provider_financial_adjustments`
Only created after authorized approval under an approved policy:
- adjustment ID
- provider ID
- booking ID
- accountability case ID
- policy version
- amount/type
- settlement period
- state: approved / posted / reversed
- Finance approval/audit

This table is downstream of accountability review, never directly from GPS/ETA code.

## ETA / lateness state machine

Suggested operational state progression:

`scheduled -> tracking_expected -> on_the_way -> eta_normal -> predicted_late -> recovery_active -> arrived`

Exceptional paths:

- `gps_unavailable`
- `route_unavailable`
- `provider_unresponsive`
- `replacement_required`
- `no_show`
- `customer_reschedule`
- `customer_cancelled`

Missing GPS must not automatically equal `no_show` or `late`.

## Detection workflow

1. Booking approaches configured tracking window.
2. System confirms provider assignment and service applicability.
3. Provider starts travel/tracking session.
4. GPS point is validated for ownership, freshness and accuracy.
5. Route provider returns ETA snapshot, or explicit degraded status.
6. Server compares predicted arrival against scheduled time + configured policy.
7. If threshold is crossed, create `predicted_late` event idempotently.
8. Trigger configured customer/Ops workflow.
9. Continue refreshing ETA using bounded frequency/cost policy.
10. On arrival, store arrival evidence and calculate actual punctuality if evidence is sufficient.

## Customer communication

Messages must distinguish forecast from confirmed fact.

Examples of states, not final message copy:
- provider on the way
- possible delay detected
- revised ETA available
- Operations is checking
- replacement selected
- provider arrived
- service needs reschedule/recovery

Do not expose continuous raw provider GPS to customers unless explicitly approved; customer experience may instead receive bounded ETA/location-state views.

## Recovery policy

When a provider is predicted or confirmed late, configured actions may include:

- provider reminder/contact
- Ops task
- customer proactive update
- alternate provider search
- reserve replacement
- reassign provider
- reschedule
- service recovery/compensation review

Replacement candidates must re-run skill, city/zone, availability, travel buffer, collision, capacity and provider-state validation at decision time.

## Penalty / accountability governance

The system must never implement `late by X => deduct ₹Y` as an unreviewed code rule.

A `penalty_candidate` may be generated only when:

- relevant policy is approved/effective
- evidence meets required quality
- booking/customer/provider identities are canonical
- excluded/exempt reasons have been evaluated
- operational recovery case is recorded

Potential exemption/review categories should be configurable, such as:
- customer-caused schedule/address change
- PawSpace reassignment/dispatch error
- prior service overrun not attributable under policy
- severe traffic/weather/road disruption if policy allows
- map/GPS/provider outage
- safety/medical emergency
- incorrect booking/service location
- approved Ops exception

The exact list and effect are management-policy decisions.

Provider must have a dispute/review route when the approved policy requires one. Reversals create new audit/financial-adjustment events rather than deleting history.

## UAT Gate 1 — Universal location session

- [ ] Tracking is booking/provider scoped.
- [ ] Wrong provider cannot post location for another provider's booking.
- [ ] Tracking outside allowed booking state is rejected.
- [ ] Invalid coordinates are rejected.
- [ ] Server received time is stored independently of client capture time.
- [ ] Stale/low-accuracy evidence is explicitly classified.
- [ ] Session ends after configured operational window.
- [ ] Unauthorized staff/customer cannot retrieve raw provider location.

## UAT Gate 2 — ETA snapshots

- [ ] Valid GPS + configured map provider produces timestamped ETA snapshot.
- [ ] Map credentials missing => `configuration_required`, not fabricated ETA.
- [ ] Provider/API failure => degraded state.
- [ ] Old ETA becomes stale.
- [ ] ETA snapshot references the exact origin/location evidence.
- [ ] Duplicate equivalent calculation does not generate uncontrolled operational alerts.
- [ ] Route result is clearly forecast, not guaranteed arrival.

## UAT Gate 3 — Predicted lateness

- [ ] Threshold comes from versioned policy.
- [ ] No approved policy => no financial/accountability consequence.
- [ ] Crossing threshold creates one predicted-late event.
- [ ] Subsequent ETA recovery updates state rather than duplicating alerts.
- [ ] Missing/untrusted GPS does not falsely classify actual lateness.
- [ ] Scheduled-time change invalidates/recalculates appropriate prior forecast.

## UAT Gate 4 — Customer + Ops recovery

- [ ] Customer alert uses configured threshold and approved channel path.
- [ ] Ops case links booking/provider/ETA evidence.
- [ ] Duplicate runner does not duplicate customer notifications.
- [ ] Provider contact result is stored.
- [ ] Escalation owner is visible.
- [ ] Recovery state is projected consistently to booking command center/CX.

## UAT Gate 5 — Replacement assignment

- [ ] Replacement excludes failed/current provider.
- [ ] Candidate is still active and eligible at assignment time.
- [ ] Zone/service/availability/collision/capacity checks pass.
- [ ] Commission provider acceptance workflow remains enforced.
- [ ] No candidate => explicit Ops escalation, not fake assignment.
- [ ] Customer retains same canonical booking identity where appropriate.
- [ ] Reassignment history is complete and auditable.

## UAT Gate 6 — Arrival / actual punctuality

- [ ] Arrival can use approved evidence source(s).
- [ ] Actual lateness calculation uses policy/scheduled snapshot.
- [ ] Insufficient evidence results in `evidence_insufficient`, not automatic guilt.
- [ ] Rescheduled booking uses correct updated schedule/version.
- [ ] Customer/service-start evidence can be cross-referenced where available.

## UAT Gate 7 — Accountability / penalty candidate

- [ ] GPS/ETA event alone cannot create financial deduction.
- [ ] Hard-coded provider performance impact score cannot create settlement adjustment.
- [ ] Candidate requires approved policy version.
- [ ] Exemption/review reasons are evaluated.
- [ ] Reviewer identity/reason is mandatory.
- [ ] Rejected/exempted candidate creates no financial adjustment.
- [ ] Approved consequence creates one downstream adjustment idempotently.
- [ ] Dispute/reversal preserves original record and creates reversal history.

## UAT Gate 8 — Partner Finance integration

- [ ] Approved provider financial adjustment references accountability case + booking.
- [ ] Same case cannot be deducted twice.
- [ ] Adjustment appears in provider statement transparently.
- [ ] Reversal restores settlement through a new ledger event.
- [ ] Locked Finance/settlement period behavior is explicit.
- [ ] No real payout deduction occurs in ordinary UAT.

## UAT Gate 9 — Privacy / retention / observability

- [ ] Location access is least privilege.
- [ ] Raw GPS retention period is configured.
- [ ] Customer-facing views do not expose more location detail than approved.
- [ ] Provider location/API errors are monitored.
- [ ] Map provider rate limits/cost are observable.
- [ ] Location ingestion anomalies/spoof-risk signals can be reviewed.
- [ ] Kill switch can disable live GPS/map adapter without corrupting bookings.

## Metrics

Operational metrics may include:
- bookings with expected tracking
- tracking-start compliance
- ETA coverage
- predicted-late count
- actual-late count where evidence sufficient
- customer proactively notified
- recovered without reassignment
- reassigned successfully
- no-show count
- average recovery time
- GPS/map degraded rate
- accountability cases approved/rejected/exempted/disputed

Do not use raw GPS volume or constant tracking as an employee/provider productivity metric.

## Production blockers intentionally open

- approved GPS/privacy/retention policy
- production Maps/route credentials and controlled verification
- provider-device location source and anti-spoof/trust design
- approved service-by-service tracking applicability
- approved lateness/grace/customer-alert/escalation thresholds
- approved accountability and financial-penalty policy
- approved exemption/dispute/reversal rules
- Partner Finance settlement integration
- live WhatsApp/SMS/push verification
- monitoring/alerting
- real-device UAT
- controlled Bengaluru pilot

Passing this specification means **ready for staff/device UAT**, not production-ready.