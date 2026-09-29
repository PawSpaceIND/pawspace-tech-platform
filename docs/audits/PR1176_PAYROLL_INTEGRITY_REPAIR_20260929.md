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
