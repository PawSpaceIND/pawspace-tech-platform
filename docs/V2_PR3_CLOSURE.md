# PawSpace V2 PR-3: Grooming checkout closure

## Scope and isolation

PR #882 completes the V2 Grooming checkout implementation on top of merged PR #881.
It does not switch production traffic, replace V1 routes, change shared booking/payment/finance
engines, publish commercial packages, or enable live money. The application entry remains
`/v2/grooming`; a durable booking is recoverable at `/v2/grooming?bookingId=<reference>`.

## Requirement-by-requirement engineering matrix

| Requirement | Implementation | Executable evidence |
| --- | --- | --- |
| Published commercial truth only | V2 rejects fallback pricing and packages outside their effective dates | `v2-grooming-checkout.test.mjs`; unpublished catalogue check in integration test |
| Exact doorstep in discovery | Explicit address/PIN sent to existing scheduler; response city/zone/window must match | Client tests plus actual handler/SQLite integration |
| Stale responses cannot restore old state | Synchronous input invalidation and per-request generations | Desktop and mobile delayed coverage/provider response browser cases |
| One immutable booking intent | Snapshot input, deterministic SHA-256-qualified key, synchronous submission guard | Executed mutation/replay tests and browser double-click case |
| Preserve partial-success identity | Publish booking ID before location save; put only booking reference into recovery URL | Location failure client and browser cases |
| Verified doorstep before payment | Customer-owned read projection; matching active provider/address with server geocode | Real SQL, session/ownership tests and browser address recovery |
| Capture is not booking confirmation | Read-only projection requires trusted capture, payment stage, work order, exact slot and provider | Field-negative tests and real post-commit integration |
| Missing webhook reconciliation can converge | Accept exact stored provider-API evidence without pretending it is a signed webhook | Real SQL tests for both authority types and deterministic capture integration |
| Browser cannot manufacture success | Existing receipt verification controller plus independent canonical read | Browser capture-before-confirmation case |
| Reload does not create booking or payment | Recovery performs reads only; payment needs an explicit action | Browser reload counters and real SQL write-count assertions |
| Full-page checkout returns inside V2 | Reuse existing bounded receipt parser; fixed same-origin V2 redirect | Executed route test and browser receipt/URL-scrubbing case |
| Ownership and failure handling | Real customer session required, customer-scoped booking/payment reads, unavailable state fails closed | Real session tests and unauthorized browser recovery |
| Responsive presentation | Emerald/gold checkout, canonical receipt details, IST times, keyboard focus and reduced motion | Desktop/Pixel 7 emulation screenshots and overflow assertion |

## Evidence classes: do not substitute one for another

1. **Executed contracts:** real V2 functions are imported and invoked. Network responses in client-only
   cases are controlled fixtures. These catch state, serialization, idempotency and refusal regressions.
2. **Database integration:** the real V2 clients invoke actual HTTP handlers and existing domain engines
   against an isolated SQLite implementation of D1's transactional API. The test publishes a package
   only inside that disposable database. It proves catalogue -> preview -> one pending booking ->
   doorstep -> capture journal -> post-commit booking/work order -> canonical confirmation.
3. **Browser contracts:** real rendered V2 components run on desktop and mobile Chromium, with API and
   Razorpay transport fixtures. They prove UI transitions, recovery and route wiring, not external delivery.
4. **Deployment/provider acceptance:** real staging bindings, published commercial configuration,
   authenticated Razorpay sandbox delivery, target-device behavior and human design acceptance are
   separate release evidence. They are not established by the local fixture suites above.

## Local checkpoint

- Focused V2 client/read-model/route/foundation and static-test-ratchet checks: 55 passed.
- Real-handler local D1-compatible integration: 1 passed.
- Browser contracts: 14 passed (7 scenarios on desktop and Pixel 7 emulation).
- Full application TypeScript check: passed.
- Repository ESLint: zero errors; existing repository warnings are not hidden or reclassified as failures.
- Full regression, exact-head hosted CI and any staging acceptance results are attached to PR #882
  with their actual commit/run identifiers, rather than inferred from a previous head.

## Reproduction

```sh
APP_ENV=staging FORBID_PRODUCTION=true PAWSPACE_PAYMENT_ENV=sandbox \
PAWSPACE_PAYMENT_LIVE_APPROVED=false PAWSPACE_LOCAL_PREVIEW=on \
PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE=on NODE_ENV=test \
node --experimental-strip-types --test \
  tests/v2-grooming-checkout.test.mjs tests/v2-grooming-integration.test.mjs \
  tests/v2-grooming-foundation.test.mjs tests/test-suite-executes-code.test.mjs

PW_PORT=4196 APP_ENV=staging FORBID_PRODUCTION=true PAWSPACE_PAYMENT_ENV=sandbox \
PAWSPACE_PAYMENT_LIVE_APPROVED=false NODE_ENV=test \
npx playwright test --config=playwright.v2.config.ts

npm run typecheck
npm run lint
npm test
```

Browser reports/screenshots are generated under the already-ignored `artifacts/v2/` directory and
published by `.github/workflows/v2-grooming.yml`. Never commit runtime databases, credentials or
customer records as test evidence. CI must validate the exact PR head before merge; successful
source tests alone do not authorize production deployment or claim that all PawSpace modules are closed.

## Release acceptance still requiring external proof

The first V2 Grooming launch is not closed until the same candidate is deployed to isolated staging,
an operator-published package and real available provider are used, an authentic Razorpay test
transaction reaches its verified canonical receipt, the same booking is visible to Partner/Ops,
and physical-device plus founder/customer UAT sign-off is recorded. No live-money activation belongs
to this PR. No next service implementation should conceal an unresolved Grooming acceptance gate.

## Security-gate correction (2026-09-17)

Security Supply Chain run `35136810715` detected one payment-key-shaped **synthetic browser
fixture identifier** at `e2e/v2-grooming.spec.ts:78` in commit
`4c972f139990ce084a64955a3fa75d0b85560a16`. That fixture intercepts the API and replaces the
Razorpay SDK; it does not configure a provider account or send a payment. The fixture now uses
a deliberately short non-credential test ID.

The sole new `.gitleaksignore` entry is that exact historical commit/file/rule/line fingerprint,
needed because the PR security workflow scans commit history. No directory, file pattern,
credential pattern, or scanner rule is allowlisted or disabled. `.gitleaks.toml` is unchanged.

Executed local scanner checks (Gitleaks 8.30.1):

- Original fixture without the historical exception: blocked by the payment-key rule.
- Revised fixture: clean.
- A generated payment-key-shaped canary in the same file: still blocked.
- The failed CI's original commit range with the exact historical exception: clean.

The combined focused contracts, real-handler integration and static-test ratchet were rerun:
**56 passed, zero failures or skips**. Desktop/mobile browser contracts were rerun as well:
**14 passed (seven scenarios on each viewport)**, and the changed browser file passes ESLint
with zero warnings. This does not replace the new exact-head hosted scan
(which uses its own pinned Gitleaks version) or the full CI merge gate. The corrected commit
must pass every engineering gate before merge; deployment and authentic-provider acceptance
remain separate requirements.

## Deployed gateway acceptance: 17 September 2026

PR #882 was merged as `c22cfe83c8240d098dfa354fe017a6a38a7bd8f5` after 15 pre-merge
workflows passed on `ad5ebe2650408809263dd4aa2aca5b3e8a0f9b83`. The merge tree equals
that tested head. Exact-head local regression completed with 6,163 passes and no failures/skips.

Staging deployment run `35175793613` completed successfully with 28/28 certificate checks,
30/30 service-zone roster pairs and six authenticated personas. This certificate is deployment
and general platform evidence; it is not a certificate for every newly added V2 route.

A subsequent no-mocks browser probe successfully signed in through the V2 sandbox OTP UI
and persisted one synthetic customer pet. It then reproduced an authenticated 403 on both
`GET /api/v2/grooming-catalogue` and `GET /api/v2/grooming-checkout`. The deployed Worker
had no permission entries for the new routes, so they fell back to staff `dashboard.view`.
No booking or payment was created by that probe. Published catalogue contents and payment
readiness were not inferred from the authorization failure.

The follow-up fix maps only those exact GET routes to `scheduling.book` and the customer
platform-session scope; checkout record ownership remains mandatory inside its handler.
Only GET/POST on the exact stateless V2 checkout-return adapter is public, as Razorpay's
cross-site form carries no customer cookie. Receipt shape is not trusted capture evidence.
Unknown V2 paths, mutation methods, provider access and spoofed workspace headers remain denied.

The new regression suite executes the Worker's trusted-ingress, subject-session and fallback-RBAC
functions before invoking the actual route, with genuine issued customer/provider sessions and
local SQL. Before the fix, 9 of its first 21 cases failed; direct-handler and mocked-API tests
had missed these failures. The V2 workflow now includes this suite and triggers on shared
Worker/gateway changes as well as V2 files.

Testing the whole authorization composition also exposed an oversized-callback hang: the shared
receipt parser awaited cancellation of a stream whose edge inspection clone was retained.
Cancellation is now requested without awaiting the unused tee branch. The byte limit, receipt
validation, redirect destinations and payment authority are unchanged. Timeout-bounded V1 and
V2 regression cases prove oversized requests return without financial writes.

A new exact-head CI pass and pinned staging redeployment are still required before claiming the
deployed gateway issue closed. Authentic Razorpay test capture, same-booking Partner/Ops
acceptance and physical-device/human design sign-off remain separate open release gates.

### Built-worker and regression follow-up

The first gateway-fix candidate exposed four failures in the legacy webhook reachability
inventory: it treated every path before the first textual `return null` as public. A new
method-specific V2 return changed that text ordering without changing the existing webhook
permissions. The inventory now executes anonymous GET/POST authorization and separately tests
that conditional public surfaces still deny administrative methods. Its assertions were not
removed, and no external-caller authentication was loosened.

The hardened built-worker suite now performs real sandbox OTP, V2 catalogue/recovery reads,
foreign/missing-booking and unknown-path refusals, and oversized cross-site return requests.
These tests use the actual compiled Worker with preview superuser disabled, not route mocks.
They also caught the shared response wrapper overwriting the return route's `no-referrer`
policy. The wrapper now preserves that stricter policy and retains `same-origin` for other
responses; no-store and nosniff are unchanged.

Before this follow-up commit, the full local regression passed 6,189 tests with zero failures
or skips. The complete hardened browser runner passed its desktop/mobile journeys, including
four new V2 built-worker executions; its existing mobile-only skip for the redundant server
auth precondition remains explicit. The separate CX visibility fixture also passed. Typecheck,
application build, artifact validation, and focused lint passed. These local results still
require exact-head hosted CI and a newly certified staging deployment.

Read-only staging configuration inspection found no active Grooming packages. That is a
separate operator-publication prerequisite, not permission to use fallback pricing or claim
the booking/payment journey passed. No commercial package was published by these checks.
