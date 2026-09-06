# E2E100 T2 — Provider, auto-assignment, Operations and multi-city evidence

Date: 2026-08-24 (Asia/Kolkata)
Repository: `PawSpaceIND/pawspace-tech-platform`
Branch: `testfix/e2e100-t2-provider-operations`
Shared candidate tested: `a8df4e301233ac18e947e382a8d18fcd8bb8e015`
Current `main` observed before branching: `0b6695c8a2c311b1ba9e5fad468198b5f688545c`
Deployment/merge: **none**

## Baseline and scope controls

- `origin/main` was fetched with pruning before testing. The main SHA above is the merge of PR #305.
- PR #302 was inspected and its exact head matched the agreed candidate: `a8df4e301233ac18e947e382a8d18fcd8bb8e015`.
- Open pull requests before T2 mutation: #302, #304, #306, #307 and #308.
- This branch was created directly at the shared candidate, not at moving `main`.
- `scripts/uat-demo-seed.sql`, `scripts/uat-demo-seed-gen.mjs` and `tests/uat-demo-seed.test.mjs` have no T2 diff. All T2 records are created in fresh in-memory D1/SQLite databases and disappear after each case.
- No provider payout, tax, penalty, eligibility or city-authorization policy was invented.

## Result

**25/25 isolated T2 cases pass.** `tests/e2e100-t2-provider-operations.test.mjs` runs each case in a fresh Node process; every selected regression creates a new D1 database. The focused provider/Operations selection passes **682/682** after the fixes, and the seven new integrity regressions pass **7/7**.

The five-city roster test creates 30 governed provider profiles: groomer, trainer, host, sitter, walker and taxi driver/handler in each of Bangalore (`blr`), Mumbai (`mum`), Pune (`pune`), Hyderabad (`hyd`) and Chennai (`chn`). Exact city, zone and service filtering is asserted for every one of the 30 combinations.

| Case | Executed objective | Result |
| --- | --- | --- |
| E2E100-T2-026 | Groomer application, verification, readiness and UAT activation | Pass |
| E2E100-T2-027 | Trainer application, vertical mandates and training readiness | Pass |
| E2E100-T2-028 | Host application and live/active/verified discovery | Pass |
| E2E100-T2-029 | Sitter eligibility and explicit host selection | Pass |
| E2E100-T2-030 | Walker booking → work → completion → Finance | Pass |
| E2E100-T2-031 | Taxi driver/handler eligibility and replacement attribution | Pass |
| E2E100-T2-032 | Rejected verification and incomplete onboarding refusal | Pass |
| E2E100-T2-033 | Provider service eligibility at offer creation | Pass |
| E2E100-T2-034 | City and zone eligibility at booking and offer boundaries | Pass |
| E2E100-T2-035 | Five-city/six-role isolation (30 profiles) | Pass |
| E2E100-T2-036 | IST working hours, weekly roster and time-off exclusion | Pass |
| E2E100-T2-037 | Capacity and overlapping-booking prevention | Pass |
| E2E100-T2-038 | Deterministic highest-score auto-assignment | Pass |
| E2E100-T2-039 | No-eligible-provider recovery without assignment loss | Pass |
| E2E100-T2-040 | Accept, decline, unavailable, expiry/no-response and recovery | Pass |
| E2E100-T2-041 | Staff reassignment with actor and audit history | Pass |
| E2E100-T2-042 | Replacement preserves booking, completed work and payment truth | Pass |
| E2E100-T2-043 | Start-service lifecycle and provider ownership | Pass |
| E2E100-T2-044 | Private evidence, scan gate and maker/checker proof security | Pass |
| E2E100-T2-045 | Canonical completion and customer-facing acknowledgement | Pass |
| E2E100-T2-046 | Offer expiry, late/no-show recovery | Pass |
| E2E100-T2-047 | Incident/case escalation without automatic guilt or deduction | Pass |
| E2E100-T2-048 | Commission versus hired-provider visibility and earnings treatment | Pass |
| E2E100-T2-049 | Incentive review/dispute and capped sandbox settlement preparation | Pass |
| E2E100-T2-050 | Canonical achievement, Operations dashboard/reports and own-record views | Pass; see city-role policy blocker below |

The exact backing test file and selected behavioural test name for every case are permanent data in `tests/e2e100-t2-provider-operations.test.mjs`; a missing or non-matching regression fails the case rather than silently skipping it.

## Reproduced defects and retained evidence

The first run of `tests/provider-operations-integrity.test.mjs` was **0/4**. These were code defects, not provider/account blockers.

| Defect | Actor and request | Pre-fix response | D1 evidence retained in regression | Minimal correction |
| --- | --- | --- | --- | --- |
| T2-F1 synthetic/out-of-scope job offer | Operations assignment caller; `offerJobToProvider({providerId, bookingId})` with missing booking, inactive/offline roster, wrong city/zone/service, or exhausted capacity | Returned `{status:"offered"}` and inserted `provider_job_offers` | Invalid inputs now leave offer count at zero; the one eligible provider creates exactly one offer | Re-check canonical booking, governed roster, scope, unavailability and overlapping capacity at the offer boundary |
| T2-F2 expired offer acceptance | Expired provider; `respondToJobOffer(... accept:true)` | Returned `accepted`; offer became accepted and booking was assigned after expiry | Expired row transitions to `expired`; canonical `provider_id` remains null | Enforce `expires_at` before response; exclude expired offers from the live workspace |
| T2-F3 false accept on owned booking | Challenger provider; accept an open offer while canonical booking belongs to `owner` | Returned `accepted`; offer changed to accepted although canonical ownership did not move | Booking remains owned by `owner`; challenger offer remains offered and request is refused | Bind acceptance to current canonical ownership and condition both offer/booking updates in one D1 batch |
| T2-F4 false settlement approval | Finance checker; approve statement with `policy_status=approved,status=failed` | Returned `approved` and wrote an approval event although the guarded statement update changed zero rows | Statement remains `failed`; approval-event count remains zero | Reject every state except `draft`/`held`; emit approval event only for the successful guarded transition |

Additional positive regressions prove a declined offer remains recoverable; a second eligible provider can accept the same booking; a configured entitlement of INR 1,000 creates one exact `sandbox`/`approval_required` payout instruction; replay is idempotent; and no live money or `paid` status is created.

The first exact-head Release CI run passed 8/9 jobs and found two compatibility failures in the aggregate Web job (2611/2613 passed): the new fail-closed JSON-list parser matched the repository's guard for unrecorded swallowed database reads, and the demo test still called its now-expired immutable offer “live.” The parser now has no swallowed-read shape and capacity tables are initialized explicitly. The demo SQL/generator remain byte-for-byte unchanged; its test now proves the stale row is preserved in D1 but excluded from live assignments. Both failed tests and the T2 integrity pack pass after the correction.

## Mandatory logic checks

- Provider own-record/work-order security is executed through provider identity and grooming journey routes; another provider cannot list, read or mutate the job.
- City, zone and service scope is checked at reservation and again at workspace offer/accept boundaries.
- Working hours, weekly roster, time-off, travel buffer, daily maximums and overlap/capacity are exercised by the scheduling suites.
- Concurrent reservation and duplicate `clientRequestId` tests prove no double booking or duplicate scheduler reservation.
- Decline, expiry/no-response, no-show, reassignment and replacement preserve the canonical booking and completed/payment truth.
- Private proof must be booking/provider/purpose bound and scan approved. Proof submitters cannot approve their own scan; incident submitters cannot acknowledge or resolve their own incident. Evidence alone does not create a penalty or deduction.
- Canonical completed work drives provider earnings, achievement and incentives. Cancelled work is explicitly excluded.
- Partner entitlement is configuration-bound, payout creation is sandbox-only and replay-resistant, and failed/unapproved statements cannot become approved or paid.
- Operations headline metrics, IST day/slots, capacity, zone filters, empty-state truth and dashboards are derived from persisted rows.

## Test and release gates

| Gate | Result |
| --- | --- |
| T2 named objective pack | 25/25 pass |
| New integrity regressions | 7/7 pass |
| Focused provider/Operations selection | 682/682 pass |
| Typecheck | Pass |
| Lint | Pass; 0 errors, 18 pre-existing warnings |
| Build | Pass |
| Artifact validation | Pass |
| `git diff --check` | Pass |
| Exact-head Release CI | Required green before closure; PR check is the source of truth |

The managed local runner refused to start the all-files command because several existing real-D1 suites open loopback listeners and the sandbox could not complete that capability approval. This is an execution-environment blocker, not a test failure. The equivalent non-listener provider/Operations surface was run locally, and the unmodified `npm test` command must execute in exact-head Release CI before this objective is closed.

## Explicit blockers and convergence notes

1. **City-restricted staff policy:** provider views are own-record and therefore cross-city safe, and matching/booking data is isolated by city and zone. The repository does not configure a city scope on staff identities for an “Operations user restricted to one city”; inventing that role/scope would be policy work. E2E100-T2-050 therefore proves provider restriction and data-level city filtering, while staff city-role authorization remains an explicit policy/identity blocker.
2. **PR #305 convergence:** current `main` contains PR #305's location/evidence integration corrections but the agreed shared candidate predates it. T2 did not copy or edit that other lane's files. Human UAT of GPS/evidence recovery must use a converged head containing both PR #305 and this T2 change.
3. **External payout/account verification:** no live provider-settlement rail, bank account, tax rule or approved payout policy was supplied. Engineering proves only an exact, idempotent sandbox instruction that remains `approval_required`; it does not claim a paid settlement.
4. **Production activation:** provider activation remains explicitly UAT-only. No production provider, booking, proof, incident, payout, merge or deployment was created.

## Readiness statement

Provider/Operations engineering logic on this branch is ready for human UAT after exact-head Release CI is green and the convergence/policy blockers above are respected. This is not evidence of production activation, live payout, or unrestricted multi-city staff authorization.
