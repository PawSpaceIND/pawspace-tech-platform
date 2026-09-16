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
