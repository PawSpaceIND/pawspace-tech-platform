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
