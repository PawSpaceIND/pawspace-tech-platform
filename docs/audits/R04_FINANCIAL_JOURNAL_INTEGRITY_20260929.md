# R04 — financial journal integrity: reproduction checkpoint

Base: `3fd9f3b2be42bc565b3b80f750cc4c274d3166b3` (merged #1170).
Branch: `fix/r04-financial-journal-integrity-20260929`.
Status: TEST-FIRST / implementation blocked. Not merge-ready or deployed.

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
