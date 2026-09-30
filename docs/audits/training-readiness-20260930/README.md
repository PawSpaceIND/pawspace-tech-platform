# Training human-UAT readiness repair — 30 September 2026

Base: `11ab937275cbfba6ea05adb167224d7a24b14d58`.
Scope: existing customer Training change requests and trainer assessments. Local implementation and verification; merge, deployment and hosted acceptance remain separate gates.

## Defects reproduced and repaired

The unchanged customer change handler admitted past/invalid session starts, because its 24-hour refusal applied only to nonnegative finite differences. It also admitted a start changed after preflight. Eight real-handler tests first returned **5 passed / 3 failed**. The unchanged failing assertions passed after repair.

- One shared helper preserves the founder policy: the exact 24-hour boundary is permitted; past, invalid and inside-window dates are not customer self-service.
- The customer route still verifies permission, customer/programme/session ownership and active programme status. It alone sets an internal customer-reschedule flag; provider/staff HTTP actions do not forward a caller-supplied flag.
- The existing lifecycle checks idempotent replay first. An already-accepted request remains replayable after the cutoff with valid renewed authentication; a new late request is refused.
- A fresh request rechecks its time and includes the original start and cutoff predicate in the lifecycle transaction's update/assertion. Concurrent changes roll back the service transition and do not create recovery or session events.
- Customer UI uses the same rule and rechecks on submission. The old literal October 1 rendering fixture now uses a fixture-local fixed clock; application clocks are unchanged.

Previously the trainer editor invented four 7/10 scores when there was no assessment. Missing scores now remain explicitly unassessed through save/reload. The existing **at-least-one valid, explicitly entered 1–10 score** rule is preserved; four scores have not been made mandatory. Recorded numeric legacy categories are retained. Null/undefined unassessed values are ignored for completion; entered strings, non-finite values and out-of-range values refuse completion. A legacy zero remains visible for correction rather than silently turning into seven. Drafts can remain incomplete.

The browser uses explicit assessment selects rather than a range that appears to have a score before it is touched. Attendance, homework, media approval, owner handover, payment, ownership and exactly-once session consumption requirements remain intact.

## Executed verification

- **Focused Node actual-handler, lifecycle, rendering and regression selection: 74/74 passed.** The same selection passed **74/74 on the forced asynchronous loader path**. These are the same tests twice, not 148 distinct journeys.
- **New native local D1 checks: 2/2 passed.** Actual lifecycle functions execute against ephemeral Miniflare D1. Past/invalid refusal, future exact-once request/replay, and a start changed immediately before the native batch are checked. Fixture schema/rows are synthetic; outbound Worker requests are explicitly refused.
- **Actual-page browser checks: 2/2 passed, zero retries**, desktop Chromium and 390px mobile Chromium. Real React state and handlers perform unassessed → draft save → reload → explicit assessment → complete once. All API identities and receipts are isolated local fixtures, not hosted transactions. No JavaScript errors or document-width overflow. Screenshots inspected.
- **Typecheck and production-format build/artifact validation passed.** Changed-file lint has zero errors and one pre-existing unused-helper warning in the lifecycle source.
- **Whole repository run is not certified.** Broad local attempts were interrupted for review corrections and a separately owned network-hermeticity issue in an unrelated checkout test. An existing native-D1 fanout test also fails before health because this execution sandbox rejects Wrangler's interface enumeration; an approved normal-execution retry produced the same error. The new native D1 test uses supported explicit loopback binding and passed without changing system settings or weakening tests. Exact-head remote aggregate CI remains required.

## Test-strength and protected-source provenance

`fingerprint-provenance.json` records the exact base and old/new SHA-256 values. Only **36 existing byte fingerprints across nine manifests** were updated, after verifying each prior value equals `SHA256(git show <base>:<path>)`. Two new shared helper sources are additionally protected in all nine manifests (**18 added entries**). No existing entry was removed; unrelated values, AST/event histories, test budgets, authorization checks and thresholds remain unchanged.

The prior zero-score source regex has become an executing helper assertion retaining the zero-preservation invariant and adding null-state checks. The completion source guard retains attendance and adds explicit-assessment readiness; it was not disabled. New real-handler and native-D1 tests verify durable refusal/no-write outcomes. The actual-page browser test is included in the existing browser test inventory and also has a targeted two-profile configuration.

## Repeatable commands

Use the repository's supported `scripts/sites-env.sh` wrapper for writable local tool state. All tests use sandbox/non-production flags.

```sh
npm run install:ci
npm run typecheck
npm run build
PAWSPACE_LOCAL_PREVIEW=on PAWSPACE_PAYMENT_ENV=sandbox PAWSPACE_PAYMENT_LIVE_APPROVED=false NODE_ENV=test APP_ENV=staging FORBID_PRODUCTION=true node --experimental-strip-types --test --test-concurrency=1 tests/training-customer-change-window.test.mjs tests/training-progress-editor.test.mjs tests/training-session-lifecycle.test.mjs tests/training-hardening.test.mjs tests/v2-booking-payment-page.test.mjs tests/v2-grooming-training-audit.test.mjs
PAWSPACE_FORCE_LOADER_HOOK=1 PAWSPACE_LOCAL_PREVIEW=on PAWSPACE_PAYMENT_ENV=sandbox PAWSPACE_PAYMENT_LIVE_APPROVED=false NODE_ENV=test APP_ENV=staging FORBID_PRODUCTION=true node --experimental-strip-types --test --test-concurrency=1 tests/training-customer-change-window.test.mjs tests/training-progress-editor.test.mjs tests/training-session-lifecycle.test.mjs tests/training-hardening.test.mjs tests/v2-booking-payment-page.test.mjs tests/v2-grooming-training-audit.test.mjs
PAWSPACE_PAYMENT_ENV=sandbox PAWSPACE_PAYMENT_LIVE_APPROVED=false NODE_ENV=test APP_ENV=staging FORBID_PRODUCTION=true node --experimental-strip-types --test tests/training-change-window-native.test.mjs
PW_PORT=4273 PAWSPACE_PAYMENT_ENV=sandbox PAWSPACE_PAYMENT_LIVE_APPROVED=false FORBID_PRODUCTION=true node node_modules/@playwright/test/cli.js test --config playwright.training-readiness.config.ts
```

The native tests are part of the ordinary root test inventory, so Release CI executes them.

The two hosted Grooming/Training histories from earlier releases are not re-certified by these local tests. No production settings, live money, payroll, customer data, external communication, merge or deployment occurred in this repair.
