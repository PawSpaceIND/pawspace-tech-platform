# PR #1152: remaining Grooming CI timeout

28 September 2026. Original tested head: `347db0b8722b7e7d72004b56730278ca00248cc6`.
PR #1152 was independently merged as `c12153ee674780397a5e36ee428259aac873b32c` during the recheck. This follow-up starts from that main commit; the merged coupon implementation is not replaced.

## Observed failures
The persona workflow's first mobile run reached Booking confirmed, then its direct account-verification GET ended with `socket hang up`. One unchanged-head rerun completed successfully (run 36401077286, attempt 2). This supports a transient transport failure, not a proven product root cause.

A separate Grooming workflow (36401077812) then exhausted its 25-minute device-job budget. Desktop job 108858825651 logged 97/97 runtime cases and 113 passing browser cases out of 135 before cancellation. The 68 route-matrix cases alone consumed most of the job. Mobile job 108858826481 was also cancelled. Cancellation correctly failed the existing aggregate gate.

## Minimal workload repair
Each existing Chromium/Pixel 7 project now has four Playwright shards. Per-test sharding is enabled only in the V2 config; each job still has one worker, zero retries and the same 25-minute deadline. At most four jobs run concurrently. No spec, route, appearance, assertion, application code, payment setting or test-quality budget changes.

All eight jobs must succeed for the original `V2 Grooming desktop and mobile` aggregate to pass. Artifacts are separately named by exact source, device and shard. The existing runtime/database checks remain in every shard.

## Executed coverage proof
The extended existing workflow test initially failed 2/10 checks on the unsharded workflow. After the repair, all 12 workflow/inventory/test-quality checks pass. The installed Playwright runner lists 135 cases per device and assigns them 34/34/34/33 across its four shards. The union equals the complete registered inventory exactly once: 270 device/case combinations, none omitted or duplicated. This is registration proof, not browser-execution evidence.

The original gate script is executed against success, failure, cancellation, skipped, missing and unknown results; only success passes. The 160-file static-test limit is untouched. Full browser execution, lint, build and repository-CI results are separate release gates and must not be inferred from inventory verification.

Evidence on the authorized Mac: `Documents/PawSpace-fixes/pr1152-grooming-shards-evidence-20260928/`. No shared staging or production deployment is included in this repair.
