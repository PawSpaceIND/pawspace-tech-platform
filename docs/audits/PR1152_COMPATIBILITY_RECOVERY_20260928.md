# PR #1152 compatibility job recovery — 28 September 2026

## Observed failure
The earlier fixed-radius failure is repaired. At feature head `f1ce752569159099af91128c5d77cc8cec1c4f04`, required Web tests, both test-harness paths, production-readiness D1 and master-production-audit all passed.

Compatibility run `36387530854` started its job at 06:41:27 UTC and ended cancelled at 07:11:46 UTC. Its configured job budget was 30 minutes. The browser step enumerated 333 cases, passed 296 and reported no failed browser case before cancellation. It had reached the all-route visual matrix; unfinished cases are not passed cases.

## Repair
The unchanged Playwright configuration and scenarios now execute in four independent groups: the three desktop engines; four phone/tablet profiles; the full Chromium route/theme matrix; and the Firefox/WebKit route matrices. All ten project names are assigned exactly once. Existing per-test deadlines, one worker per runner and zero retries are unchanged. Every browser job retains a 30-minute budget.

Offline transport/storage and real-D1 regressions execute once, independently. Browser artifacts include group and source identities. The original `compatibility` gate waits for every group and offline tests; failure, cancellation or skipping cannot satisfy it. Matrix fail-fast is disabled so a failing group does not erase the others' evidence.

Three new executable regression checks failed before the workflow repair and pass afterward: project coverage equality, isolation/evidence preservation and all sixteen combinations of aggregate success/failure/cancelled/skipped inputs.

The feature branch also incorporates `81517b8a` (employee offboarding) from main without conflicts. Existing coupon, automatic-application and shared AI policy code is unchanged by this CI repair. No production configuration, payment rule, coupon allowance or test assertion is relaxed.

## Verification boundary
598 focused coupon/AI/V2/employee/presentation/offline/CI checks passed, with no failures or skips. Full current-head GitHub workflows and browser group results remain the release gate; earlier green runs are not substitutes. This document does not claim the new workflow has finished, that the branch has merged, or that staging has been redeployed.

The separate legacy informational findings in partner-settlement statements and AI analytics remain outside this CI scheduling repair. A green Node exit alone is not proof that all product flows are defect-free.
