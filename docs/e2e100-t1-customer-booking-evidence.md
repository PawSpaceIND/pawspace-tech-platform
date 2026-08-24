# E2E100 T1 — Customer, pet, booking, service and payment evidence

Status: local engineering UAT complete on the T1 branch; exact-head Release CI pending the PR push.  
Execution date: 2026-08-24 (Asia/Kolkata).  
No merge, deployment, live payment, refund or provider action was performed.

## Baseline

| Item | Recorded value |
|---|---|
| Repository | `PawSpaceIND/pawspace-tech-platform` |
| Starting `origin/main` | `0b6695c8a2c311b1ba9e5fad468198b5f688545c` |
| PR #302 | Open, mergeable; `closure/9plus-lane3-money-comms` → `main` |
| PR #302 exact head | `a8df4e301233ac18e947e382a8d18fcd8bb8e015` |
| Selected common candidate | `a8df4e301233ac18e947e382a8d18fcd8bb8e015` (matched expected SHA) |
| Starting working tree | Clean; prior local branch `testfix/e2e100-t2-provider-operations` |
| T1 branch | `testfix/e2e100-t1-customer-booking` created directly at the selected candidate |
| Demo seed | `scripts/uat-demo-seed.sql`, generator and regression preserved unchanged |

Open PRs enumerated before T1 changes:

| PR | Title |
|---:|---|
| 302 | Lane 3: close money and communications evidence gaps |
| 304 | Lane 1: close service journeys and commercial authority gaps |
| 306 | Lane 4 closure: AI provider boundary, voice operator console, readiness evidence, staging certification |
| 307 | E2E100 T3: harden CRM, AI and communications UAT |
| 308 | E2E100 T4: prove Finance, GST, payroll and closure |
| 309 | E2E100 T2: harden provider assignment and Operations UAT |

PR #302 was inspected rather than accepted only by SHA. Its open review findings concerning payment-link expiry, stale partner payment state, and missing link-to-reconciliation mapping were reproduced on the candidate and fixed in this T1 branch. The unrelated documentation-heading review remains on PR #302 and this branch did not edit another tester's evidence.

## Execution model and data isolation

`tests/e2e100-t1-customer-booking.test.mjs` owns exactly 25 deterministic case IDs, `E2E100-T1-001` through `E2E100-T1-025`. Every case launches its named behavioral regression in a fresh process. The selected regressions execute routes or owning modules over isolated in-memory SQLite-backed D1 adapters and assert canonical rows; source-only tests are not used as the sole journey evidence.

The cases create their own customers (new and returning), pets, addresses, bookings, reservations/work orders, payments, coupons, subscriptions and failure states. They are repeatable and leave the existing demo seed untouched.

## Case matrix

| Case | Objective | Result | Principal executable evidence |
|---|---|---|---|
| E2E100-T1-001 | Registration, OTP/session, returning customer and concurrent binding | PASS | `customer-registration-profile-integrity`, `comms-identity-hardening` |
| E2E100-T1-002 | Name, phones, email, saved address and city | PASS | profile/address mutation and readback against D1 |
| E2E100-T1-003 | Pet creation, attributes, ownership and idempotency | PASS | `pet-manager` real execution |
| E2E100-T1-004 | Verified, pending, missing and invalid vaccination states | PASS | `boarding-reservation-authority`, pet validation |
| E2E100-T1-005 | Bengaluru, Mumbai, Pune, Hyderabad and Chennai | PASS | five-city customer/address rows and city propagation |
| E2E100-T1-006 | City/zone/PIN serviceability | PASS | resolver and canonical booking city/zone execution |
| E2E100-T1-007 | Cross-city and unsupported-zone refusal | PASS | zero-write mismatch and no-orphan route journeys |
| E2E100-T1-008 | Grooming booking | PASS | discounted Grooming route journey |
| E2E100-T1-009 | Training plan and sessions | PASS | exact-N materialization, completion derivation |
| E2E100-T1-010 | Boarding stay and host selection | PASS | chosen-host reservation and complete stay lifecycle |
| E2E100-T1-011 | Sitting visit/overnight and unconfigured variants | PASS + POLICY BLOCKER | Home Visit and Overnight are server-priced; hourly/daycare catalogue/pricing is not configured and is refused, not invented |
| E2E100-T1-012 | Walking plan booking | PASS | recurring quote/schedule and booking-to-Finance chain |
| E2E100-T1-013 | Taxi route/distance/fare inputs | PASS | server route-class pricing, constraints, assignment/no-driver |
| E2E100-T1-014 | Food order/subscription | PASS | order/fulfilment and payment-link renewal execution |
| E2E100-T1-015 | Date/slot/collision/duplicate submission | PASS | atomic reservation collision and concurrent order guard |
| E2E100-T1-016 | Provider preference/no-provider | PASS | preferred-provider fallback and no-capacity refusal |
| E2E100-T1-017 | Canonical auto-assignment | PASS | deterministic highest-score engine and route selection |
| E2E100-T1-018 | Full payment and authority/tamper boundaries | PASS | raw signed webhook, mismatch and cross-customer order refusal |
| E2E100-T1-019 | Split payment | PASS | two-stage accumulated collection and balance guard |
| E2E100-T1-020 | Post-service payment link | PASS | external-style Razorpay sandbox contract and D1 reconciliation |
| E2E100-T1-021 | Coupon eligibility/expiry/reuse/stacking/service mismatch | PASS | quote/consume, limits, concurrent consume and tamper tests |
| E2E100-T1-022 | Grooming subscription reserve/consume/reverse | PASS | credit-ledger real execution |
| E2E100-T1-023 | Reschedule/date change | PASS | atomic move and roster/travel collision refusal |
| E2E100-T1-024 | Cancellation and partial/full refund | PASS | cancellation, exact refund math and collected-funds ceiling |
| E2E100-T1-025 | Completion → proof/invoice/CRM/loyalty/review/reminder | PASS | cross-module D1 journey plus focused consequence suites |

T1 case command:

```sh
node --experimental-strip-types --test tests/e2e100-t1-customer-booking.test.mjs
```

Result after fixes: **25 passed, 0 failed, 0 skipped**.

The pre-change focused T1 regression inventory executed 884 relevant tests and passed **884/884**. After the payment-link corrections, the T1 matrix plus affected payment, refund and reconciliation suites passed **93/93**.

## Confirmed defects and behavioral corrections

### T1-DEF-001 — concurrent OTP challenges duplicated canonical customers

Classification: confirmed code defect.

Failing actor/request:

```json
{
  "actor": "anonymous_customer_otp",
  "request": {
    "phoneVariants": ["+91 90000 01001", "9000001001"],
    "cityId": "blr",
    "concurrentVerifiedChallenges": 2
  },
  "responseBeforeFix": {
    "customerIds": ["CUS-5781C75D-B07", "CUS-F74F5E9B-E04"]
  }
}
```

Relevant failed D1 truth (sanitized test data):

```json
[
  {"id":"CUS-5781C75D-B07","name":"First Request","primary_phone":"9000001001"},
  {"id":"CUS-F74F5E9B-E04","name":"Second Request","primary_phone":"9000001001"}
]
```

First incorrect canonical write: each verifier generated a random customer ID after both read the phone as absent. Correction: a SHA-256-derived ID that does not embed the plaintext phone now makes the primary-key insert the atomic identity claim; both responses reload the persisted canonical row. Permanent regression: `concurrent OTP registrations for one phone bind to exactly one canonical customer`.

### T1-DEF-002 — provider/local payment-link expiry diverged

Classification: confirmed code defect found while inspecting PR #302.

Before correction, the provider request omitted `expire_by`, local D1 invented a 24-hour expiry independently, and an expired HTTPS URL still returned `collectable:true`. Correction: send a 24-hour Unix-seconds expiry, require the provider to echo a valid future expiry, persist that provider value in milliseconds, and make expired or settled links non-collectable. The partner renders checkout only when `collectable` is true.

### T1-DEF-003 — payment-link capture could strand the refund path

Classification: confirmed code defect found while inspecting PR #302.

First incorrect canonical write: `post_service_payment_requests` was created without the matching `payment_gateway_links` and reconciliation rows. A verified capture could resolve from webhook notes, but there was no link row on which to retain `gateway_payment_id`; governed refund initiation therefore could not find a captured provider payment. Correction: payment request, provider reference mapping and reconciliation record are written in one D1 batch. The regression executes link creation → verified capture → mapping update → refund event and checks exact rows.

### T1-DEF-004 — an open partner screen retained stale unpaid state

Classification: confirmed code defect found while inspecting PR #302.

The screen loaded payment truth only on selected-booking/manual refresh. It now refreshes only while the request is pending, stops on terminal payment state, and removes the checkout when the server reports settled/expired truth. No client transition marks money captured.

## Negative and money-truth outcomes

- Cross-customer booking/payment/address/pet access: refused.
- Foreign pet and unverified/pending/missing vaccination: refused before reservation.
- City/zone mismatch and unsupported serviceability: refused with zero business writes.
- Duplicate booking/order/coupon/payment submissions: idempotent or governed conflict.
- Concurrent slot collision: exactly one reservation survives.
- Client-reported capture without verified authority: does not create collected truth.
- Wrong capture amount/currency and tampered coupon amount: exception/refusal; canonical payment stays unchanged.
- Refund greater than collected: refused; booking total is not the ceiling.
- Completion without clean required evidence: refused.
- Cancelled/refunded work: excluded from CRM conversion/revenue achievement and reminder cadence.

## External and policy boundaries

| Boundary | Classification | Engineering result |
|---|---|---|
| Sitting hourly/daycare products | Missing business policy/catalogue | No package or governed price exists. The server returns 404; only implemented Home Visit and Overnight were exercised. No price was invented. |
| Razorpay account and live money | External-account blocker | Local external-style HTTP contracts cover accepted/failure responses and signed callbacks. No actual Razorpay credential, charge, capture or refund is claimed. |
| Production Maps/GPS/provider availability | External/configuration boundary | UAT route classes and canonical scheduling were exercised; no production distance, live provider or GPS claim is made. |

Engineering integration readiness is distinct from actual-provider verification. T1 is engineering-ready subject to the explicit Sitting product-policy gap; real-provider verification remains outstanding.

## Exit gates

| Gate | Result |
|---|---|
| T1 isolated matrix | PASS — 25/25 |
| Focused payment/refund/reconciliation rerun | PASS — 93/93 |
| Typecheck | PASS |
| Lint | PASS — 0 errors (pre-existing warnings remain) |
| Repository Web tests | PASS — 2,534/2,534 non-listener cases; the two localhost Wrangler/D1 listener tests cannot bind in this managed workspace and are delegated to exact-head Release CI |
| `npm test` | LOCAL ENVIRONMENT BLOCKER — its build and 2,534 tests passed separately; launch is intercepted when the two localhost listener suites request a socket |
| Build | PASS |
| Artifact validation | PASS |
| Exact-head Release CI | PENDING PR push |

## Release and safety statement

Exactly one T1 pull request will be opened from `testfix/e2e100-t1-customer-booking`. This work does not merge PR #302, merge T1, deploy any environment, move live money, contact a live provider or modify the preserved demo seed.
