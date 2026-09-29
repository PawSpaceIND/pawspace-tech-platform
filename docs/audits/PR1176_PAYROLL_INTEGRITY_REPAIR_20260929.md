# PR1176 — payroll CI and review repair

Scope: V2 HR governance; no live salary transmission or historical repair.
The reported failed cloud head was `9e304fc7`; the repair was recovered from
`fix/pr1176-ci-repair-20260929` at `7235c559` without discarding its pending work.

## Confirmed failures and correction

The cloud jobs repeated two assertions: scheduler inventory could not follow the
salary dispatcher's delegation, and malformed policy JSON was swallowed as an empty
list. The inventory now follows that source only if its entry point is actually
called by the scheduled worker. Policy parsing refuses malformed configuration.
Neither guard was disabled or exempted.

A fresh recovered baseline passed 26/30: duplicate adjustment application, canonical
payment-preparation compatibility, suppressed deduction persistence and a concurrent
payroll review all failed. The transaction repair made the same selection pass 30/30.
Deductions, net pay, the deterministic line, approval marker, V2 evidence and audit
entry now share one guarded batch. Competing or stale requests cannot apply twice.
The original employee compensation snapshots remain unchanged; applied V2 identities
are recorded separately and matched against independently approved source rows.
Canonical payment preparation still refuses missing lines/markers, changed amounts
and non-independent approvals. This does not enable payouts or relax V1 validation.

Literal JSON booleans, explicit approval decisions and valid per-item release dates
are required. The release date cannot precede its plan; caller-supplied queue clocks
are ignored by the HTTP action. Approval updates cannot reset applied adjustments.

## Verification boundaries

A 20-case checkpoint passed: 15 isolated SQLite checks plus five native local D1
checks. Native checks cover normal posting/replay, concurrent application, suppressed
line and snapshot rollback, and a payroll-review race. The first native race test
attempt tried to replace a method on the runtime proxy and did not intercept it;
the explicit DB wrapper corrected that fixture and the complete five-case rerun
passed. The initial failed log is retained, not relabelled as a pass.

Native payroll checks are added to Financial Ledger Sandbox after its existing
financial lifecycle and R04 journal checks. No existing tests or thresholds were
removed. Exact final-commit source guards, broader regressions, full CI, build and
independent review are separate gates; consult the PR's latest evidence checkpoint.

Evidence: `Documents/PawSpace-fixes/pr1176-ci-repair-evidence-20260929/final-repair/`.
These are synthetic local tests, not an actual employee payroll or hosted bank test.
The founder Chromium session was not used to issue any payroll action. Human HR,
Finance, salary-provider and end-to-end employee acceptance remain open under #17.

## Additional release-boundary closure

Reviewing the shared salary queue found that calling it directly could bypass an
existing V2 hold or future release date. Seven new checks reproduced six refusals
that did not happen (one positive case passed). The canonical queue now enforces
V2 enrollment/release-plan evidence, independent approval, exact employee/amount,
ready hold status and real-server due time. The same checks guard instruction
persistence inside its transaction. Unplanned, unenrolled V1 runs keep their existing
path. Explicit empty selections refuse rather than selecting every employee.
All existing instructions are checked for matching payroll identities and amounts.

Concurrent HR/Finance plan approvals are now conditional; one checker cannot
silently replace another. Draft or pending-Finance item edits invalidate earlier HR
approval, requiring the revised plan to be reviewed again. A concurrent final
Finance approval prevents the edit. Three new checks failed before these changes;
the resulting combined payroll/salary/native-D1 checkpoint passed 47/47.

The native suite additionally exercises held, future and approved-due salary plans
through the shared queue. It creates isolated TEST instructions only and performs
no provider dispatch, bank transfer, hosted payroll or employee-data modification.
The final commit's broader and CI results must still be checked independently.

## Independent review follow-up: explicit enrollment and release amendments

Current-delta review 5888117996 identified no-deduction enrollment, held-item approval
reuse, and ambiguous employee overrides. Ten new regressions reproduced these gaps:
25/35 existing-plus-new SQLite cases passed before repair; all ten new cases failed.
The fixes preserve V1 payroll and intentional future salary scheduling:

- Explicit V2 calculation reuses the canonical engine and records `payrollScope:v2`
  in the original transaction, including when there are no adjustments. A V2 retry
  cannot claim an unmarked V1 calculation key. Existing calculated runs selecting
  V2 deduction governance are enrolled before proposing/applying, even a zero apply.
- The V2 calculation UI calls the permission-checked V2 endpoint; V1 retains its
  canonical endpoint. The shared queue requires the marked run's release plan even
  if the plan table is absent. No approval can be obtained from a client clock.
- Releasing a hold is now a proposed schedule amendment. One transaction changes
  the item and clears old HR/Finance approvals, returning the plan to draft. The UI
  states that renewed approval is required. Future dates remain valid schedules,
  but no instruction queues before both new approvals and its real due time.
- Unknown, duplicate, missing or malformed employee overrides are rejected before
  plan writes. Partial valid overrides retain server defaults for other payable
  employees; final amounts still come from canonical payroll, never client items.

Native local D1 also verifies no-deduction enforcement and a suppressed approval
reset: the item amendment rolls back and a later retry requires fresh approvals.
The source fingerprints were changed only for reviewed sources, with previous
hashes verified against the committed candidate; no old protection was removed.
The prior duplicate local full suite on 965aad82 was stopped for this new repair,
not counted as a pass. Final-head full tests, CI and independent review remain gates.
Evidence: `pr1176-ci-repair-evidence-20260929/review-closure/`.
