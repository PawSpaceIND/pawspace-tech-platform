# Human-UAT financial and leave integrity fixes

Base: `11ab937275cbfba6ea05adb167224d7a24b14d58` (30 September 2026).

## Changes

- Funeral customer payments derive their amount from the persisted quote. Any supplied amount must match exactly and be finite; stored money must be positive, safely representable in whole paise.
- A stable stored payment ID identifies the canonical collection. Payment, invoice, balanced collection journal/marker and payment event commit in one D1 batch, guarded against stale price/status and cash-configuration changes. Repeated paid requests do not post, alter the instrument, or backfill historical records.
- Paid quotes cannot be reset to due by `set_service_amount`. Corrections remain in the existing governed refund workflow.
- The public route and internal payment mutation both require the canonical explicit sandbox payment declaration and refuse a declared production deployment/app profile. The route refuses before database/auth initialization. No live capture path is added.
- Canonical collection account mappings, rounding, journal integrity checks and cash Finance verification requirements are unchanged. Simulated cash remains `pending_finance_verification`.
- Leave approval/rejection checks the pending request inside its write transaction. Approval also checks the current active policy and live balance in the same batch, then applies an additive debit. Distinct requests cannot spend the same last day; explicit allow-negative policy still works. Rejection cannot overwrite an approved decision, and a failure rolls back request, ledger and balance.
- Existing whole/half-day/calendar validation and maker/checker restrictions remain. No provider-availability or leave-blocking business policy is invented.

## Executed local verification

- Locked dependency installation: `npm ci --ignore-scripts --no-audit --no-fund` passed.
- `npm run typecheck`: passed.
- Changed-file ESLint: zero errors/warnings.
- `npm run build`: passed, including ESM Worker and hosting-manifest validation.
- Focused financial, Funeral, leave, schema and reviewed presentation-contract set: **229/229 passed**. This includes the five native-D1 profile tests below; overlapping runs are not additive.
- `git diff --check`: passed.

`node --experimental-strip-types --test tests/financial-workforce-integrity-real-d1.test.mjs`

This starts an isolated **local workerd/Cloudflare D1** worker through Wrangler, bound to an OS-assigned loopback port. It does not call a hosted database or gateway. Read rendezvous wrappers only control timing; queries and transaction batches execute in native D1. SQLite trigger faults exercise rollback after earlier statements in the same transaction.

The sandbox run asserts 13 scenarios: last-day contention; permitted negative balance without lost updates; approve/reject contention; same-request replay; missing policy refusal; leave rollback and retry; concurrent/sequential payment replay; bad/caller-supplied amounts including paid replay; paid repricing refusal; manual cash verification; collection rollback and retry; price-change contention; and real authenticated route ownership, underpayment and retry behavior.

Four separate profiles (`live`, unset payment environment, production deployment, production app environment) each prove all three payment actions refuse before creating tables. The default sandbox profile stays explicitly non-live.

Regression sensitivity was also checked in a separate untouched-base checkout: the native suite failed on the old leave overspend behavior and all four missing environment guards. With only the leave fix supplied to that separate checkout, the unchanged Funeral implementation failed the retry/journal uniqueness assertion. These are expected negative-control failures, not candidate failures.

Only the three intentionally changed production-file fingerprints were refreshed in the existing nine protected-source fixtures. No other fingerprints or business assertions were relaxed.

## Aggregate verification limitations

A standard `npm test` run was attempted after the focused run and build. It was not completed or counted as passing. An existing native booking-fanout test failed before health with `uv_interface_addresses` in this execution environment (isolated rerun confirmed the same startup failure). The later checkout-wiring fixture unexpectedly reached the real provider-read fallback despite its synthetic keys; execution was stopped before any authorized external-provider validation could be established. A separate, test-only hermetic fixture patch now passes checkout wiring plus capture reconciliation (80/80), but is not included in this financial/leave patch. No real payment/provider test is claimed here.

## Remaining gates

This is a draft code fix, not hosted UAT or production certification. Full repository CI must be reviewed at the exact PR SHA; unrelated base failures must not be counted as passing. No production database, financial record, settings, secrets, real payment, branch merge, or deployment was changed. Existing historical inconsistent records require separate authorized reconciliation; this change deliberately does not repair/backfill them.

Funeral live provider/gateway/refund/media/contact completion and the business decision on when provider leave blocks availability remain separate launch gates.
