# Atlas journey repair: ledger, receipts and finite plan

Owner of this lane: the single Claude implementation chat ("PawSpace Atlas journey repair"). Scope: local, non-outbound
source and executable tests only. No hosted switch, deployment, model or voice call, external contact, credential,
live transaction, payout, refund or filing was made or is authorised by anything in this document. The sole publisher
owns hosting and any separately authorised execution.

Every result below is labelled TEST/LOCAL. Nothing here is hosted whole-job evidence.

## 1. Diagnosed blocker and repair (run 37181747899)

Observed: HTTP409 `revision_unproven` with `checks:{}` at source `9dcbcdf9ba4f53907926fc1913eaf4747470b0c9` was recorded
as `diagnosticCaptured:true, ok:true` because the executed runner accepted any recognised code
(`receipt.diagnosticCaptured=receipt.temporaryFixture.code!==null`).

Findings from inspecting the exact commit (fetched as a detached object; it is not an ancestor of `main`):

| Finding | Evidence |
|---|---|
| Committed source emitted **no** predicates | `lib/staging-fixture-isolation.ts:52` at 9dcbcdf: `return json({ok:false,code:"revision_unproven"},409)` |
| Committed artifact fc38 **did** emit four booleans | `scripts/ops/atlas-session/atlas-api-review.js:439` at 9dcbcdf |
| fc38 was compiled from two uncommitted working trees | module headers `three-chat-release-review/lib/...` and `atlas-revision-diagnostic-review/lib/...` inside fc38 |
| Committed `worker/atlas-api-entry.ts` differs from fc38's entry | committed entry serves `/api/ai-web-chat` POST; fc38 serves only the fixture GET |
| Hosted artifact/routing identity | **UNPROVEN**. The sanitizer yields `checks:{}` for an absent `checks`; which artifact answered at the edge was never read. Not a confirmed propagation cause. |

Repair (response and runner together, all in this branch):

- `lib/staging-fixture-isolation.ts`: `observeRevision()` always emits the four booleans, a versioned marker
  `diagnosticContract:"atlas-revision-diagnostic-v2"` and `version:{buildSha,id,timestamp}` where each field is a
  well-formed public identifier or `null` (unknown). A predicate is true only when the value it describes is non-null.
  The HTTP200 attestation carries the same marker and observed identity. Normal auth, Founder requirement, scope,
  runtime gates, SELECT-only reads and all existing assertions are preserved (69 existing tests still pass).
- `scripts/ops/atlas-session/diagnostic-contract.mjs`: `classifyDiagnostic(status, RAW payload, {expectedSha,
  expectedVersion, artifactContentVerified})` returns three separate facts (`transportCaptured`, `contractQualified`,
  `operationalSuccess`) and a decision: `BLOCKED` (marker absent, predicates missing/wrong-type/foreign, identity raw
  type not string|null, all-true 409, predicate/identity inconsistency, version drift), `VERIFIED_REFUSAL` (complete
  409, `ok:false`, never success) or `FIXTURE_ATTESTED` (explicit HTTP200 contract: all booleans true, non-null expected
  identity, 64-hex snapshot digest). `modelAdmission` is always false. `edgeIdentityProven` requires the publisher's
  `artifactContentVerified` plus a matching expected version; a marker is never a bundle hash.
- `scripts/ops/atlas-session/sanitize-fixture.mjs`: persists the marker and records raw field types so a null in a
  receipt is attributable to the artifact or to sanitisation. It is for the receipt, not for acceptance.
- `scripts/ops/atlas-session/session-runner.acceptance.REFERENCE.patch`: the exact hunk against the pinned runner.
  The historical runner is NOT re-added as executable code: its approval window, version pin and mutable schedule/
  upload actions are expired reference material. `receipt.ok` in the patched runner means "protocol finished", never
  operational success.

### 1a. Publisher canary (post-6269668, bounded fix, uncommitted/unpushed)

Publisher finding: the HTTP200 branch accepted `checks:{unrelated:true}` with a valid marker, version and snapshot as
FIXTURE_ATTESTED / operationalSuccess:true. Confirmed; integration BLOCKED; no hosted run; the 69 pre-existing tests give no
success credit. Fix in `diagnostic-contract.mjs`: the attestation must declare a known `scope`, that scope must be the one the
runner requested (`expectedScope`, default `grooming_strict`), and `checks` must be EXACTLY that scope's 14 predicate keys
(7 runtime gates, 5 common, 2 scope-specific), all boolean true. Fewer, extra or renamed keys and roster-scope keys under a
strict request are BLOCKED (`attestation_predicates_incomplete`, `attestation_scope_invalid`, `attestation_scope_mismatch`).
Regression: `PUBLISHER CANARY` test in `tests/atlas-revision-diagnostic-contract.test.mjs`. The real compiled artifact's
HTTP200 still attests because its emitted key set is exactly the 14. The historical unit fixture that itself used an incomplete
`checks` object was corrected.

### 1b. Three HTTP200 acceptance gaps closed together (uncommitted/unpushed, patch 0003)

1. **Exact predicates:** `checks` must be exactly the 14 declared predicates of the declared scope, all boolean true;
   missing, extra, renamed or roster-under-strict keys are BLOCKED (`attestation_predicates_incomplete`).
2. **Exact scope and safety declarations:** declared `scope` must be known and equal the requested scope; the payload must
   carry `bookingMutationAuthorized:false`, `productionReadiness:false`, `assignmentLock:false` and
   `requiresMatchingDeploymentIsolationCertificate:true` exactly (`safety_declaration_missing_*` / `_violated_*`).
3. **Operational permission:** `ok`/`operationalSuccess` become true ONLY when the publisher supplied `expectedVersion`
   and the observed version matches AND `artifactContentVerified===true`. Otherwise the result is the separate decision
   `CONTRACT_QUALIFIED_ATTESTATION` with `ok:false, operationalSuccess:false, modelAdmission:false`
   (`expected_version_not_supplied` / `artifact_content_not_verified`). A well-formed foreign Worker UUID with an omitted
   expected version is qualified-only; with the expected version supplied it is BLOCKED (`observed_version_drift`).
   Null identity fields on a 200 are BLOCKED (`attestation_identity_unknown`).

Consequence: the local compiled-artifact HTTP200 in the contract test is now reported as CONTRACT_QUALIFIED_ATTESTATION,
never as operational success. Canaries: `PUBLISHER CANARY` (1), `PUBLISHER CANARY (2)`, `PUBLISHER CANARY (3)`, plus valid
qualified and valid operational examples. Contract suite: 13/13.

## 2. Source to compiled artifact correspondence (LOCAL)

`scripts/ops/atlas-session/local-artifact-receipt.json` records the rebuild of `worker/atlas-revision-diagnostic-entry.ts`
via `scripts/ops/atlas-session/build-diagnostic-bundle.mjs` (esbuild, no network). The test
`tests/atlas-revision-diagnostic-contract.test.mjs` rebuilds the artifact and asserts the receipt hash, then drives the
compiled module over a real localhost TCP HTTP server with a real signed Founder UAT cookie against a SELECT-only
SQLite D1 facade. Semantic diff fc38 -> rebuilt artifact: contract marker, `observeRevision`, nullable identity and the
entry rename only; the native transport boundary is byte-identical in behaviour.

Simulated and labelled: the `cloudflare:workers` ambient env, the D1 binding, the https scheme/workers.dev host.
workerd was not used. These are what fc38's local HTTP receipt also simulated; they remain local evidence only.

Test results (local): contract suite 13/13 (after the three-gap fix), existing fixture-isolation suite 69/69, first journey 1/1.

## 3. First executable normal Grooming journey (TEST/LOCAL)

`tests/atlas-grooming-first-journey.test.mjs`, run descriptor `FINANCE-TEST-OPS-GROOMING-01` (the existing APPROVAL
fixture string in `lib/atlas-text-test-admission.ts`; no second descriptor, no second harness: the existing
`tests/helpers/grooming-journey-harness.mjs` and the normal routes are reused). Packet:
`docs/atlas/first-journey-packet.TEST-LOCAL.json`.

| Stage | Route / function | Actor | Approval / consent | Outcome | Evidence | Replay / idempotency |
|---|---|---|---|---|---|---|
| 1 Enquiry | `POST /api/ai-web-chat` `bot:true,start:true` | customer (TEST session) | none; no model dispatched | autonomous | 200, owned thread id | re-start returns same thread |
| 2 Owned CRM / transcript | `communication_threads`/`messages`, `GET ?mode=thread` | customer (TEST session) | ownership by session subject | autonomous | owner 200 sees thread; other customer sees nothing | n/a |
| 3 Scoped quote | `quoteCoupon` -> `coupon_quotes`; package price governed server-side | coupon governance | none | **manual (GAP)** | quote row scoped to customer | n/a |
| 4 Explicit customer confirmation | `POST /api/canonical-bookings` with `idempotencyKey` | customer (TEST session) | none | autonomous (**GAP**: no accept-quote record) | 201 | replay `duplicatePrevented:true` |
| 5 Reservation / booking / work order | `POST /api/uat-scheduling`, canonical booking | customer + scheduler | none | autonomous | reservation, booking, `provider_work_orders` rows | schedule replay `duplicatePrevented:true` |
| 6 Assignment | governed capacity in scheduling | scheduler | none | autonomous | booking.provider_id = chosen provider; visible in provider feed | n/a |
| 6b Payment capture | `POST /api/grooming-payment-sandbox` `simulate_event` | **TEST sandbox event** | none | **manual (simulated)**; commercial mode `prepaid` unchanged | `booking_payments.status=captured` | replay `duplicate:true` |
| 7 Provider lifecycle + media | `POST /api/grooming-lifecycle`, `/api/grooming-route`, `/api/service-media` | provider (TEST session), **TEST GPS, TEST media bytes** | provider ownership; non-assigned provider 403 | **manual (external physical input)** | accept/on_the_way/arrived/start 200; complete-without-proof 409; proof 200; complete 200 | second `complete` 200 with no new finance |
| 8 Invoice + balanced accounts | completion finance inside `complete` | system | none | autonomous | 1 invoice; 5 journal rows; debits 3598 = credits 3598 | replay: invoice count 1, journal count unchanged |
| 9 Consented follow-up | `POST /api/post-service-feedback` `schedule_call` | customer (TEST session, **TEST consent flag**) | explicit consent required; refused without it | **blocked (governed 412)**: `call_policy_unknown, voice_consent_not_explicit, voice_consent_missing, timezone_unknown, quiet_hours_policy_unknown` | no call persisted | n/a |

Gaps surfaced by the journey (not patched here because each changes a commercial or consent model, which is the
publisher's and Finance's decision): Grooming has no persisted commercial quote table or quote-acceptance route
(other verticals have `*_commercial_quotes`); the follow-up call needs a real explicit voice-consent record, customer
timezone and the city call/quiet-hours policy. No consent, policy or price was fabricated to turn stage 9 green.

## 3a. Milestone 0004: governed Grooming quote/acceptance and TEST consent fixture (uncommitted/unpushed)

Inspected first: `lib/ai-sales-offers.ts` (reads approved coupon campaigns only), `lib/customer-offers.ts`, `lib/offer-engine.ts`
(types), `lib/voice-conversation-followup.ts`, `lib/outbound-routing-policy.ts`, `lib/ai-first-control-plane.ts` (a
`quote.request` capability string). None persists an offer acceptance or links to a booking. Every other vertical uses
`*_commercial_quotes` + `*_booking_quote_links`, and acceptance is the customer's canonical booking POST naming the quote.

Implemented on that pattern, reusing the canonical price authority (no manual price, no parallel catalogue):

- `lib/grooming-commercial-governance.ts`: `createGroomingQuote` prices through the existing
  `quoteGroomingBookingWithLiveMultiPet` and pins package, pets/species, city, zone, start, payment mode, totals, tax
  breakdown, catalogue version and optional coupon quote (which must be the customer's own open Grooming coupon quote priced
  on the same governed total). 15-minute TTL. `governGroomingQuoteAcceptance` refuses unless the quote is the customer's own,
  open, unexpired, unlinked, matches every booking parameter and coupon, and its pinned totals equal the amounts the booking
  route governed in the same request. Link and consume exactly once.
- `app/api/grooming-commercial/route.ts` (POST): normal `resolveActor` + `requireCustomerOwnership`, same-origin, audited.
  Returns `productionReady:false, liveMoney:false`.
- `app/api/canonical-bookings/route.ts`: optional `pricing.groomingQuoteId`; after live governance, acceptance check, link
  statement in the booking batch, consume after commit. Bookings without a quote follow the unchanged existing path.
- `tests/atlas-grooming-quote-acceptance.test.mjs` (2/2): quote equals live governance; foreign customer 403; tampered total
  409 with no booking written; payment-mode swap 409; acceptance 201 with link row, quote `used`, booking total and payment
  mode preserved, `pricing_json.groomingQuoteId`; replay idempotent; reuse of a consumed quote 409; expired quote 409;
  foreign quote 403; no-quote path unchanged.
- Shared harness `runCompletedJourney` gained an opt-in `groomingQuote` flag (same harness, no duplicate).

TEST consent fixture for the follow-up (stage 9), through existing writers only: call policy via the route's own env
contract, city quiet hours via `seedCommunicationPolicy`, timezone/service updates via `setCommunicationPreference`,
explicit voice consent via `recordVoiceConsent` with a TEST source. **Exact missing contract:** nothing in `lib/` or `app/`
writes `communication_consent.voice_allowed=1` (central channel consent); the only writer is `recordGlobalOptOut`. Older
tests insert the row with raw SQL. This lane does not fabricate it, so stage 9 remains blocked with exactly
`voice_consent_not_explicit`. Resolving it needs an owner decision on a customer-facing central consent writer.

First-journey observation after 0004 (TEST/LOCAL, OPS-GROOMING-01): autonomous 1,2,3,4,5,6,8; manual 6b (TEST capture),
7 (TEST provider lifecycle/GPS/media); blocked 9 (governed, `voice_consent_not_explicit`). Whole-case under the strict
criterion remains **blocked/manual**: provider and payment steps are simulations and the follow-up did not reach terminal.

## 3b. Milestone 0005: review findings on the 0004 quote/acceptance delta (uncommitted/unpushed)

Accepted 0003 classifier source is untouched (`scripts/ops/atlas-session/diagnostic-contract.mjs` hash unchanged).

1. **Final terms pinned and compared.** The quote now pins base package amount, selected add-ons (existing add-on catalogue
   per saved species) and their total, coupon id, coupon discount and final payable (from the customer's own coupon quote,
   which must be priced on exactly base+add-ons), amount due now, payment mode, declared pets, catalogue version, tax
   breakdown and the commercial policy version in force. The booking route runs acceptance AFTER it has governed the final
   amount (live base, add-ons, coupon final) and passes those final governed terms; every pinned term must equal them. No new
   discount or fee; configured prices and policy are read, never computed here.
2. **Exact minor units.** All amounts are stored and compared as integer paise (`toMinor`/`sameMinor`); 1349 vs 1349.49
   refuses. Coupon quotes past `expires_at` are refused at quote creation even when the row still reads `open`.
3. **Declared pets and scope.** Declared pets must be the customer's saved pets; species comes from the saved row and is
   cross-checked against the client claim; the canonical pet set (source id + species) is pinned and compared, so same-count
   substitution refuses. Catalogue version, pricing breakdown and commercial policy version are compared at acceptance.
   Authentication and ownership guards are unchanged (customer actor + ownership on quote; 403 for foreign customer/quote).
4. **Atomic consumption.** Link insert and conditional `status='used'` update are statements inside the booking's own batch;
   the link primary key makes a concurrent second acceptance fail as a whole batch (no booking, no link). Post-commit
   `reconcileGroomingQuoteLink` is idempotent repair only (link present but quote not used -> mark used; never the reverse).
   Proven: injected batch failure leaves no booking/link and the quote open; exact-key replay returns the same bundle with no
   new writes; two concurrent acceptances of one quote yield exactly one booking and one link.

Tests (`tests/atlas-grooming-quote-acceptance.test.mjs`, 5/5): add-on dropped with equal final -> 409; coupon removed -> 409;
paise deltas 0.49/0.01/-0.01 -> 409; expired coupon -> 409 at quote; pet substitution -> 409; unsaved/foreign pet -> 409/403;
catalogue/breakdown/policy drift -> 409; injected failure, replay, concurrency; optional path without quote unchanged.
Regressions: golden 6/6, completion-invoice 5/5, training coupon 9/9, city-zone 8/8, first journey 1/1.
Quote integration stays optional for legacy requests pending owner approval of a mandatory rollout.

### Separate proposal for owner decision: central voice-consent writer (NOT implemented)

Stage 9 remains consent-blocked (`voice_consent_not_explicit`): `communication_consent.voice_allowed` has no writer other than
`recordGlobalOptOut`. A narrow, legitimate writer would be: a customer-authenticated action on an existing customer settings
route (platform session subject only, `requireCustomerOwnership`), writing `communication_consent` for that subject with an
explicit `voice_allowed` boolean, `source` (app surface), `updated_by` (the customer subject) and `updated_at`, audited via
`securityAudit`, never callable by staff headers, and never defaulting a missing row to allowed. Tests would then record a
TEST consent through that route. This is a consent-model change and is not made here.

## 3c. Milestone 0006: P1/P2 closure, governed consent writer, executable 21-case harness (uncommitted/unpushed)

**P1 (eligibility inside the transaction).** `groomingQuoteAcceptanceStatements` now (1) consumes the quote only if it is still
open, unexpired at commit time and owned by this customer, then (2) inserts the link with `quote_id` taken from a subquery that
matches only when step 1 consumed THIS quote for THIS booking; the NOT NULL/CHECK constraint raises otherwise, so booking, work
order, payment, link and consume all roll back. The route maps that guard error to HTTP409 `grooming_quote_not_acceptable`.
Proven: expiry injected between validation and batch; status flipped to used between validation and batch; the reviewer's
supplied-statement canary against an expired quote (batch rejects, no link, quote open); foreign customer in statements;
concurrent acceptance (exactly one booking/link); SQL failure rollback; healthy acceptance still 201.

**P2 (replay reconciliation on the normal route).** The existing early idempotency replay now, when the request names a
Grooming quote, runs `reconcileGroomingQuoteLink` and returns `quoteReconciliation` in the bundle. It repairs ONLY a linked-but-
open quote whose link was written before the quote's expiry; a link written after expiry, or a quote used by another booking,
is reported (`staleLinkDetected`, reason) and left untouched. It never un-consumes, never links, never creates a booking.
Proven on the real route: healthy replay (consistent), injected torn row (repaired, same bookingId, 1 booking, 1 link), stale
link (reported, quote stays open), used-by-other (reported, untouched), replay without quote id (no reconciliation).

**Consent writer: proposed, implemented, verified (separately).**
- Proposed (previous ledger): narrow customer-authenticated, customer-owned central consent writer.
- Implemented: `recordCustomerChannelConsent` in `lib/communication-governance.ts` and `POST /api/customer-communication-consent`.
  Principal is the platform-session SUBJECT only (no staff header, no caller-supplied id for another customer: 403), explicit
  boolean required, allow-listed app sources, missing row created with every other channel NULL (never defaulted to allowed),
  explicit refusal persisted as 0, global opt-out never lifted, audited with the customer as actor.
- Verified (`tests/customer-communication-consent.test.mjs`): 401/403/400 paths, single-channel write, refusal, opt-out
  precedence, audit rows. Stage 9 of OPS-GROOMING-01 now reaches a scheduled feedback call (201, one persisted call, refused
  without consent) using the governed writer as the TEST customer's own session. This is TEST consent by a synthetic customer:
  stage 9 is **manual(TEST consent)**, not autonomous, and no consent row was inserted directly.

**Executable 21-case harness** (`tests/atlas-cohort-21-harness.test.mjs`, 21/21): reads the frozen source JSON unchanged and
writes a separate observation per ID to `docs/atlas/cohort-21-observations.TEST-LOCAL.json`. Executors exist for
OPS-GROOMING-01 (normal) and OPS-GROOMING-02 (cancel_refund: chain to TEST capture, customer cancellation 200, booking/work
order/reservation cancelled, refund case `requested`, payment `refund_pending`; refund/reversal NOT executed because the cohort
lists Finance authorization as mandatory and a gateway refund event is an external input; follow-up not executed because the
booking is not completed). The other 19 IDs are `not_executed` with "no local executor for <service>/<branch>; nothing inferred".
Strict criterion applied by the harness: **0/21 qualified whole journeys**. The harness asserts that a TEST-simulated or blocked
case is never counted as qualified.

## 4. 21-row operational ledger (frozen cohort, actual IDs)

**Source:** `docs/atlas/frozen-cohort-21.source.json`, the sanitized cohort supplied by the user on 2026-10-04 as JSON text
(native picker malfunction). Original pretty-file SHA-256 `7c452f2d5bb97960356bb99cd01bed7cc3bebeb29933a8e3a6ed6c3054abc239`
(not reproducible here: formatting differs); stored compact copy SHA-256 `868530bf8008c926afbd6d73e913882048165acb363dc559139bcc68624ef602`.
Frozen at 2026-10-03T06:44:07.820855+00:00, 21 unique IDs, stream "separate operational robustness pilot". Source fields are never overwritten; the
"Current observation" column is this lane's separate record.

**Strict criterion (unchanged from source):** correct FULL declared terminal outcome with zero staff/provider/Finance/human operational steps; required end-customer inputs disclosed separately
**Rate policy (source):** completed full-chain sandbox rate unavailable until terminal observations; 0/21 currently evidenced coverage is NOT a measured operational failure rate
Any later metric that excludes physical-provider steps must be declared separately and never replace this criterion.

Current coverage under the strict criterion: **0/21 qualified whole journeys** (harness-computed; 2 executed locally as TEST, 19 not executed). Hosted whole-job: 0/21.

| # | Frozen ID | Service | Branch | Frozen baseline (source) | Current observation (this lane) | Mandatory approvals (source) | Detail |
|---|---|---|---|---|---|---|---|
| 1 | `OPS-GROOMING-01` | grooming | normal | not_executed / observedAutonomousSuccess:false | blocked/manual (TEST) | none listed | **EXECUTED LOCALLY (TEST).** Autonomous 1,2,3,4,5,6,8; manual 6b (TEST payment capture), 7 (TEST provider lifecycle/GPS/media), 9 (feedback call scheduled with TEST consent through the governed writer; synthetic customer). Terminal reached locally; fails the strict criterion because provider, payment and consent inputs were simulations. |
| 2 | `OPS-GROOMING-02` | grooming | cancel_refund | not_executed / observedAutonomousSuccess:false | blocked (Finance authority) | Finance authorization for refund/reversal where policy requires | **EXECUTED LOCALLY (TEST) to the authority boundary.** Autonomous chain to assignment, customer cancellation (200), capacity release; manual 6b (TEST capture); blocked 9: refund/reversal requires Finance authorization and an external gateway refund event, neither executed; 10, 11 not executed. No automatic refund. |
| 3 | `OPS-GROOMING-03` | grooming | recovery_switch | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for grooming/recovery_switch; nothing inferred. |
| 4 | `OPS-TRAINING-01` | training | normal | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for training/normal; nothing inferred. |
| 5 | `OPS-TRAINING-02` | training | cancel_refund | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | Finance authorization for refund/reversal where policy requires | Not executed: no local executor for training/cancel_refund; nothing inferred. |
| 6 | `OPS-TRAINING-03` | training | recovery_switch | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for training/recovery_switch; nothing inferred. |
| 7 | `OPS-BOARDING-01` | boarding | normal | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for boarding/normal; nothing inferred. |
| 8 | `OPS-BOARDING-02` | boarding | cancel_refund | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | Finance authorization for refund/reversal where policy requires | Not executed: no local executor for boarding/cancel_refund; nothing inferred. |
| 9 | `OPS-BOARDING-03` | boarding | recovery_switch | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for boarding/recovery_switch; nothing inferred. |
| 10 | `OPS-SITTING-01` | sitting | normal | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for sitting/normal; nothing inferred. |
| 11 | `OPS-SITTING-02` | sitting | cancel_refund | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | Finance authorization for refund/reversal where policy requires | Not executed: no local executor for sitting/cancel_refund; nothing inferred. |
| 12 | `OPS-SITTING-03` | sitting | recovery_switch | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for sitting/recovery_switch; nothing inferred. |
| 13 | `OPS-WALKING-01` | walking | normal | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for walking/normal; nothing inferred. |
| 14 | `OPS-WALKING-02` | walking | cancel_refund | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | Finance authorization for refund/reversal where policy requires | Not executed: no local executor for walking/cancel_refund; nothing inferred. |
| 15 | `OPS-WALKING-03` | walking | recovery_switch | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for walking/recovery_switch; nothing inferred. |
| 16 | `OPS-PET_TAXI-01` | pet_taxi | normal | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for pet_taxi/normal; nothing inferred. |
| 17 | `OPS-PET_TAXI-02` | pet_taxi | cancel_refund | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | Finance authorization for refund/reversal where policy requires | Not executed: no local executor for pet_taxi/cancel_refund; nothing inferred. |
| 18 | `OPS-PET_TAXI-03` | pet_taxi | recovery_switch | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for pet_taxi/recovery_switch; nothing inferred. |
| 19 | `OPS-FOOD_DELIVERY-01` | food_delivery | normal | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for food_delivery/normal; nothing inferred. |
| 20 | `OPS-FOOD_DELIVERY-02` | food_delivery | cancel_refund | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | Finance authorization for refund/reversal where policy requires | Not executed: no local executor for food_delivery/cancel_refund; nothing inferred. |
| 21 | `OPS-FOOD_DELIVERY-03` | food_delivery | recovery_switch | not_executed / observedAutonomousSuccess:false | not_executed (no observation) | none listed | Not executed: no local executor for food_delivery/recovery_switch; nothing inferred. |

Critical fail gates (source): identity/CRM linkage, consent, booking/capacity, invoice/tax/accounts, refund/authority, safe mode switch. Prohibited (source): external delivery, live money, new payouts, paid model/voice, government submission, policy/production change, publish/merge/deploy, shared browser control.

## 5. Exact next publisher-owned read-only hosting identity check

Performed by the sole publisher only, with existing authenticated access; nothing here is run by this lane.

1. Read active deployment: `GET /accounts/{id}/workers/scripts/pawspace-staging/deployments`; record `version_id`,
   percentage and timestamp (**before**).
2. Read served module content: `GET /accounts/{id}/workers/scripts/pawspace-staging/content` (or the versions content
   endpoint for that `version_id`); SHA-256 the main module bytes.
3. Re-read deployments (**after**); refuse the result if `version_id` or timestamp changed between 1 and 3.
4. Compare the content hash with the approved artifact hash. Today the only approved-by-source hash is
   `local-artifact-receipt.json#artifactSha256` for a *future* upload; the normal restored staging must hash to the
   certified normal bundle, not to fc38 or to this artifact. Any match to fc38 means the temporary artifact is still
   serving and restoration is incomplete.
5. Only with (4) recorded may a later, separately authorised origin diagnostic set `artifactContentVerified:true` and
   `expectedVersion` when calling `classifyDiagnostic`. Control-plane upload acknowledgement is not edge proof.

## 6. Budget, window and authority preservation

- The encoded cap is `capMicros:5_000_000` (US$5, tax excluded) plus the separate tax-scope approval, `maxTurns:10`,
  window `2026-10-03T14:11:15Z` to `15:11:15Z`, in `lib/atlas-text-test-admission.ts`. This lane changed none of it,
  did not reset the ledger, did not reuse the expired window and created no new approval. The user-stated cumulative
  US$6 figure is the inclusive total of these approvals; the code encodes the model-usage part.
- Running 21 journeys does not acquire any model calls: journey stages 1 to 9 are zero-model. Any future Atlas
  information turn stays inside the existing single-admission ledger and needs publisher-validated budget and window.
- The historical runner's one-time approval (`2026-10-04T04:43:05Z` to `08:28:00Z`) is expired reference code.

## 7. Autonomous / manual / blocked summary for this lane

Autonomous (done, verified locally): blocker diagnosis; response+runner contract repair; source-pinned artifact build
and hash receipt; actual local HTTP contract tests; first journey stages 1,2,4,5,6,8; ledger scaffold.

Manual (publisher / Finance / Ops): hosted identity read (§5); decision on a Grooming quote/acceptance model; real
customer consent, timezone and city call policy for stage 9; Finance seller tax policy row; any paid or hosted
execution.

Blocked (exact): frozen 21-case cohort definition missing from repo and packet; hosted edge identity unproven;
stage 9 governed 412; workerd not used locally (Node HTTP only); pinned commit 9dcbcdf is not on `main`, so the
historical runner directory exists only there.
