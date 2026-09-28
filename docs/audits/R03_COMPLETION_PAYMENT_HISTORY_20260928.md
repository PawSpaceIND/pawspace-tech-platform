# R03 — Grooming completion payment history

Date: 28 September 2026. Base: f9128593c40cd339cb7e2fe150af1b6b1743f23a (#1164).
Branch: fix/r03-completion-payment-history-20260928.
Status: local implementation; final verification and protected-source refresh blocked.
Not merged, deployed, production-certified or a completed hosted booking-to-accounts test.

## Reproduced defect

The completion route retained a payment object read before its lifecycle lease.
A controlled local approved refund arrived immediately before the completion-event write.
The real local payment simulator changed the canonical payment to partially_refunded,
but the completion history still recorded captured. The new regression failed on the
unchanged application while all five #1164 invoice/response regressions passed (5/6).
This is synthetic SQLite-backed handler evidence, not an actual gateway transaction.

## Repair

A dedicated server-side event writer reads canonical payment status in the same SQL
statement that inserts service_completed history. It matches booking, customer and
provider and requires the Grooming booking to be completed. It overwrites a stale
paymentStatus property in the supplied event detail with the stored payment status.
Missing/mismatched records refuse the event rather than inventing a capture. Database
write errors propagate. No payment, amount, collection, commission or payout is changed.
The route removes its stale payment snapshot and keeps the existing privacy projection
and post-event response read introduced in #1164.

## Verification checkpoints and blocked work

- Before fix: 5 passed / 1 failed; failure was captured vs partially_refunded history.
- First repaired selection: 12/12 passed (new race, #1164 regressions, golden journeys).
- Expanded selection: 24/24 passed, zero failed/cancelled/skipped/todo, on Node 22.16.0.
  It includes thirteen R03 scenarios, five #1164 scenarios and six golden journeys.
  R03 covers six canonical payment states, five record/scope refusals, one injected
  capture-projection update at SQL execution, and the actual-handler refund race.
- A further database-write-error propagation regression was subsequently added.
  Its final rerun is NOT completed or counted as a passed test.
- The execution tool blocked the planned protected-source fingerprint refresh. None
  of the nine original manifest entries was changed or removed. No alternative route
  was used to apply the blocked change; integrity checks must remain effective.
- The subsequent related-suite/loader/typecheck/lint/build command was also blocked.
  No full-suite, current-commit build, green CI or merge-readiness claim is made.

Evidence: Documents/PawSpace-fixes/r03-completion-payment-evidence-20260928/
contains before-repair, after-repair and expanded logs with test-process exit files.
Their counts overlap and must not be added as unique customer journeys.

## Deployment and coordination

The latest inspected successful staging deploy was run 36443574225 at 7f3a3bd6.
The #1164 staging-deployment command was tool-blocked and was not retried through
another mechanism. A subsequent read-only listing confirmed no new deployment started.
The normal test-persona/OTP, production configuration and live-money gates were not changed.
The next-build branch was created separately for local work from merged #1164.

PR #1163 retains ownership of pay-after-service and cash reconciliation; a coordination
comment identifies this narrower history-only change and the shared route integration.
No parallel UI, voice, payment-mode, payout-provider or fixture-login work was changed.

Remaining: review and apply the legitimate source fingerprints through permitted tooling,
run every new regression plus full CI/build, integrate with current main, review, merge,
deploy the accepted revision and complete hosted acceptance. Existing finance-before-
finalization and post-commit event failure recovery are separate open work under #17.
The single event-write snapshot is not whole-completion transaction atomicity, historical
backfill, bank reconciliation, actual payout proof or global launch approval.
