# PawSpace master QA: stabilization changes and open closure gates

**Controlling acceptance standard:** [Connected-flow closure protocol](connected-flow-closure-protocol.md). Every flow requires frontend-through-recovery evidence; isolated module/API results do not close it.

**Readiness verdict: 95% human-test readiness is not certified.** This report records implemented fixes, executable verification, and remaining work. A passing test suite is not a substitute for completing the requested business flows or deployed human UAT.

Audit started from `origin/main` commit `ccfe2ee5`. Work is isolated on `codex/master-qa-module-closure`. No production deployment, live payment, customer message, policy activation, or production data migration was performed.

## Implemented fixes

| Area | Defect | Result | Regression evidence |
|---|---|---|---|
| Communications receipts | A delivered message could advance to read while its outbox remained delivered. | The outbox permits delivered → read while preserving protection against late lower-state callbacks. | `tests/communication-outbox-hardening.test.mjs`; the added test failed before the change. |
| Service review eligibility | Staff could request a review without proving a completed customer-owned booking; submission relied only on request ownership. | Request and submission check the canonical booking, matching customer and service, and completed status. | `tests/service-review-closure-execution.test.mjs`: pending, in-progress, cancelled, refunded, wrong-customer and wrong-service refusals. |
| Low service ratings | A 1- or 2-star submission did not immediately create a support case. | A high-severity customer complaint, with customer/booking/provider context, is persisted with the review and its audit event in one D1 batch transaction. | Tests cover both low ratings, no case for 3–5 stars, duplicate submission, configured SLA deadlines and injected rollback. |
| Low host ratings | Host reviews lacked the same immediate recovery case. | Low host ratings create a linked support case transactionally with the review. | Host review execution test checks case linkage and aggregate rating. |
| Case transaction boundary | Case creation and its audit event were separate writes. | Case creation, its event, and optional related domain statements commit or roll back together. | Injected review-write failure leaves no case, no event, and the request unreviewed. |
| Cross-sell paths | The base recommendation engine omitted Grooming → Training and Boarding → Taxi. | Training is available for grooming customers with stated training intent; boarding history can recommend taxi. | `tests/pet-next-best-service-closure.test.mjs`. |
| Cross-sell suppression | Base recommendations ignored future bookings; sequential outbound recommendations could bypass service eligibility and entitlement suppression. | Both paths suppress existing future bookings, active entitlements and explicitly unsafe service eligibility. Overlapping histories yield one base recommendation per service. Invalid negative ages no longer qualify as young dogs. | Cross-sell closure and outbound orchestrator execution tests. |
| Beta payment kill switch | The canonical parser did not enforce `FORBID_PRODUCTION`. | Live mode is refused when the flag is the string `true` or boolean true. A live Razorpay key in the sandbox key binding is also refused. | `tests/payment-beta-lock-matrix.test.mjs`. |
| Subscription payment environment | Subscription and plan verification treated unknown environments as live and accepted case-normalized approval. | Both use the strict canonical parser; subscription contract persistence uses the same parser; approval requires exactly the string `true`. Settlement approval is also exact. | Payment matrix, subscription lifecycle and settlement tests. |
| Test reliability | Review tests omitted canonical bookings; boarding window endpoints read separate clocks and could turn 48 hours into 48 hours plus 1 ms. | Fixtures contain completed bookings and the boarding window uses one clock anchor. Production pricing rules remain intact. | Miscellaneous review tests, E2E100 customer journey and boarding vertical tests. |

## Thirteen-module closure matrix

“Validated subset” means the selected checks passed; it does **not** mean every requested acceptance criterion is closed.

| # | Module | Evidence and changes | Remaining closure requirements |
|---|---|---|---|
| 1 | Core WhatsApp | Initial 174 selected communications tests passed; 175 passed after adding the receipt regression. Includes signature, routing, templates, media, inbox controls and outbox tests. Receipt consistency fixed. | Deployed Meta round-trip evidence for each media type, receipt ordering, quiet-hours release, retries and opt-out. Audit all delivery implementations under concurrent callbacks; existing test coverage includes source contracts as well as execution. |
| 2 | Customer ↔ provider chat | Conversation authorization, shared-inbox controls and provider communication boundaries exercised in the communications selection. | Booking-created conversation coverage across all services, offline-provider-to-support behavior and measured end-to-end latency. No fresh browser/offline simulation was performed. |
| 3 | CX inbox | Search/filter, ownership and operator controls covered by selected tests; customer-experience template uses a conversation EventSource with polling fallback. | Browser verification of profiles, active booking contexts, assignment, internal notes, SLA timer rendering and search/filter transitions. |
| 4 | Lead management | 113 CRM/sales tests passed across scoring, assignment, ingestion, attribution, conversion integrity and governance. | Every external lead source needs an authenticated sandbox payload-to-inbox trace; validate active policy values and Lost-reason UX. |
| 5 | Sales execution | SLA, assignment and sales-productivity test selections passed. Existing WhatsApp no-response tests passed. | Approved SLA/cadence values and deployed scheduled runs for missed calls, untouched leads, payment-pending and quote follow-ups. |
| 6 | Cross-sell | Missing recommendation paths and suppression bypasses fixed. The outbound engine calls the base engine, so the changes reach outbound candidates. | Approved age/breed eligibility policy, complete pet-profile combinations, and governed end-to-end outbound dispatch evidence. No offer or campaign was activated. |
| 7 | Win-back | Lifecycle selection: 78 tests passed, including reminders, marketing regressions and subscription lifecycle. Service-specific policy definitions exist in `lib/policies/winback-lifecycle.ts` and are marked draft/requiresApproval. | Approved thresholds, incentive amounts, add-on rules and daily caps; verify actual offer/points/discount issuance and scheduled dispatch with those policies. |
| 8 | Retention/churn | Predictive churn feature/model code exists alongside the simpler growth intelligence engine; selected intelligence tests passed. | `scoreCustomerChurn` in `lib/services/elite-production-runtime.ts` derives recency from lead updates and supplies zeros for several customer telemetry fields. Real booking, payment, complaint and engagement telemetry must be connected and tested before this requirement is closed. |
| 9 | Discovery | Service-capacity and boarding-host selection tests passed as part of the 59-test discovery/review/refund selection. | Real deployed indexing, geographic accuracy, availability changes and sorting under realistic data/load need verification. |
| 10 | Ratings/reviews | Completed-booking eligibility and immediate low-rating support cases fixed for service and host reviews. Host score is computed from stored reviews. | Provider score behavior across all review surfaces, concurrent updates and customer/provider browser journeys require further certification. |
| 11 | Complaints/tickets | Immediate low-rating cases now use the existing case center and configured SLA policy. Case-state, authorization, SLA and refund tests executed. | Verify policies exist for every deployed case severity/type, timer UI, refund-ledger drilldowns and resolution journeys. Without an active policy the existing case system deliberately leaves deadlines null. |
| 12 | Admin data layer | Selected admin, customer-360, operations and cross-module checks: 40 tests passed. | Full CRUD, validation, pagination and browser acceptance remains required for Customers, Pets, Partners, Staff, Leads, Bookings, Payments, Refunds, Subscriptions, Packages, Coupons, Complaints, Cities and Pricing. These are not declared closed by the selected tests. |
| 13 | Operations command | Operations queue and authorization tests passed. | `app/booking-command-center/page.tsx` is a fetched snapshot with manual refresh, not the requested live WebSocket booking feed. Implement and verify live updates and all requested alert states. |

## Safety evidence and its limits

All audit payment tests used explicit sandbox declarations. `scripts/assert-beta-payment-lock.mjs` fails unless all three exact values are present:

```
PAWSPACE_PAYMENT_ENV=sandbox
FORBID_PRODUCTION=true
PAWSPACE_PAYMENT_LIVE_APPROVED=false
```

The payment matrix exercises eight live/invalid environment declarations × six approval values = **48 combinations**, checks order, subscription, plan and webhook boundaries, and asserts **zero network calls**. Additional cases test strict approval, valid sandbox configuration and a misplaced live key. The finite matrix complements the parser's unconditional rejection branch; it is not a mathematical proof of every runtime or external deployment.

The task's initial shell had all three variables unset. Explicitly setting them for this audit does not prove hosted settings. The Sites project in `.openai/hosting.json` returned `Sites project not found` through the available connector. Hosted configuration and deployment therefore remain unverified. No attempt was made to replace the site, unlock live mode or deploy elsewhere.

## Validation record

- Initial full build/test run: 4,659 tests, 4,658 passed, one failure caused by the now-corrected review fixture.
- Second full run: 4,669 tests, 4,668 passed, one boarding-window timing failure. That fixture was corrected after the run.
- Final changed-scope run: **125 passed, zero failed, zero skipped**. Includes the corrected boarding test, E2E100 customer journey, all new closure tests, outbound recommendations, reviews/cases, subscriptions and settlement regressions. The entire suite was not rerun after the last isolated fixture/outbound changes; these results must not be presented as an exact-source all-green full-suite run.
- Final source build: successful; the repository artifact validator confirmed the ESM Worker default fetch export and hosting manifest.
- Final typecheck: passed. `git diff --check`: passed.
- Logs are retained with the delivered report. Test selections overlap and must not be added together as unique test counts.
- No new human/browser UAT, load test, real Meta delivery or hosted payment-setting attestation was completed.

## Inputs needed for full closure

1. Approved lead SLAs, daily communication limits, win-back incentive policies and age/breed eligibility rules. A clarification was requested during the audit; existing policies were preserved.
2. An accessible canonical staging deployment and its deployment configuration, with test identities and allowlisted communication recipients for external integration UAT.
3. Completion of the remaining implementation and verification work explicitly listed in the module matrix, particularly churn telemetry and the Operations live feed.

The stabilization changes are reviewable fixes, not a declaration that all 13 modules meet the requested readiness standard.

## Subsequent connected support-notification increment — 9 September 2026

The earlier statement that no new browser UAT occurred is historical. A local demo now executes sandbox customer sign-in → Activity one-star rating → recovery case → overdue SLA sweep → internal outbox delivery → authenticated customer inbox. The booking and overdue timestamp were fixtures; the customer actions, route handlers, case transaction and notification functions were real. No payment or external send was made.

The fix spans communications, customer inbox, ratings and complaints: overdue-case chat notices no longer enter the unsupported-channel dead-letter path. Delivery is transactional, checks current consent and case state, and appears through an ownership-checked paginated API. The customer menu/header placeholders now open a modal inbox with error/retry/timeout states. Scheduled notices remain hidden; resolved cases suppress pending notices. Native modal focus and the delivered layout were inspected in the local app browser.

62 focused regressions passed. The selected tests include rollback/retry, duplicate prevention, authorization, deterministic pagination, scheduling, opt-out and stale-case suppression while preserving payment/analytics invariants. Build and typecheck were rerun. The standalone Playwright test could not launch under macOS sandbox restrictions; its browser execution remains open. The local app browser supplied the UI evidence described above, including an offline error/Retry state.

See the connected-flow protocol for stage-by-stage evidence and limitations. This increment does not close general chat, all notifications, the full CX inbox, or any module at 95%. Existing dead letters are not automatically replayed. Hosted environment, external delivery, Operations live updates and churn telemetry remain open.

### Order-notification follow-through

Fixed the customer gateway 403 on the independent order inbox, removed the global notification sweep from customer GET, protected cross-origin read acknowledgements, preserved their original timestamp on retry and corrected unread totals beyond the current page. Customer responses omit internal payload/transport details. Load/read failures now remain visible with retry controls.

18 focused tests passed, with build/artifact validation and typecheck successful. The authenticated local browser opened the real order inbox successfully. The connected protocol records coverage and remaining transport, pagination, identity-refresh and deployed checks; no broader module closure is claimed.

### Older inbox pages and sign-in recovery

Order notifications now have deterministic cursor pagination, UI newer/older navigation, input validation and a matching index. The widget rechecks verified identity after customer OTP and on focus/periodic checks, clears stale customer data, and times out stalled requests. The current page survives acknowledgement refresh.

18 selected tests, build/artifact validation and typecheck passed. Local browser evidence covers 32 fixture notices across two pages, a persisted acknowledgement/count change, return navigation, and sandbox sign-in restoring the widget without page reload after simulated local session expiry. The connected protocol distinguishes these executed paths from unexecuted adversarial races and deployed checks. Module-wide readiness remains open.

### Order communication delivery

Connected ordinary order chat messages to internal delivery after validating their persisted notification/customer/order linkage and current consent. Message, event, outbox and notification delivery state commit atomically. Delivery projections reconcile from canonical communication status. Creation notices now say recorded instead of claiming every booking is confirmed.

39 selected regressions passed, including injected rollback/retry, duplicate prevention, opt-out after enqueue, simulated receipt reconciliation and no payment writes. Build/artifact validation and typecheck passed. This is internal delivery and local contract evidence; external deployed delivery and generic chat remain open.

### Provider chat authorization

Fixed idempotency replay returning message content before current provider assignment/suspension checks. Keys now remain bound to the provider's chat activity and conversation. Assignment-store failures fail closed in send/read paths rather than silently trusting fallback ownership. Eleven focused tests passed with build/artifact validation and typecheck; complete provider/customer chat UI and takeover journeys remain open.


### Atomic staff takeover and AI resume

Handoff lifecycle transitions now atomically update ownership, SLA, assignment/audit history and AI session state. Concurrent transitions have a single winner; failures roll back and remain retryable. Wrong-customer duplicate requests are rejected. Twenty-nine selected tests passed, including six new rollback/concurrency regressions, with build/artifact validation and typecheck successful. Full connected browser/deployed handoff readiness is still open; see the protocol for evidence limits.


### Broader regression follow-through

The broader run found that booking complaint projections sorted only inside each D1 chunk. The projection now sorts the combined result by creation time descending and ID, preserving deterministic ordering across large booking lists. A new executed regression spans more than two chunks and compares with a single SQL ordering. Two AI assertions were updated for the deliberate HTTP 400 validation response and removal of the non-atomic assignment helper. The gateway audit now separately recognizes the two route-authenticated customer inboxes; their ownership protection remains exercised by the connected suite.

50 selected checks passed (33 AI/chunk semantics, 7 gateway reachability, 10 connected journeys), with build/artifact validation and typecheck successful. The broader suite is still in progress; no full-suite or 95% readiness claim is made.


### Provider conversation read visibility

Provider GET now applies the Trust & Safety suspension/ban check used by sending, excludes queued/suppressed/failed messages and returns an explicit text projection rather than arbitrary stored payload fields. Text contact details are masked by the existing pure redactor. Private notes, nested finance/identity metadata and raw media URLs are not returned. This projection does not implement governed provider media delivery; that remains open along with audience-specific customer/staff threads, older-history pagination and browser chat wiring.

The new route regression failed before the fix because queued content was visible, then passed after it. Twelve focused provider/trust checks pass, with build/artifact validation and typecheck successful. The broader earlier run completed with 4,678/4,682 passing; all four failures were addressed with focused tests in the preceding increment. A fresh full-suite run is still required. No real communications or financial transactions were performed.


### Full regression baseline and AI replay access

Commit `1233a544` passed all 4,684 tests in the full local suite, with no failures or skips. This is automated local evidence and does not establish deployed or human-test readiness. The exact run is exported as `stabilization-full-suite-1233a544.log`.

Subsequent inspection reproduced a completed AI-turn replay returning another customer's record before authorization. Replays now validate the canonical input and current customer ownership, and the stored key must match customer, thread, message and channel. Retryable reservation claims also match those fields so a conflicting request cannot seize another turn's reservation. Valid replay remains idempotent. Forty-two selected executed AI/handoff checks pass, including wrong-customer/revoked access, changed-message/key conflicts and unchanged conflicting retry reservations; build/artifact validation and typecheck pass. These later changes have focused evidence, not a new full-suite run. Takeover during an in-flight model call remains under investigation.


### In-flight AI handoff protection

A deterministic provider test reproduced a model draft returning after staff takeover. The orchestrator now rechecks ownership immediately before invoking the model, and uses conditional database writes for both the draft suggestion and final turn. If an active handoff exists at either commit, the operation returns 409, does not complete its reservation, and leaves it retryable. Suggestion audit events are inserted only for an actual suggestion. A draft committed before takeover may remain for staff review, but the blocked turn is not returned as a completed AI response.

Three new executed tests cover takeover during the model call and a handoff arriving immediately before each persistence batch. All 209 AI tests pass, as do build/artifact validation and typecheck. One older test adapter was corrected to return actual SQLite affected-row counts, matching the D1 contract. No external model/recipient or payment was called. Distributed delivery already beyond its commit point and deployed D1 concurrency remain separate verification requirements.
