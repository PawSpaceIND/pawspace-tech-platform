# E2E100 T4 — Payments, Finance, GST, payroll and closure evidence

Date: 2026-08-24 (Asia/Kolkata)
Branch: `testfix/e2e100-t4-finance-gst-close`
Repository: `PawSpaceIND/pawspace-tech-platform`

## Outcome

Engineering result: **25/25 T4 objectives passed** through isolated executable SQLite/D1-compatible behavior. The range/uniqueness guard also passed, so Node reports 26 tests for the objective pack. The expanded payment, Finance, accounts, GST, payroll, incentive, settlement, close, P&L and revenue selection passed **319/319**.

Engineering integration readiness score: **9.3/10**. This score is for the internal contract and ledger implementation, not live-provider or statutory certification. No real payment, refund, bank transmission, payroll payment, partner payout, GST filing, merge or deployment occurred.

Actual-provider and operational verification is **not claimed**. It remains blocked on real Razorpay sandbox credentials/webhook secret, controlled allow-listed test identities, banking/accounting endpoints, approved chart-of-account mappings, approved payroll/partner policies and statutory reviewer evidence.

## Baseline and change control

| Check | Evidence |
|---|---|
| Synced `main` at start | `85ac0c6e275a93d1690428c59aac0b214cdcddf4` |
| Agreed common candidate | `a8df4e301233ac18e947e382a8d18fcd8bb8e015` |
| Branch point | Exact common candidate above |
| PR #302 | Open; head exactly `a8df4e301233ac18e947e382a8d18fcd8bb8e015`; “Lane 3: close money and communications evidence gaps” |
| Open PRs enumerated before changes | #302, #304, #305, #306, #307 |
| Demo seed | Preserved; the T4 harness uses fresh in-memory databases and never opens or mutates the demo database |
| Delivery constraint | One T4 PR; no merge; no deployment |

The exact-head Release CI result is intentionally reported on the PR checks, because changing this file after a CI run would make that run non-exact-head.

## Confirmed defects and corrections

| Defect | Reproduction evidence and first incorrect truth | Minimal correction | Permanent regression |
|---|---|---|---|
| Eligible GST input credit omitted from monthly close | Actor `finance@test`; an August vendor-tax review row had canonical `review_status='eligible'`, `eligible_tax_amount=300`; close response reported eligible input tax `0`. First error was the close query reading the non-canonical value `approved`. | Read the canonical `eligible` state. | `statutory-finance-close.test.mjs` seeds the canonical row and requires eligible input `300`, net GST `1500`. |
| Monthly close did not lock the canonical period used by downstream Finance modules | Actor `finance@test`; close returned `closed`, but no `finance_close_periods` row existed, so GST, payroll and export mutation guards still saw an unlocked period. | Upsert the shared canonical period as `locked`, preserving checklist, actor and time when close succeeds. | The same D1 regression requires `finance_close_periods.status='locked'`, actor retention, immutable snapshot and duplicate-close refusal. |
| Replayed invoice rewrote tax-ledger history and repeated service lines could collapse | Actor `maker@pawspace.in`; two same-service invoice lines were issued, then the same source event was replayed. Before correction the wrapper deleted/recreated tax rows, changing row IDs/timestamps; canonical event keys also used service code rather than line identity. The first incorrect canonical keys were `event:service:component`. | Snapshot `lineKey` and key output-tax rows by `event:lineKey:component`; remove wrapper deletion/recreation. | `finance-statutory-execution.test.mjs` requires both repeated lines and byte-for-byte stable tax-ledger rows after replay. |
| Razorpay outbound boundary could not be safely exercised against an external-style local server and had no bounded body/timeout | Contract actor used sandbox-only synthetic credentials. The candidate hard-coded the live provider origin; a safe local contract request was therefore impossible, and response read/timeout were unbounded. No D1 write occurred because this defect is before canonical persistence. | Permit a loopback override only in explicit sandbox contract-test mode; add bounded timeout, response-size limit and redirect refusal while keeping the real Razorpay origin as default. | `payment-provider-contract.test.mjs` executes a real local HTTP boundary for accept, 400/401/429/500/503, timeout, network failure, invalid response and override refusal. |
| Post-service payment-link expiry was not bound to provider truth and expired URLs remained collectable | Actor `provider-test`; candidate created a local `expires_at` without sending `expire_by`, then `paymentRequestView` treated any HTTPS path as collectable after expiry. The affected D1 row was `post_service_payment_requests.expires_at`; the provider request lacked the matching expiry. | Send the 24-hour Unix expiry, require it in the accepted response, persist provider seconds as D1 milliseconds, refuse expired/settled requests and hide checkout/QR when not collectable. | Executable D1 regression proves provider expiry binding, exact persisted conversion and expired refusal; UI guard is pinned in the same test. |

Failed attempts preserved their actor, request, response expectation and affected-row assertions in the regressions above. No failed financial transaction or ledger history was deleted to repair a test.

## Isolated case results

| Case | Objective | Result |
|---|---|---|
| E2E100-T4-076 | Sandbox order creation through external HTTP contract | PASS |
| E2E100-T4-077 | Post-service link, expiry and invalid provider response | PASS |
| E2E100-T4-078 | Raw signature verification; invalid/unconfigured refusal before state | PASS |
| E2E100-T4-079 | Signed captured payment and duplicate refusal | PASS |
| E2E100-T4-080 | Failed payment collects zero | PASS |
| E2E100-T4-081 | Duplicate/out-of-order capture notifications | PASS |
| E2E100-T4-082 | Order/customer/booking/amount/currency binding and entity isolation | PASS |
| E2E100-T4-083 | Full refund reconciliation | PASS |
| E2E100-T4-084 | Partial refund and collected-funds ceiling | PASS |
| E2E100-T4-085 | Unmatched gateway event and governed resolution | PASS |
| E2E100-T4-086 | Booked/collected/refunded/net decomposition; draft/cancelled exclusion | PASS |
| E2E100-T4-087 | Invoice numbering, repeated lines and immutable replay | PASS |
| E2E100-T4-088 | GST output/input ledger and eligible-credit review | PASS |
| E2E100-T4-089 | Balanced journal; unbalanced negative | PASS |
| E2E100-T4-090 | Expense/vendor-bill governance and period precheck | PASS |
| E2E100-T4-091 | Finance maker self-approval refusal | PASS |
| E2E100-T4-092 | Checker evidence-reference requirement | PASS |
| E2E100-T4-093 | Credit/reversal/correction without deletion | PASS |
| E2E100-T4-094 | Entity-scoped export checksum and replay | PASS |
| E2E100-T4-095 | Payroll calculation, idempotency, approval and unapproved-post refusal | PASS |
| E2E100-T4-096 | Payroll posting through configured accounts only | PASS |
| E2E100-T4-097 | Incentive inclusion/reversal, partner settlement and pipeline exclusion | PASS |
| E2E100-T4-098 | Bank mismatch/transmission never marks paid | PASS |
| E2E100-T4-099 | Monthly close and canonical locked-period enforcement | PASS |
| E2E100-T4-100 | Twelve-month completeness, annual close, P&L and authorization | PASS |

Each case creates its own case ledger, and each owning regression creates a fresh database. The case range guard proves the exact unique sequence 076–100.

## Complete Finance test year

`finance-year-closure.test.mjs` creates April 2026 through March 2027 with 12 distinct periods: eight locked, one closing and three open. It contains invoices, refunds, credit notes, configured-test GST rows, payroll, incentives, partner settlements, expenses and accounting export packages. It posts 12 journals through the canonical `postJournal` path and reconciles debit to credit for every period. Twelve SHA-256 export checksums are unique; an identical checksum replay creates zero new export rows.

The fixtures deliberately use labels such as `configured_test_tax`, `configured-test-debit` and `configured-test-credit`. They are not represented as statutory rates, production account mappings or partner policies.

## Provider contract matrix

The test server is a real loopback HTTP server at the adapter boundary, not an internal “mark delivered/paid” shortcut.

| Contract behavior | Result and persisted truth |
|---|---|
| Accepted order | HTTP accepted; synthetic prefix `order_contract_test_*`; exact amount/currency/booking/payment notes; no capture write | PASS |
| Accepted post-service link | HTTP accepted; synthetic prefix `plink_contract_test_*`; HTTPS test URL, non-partial flag, customer binding and future `expire_by` | PASS |
| HTTP 400, 401, 429, 500, 503 | `connected:false`; no provider/payment truth manufactured | PASS |
| Timeout and network failure | Bounded refusal; no provider/payment truth manufactured | PASS |
| Invalid 200 response | Missing/invalid order, URL or expiry rejected | PASS |
| Override safety | Non-contract sandbox and every live environment refuse the loopback override before contact | PASS |
| Signed capture/refund callbacks | Raw-body HMAC path and exact reconciliation rows exercised | PASS |
| Invalid signature/unconfigured secret | Refused before state mutation | PASS |
| Duplicate callback/out-of-order notification | One canonical collection/refund truth | PASS |
| Unmatched event | Preserved as an exception for governed resolution | PASS |

All references are synthetic contract-test references. They are not Razorpay evidence.

## Negative-control disposition

The suite explicitly refuses unsigned capture; wrong order/customer/booking/amount/currency; refunds above collected funds; duplicate payments/refunds; direct locked-period mutations; posted-history deletion semantics; unbalanced journals; missing account mapping; payroll/Finance self-approval; checker without evidence; unapproved payroll posting; bank mismatch/transmission success; pipeline as achieved revenue; cancelled/refunded revenue overstatement; cross-entity reads; unauthenticated P&L; incomplete annual approval; and export replay duplication.

Every executed journal in the T4 objective and Finance-year pack balances. Payment/refund decomposition reconciles captured, refunded and net independently. Forecast/pipeline rows never become achieved revenue.

## Validation record

| Gate | Result |
|---|---|
| T4 objective pack | 25/25 business cases; 26/26 including range guard |
| Focused fixed behavior | 47/47 before expiry follow-up; 39/39 provider/link/T4 follow-up selection |
| Expanded Finance/payment regression | 319/319 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors; pre-existing warnings only |
| `npm run build` | PASS; verified Sites artifact emitted |
| `npm run validate:artifact` | PASS |
| `git diff --check` | PASS |
| Local aggregate `npm test` | Local managed runner blocked the runtime suite's local network harness; no test failure was produced. Exact aggregate execution is delegated to exact-head Release CI. |
| Exact-head Release CI | The PR's exact-head checks are the source of truth; closure is reported only after they are fully green. |

## External and policy blockers

- No actual Razorpay sandbox account credentials or real webhook secret were available; no actual order, link, capture or refund is claimed.
- No live banking/file-transmission endpoint was configured; all bank behavior is preparation/reference/reconciliation only.
- No production accounting/export receiver or GST filing portal was contacted.
- Production chart-of-account mappings, GST registrations/rates/filing rules, payroll rates, incentive rules and partner payout policies require approved configuration and reviewer evidence. None were invented here.
- Live cross-entity access review, statutory sign-off and actual settlement/payroll disbursement remain controlled human/provider UAT items.

These blockers separate engineering integration readiness from actual-provider, banking and statutory verification. They do not conceal a known reproducible T4 code defect.

## Release statement

Ready to begin controlled human UAT for demo-data logic after exact-head Release CI is green. Human UAT must keep sandbox/live-money protections enabled and must treat provider, banking and statutory steps above as blocked until real account and policy evidence exists.

No merge. No production deployment. No live money movement.
