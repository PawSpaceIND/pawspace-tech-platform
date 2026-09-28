# Employee exit and settlement review — implementation checkpoint

Date: 28 September 2026 IST.
Base: merged PR #1149, commit `7da65665555496f79d2f5f453bbbc9da441e91e6`.
Branch: `fix/employee-exit-settlement-20260928`.
**Release status: HOLD. Two executed lead-cutoff regressions fail. This follow-up is not merged or deployed.**

## Delivered on the follow-up branch

The existing employee master, employment history, payroll, incentive and salary-payment modules remain authoritative. No second employee or payable ledger is created.

- Requested exit, independent human approval, explicit access cutoff, pre-cutoff cancellation and due-exit execution.
- Approved cutoffs deny staff credential use even before the scheduled writer runs. The cutoff follows the recorded user ID if the login email changes.
- Transactional identity/session revocation retains employee and payroll records. Failed audit writes roll back the entire exit.
- Open lead/case ownership and direct-report handover are surfaced. Work is not silently cancelled or reassigned.
- Verified leavers remain eligible for earned salary in their final employment interval and for reviewed TEST beneficiary configuration, without reactivating access.
- Canonical payroll/salary confirmation and explicit HR/Finance references drive sandbox settlement review. A later salary reversal invalidates the current review without deleting its history.
- System actor labels cannot approve exits or sign off settlement. Approved zero-value incentive results do not fabricate a payment requirement; unconsumed approved reversals block closure.
- Staff page `/team/people/offboarding` has exit request, independent approval, due execution, cancellation, source review and sandbox-review controls, with visible failures and synchronous write locking.
- V2 routes `/v2/people`, `/v2/payroll`, `/v2/employee` and `/v2/people/offboarding` mount the same canonical pages. There is no forked UI logic or alternate authorization route.
- Exit administration requires both People and User administration. Salary details and final review retain separate payroll permissions. No caller-supplied actor ID is trusted.

## Executed verification

| Evidence | Result | Scope |
|---|---|---|
| Current related employee/auth/payroll selection | 304 passed, 2 failed, 0 skipped, across 38 files / 306 tests | Includes the new exit tests; not a passing release gate |
| Exit domain suite | 18 passed, 2 failed, 0 skipped | Actual application code and transactional SQLite; synthetic identities and signed callback data |
| Local Cloudflare D1 | 2/2 passed | Exit rollback/retry and final earned salary without restoring login or sending payment |
| New route/source plus presentation checks | 67/67 passed | Includes four source/mapping tests; not authenticated browser acceptance |
| Production-format build and artifact validation | Passed | Current application source, no deployment |
| TypeScript / changed-file lint | Passed | No rule suppression |
| Anonymous desktop and 390px mobile browser checks | Passed | Built local V2 exit page: sign-in recovery visible, no employee form/data, no runtime overlay; mobile document width 390px |

These selections overlap and must not be added as unique end-to-end journeys. The complete repository suite has not been rerun for this follow-up. The original merged #1149 main-branch Release CI run `36343606105` was rechecked and completed successfully.

## Two known release blockers — assertions retained

1. `lead selection respects approved exit cutoff before the employee row is disabled`: fails. Staff authentication checks the approved cutoff, but lead eligibility can still choose the active employee before scheduled exit execution changes their row.
2. `exit approved during lead selection blocks the assignment write atomically`: fails. A cutoff approved after candidate selection is not yet reasserted by the canonical lead assignment INSERT.

A combined edit intended to repair these checks was blocked by tool safety-status checking before execution. File verification confirmed that the edit was not applied. It was not retried through another mechanism. Both negative tests remain in the ordinary test suite and currently fail; neither is skipped, weakened or relabelled as passing. **Do not merge or deploy this candidate until they are repaired and the appropriate full gates pass.**

## Evidence and release boundaries

Only 60 expected fingerprint entries for intentionally changed source were refreshed, after verifying each old value against the merged base. No unrelated assertion or security condition was removed. Owned local browser processes were stopped after the anonymous checks.

Continuous authenticated employee/MFA/browser acceptance remains unverified. The earlier blocked authenticated flow was not retried. Anonymous page checks do not prove that signed-in form submission works.

No hosted employee, real bank account, payroll configuration, staff-access record, staging deployment or production resource was mutated. Direct source/domain tests used synthetic local databases; no actual bank request or salary transfer was performed. Live salary activation, legal/statutory applicability, additional entitlements/deductions, provider offboarding and corrective payroll remain separate governed work.

Raw local evidence: `Documents/PawSpace-audits/employee-exit-20260928/evidence/` (`exit-current.log`, `exit-final-related.log`, `exit-local-d1.log`, `exit-build.log`, `exit-surface.log`, `exit-contract-update.json`, and the anonymous browser snapshots/screenshots).

## Cutoff repair — 28 September 2026 continuation

The two retained assignment blockers were reproduced on `a9e5ed55` and repaired without changing their assertions. Employee eligibility now calls the existing approved-exit cutoff helper. The lead INSERT itself uses that same cutoff predicate, so a cutoff approved after selection cannot create an assignment, owner projection or assignment event. A retry selects the configured fallback queue.

The canonical exit-case DDL is shared between lead bootstrap and exit bootstrap. Lead-only schema initialization creates no exit, approval or employee records. This removes the cold-database gap where the first exit might otherwise appear after an optional table check. Account disabling is also rechecked by the assignment statement.

The renamed-user-ID boundary remains enforced. Added positive controls preserve assignment for pending, future and cancelled exits. Added negative controls cover the first exit during a cold assignment and an approved exit after a login email change.

The hosted CI log exposed a third failure: the customer appearance inventory incorrectly included the four new staff aliases. They are now classified explicitly as staff and their exact canonical page exports are checked. No customer page was removed from the appearance inventory.

Executed before publication:
- Existing exit suite before repair: 18 passed, 2 failed.
- Expanded employee/routing/schema/appearance selection: 396 passed, 0 failed/cancelled/skipped across 54 files (includes 25 exit-domain tests).
- Local Cloudflare D1: 4 passed, including the cutoff race and retry into fallback. D1 responses and application functions are not mocked; a transport wrapper pauses the statement so approval can complete first.
- The original two D1 checks still verify exit rollback and final earned salary without restoring access.
- Nine expected source fingerprints refreshed only for the intentionally changed lead module, after checking each old value against `a9e5ed55`.

Full repository build/CI, final review and continuous authenticated employee-browser acceptance remain separate gates. No hosted employee was exited, no real payment was made and no production setting was changed during these tests. Earlier HOLD findings above are historical; the two cutoff assertions now pass.

## Review corrections — same-day continuation

A review-identified whitespace-only linked email reproduced a missing approved sales incentive. Payroll now trims each identity before falling back to the employee's work email; the synthetic regression verifies the extra INR 1,000 is included once in INR 31,000 net pay.

The September exit-domain fixture now uses a test-local deterministic Date clock. Native D1 tests pass the explicit cutoff to execution; no production clock, duration or approval policy was changed.

Three concurrent native-D1 exit sweeps reproduced false review-required results for workers that lost the execution race. The exit sweep now counts only the worker that actually executed the exit and re-reads a concurrent completion before reporting failure. A failed re-read still reports review required. The actual employee/session/audit writes remain transactional, with one revocation event. This hardens the employee task; it is not a replacement or certification of the entire shared scheduler's locking scheme.

Validation: before these corrections, the combined domain/native-D1 selection had 29 passes and 2 failures; afterward 31/31 passed (26 domain cases and 5 native D1 cases). TypeScript and changed-file lint passed. These selections overlap earlier results.

The platform-session review concern was checked against the actual type and permission model: platform sessions resolve only customer/provider permissions, not privileged staff. Both staff authentication paths enforce employee cutoff. A former employee's separately held personal customer identity is not a staff-access grant; it has not been disabled by this change.
