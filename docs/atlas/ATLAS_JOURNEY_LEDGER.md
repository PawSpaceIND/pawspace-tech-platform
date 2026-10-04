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

## 2. Source to compiled artifact correspondence (LOCAL)

`scripts/ops/atlas-session/local-artifact-receipt.json` records the rebuild of `worker/atlas-revision-diagnostic-entry.ts`
via `scripts/ops/atlas-session/build-diagnostic-bundle.mjs` (esbuild, no network). The test
`tests/atlas-revision-diagnostic-contract.test.mjs` rebuilds the artifact and asserts the receipt hash, then drives the
compiled module over a real localhost TCP HTTP server with a real signed Founder UAT cookie against a SELECT-only
SQLite D1 facade. Semantic diff fc38 -> rebuilt artifact: contract marker, `observeRevision`, nullable identity and the
entry rename only; the native transport boundary is byte-identical in behaviour.

Simulated and labelled: the `cloudflare:workers` ambient env, the D1 binding, the https scheme/workers.dev host.
workerd was not used. These are what fc38's local HTTP receipt also simulated; they remain local evidence only.

Test results (local): contract suite 10/10, existing fixture-isolation suite 69/69, first journey 1/1.

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

## 4. 21-row operational ledger

**Missing artifact:** the frozen 21-case cohort list is not in this repository (HEAD 799cf99), not in the pinned commit
9dcbcdf, and not in the handoff packet (HANDOFF.md, manifest.json, INDEPENDENT-REVIEW.md, CLAUDE-PROMPT.txt). The only
local references are to Mac paths that are provenance, not bundled. The cohort IDs therefore cannot be filled in here
without inventing them. Row 1 is the executed Grooming case; rows 2 to 21 are reserved for the frozen cases and carry
the candidate path family that the existing route/test surface can execute once each case definition arrives.

Outcome vocabulary: `autonomous` (route executed with no human actor), `manual` (requires an external or simulated
human/physical/payment input), `blocked` (refused or cannot be executed; exact reason given). Hosted whole-job: 0/21.

| # | Frozen case ID | Candidate path family (CANDIDATE, not the cohort) | Local executable status | Autonomous stages | Manual stages | Blocked stages |
|---|---|---|---|---|---|---|
| 1 | *(missing; Grooming BLR prepaid)* | enquiry -> follow-up, this document §3 | **EXECUTED LOCALLY** | 1,2,4,5,6,8 | 3 (quote gap), 6b (TEST payment), 7 (TEST provider/media) | 9 (governed 412) |
| 2 | *(missing)* | second-city Grooming (MAA) same chain | harness exists (`grooming-golden-journey` test 2) | same as #1 | same | 9; cohort ID |
| 3 | *(missing)* | no-capacity refusal with no orphan rows | harness exists | reservation refusal | none | cohort ID |
| 4 | *(missing)* | captured booking cancellation + refund simulation | harness exists; refund is TEST | cancellation | refund (TEST) | cohort ID; live refund never local |
| 5 | *(missing)* | provider unavailability after reserve -> reassignment request | harness exists | detection | staff reassignment (`provider-assignment-recovery`, `bookings.manage`) | cohort ID |
| 6 | *(missing)* | reassignment executed by staff | route exists, not chained | none | staff action + approval | cohort ID; staff approval evidence |
| 7 | *(missing)* | reschedule with customer change-consent | `grooming-booking-change` route exists | none | customer consent | cohort ID |
| 8 | *(missing)* | multi-pet booking pricing | governance exists | pricing | none | cohort ID |
| 9 | *(missing)* | coupon-less full-price booking | harness supports | all of #1 minus 3 | 6b,7 | 9; cohort ID |
| 10 | *(missing)* | subscription purchase + usage | tables exist | unknown | payment (TEST) | cohort ID; not exercised |
| 11 | *(missing)* | arrival geofence failure path | lifecycle route | refusal | GPS (TEST) | cohort ID |
| 12 | *(missing)* | media scan quarantine path (`PAWSPACE_MEDIA_ENV`) | service-media route | quarantine | scan decision (staff) | cohort ID |
| 13 | *(missing)* | completion without proof refusal | executed inside #1 (409) | refusal | none | cohort ID |
| 14 | *(missing)* | invoice tax policy missing -> no invoice | observed log line in run (`No active tax policy names the seller` for a pre-seed id) | detection | Finance seller policy | cohort ID; Finance config |
| 15 | *(missing)* | settlement readiness / provider commission | tables written by completion | posting | Finance verification | cohort ID; payouts never local |
| 16 | *(missing)* | post-service review invitation | GET executed in #1 (200, `no_approved_config`) | read | approved review config | cohort ID |
| 17 | *(missing)* | feedback call scheduled with real consent + city policy | route exists | none | explicit customer consent; Ops policy | cohort ID; consent cannot be simulated as real |
| 18 | *(missing)* | public (anonymous) web enquiry -> lead -> CRM owner | `public-contact` route | lead rows | none (AI turn would be a paid model call: excluded) | cohort ID; model budget |
| 19 | *(missing)* | staff CRM read of owned conversation | `crm/chat` route | read | staff auth | cohort ID |
| 20 | *(missing)* | customer callback request via governed voice | web-chat `request_call` | none | voice policy; consent | cohort ID; voice calls never local |
| 21 | *(missing)* | Atlas text-admission information turn (zero-model local) | `atlas-text-direct-admission` test exists | admission refusal paths | publisher-serialized dispatch | cohort ID; budget window expired (see §6) |

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
