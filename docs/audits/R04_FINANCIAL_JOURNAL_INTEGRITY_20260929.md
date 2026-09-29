# R04 — financial journal integrity: reproduction checkpoint

Base: `3fd9f3b2be42bc565b3b80f750cc4c274d3166b3` (merged #1170).
Branch: `fix/r04-financial-journal-integrity-20260929`.
Status: IMPLEMENTED LOCALLY / full current-head validation and review pending. Not merged or deployed.
Historical blocked checkpoints below are superseded only by the final implementation section.

## Scope and reproduced checks

The next structured-finance batch examines the shared `prepareJournalPosting` /
`postJournal` boundary. The existing implementation checks raw totals before rounding
individual stored lines, treats the first journal row as replay evidence, and uses
INSERT OR IGNORE for the individual financial rows. These are source observations,
not a claim that historical hosted records have been audited or damaged.

Eight isolated SQLite-backed executable tests ran on Node 22.16.0. The ordinary
complete posting/exact replay passed; seven proposed safety assertions failed:
rounded-line imbalance, an ignored balancing line, a historical partial group,
a repeated group key carrying different financial lines, and NaN / positive Infinity /
negative Infinity. Process exit: 1. These are intentionally RED reproduction tests,
not completed fixes or customer journeys. The default test thresholds were not changed.

The expected repair must validate the actual persisted monetary values, refuse a
partial or conflicting replay, and assert the full journal inside the same database
transaction before acknowledging success. No historical row may be silently rewritten.
Existing rounding policy must be distinguished from individual-row arithmetic.

## Block and preserved work

The execution tool blocked the write that would add the transactional integrity
assertion. It also blocked one combined diagnostic command. Neither blocked
operation was retried through a different tool or route. The unfinished, unimported
helper was preserved outside application source in the evidence directory rather
than shipping a half-built runtime module.

This branch preserves ONLY the regression specification and this audit checkpoint.
No application code, financial data, source fingerprint, CI workflow, permission,
provider configuration or money setting was changed. No PR or merge is requested
for these intentionally failing tests. Do not disable them to manufacture a green result.

Evidence: `Documents/PawSpace-fixes/r04-financial-journal-evidence-20260929/`
contains the baseline SHA, test log/exit code and incomplete helper draft.
The separate open #1167 payout, #1168 UI and #1171 voice workstreams were not modified.

## Release boundary

#1170 is merged, but the last inspected shared staging deployment was still
`3a37d67e` (run 36461328655). No staging deployment was attempted in R04.
No bank/gateway calls, real transfers, tax filing, payroll, customer bookings or
historical reconciliation were executed. Previous whole-completion finance rollback
and hosted booking-to-accounts acceptance requirements remain open under issue #17.

The next implementation gate is the complete journal-persistence repair, followed by
before/after tests, native local-D1 batch checks, related finance/collection tests,
full current-head CI and review. Native-D1 verification has NOT been executed here.
D1's documented batch rollback contract is a reference, not proof of this build:
https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

## 29 September continuation — staging verified and native D1 reproduction

The user's requested #1170 deployment is already present in the newer staging release
`7008c8560a509078d10f8e75e83c6e9343125b2d` (#1168 UI). Ancestry to #1170's merge
`3fd9f3b2be42bc565b3b80f750cc4c274d3166b3` was verified. Deploy staging run
36511803932 succeeded; downloaded certificate artifact 11009280838 reports 28/28
checks true, zero failures and no unavailable checks. It certifies the exact SHA,
isolated staging D1, sandbox mode, live approval false, six persona sign-ins and
six authenticated smoke routes. Certificate SHA-256:
`380668c6caa59a37808099118d5b4bd1ccda2446791e5829f174b2280340bf22`.
All four #1170 post-merge workflows are now successful. No older revision was deployed
on top of that accepted UI release. This is deployment verification, not a new full
hosted customer-to-accounts acceptance run. The PR now contains the verified checkpoint.

The R04 branch integrated the newer main without conflicts (`45f4229c` integration).
The attempted transactional-helper append was tool-blocked again. It was not retried
through a different interface. Its incomplete, unimported first chunk was moved outside
application source to continuation/finance-journal-integrity-incomplete.ts.txt.
No production financial function or source-protection manifest was changed.

### Native local D1 checkpoint (supersedes the earlier not-executed boundary)

Added tests/integration/finance-journal-integrity.test.mjs using the repository's
installed Miniflare converter and actual D1Database, with ephemeral storage, cf lookup
disabled and outbound requests refused. No cloud account credentials, hosted bindings,
real payments or network provider calls are used.

Three complete cases ran against the unchanged financial engine: normal posting/exact
replay passed; rounding-to-stored-lines and deliberately ignored balancing-credit safety
assertions failed because posting did not refuse them. Native baseline: 1 pass / 2 fail,
zero cancelled/skipped/todo, process exit 1. These are expected RED reproductions, not
implemented repairs. They show these two issues are not unique to the SQLite test shim.
The first constructor smoke used an incompatible API form; it was corrected to the
repository's existing convertV4MiniflareOptions pattern before this three-case run.

A separate append for three more native cases was tool-blocked and left unapplied.
Those cases are not included in the executed count. Workstation reads timed out while
checking completion; after connectivity returned, the saved complete TAP log and exit 1
were verified. No test remained active at that check.

Evidence is in r04-financial-journal-evidence-20260929/continuation, including the actual
native-d1-baseline.log and .exit and downloaded staging certificate. This branch remains
TEST-FIRST, not merge-ready: the full journal-persistence implementation, its positive
and fault/retry tests, related compatibility suites, full CI and review remain open.

## Implementation checkpoint — 29 September 2026

The transaction-guard implementation is now present on the R04 branch. This supersedes
previous implementation-blocked checkpoints, not the outstanding merge/deployment gates.
Only lib/finance-accounts.ts changes runtime behavior; standalone Node import compatibility
is retained, with the new private helpers kept inside that module.

- Validate every supplied monetary value before filtering, including NaN and infinities.
- Round each persisted line using the existing rule, then validate integer-cent totals.
  The established one-cent tolerance and signed correction amounts remain supported.
- Compare every financial row and identity in an existing group, not merely its first row.
  Partial, differently valued or differently identified groups require reconciliation.
  Exact replays remain read-only, including after month close. Narration and mutable
  verification metadata are intentionally not the immutable financial comparison.
- Wrap prepared journal inserts in before/after persistence assertions within the caller's
  D1 transaction. A suppressed balancing line aborts the batch; failed replay checks never
  fill or rewrite historical rows. Constraint-check rows are removed before commit.
- Add the existing native local-D1 regression to Financial Ledger Sandbox CI without
  changing any original command, permissions, environment gate or threshold.
- Refresh only finance-accounts.ts's nine protected-source snapshots after verifying each
  old hash against deployed main 7008c856; all other entries and assertions are unchanged.

The original eight tests plus all three native-D1 tests passed (11/11). Six additional
SQLite cases cover absent first rows, group counts/prefixes, Unicode/wildcard identifiers,
closed-month replay, signed/tolerated amounts and sub-cent zero-only journals.

The Unicode test initially failed and was repaired by counting code points like SQLite,
not JavaScript UTF-16 units. Broader compatibility first showed two failures (62/64):
a new extensionless helper import broke an existing standalone test, and one error's
wording changed. Keeping private helpers in the original module and preserving existing
error prefixes repaired both without modifying those tests. The same selection then
passed 64/64, zero failed/cancelled/skipped/todo, including the 17 R04 cases.

An append proposing two further native concurrent-posting tests was tool-blocked and
not reapplied by another interface. They are absent from the native test file and are
not counted as executed. The native evidence currently consists of the three retained
normal/replay, rounding and ignored-credit rollback/retry cases. Existing finance
concurrency regressions were run unchanged in the broader selection; they are not a
substitute claim for those two proposed new native cases. A later command returned an
indeterminate safety status; no changes were observed, and one identical retry through
the same execution tool succeeded. No blocked SQL was executed against a hosted database.

New evidence: r04-financial-journal-evidence-20260929/implementation/ contains the
first repair, expanded/Unicode and compatibility logs/exit files, source-snapshot
provenance, typecheck/lint and subsequent exact-head results. Full current-head CI,
review and any permitted additional coverage remain required before merge. Existing
pre-completion finance/lifecycle atomicity and historical reconciliation are not closed
by journal-row integrity. No hosted payment, payout, salary or financial-data repair
was performed, and this branch has not been deployed.

## PR #1172 failed-CI follow-up — 29 September

Integrated latest checked main `1610115c` (#1167 payout receipts) into this branch;
no upstream payout, UI, voice, permission or deployment behavior was discarded.
The old Release CI run 36514185154 reported 9,228/9,231 assertions passed and three
failures. Pre-UAT repeated the same three; hook-path certification repeated two.
A local reproduction of those three suites produced 29 pass / 3 fail, exit 1.

Two failures were genuine replay compatibility regressions: completion finance used
the new read date rather than the posted journal's accounting date, and legacy
journals did not have the modern vertical dimension. The caller now preserves the
original date, period and accounting dimensions when replaying. It does NOT copy
stored monetary lines as its expected values: amounts and source/account identities
still derive from the frozen completion calculation, and the strict journal checker
continues to compare every row. First-row-only acceptance has not been restored.
Closed-month legacy/current replays now assert that every original journal row is
unchanged. Five negative cases still refuse missing first/credit rows, changed
amounts, wrong source identities and wrong accounts without repairing history.

The third failure was a source contract expecting the old `existing` variable name.
It now checks the current `replay` name and both concurrent period/replay reads.
No existing assertion was removed. An attempted additional executable overlap test
was tool-blocked and left unapplied; it is not included in any passing count.

The reviewer also identified intermediate signed-sum overflow. Two new debit/credit
regressions reproduced it (14/16 passed); each now refuses before the unsafe addition.
The existing signed corrections, safe inputs and one-paise tolerance remain intact.
Two native local-D1 concurrent tests are now implemented and pass: identical posts
create one group; conflicting posts leave one complete winner and reject the other.
They use ephemeral D1, no credentials and refused outbound access. Total native cases
are now five; the earlier three-case boundary is superseded only for this candidate.

The expanded nine-file selection passed 101/101 assertions with zero failed/skipped.
A first expanded attempt failed because the new month-lock fixture preceded activation
of the existing backdated test term; placing that fixture AFTER existing term setup
preserved the real closed-period protection and the stronger replay assertions.
Nine manifests were refreshed only for the two reviewed runtime sources, validating
prior fingerprints against the integrated base and preserving all other entries.

Full exact-head repository/build and cloud results remain separate verification gates.
No historical ledger rewrite, live charge, refund, payout, salary, deployment or hosted
booking was performed. These fixes do not certify whole-completion rollback, bank
reconciliation, or production launch. Evidence: r04-financial-journal-evidence-20260929/
pr1172-failure-fix/ (failed CI logs, 29/3 and overflow 14/2 reproductions, repairs and
exact-source validation). Keep PR #1172 unmerged until final checks/review complete.
