# Atlas narrative integrity candidate - NOT ACTIVE

The deployed founder Q&A route returned incomplete narratives under a 220-token limit. It does not currently check the provider stop reason. Five constructed negative controls also exposed gaps in the current numeric guard: missing mission data, overclaimed percentage, markdown labels, a contradictory second claim, and Indian magnitude units.

This branch contains only a candidate helper plus 15 passing focused tests. It is NOT wired into the live answer path and is NOT a completed fix. Typecheck passes. It does not grant any new execution permission.

The tool permission layer refused the requested edit to `lib/intelligence/atlas-business-snapshot.ts`. No alternate editing route was used. Approval is still needed before wiring the helper, supplying the explicit answer-scope contract, raising the bounded answer budget, checking provider completion reasons, and retaining useful canonical operational facts in fallback answers. Preserve upstream outcome-learning context as secondary observational context only.

After approved wiring, validate both positive and negative founder Q&A against the deployed exact build, then verify source/as-of, missing-current-mission behavior, percentages and currency magnitudes, repeat claims, draft-only scope, and no false financial/provider/campaign execution claims. The 15 candidate tests are not a deployed Q&A certificate.
