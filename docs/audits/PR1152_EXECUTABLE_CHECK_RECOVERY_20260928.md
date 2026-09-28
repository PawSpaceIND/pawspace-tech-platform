# PR #1152: executable test-quality recovery

Date: 28 September 2026. Failed source: `c6e985ce87919b029100aacb27b37d9eac0db89d`.

## Failure
Both Web tests (job 108842926757) and Staging isolation + full certification (job 108841863834) failed the static-test ratchet: 161 files against the unchanged limit of 160. Each job reported one failed assertion. The previously repaired offer-card radius was not this failure.

The recent `v2-launch-ci-partition` suite checked workflow structure and executed its aggregation shell, but did not execute product code. The ratchet intentionally measures app/lib execution, not shell-only evidence; its final-eight filename excerpt is not a list of newly introduced defects.

## Repair
Retained every existing partition, sandbox declaration and failure-propagation assertion. Added executable cases for both actual workflow partitions using `parsePaymentEnvironment` and `sandboxCapabilitiesUnlocked`, with each run step's effective job/step environment.

Verified the real parser accepts those sandbox environments and rejects live mode even with approval, malformed environment declarations, and a live-prefixed key in the sandbox binding. No network, genuine credentials, bookings, campaigns or payments are used.

The quality budget remains 160. No detector change, exemption, skip or removed assertion. The final measured count is back within that unchanged budget. Integrated upstream `f2552452` without conflicts; coupon/AI/Grooming sources and the quality guard are byte-identical to the failed source.

## Non-vacuity proof
Temporarily disabled, separately, the production parser's live-mode block, misbound-key block and sandbox capability refusal in this isolated worktree. Each mutation left the three original structural tests passing but made both new runtime cases fail. Restored exact original bytes after every experiment; none of these mutations is committed.

All 11 focused partition, route-batching and quality checks pass after restoration. Including the existing payment-pilot checks: 16/16 pass. Full-run and hosted CI outcomes are recorded separately on the PR when complete, not inferred from these focused results.

Evidence on the authorized Mac: `Documents/PawSpace-fixes/pr1152-latest-failure-20260928-evidence/`, including original job logs, before/after results and mutation-proof.json. No staging/production deployment is part of this test-only repair.
