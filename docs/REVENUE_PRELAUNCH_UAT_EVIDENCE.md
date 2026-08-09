# Revenue Mission Control — PRE-LAUNCH UAT Evidence

## Test run header

- PR: #20
- Branch: `agent/revenue-mission-control-uat`
- Exact tested head: ______________________________
- UAT/preview URL: ______________________________
- Test date/time (IST): ______________________________
- Primary tester: ______________________________
- Secondary reviewer: ______________________________
- Tester role/permissions: ______________________________
- UAT mission ID: ______________________________
- Mission config version: ______________________________
- Metric definition version: ______________________________
- Productivity fact run ID: ______________________________
- Leadership report run ID(s): ______________________________

Allowed result values: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`.

Evidence must include a screenshot, canonical record ID, audit/event/report run ID, API reference, or concise reproducible observation. Do not mark PASS from a checkbox alone.

## Gate 1 — Mission configuration

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| ₹2,00,000 target visible with explicit period | NOT RUN | |
| Missing/invalid period rejected | NOT RUN | |
| Revenue basis explicit | NOT RUN | |
| Unauthorized mission mutation denied | NOT RUN | |
| Mission version/audit history visible | NOT RUN | |
| Closed mission configuration frozen | NOT RUN | |

Gate 1 result: **NOT RUN**

## Gate 2 — Revenue truth

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| Canonical booking creates at most one booked event | NOT RUN | |
| Collection creates one collected event | NOT RUN | |
| Duplicate/replayed source event does not double-credit | NOT RUN | |
| Full refund is explicit and adjusts net | NOT RUN | |
| Partial refund adjusts eligible portion only | NOT RUN | |
| Unpaid/cancelled booking does not count as collected | NOT RUN | |
| Booked/collected/refunded/net reconcile to canonical sources | NOT RUN | |
| Pipeline/estimate does not increase achieved revenue | NOT RUN | |

Gate 2 result: **NOT RUN**

## Gate 3 — Lead assignment

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| Eligible active staff receives lead | NOT RUN | |
| Inactive/unavailable staff excluded as configured | NOT RUN | |
| Workload cap respected | NOT RUN | |
| Continuity works when configured | NOT RUN | |
| No eligible owner produces fallback/unassigned state | NOT RUN | |
| Reassignment preserves reason/history | NOT RUN | |
| Duplicate request does not create duplicate active assignment | NOT RUN | |

Gate 3 result: **NOT RUN**

## Gate 4 — SLA / next action

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| Due time derives from active policy | NOT RUN | |
| First response updates correct clock | NOT RUN | |
| Breach creates manager-visible escalation | NOT RUN | |
| Duplicate runner execution is idempotent | NOT RUN | |
| Pause/resume works when configured | NOT RUN | |
| Non-terminal outcome requires configured next action | NOT RUN | |
| Reopened/reassigned work receives policy-derived SLA | NOT RUN | |

Gate 4 result: **NOT RUN**

## Gate 5 — Opportunity governance

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| Opportunity uses canonical customer facts/signals | NOT RUN | |
| Estimated value remains estimate with source/confidence | NOT RUN | |
| Consent/opt-out suppression works | NOT RUN | |
| CX/safety/refund/payment-dispute suppression works | NOT RUN | |
| Duplicate/data-quality/frequency/quiet-hour controls work | NOT RUN | |
| Suppressed/review-required opportunity cannot authorize outreach | NOT RUN | |
| No automatic outreach occurs | NOT RUN | |
| Conversion binds same canonical customer/booking | NOT RUN | |

Gate 5 result: **NOT RUN**

## Gate 6 — Productivity

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| Facts derive from canonical assignment/SLA/action/booking/revenue sources | NOT RUN | |
| Refunds reduce net-attributed revenue | NOT RUN | |
| Staff identity is directory-derived, not hard-coded | NOT RUN | |
| Employee cannot manipulate own fact rows | NOT RUN | |
| Unsupported metrics remain unavailable/null | NOT RUN | |
| Ranking/incentive are not payroll authority | NOT RUN | |
| Drill-down reaches supporting source records | NOT RUN | |

Gate 6 result: **NOT RUN**

## Gate 7 — Mission Command Center

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| Target/period/achieved basis/gap visible | NOT RUN | |
| Booked/collected/refund/net displayed separately | NOT RUN | |
| Pipeline visually/numerically separate from achieved | NOT RUN | |
| Collection/refund changes recalculate gap | NOT RUN | |
| Service/city/owner contribution reconciles | NOT RUN | |
| Unassigned/SLA breach/escalation queues visible | NOT RUN | |
| Configuration/reconciliation/data-quality warnings prevent false green | NOT RUN | |

Gate 7 result: **NOT RUN**

## Gate 8 — Leadership reporting

| Case | Result | Evidence / IDs / notes |
|---|---|---|
| Daily/weekly/monthly/mission snapshots respect mission period | NOT RUN | |
| Repeated idempotency key returns existing report | NOT RUN | |
| Snapshot stores mission-config and metric-definition versions | NOT RUN | |
| Delivery state changes do not alter metric truth | NOT RUN | |
| Report separates booked/collected/refund/net/pipeline | NOT RUN | |

Gate 8 result: **NOT RUN**

## Mandatory negative tests

| Negative test | Result | Evidence / IDs / notes |
|---|---|---|
| Unauthorized mission/policy mutation denied | NOT RUN | |
| Duplicate booking/payment/refund event does not double-credit | NOT RUN | |
| Suppressed opportunity cannot authorize outreach | NOT RUN | |
| Pipeline estimate cannot appear as achieved revenue | NOT RUN | |
| Delivery state cannot change report metrics | NOT RUN | |
| No Revenue Mission endpoint/page claims production ready | NOT RUN | |

## Defects

| ID | Severity | Summary | Status | Retest evidence |
|---|---|---|---|---|
| | | | | |

Severity guide:
- P0: security/data-loss/live-money/live-outreach/false-financial-truth issue; stop testing.
- P1: core UAT flow or reconciliation materially broken; closure blocked.
- P2: important but workaround exists; product/engineering disposition required before closure.
- P3: minor UX/copy/non-blocking issue.

## Final sign-off

- Gates 1–8 all PASS: [ ]
- Mandatory negative tests all PASS: [ ]
- No unresolved P0/P1: [ ]
- Any fixes were re-certified by exact-head CI: [ ] N/A [ ]
- Affected UAT cases re-tested after fixes: [ ] N/A [ ]

Final Revenue Mission Control status:

**PRE-LAUNCH UAT: NOT CLOSED**

Staff tester sign-off: ______________________________

Reviewer sign-off: ______________________________

Date/time (IST): ______________________________

**PRODUCTION READY remains FALSE.**
