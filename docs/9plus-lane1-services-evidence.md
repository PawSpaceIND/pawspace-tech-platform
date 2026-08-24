# PawSpace 9+ closure evidence — Lane 1 service journeys

## Candidate identity and boundary

- Starting `origin/main`: `a95ed7adbbf513ed78e4b88b22afa38ce3b5c940`.
- Open pull requests in the initial enumeration before work began: none. Re-enumeration before this PR found concurrent PRs [#302](https://github.com/PawSpaceIND/pawspace-tech-platform/pull/302) (Lane 3 money/communications) and [#303](https://github.com/PawSpaceIND/pawspace-tech-platform/pull/303) (Grooming commercial catalogue). Their changed files do not overlap this candidate.
- Candidate branch: `closure/9plus-lane1-services`.
- This lane does not merge or deploy production. The only permitted hosted action is the isolated `pawspace-release-preview` workflow at an exact commit SHA.
- The canonical booking route, shared scheduling/capacity/provider-assignment core, provider/KYC/Maps/media, payment/Finance/communications infrastructure, AI/voice/readiness registry and deployment workflows are unchanged.

## Scoring rule

`Build` measures implemented server/customer behaviour, `Proof` measures non-vacuous executable coverage, and `Hosted` measures the exact candidate on the isolated release preview at phone/tablet/desktop sizes. A score of 9 requires executable proof; source-text assertions alone never qualify. Hosted scores remain `pending` until both exact-head release CI and the isolated preview UI gate are green.

| Owned module | Build | Proof | Hosted | Exact executable basis |
|---|---:|---:|---:|---|
| Grooming | 9.4 | 9.5 | pending | Golden journey, booking swarm, customer integrity, payment reconciliation, pricing/coupon runtime and completion-proof gates |
| Training | 9.1 | 9.2 | pending | Quote/capture/programme creation, exact session materialisation, trainer/session lifecycle, no-capacity recovery, cancellation/refund and reconciliation runtime |
| Boarding | 9.2 | 9.3 | pending | Owned-pet/vaccination authority, persisted city/zone quote, exact stay reservation, verified host, split payment, care plan, proof, recovery and finance projections |
| Pet Sitting | 9.2 | 9.2 | pending | Persisted city/zone quote, captured-amount binding, exact care reservation, booking bundle, lifecycle/proof/recovery gates |
| Dog Walking | 9.3 | 9.4 | pending | Server package/session quote, exact recurring reservations, walker assignment/refusal, route proof, replacement and cancellation/finance runtime |
| Pet Taxi | 9.0 | 9.2 | pending | Server route-class quote, pickup window/trip lineage, one-pet scheduling, provider refusal, handover/route proof and recovery; explicitly controlled-review/UAT only |
| Fresh Food | 9.3 | 9.5 | pending | Pet-bound quote/order, inventory reservation, SKU/lot fulfilment, subscription renewal, delivery proof, cancellation/recovery, idempotency and finance projection runtime |
| Relocation | 9.1 | 9.1 | pending | Customer form payload, authenticated enquiry persistence, staff operational visibility, state mutation and production-truth refusal tests |
| Customer navigation and service catalogue | 9.1 | 9.1 | pending | All eight service routes/build artifacts, server-owned package presentation, governed city propagation and disconnected-claim assertions; final responsive gate pending |
| Pricing, coupons, plans, subscriptions, wallet and referrals | 9.3 | 9.5 | pending | Real SQLite/D1 quote, expiry, consume, reserve, release, replay, ownership, city and idempotency-collision execution |
| Cancellation, reschedule and fulfilment rules | 9.2 | 9.4 | pending | Per-vertical lifecycle, no-orphan recovery, money-state projection, required proof and canonical operations tests |

The Build/Proof scores are candidate scores. Hosted scores and the final 9+ decision are published only after the exact-head gates below complete.

## Defects closed in this candidate

1. Boarding and Sitting quotes now persist the resolved city and zone. Confirmation rejects a browser relabel to another city/zone before consuming the quote.
2. The mobile stay flow and standalone Boarding/Sitting pages pass an explicit governed location into server quote creation.
3. The standalone Sitting page no longer starts human testing with a fixed date that becomes stale; it derives a future care window.
4. Coupon redemption idempotency keys are bound to quote, booking and customer. Cross-payload reuse returns a governed conflict.
5. Referral claim keys are bound to code, referred customer, service and city; reward reservation keys are bound to reward, booking and customer.
6. Subscription-wallet keys are bound to subscription, action, booking, actor and reserve-credit count.
7. Fresh Food order keys are bound to quote, customer, city and zone, preventing a retry key from returning an unrelated order.

## Executable evidence added

### `tests/lane1-commercial-runtime.test.mjs`

- Coupon quote → consume → exact retry; expiry, unsupported city and cross-payload key collision refusal.
- Referral claim in governed Chennai (`maa`) → first completed/paid booking → reward; retry, self-referral, unsupported city and cross-customer key collision refusal.
- Subscription wallet reserve → consume/release; expiry, ownership mismatch, credit mismatch and cross-subscription key collision refusal.

### `tests/stay-quote-city-binding.test.mjs`

- Boarding persists `maa/maa-central` quote truth and refuses a Bengaluru scheduling relabel.
- Sitting accepts matching persisted/scheduled Chennai truth and refuses a Bengaluru relabel.

### Extended executable regression

- `tests/food-hardening.test.mjs` now proves a Food idempotency key cannot be reused for a different quote or delivery context.
- `tests/stay-split-payments.test.mjs` now requires the customer flow to submit the governed quote city/zone.

## Existing runtime proof used by the assay

| Concern | Principal executable suites |
|---|---|
| Grooming end to end | `grooming-golden-journey`, `grooming-booking-swarm-runtime`, `grooming-customer-integrity`, `grooming-pricing-coupon-runtime`, `grooming-payment-reconciliation` |
| Training commercial/work proof | `training-hardening`, `training-programme`, `training-session-lifecycle`, `training-booking-guards`, `training-ops-actions` |
| Boarding/Sitting | `boarding-reservation-authority`, `boarding-host-discovery`, `boarding-gate1..5`, `sitting-captured-amount`, `sitting-payment-binding`, `sitting-gate1..5`, `stay-split-payments` |
| Walking/Taxi | `walking-flow`, `taxi-flow`, `walking-taxi-ops-hardening`, `walking-gate1..5`, `taxi-gate1..5` |
| Food | `food-flow`, `food-hardening`, `food-supply-chain`, `food-subscription-renewal`, `food-gate1..5` |
| Relocation | `relocation-enquiry`, `relocation-closure` |
| Identity/location/replay | `booking-replay-scoping`, `canonical-booking-city-zone-integrity`, `city-propagation-closure`, `service-zone-pincode-validation` |
| Commercial controls | `lane1-commercial-runtime`, `coupon-governance-uat`, `referral-governance-uat`, `subscription-plan-governance`, `subscription-wallet-uat`, `wallet-credit-dual-control` |

## Local candidate verification

- Lane 1 executable pack on the current PR base: **587 tests passed, 0 failed**.
- Typecheck: passed.
- Lint: 0 errors; 18 pre-existing warnings outside this change.
- Production build: passed.
- Artifact validation: passed.
- Broad local suite: 299 of 301 test files passed in bounded runs. The two remaining real-D1 files start local Wrangler child processes and are intentionally left to the unrestricted GitHub Release CI environment; this is an environment-boundary limitation, not a recorded test failure.

## Cross-lane blockers and launch truth

These do not authorize Lane 1 to edit the owning files and must remain visible in the human-test decision:

1. **CROSS-LANE-BLOCKER — Training second-city activation (Lane 2):** the customer guard and commercial quote currently support Bengaluru only, while final quote/location binding is performed through the excluded canonical booking core. Chennai must not be presented as bookable Training until the shared booking boundary carries and verifies persisted quote city/zone and a governed trainer roster is activated.
2. **CROSS-LANE-BLOCKER — Second-city provider capacity (Lane 2):** Lane 1 proves city propagation, quote persistence and cross-city refusal. A full hosted Chennai fulfilment journey for each provider-led vertical additionally requires governed Chennai provider profiles, availability and capacity owned by the shared assignment lane.
3. **CROSS-LANE-BLOCKER — External adapters (Lane 3):** real payment gateway/capture, Maps/GPS, media/object storage, WhatsApp/SMS/email and provider/KYC verification remain fail-closed or sandboxed. Human UAT must not interpret sandbox payment, route samples, queued communications or private-media metadata as a live integration.
4. **CROSS-LANE-BLOCKER — Pet Taxi launch scope (Lanes 2/3):** Taxi is executable in controlled review with canonical trip lineage and proof gates, but production routing/GPS, driver roster and communications must be certified by their owners before live-service UAT.

## Exact-head gates required for final 9+ status

1. Release CI on the final pull-request head: Web tests (full tracked suite), lint, typecheck, artifact, Runtime D1, scheduler D1, pricing D1 and production-readiness truth.
2. Deploy that exact SHA only to the isolated `pawspace-release-preview` Worker/D1.
3. Run `Release UI closure` against that preview. It discovers all application routes and verifies route rendering, controls, and phone/tablet/desktop layouts. The eight owned service entry points must be visible and reachable, with no disconnected integration represented as live.
4. Record the run URLs and preview evidence in the PR/final closure report. Do not merge and do not deploy production.
