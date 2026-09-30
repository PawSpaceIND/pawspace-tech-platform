# Human-test readiness: Taxi custody and recovery integrity

Audited from main `ac3716af91c329e1e1a10db8322ac34b57f65e05` on 30 September 2026. This is a bounded functional repair toward human testing within 48 hours, not a production-readiness certificate.

## Ownership and isolation

Open PR scopes were read before editing: #1201 financial/workforce/Training/AI/UI readiness; #1200 provider leave; #1197 guest booking; #1199 and #1194 voice sales; #1202 native voice UAT quality. None modifies `lib/taxi-lifecycle.ts`. Before the authorized Finance extension, open scopes were rechecked: no other open PR owned `lib/taxi-finance-governance.ts`. No shared UI or browser changes were made.

The source checkout was clean. A separate shared-object clone and fresh worktree were created under this task's writable workspace. Branch: `fix/uat-partner-lifecycle-20260930`. No other worktree was modified. Existing dependencies were referenced through a local ignored symlink to avoid another install on the memory-pressured Mac.

## Reproduced defects and repair

The first 16 executable regressions all failed against unchanged main, because the real lifecycle returned success where refusal was required:

- `decline`, `driver_unavailable`, and staff `no_show` could turn a cancelled, refunded, or completed canonical booking back into `reassignment_needed` when its trip projection remained scheduled.
- Recovery accepted `pickup_confirmed`, or a stale pre-pickup trip carrying a confirmed handover marker, releasing assignment/capacity after the pet was handed over.
- A fresh idempotency key after recovery created another recovery case and queued another pair of notifications.

Recovery now refuses closed bookings/trips and confirmed pickup/active trips with governed 409 responses. Only pre-pickup booking/trip states may recover. The existing safety incident workflow remains the route for a pet already in custody.

The recovery case, canonical booking, trip, work order, scheduling/fleet capacity, assignment decision/offer, event, two queued notifications, and scoped idempotency receipt commit in one D1 batch. The first statement uses the case's existing NOT NULL `booking_id` as a transactional assertion: its scalar subquery must still match eligible booking/trip state, pending pickup, matching provider ownership and schedule group, and an open work order. A stale or inconsistent read aborts the batch. No schema, refund-amount, payout or price-policy changes are included.

## Finance custody extension

A subsequent hermetic reproduction confirmed that a request and distinct-checker approval could cancel an assigned trip whose pickup was confirmed, even with zero approved refund. Booking/trip became cancelled with the confirmed custody marker retained. Parent authorized the coherent extension after a fresh open-PR ownership check. Ten Finance regressions failed before this repair; four authority/amount invariants already passed.

Both customer cancellation requests and Finance approval now enforce the existing active-trip safety refusal from confirmed pickup onward, including a stale trip status carrying a confirmed pickup marker. Request, approval and unpaid-hold claims recheck custody inside their SQL transaction. Approval also checks the unchanged booking/trip/group assignment and maker/checker separation inside its conditional claim. Its scoped idempotency receipt commits with cancellation/refund writes, so a receipt-write interruption rolls everything back. Exact-key concurrency replays the saved result; a new key cannot approve the same cancellation twice. No zero-refund bypass remains.

The unpaid-hold release still claims the booking first, with custody and collection checks. Its following request insert uses SQLite `changes()` from that claim; all outputs then use the unique request ID as ownership. Two independent callers sharing the same millisecond timestamp cannot claim one another's release. The existing capture-first hold-expiry regression remains passing.

## Evidence and limits

The focused suite executes production lifecycle modules and route handlers against SQLite through the repository's D1 adapter. It covers closed/stale states, positive pre-pickup recovery, exact-key and fresh-key retries, failure after booking/trip updates, changing provider/group/closed work order, and negative route authority for customer, different driver, and partner attempting staff-only `no_show`.

The concurrency regressions use two independent connections to one temporary SQLite file. The stale caller pauses before its transaction; the competing caller independently commits before the stale caller resumes. Fresh keys yield one durable recovery; matching keys return the winner's receipt. This proves that explicit ordering on real SQLite, not a live Cloudflare D1 concurrency certification.

Existing focused suites sample Taxi finance/proof/recovery/completion, Boarding/Sitting acceptance and lifecycle, Training session evidence/consumption/ownership, and Grooming completion retry/invoice integrity. Some existing suites explicitly contain source-contract checks; their pass count is not a count of live customer journeys.

Validation command:

```sh
NODE_ENV=test APP_ENV=staging FORBID_PRODUCTION=true \
PAWSPACE_PAYMENT_ENV=sandbox PAWSPACE_PAYMENT_LIVE_APPROVED=false \
node --experimental-strip-types --test --test-concurrency=1 \
tests/taxi-recovery-boundaries.test.mjs tests/taxi-custody-finance.test.mjs \
tests/taxi-gate2.test.mjs \
tests/taxi-gate3.test.mjs tests/taxi-unpaid-hold-expiry.test.mjs \
tests/taxi-gate4.test.mjs tests/taxi-gate5.test.mjs \
tests/launch-partner-lifecycle-refusals.test.mjs tests/sitting-gate2.test.mjs \
tests/boarding-gate2.test.mjs tests/training-session-lifecycle.test.mjs \
tests/grooming-completion-recovery.test.mjs \
tests/grooming-completion-invoice-integrity.test.mjs \
tests/launch-partner-grooming-repairs.test.mjs
```

Local result: **170 passed, 0 failed, 0 skipped**, including **61 new Taxi recovery/Finance regressions**. Local runtime: Node 24.19.0. Focused lint passed: `eslint lib/taxi-lifecycle.ts lib/taxi-finance-governance.ts tests/taxi-recovery-boundaries.test.mjs tests/taxi-custody-finance.test.mjs`; `git diff --check` passed. Hosted focused CI uses Node 22.16.0 with no build, credentials, deploy, seed, or external fixture mutations. Broader repository checks run through existing PR CI.

Unrun locally: full build, whole suite, full typecheck, live/staged browser journeys, native partner GPS/handover, real payments/refunds/payouts, customer messages and provider dispatch. Browser ownership was reserved for the separate UI task. Hosted exact-head results must be read from the PR; local success does not establish deployed behavior.

## Follow-up before Taxi human testing

The initially source-only post-handover Finance concern was reproduced and repaired in this same bounded PR with the parent's authorization. The new head requires fresh hosted CI; green checks on earlier recovery-only head `2f76bbaa87ad568e59b575d4182ffe39097a2740` do not certify this expanded code.

Also unverified: recovery replacement acceptance under native D1 contention and the deployed customer → driver → operations → completion → accounting journey. Training/financial fixes in #1201 are intentionally not duplicated here. Cross-PR integration and exact deployed SHA verification remain prerequisites for a human-test readiness claim.

## Fresh-head compatibility repair and coordinated digest refresh

Expanded head `d008c0c36d3cd1ec410046e640604ba844015729` passed the hosted focused job (run 36696124220: 116 tests, zero failures/skips, focused lint), but broader Web tests failed (run 36696124212, job 109824783740). Failures reproduced the nine protected-source digest contracts, conditional-transition source contract, TS-03 public safety refusal, and the old post-pickup replacement fixture plus its E2E100 wrapper.

Commit `4441c6b` retains conditional booking/trip UPDATE predicates, preserves the terminal safety-incident refusal contract, and corrects replacement to occur before custody. The replacement regression still verifies persisted handover re-attribution and completion/accounting; a new real-pickup test refuses replacement and preserves custody. Focused checks: 42 recovery tests passed; 29 existing lifecycle/replacement compatibility tests passed with the repository's governed local-preview fixture flag. Production eligibility guards remain intact.

After fresh-head hosted mismatch evidence, parent-authorized digest refresh changes exactly two reviewed source entries in each of nine manifests. No other hash, assertion, or source inventory entry changes. Exact old/new paths and SHA-256 values are recorded in `UAT_TAXI_SOURCE_DIGEST_PROOF_20260930.json`; the updater compared all other parsed JSON entries for equality. These manifests overlap #1201 and require combined merge validation later. All earlier CI results apply only to their recorded heads; the final pushed head requires fresh checks.
