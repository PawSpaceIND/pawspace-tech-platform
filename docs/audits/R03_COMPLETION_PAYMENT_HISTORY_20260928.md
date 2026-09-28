# R03 — Grooming completion payment history

Date: 28 September 2026. Base: f9128593c40cd339cb7e2fe150af1b6b1743f23a (#1164).
Branch: fix/r03-completion-payment-history-20260928.
Status: source-integrity CI repair applied; full exact-head verification and review pending.
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

## PR #1170 CI-repair checkpoint — 28 September 2026

The retained hook-path job 109027351512 in Release CI 36451437268 failed exactly
these two checks: Inbox source preservation and integrated business source preservation.
Both expected the old Grooming lifecycle SHA-256 `6161f260…`; the actual reviewed
R03 route was `b64d292f…`. Build, artifact validation, lint and typecheck on that
original head passed. The complete source-identity mismatch was reproduced locally:
the six-test Inbox suite had four passes and two failures with process exit 1.

Before updating expectations, all 25 handler/event/golden regressions passed,
including the formerly unexecuted database-write-error case. Each of the nine
retained manifest values was checked against the exact merged base `f9128593`.
The permitted CI-repair operation updated only the reviewed route fingerprint and
added `lib/grooming-completion-event.ts` as a protected source in every manifest.
Every other protected entry and all test logic, thresholds and workflows are unchanged.
No application code was changed in this CI repair.

The repaired Inbox suite passed 6/6. A controlled local comment appended to the new
helper made those same two integrity assertions fail (4/6, exit 1); restoring the
exact helper bytes returned the unchanged suite to 6/6. This verifies that the
updated source protection is still enforced, including the newly extracted helper.

Evidence for this repair is under `pr1170-ci-repair-20260928/` in the R03 evidence
directory: sanitized failed-job log, 25-test baseline, before/after/negative-control
logs and exits, and exact source snapshot provenance. Broader and exact-head results
are reported separately in the PR once complete. The earlier tool-blocked checkpoints
above remain historical; neither a passing local check nor a successful snapshot
update is a deployment, live-money operation or hosted journey acceptance.

## Full-run follow-up: referral source-contract location

The complete 1,058-file run on exact head `27ad5d6d` finished with 9,042 passed and
one failed assertion (zero cancelled/skipped/todo). Its source stayed clean and
unchanged. The remaining failure was `referral-booking-governance-uat.test.mjs`:
it still searched the route for the `service_completed` literal, now held by the
extracted completion-event writer. The isolated referral suite reproduced 14/15,
exit 1. The earlier hook-path source-hash failures no longer occurred in this run.

The source contract now checks the actual imported writer, its awaited call after
referral qualification, and its INSERT/bound service_completed event name. All other
referral/payment assertions remain, and the test is labelled as a source contract.
No runtime or financial rule was changed. The repaired referral/event/invoice/golden/
integrity selection passed 46/46; this count overlaps the broader selection.

The full 9,042/1 result is retained as a pre-correction checkpoint, NOT relabelled a
9,043-pass run. Fresh current-head CI is required after the source-contract correction.
CodeAnt raised the pre-existing collection/finalization race and post-commit event
recovery limits; both threads were acknowledged and left unresolved. The finance/
finalization section was verified byte-identical to base f9128593. CodeRabbit's
requested review was rate-limited and is not counted as a completed review.

## Integration with newly merged #1163

Main advanced to `a2154d9e6848ec0b55e7e9517e10b81348912a71` during verification.
The new pay-after-service/cash-reconciliation branch overlapped the lifecycle route
and nine source manifests. These conflicts were resolved on the existing R03 branch,
not by choosing an entire side or removing the newly merged cash-posting behavior.

The integrated route retains #1163's post-completion manual-cash ledger entry and
its cashLedger history detail. It reads only the stable canonical payment ID before
the lease, because the cash posting needs that identity; the payment status still
comes from R03's one-statement history writer, never from a pre-lease snapshot.
Reversing these explicit R03 adaptations reproduces the upstream route exactly.

Each source manifest retains the complete upstream expectations, plus the integrated
route fingerprint and protected event helper. The separate V2 payment UI, Finance
verification, collection calculations and payment-reconciliation sources are unchanged
from #1163. No live payment or hosted customer operation was performed.

The upstream cash-completion test was strengthened: after manual cash is recorded,
payment and completion history both remain `created` (no invented gateway capture),
and the history links the actual cash-ledger group with pending Finance verification.
The integrated focused selection passed 58/58, including that cash path and the
R02/R03/referral/integrity cases. Broader current-head results remain separate gates.
Integration provenance and logs are in `pr1170-main-integration-20260928/` under the
R03 evidence directory. Earlier pre-integration results are not current-main proof.

## Review closure after latest-main integration

Current main integration includes `3a37d67e` (#1169) without replacing its fixture or
browser changes. The two previously deferred review findings are now addressed in
this PR, rather than being resolved merely because older CI passed.

### Collection/finalization race

A one-statement snapshot captures the existing booking/payment, reconciliation,
cash/override, refund and customer-funding inputs before collection and finance are
evaluated. The same source predicates are checked inside the final lifecycle batch.
A correction or payment/refund change refuses finalization and leaves no new
completion or settlement-readiness projection. Existing monetary formulae and
payment-provider authorization are unchanged. Missing optional source tables must
stay absent; newly created sources require a fresh attempt instead of being ignored.

A real-handler test uses the existing governed cash-recording API to correct a
synthetic entry at the finalization boundary. Before the fix completion returned 200
with stale accrued readiness. After the fix it returns 409, remains in service, and
retry records the existing shortfall policy as withheld. A second test covers the
opposite order: an in-flight correction cannot overwrite cash after completion;
the cash INSERT now checks the open booking/provider/amount at execution time.

This protects the final decision, not whole-finance rollback. A financial journal
posted before an aborted finalization still requires the existing reconciliation
policy; the response names that boundary and never represents it as a released payout.

### Durable history recovery

The existing atomic `provider_lifecycle_events` transition now retains a versioned,
server-authored completion receipt. It freezes finance, the collection decision,
recorded cash, consumed-session count, completion time and the stable history ID.
No new public endpoint or schema is introduced. A permitted retry for the same
completed booking uses only its matching stored receipt; it does not repeat finance,
service-state changes or subscription consumption. Historical completions without
such a receipt still require Operations reconciliation, not fabricated backfill.

The history writer accepts the receipt's deterministic event ID and preserves an
already recorded same-booking event. Existing cash posting and referral processing
remain idempotent; the standard provider projection still protects returned data.
The injected history-write-failure test reproduced an unrecoverable 409 before repair.
It now recovers on retry and remains safe on another replay, with exactly one history
and provider-completion event and unchanged invoice/journal rows.

The expanded focused selection passed 49/49 on Node 22.16.0 after these repairs;
counts overlap broader runs. Typecheck and changed-source lint passed. Current-head
full tests, review and cloud CI remain merge gates and are reported in the PR rather
than inferred here. Existing source manifests retain all entries and protect both
new helpers plus the deliberately modified route/event/cash sources.

A broader initial test append containing direct financial fixture updates was not
permitted and those operations were not performed. The accepted test uses the
application's governed cash API on isolated synthetic data. A combined patch command
also returned an indeterminate safety result; read-only inspection confirmed no
application changes from that attempt before smaller source-only edits were applied.
No deployment, actual payment, payout, customer message or hosted record was changed.
