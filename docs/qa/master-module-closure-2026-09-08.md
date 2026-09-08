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
