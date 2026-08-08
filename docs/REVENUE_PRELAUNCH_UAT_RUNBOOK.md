# Revenue Mission Control — PRE-LAUNCH UAT Runbook

## Status meaning

**PRE-LAUNCH UAT** means the Revenue Mission Control engineering scope is implemented, exact-head CI is green, and the build is ready for controlled staff testing. It does **not** mean production launch approval.

Production payments, live marketing outreach, production provider integrations, production accounting/tax policy and public launch remain outside this gate.

## Entry points

Primary staff view:

- `/team/revenue-mission`

Supporting governed APIs used by staff/admin test actions:

- `/api/revenue-mission-control`
- `/api/revenue-mission-command-center`
- `/api/lead-assignment-governance`
- `/api/lead-sla-governance`
- `/api/revenue-opportunity-governance`
- `/api/sales-productivity-governance`
- `/api/revenue-leadership-reporting`

## Start-test prerequisites

All of the following must be true before staff begin:

- [ ] Current PR head passes backend typecheck/tests and web build/tests/lint/artifact validation.
- [ ] The current branch is available in the PawSpace Sites UAT/preview environment.
- [ ] D1 binding `DB` is present for the preview/UAT environment.
- [ ] Tester is signed in with a provisioned PawSpace workspace identity.
- [ ] Tester has `reports.view`; setup/operator tester also has `customers.manage`.
- [ ] No production payment, marketing, messaging or live-money credentials are intentionally enabled for this test.
- [ ] Screenshots / request IDs / canonical record IDs can be captured as evidence.

If the tester receives `401 Authentication required`, authenticate through the normal workspace/Sites sign-in path. If the tester receives `403 Access has not been provisioned for this identity`, provision the tester in the PawSpace role directory or ensure the configured founder identity is being used. Do not weaken authorization to make UAT pass.

## Test data and policy rule

Use controlled UAT data only. The mission target for this UAT is **₹2,00,000**, but the tester must explicitly choose the mission start/end period and revenue basis. SLA values, assignment limits, outreach limits and other commercial/operating values used during testing are **UAT fixtures only** unless separately approved as company policy.

Never treat fixture values as production policy. Never enable live outreach or production money to make a test pass.

## Setup sequence

1. Sign into the UAT/preview build with a staff identity that has the required permissions.
2. Open `/team/revenue-mission`. Confirm the page says `REVENUE MISSION CONTROL · UAT ONLY` and `Production ready: NO`.
3. Create the ₹2,00,000 UAT mission with an explicit start/end period, scope and revenue basis. Activate it using an evidence/approval reference that clearly says UAT.
4. Configure and activate UAT-only lead assignment, SLA, opportunity and productivity policies. Use explicit test values; do not copy legacy hard-coded Revenue CRM constants as policy truth.
5. Add at least two active test staff identities to the assignment team when testing workload/continuity/reassignment behavior. Also test the no-eligible-owner fallback path.
6. Create or use canonical UAT customer/booking/payment/refund records. Do not use the legacy synthetic Revenue-100 generator as achieved-revenue truth.
7. Run mission canonical-source backfill so booked/collected/refunded/net events are synchronized from canonical sources.
8. Generate a productivity fact run for the test period.
9. Generate at least one leadership report snapshot and retain its run ID, metric-definition version and mission-config version.
10. Perform the eight UAT gates below and record evidence in `docs/REVENUE_PRELAUNCH_UAT_EVIDENCE.md`.

## Gate 1 — Mission configuration

Pass when:

- ₹2,00,000 target is visible with an explicit period.
- Missing/invalid period is rejected.
- Revenue basis is explicit.
- Unauthorized mutation is denied.
- Mission version/audit history is visible.
- Closed mission configuration is frozen.

## Gate 2 — Revenue truth

Pass when:

- One canonical booking contributes at most one booked event.
- Collection contributes one collected event.
- Replay/duplicate source events do not double-credit.
- Full and partial refunds are explicit and reduce net truth correctly.
- Unpaid/cancelled bookings are not counted as collected revenue.
- Booked, collected, refunded and net totals reconcile to canonical records.
- Pipeline/estimated opportunity values never increase achieved revenue.

## Gate 3 — Lead assignment

Pass when:

- Eligible active staff can receive a lead.
- Inactive/unavailable staff are excluded when policy requires it.
- Workload cap and continuity rules behave as configured.
- No eligible owner produces a visible fallback/unassigned state.
- Reassignment records reason/history instead of overwriting history.
- Duplicate requests do not create duplicate active assignments.

## Gate 4 — SLA and next action

Pass when:

- Due times derive from the active UAT policy.
- First response updates/stops the correct clock.
- Breach and manager escalation are visible.
- Duplicate runner execution is idempotent.
- Pause/resume works when configured.
- Non-terminal outcomes require the configured next action.
- Reopened/reassigned work gets policy-derived clocks, not legacy constants.

## Gate 5 — Opportunity governance

Pass when:

- Opportunity records use canonical customer facts/signals.
- Estimated value remains an estimate with confidence/source context.
- Consent/opt-out, CX/safety, refund/payment dispute, duplicate/data-quality and frequency/quiet-hour suppressions work.
- Suppressed/review-required opportunities cannot authorize outreach.
- No automatic outreach occurs.
- Conversion binds to the same canonical customer/booking.

## Gate 6 — Productivity

Pass when:

- Facts are derived from canonical assignment, SLA/action, booking and mission-revenue sources.
- Refunds reduce net-attributed revenue.
- Staff identity is sourced from the user directory, not hard-coded names.
- Employee cannot manipulate their own fact rows through the reporting surface.
- Unsupported metrics remain unavailable/null rather than fabricated.
- Ranking/incentive fields are not payroll authority.
- Drill-down can reach supporting source records.

## Gate 7 — Mission Command Center

Pass when:

- Target, period, achieved basis and gap are visible.
- Booked/collected/refund/net truth are separate.
- Pipeline is visually and numerically separate from achieved revenue.
- Collection/refund changes recalculate the gap.
- Service/city/owner contribution reconciles to source records.
- Unassigned/SLA-breach/escalation queues are visible.
- Configuration/reconciliation/data-quality warnings prevent a misleading green state.

## Gate 8 — Leadership reporting

Pass when:

- Daily/weekly/monthly/mission snapshots respect the configured mission period.
- Repeated idempotency key returns the existing report rather than duplicating it.
- Snapshot stores mission-config and metric-definition versions.
- Delivery state changes do not alter metric truth.
- Report separates booked, collected, refunds, net and pipeline.

## Mandatory negative tests

Record at least one evidence item for each:

- unauthorized mission/policy mutation returns permission denial;
- duplicate booking/payment/refund source event does not double-credit;
- suppressed opportunity cannot authorize outreach;
- pipeline estimate cannot appear as achieved revenue;
- failed/changed report delivery cannot change report metrics;
- no endpoint or page reports `productionReady: true` for this workstream.

## Immediate stop conditions

Stop the test and mark the gate failed if any of these occur:

- live payment capture/refund/payout is triggered;
- live marketing/message/call is sent without explicit controlled-integration approval;
- unauthorized staff can view or mutate protected data;
- duplicate/replayed source events change revenue twice;
- pipeline/forecast/estimated value is credited as achieved revenue;
- a refund disappears from net truth;
- report delivery changes historical metric truth;
- the UAT surface claims production readiness.

## Evidence standard

Every PASS must include enough evidence for another reviewer to reproduce or inspect it: screenshot, canonical record ID, API request/response reference, report run ID, audit/event ID, or a short note explaining the observed result.

A checkbox alone is not evidence.

## Closure rule

Revenue Mission Control becomes **PRE-LAUNCH UAT CLOSED** only when:

- every required Gate 1–8 case passes;
- mandatory negative tests pass;
- evidence is recorded;
- no unresolved P0/P1 defects remain;
- any code fixes found during UAT are followed by a fresh exact-head CI pass and affected UAT re-test.

Even after this gate closes: **PRODUCTION READY = FALSE** until the broader PawSpace pre-live regression, integration, Finance/People/CA approvals, real-device/pilot and launch controls are separately satisfied.
