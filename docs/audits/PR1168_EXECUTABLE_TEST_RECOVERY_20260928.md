# PR #1168 — executable-test CI recovery

## Observed failures

The original candidate `dff1ce76127e76b2b5a5c025c4779769ff2a4ea0` passed its 60/60 hosted visual tests and both hook-path jobs, but Release CI Web tests and Pre-UAT full certification failed the same static-test ratchet.

- Web job `109020493974`: 9,068/9,069 tests passed in the main batch; the separate ten-test batch also passed.
- Pre-UAT job `109014101676`: 9,078/9,079 tests passed.
- Both reported 161 source-only test files against an unchanged limit of 160. The new `tests/ui-audit-closure.test.mjs` preserved source contracts but did not itself execute product code.

## Correction

The audit suite now imports and executes the actual `app/components/ui/ReadableText.tsx` through the repository's existing module-hook harness and React server renderer. Six runtime tests assert exact or bounded rendered output for paragraphs, emphasis, inline references, heading/list structure, ordered-list starts, escaped markup, literal links, fenced examples, unfinished markers, empty replies and long replies.

The original 45 action/program/source assertions remain. No budget increase, detector change, exclusion, skipped test or weaker predicate was introduced. No application component, API, payment rule, identity rule or production configuration was changed by this correction.

## Local verification

- Standard hook path: 53/53 passed (51 audit tests plus two unchanged static-test ratchet tests), zero skipped.
- Forced loader-hook compatibility path: 53/53 passed, zero skipped.
- ESLint on the changed test file: passed without warnings.

The hosted verdict must be rerun for the new commit. The former 60/60 browser result belongs to the unchanged application code at the earlier candidate, not automatically to this new head. Release and visual sign-off remain subject to the new head's complete CI and review; the wider customer/partner audit remains outside this batch.
