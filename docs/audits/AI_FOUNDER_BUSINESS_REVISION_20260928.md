# PR 1161 — founder business update review revision, 28 September 2026

Base review commit: `7614247dcb738959d04e88099e4c3687df1b9eca`. Business authority: the founder's explicit six-service handoff of 28 September 2026, retained in `docs/ai/FOUNDER_BUSINESS_DECISIONS_20260928.md`.

## Changes prepared

- Six confirmed business decisions are separate from 12 open records: two implementation clarifications, eight remaining commercial groups and two independent authorizations.
- Grooming and Grooming subscriptions allow prepaid or pay-after-service, with cash/UPI acceptance. Method acceptance is not an invented exclusive-method prohibition or timing decision.
- Daycare uses full prepaid or 50% at booking / 50% due 24 hours before the exact start; no overnight longer-than-four-nights restriction. The read-only review helper marks less-than-24-hour bookings unresolved rather than inventing a new deadline or mandatory full-prepayment rule.
- Walking is prepaid for one-time bookings, subscriptions and renewals. Food is prepaid only. Relocation is enquiry-only, with no instant booking or payment collection.
- Subscription per-session versus whole-pack collection, milestone and credit activation remain unresolved. No ledger or collection implementation is inferred.
- Existing Training terms are recorded as unchanged code, not newly approved business terms: 50% upfront, remaining balance scheduled for the final session, 60% extra per additional dog. No training implementation was changed.
- Five focused cards added: the review library now has 70 unique cards. The human review copy contains the exact 12 affected card texts and is tested against the code.
- The specialist prompt no longer generalises subscriptions as prepaid-only, but the existing prepaid checkout action remains unchanged. No new voice-payment authority is granted.
- Staff coverage now reports confirmed decisions and unanswered questions separately. Draft staging still creates drafts only; it cannot replace an active source. No source-authority hierarchy was newly approved.

## Verification completed locally

Node 22.16.0:
- AI/voice regression selection: **662 passed, 0 failed**; final test command exit 0.
- Loader-hook fallback selection: **110 passed, 0 failed**; final test command exit 0.
- Tests cover the exact six service rules, payment timing versus method, daycare timezone/deadline boundaries including exactly 24 hours, invalid dates, unresolved collection, retained voice permissions, in-memory draft-only lifecycle, source retrieval, review-copy synchronization and honest unexecuted-audio status.
- Typecheck passed. Build passed, including Worker/hosting artifact validation.
- Full lint exited 0: **0 errors, 175 warnings**. Warnings are not represented as a clean warning-free result.
- Nine existing protected-source manifests were refreshed only for the intentionally changed grounded-runtime and knowledge-configuration paths after checking their previous values against the respective prior commits. No assertion or protected path was removed. A temporary harmless runtime edit was rejected by the existing Inbox protection test and then restored exactly.

These are local tests with disposable SQLite records and simulated external responses, NOT live AI audio proof.

## Remaining gates and restrictions

The original five audio scenarios and their twenty questions are preserved unchanged in `tests/fixtures/ai-founder-business-acceptance.json`, including the expected human handoff at question 4 of scenario 5. Nine founder-specific supplemental probes are listed separately. Status is **not_run_on_this_revision** with no fabricated results.

Review and exact-head CI precede isolated staging validation and the original five synthetic audio checks. Any draft knowledge used for a test must remain in an isolated/disposable review context; do not silently publish it into the live customer retrieval collection. Retain all attempts, ASR/audio completion, final transcript, factual grounding, timing, handoff and side-effect evidence.

No handset or carrier request, live knowledge activation, customer/payment change, payment-engine rewrite, shared-staging deployment or paid-model run was performed for this revision. The founder's handset stays on hold. Live publication, wider voice-payment access, the global V2 source hierarchy and unresolved commercial terms remain outside this authorization.

## Carried-over CI failures resolved in the same PR

The earlier `7614247` Release CI run `36423485291` finished with two distinct failures while the founder update was being prepared. Both were reproduced locally (9 passed / 2 failed across their original suites) before correction:

1. `tests/degraded-reads.test.mjs` identified malformed visibility JSON silently returning no knowledge result. The retrieval path now uses the existing degradation log and returns `retrievalDegraded` plus sanitized diagnostics while still excluding the bad record. Neither raw JSON, private source identity nor content is leaked. Invalid mixed-shape scope arrays are excluded too. The existing guard and its debt baseline were not changed.
2. `tests/elevenlabs-sales-action-chain.test.mjs` expected three total completed tool records, but fast voice now legitimately performs `approved_knowledge.read` before the original checkout. The test now asserts exactly **one knowledge read plus the original three ordered action tools**: reserve, booking and payment-order creation. It still verifies one model call, one booking/payment order, no Ops case, no automatic capture, and replay safety. No fourth mutation or extra payment authority was introduced.

After the correction: the focused recovery selection passed **21/21**; the expanded regression/fallback totals above are **662/662** and **110/110** on Node 22.16.0. Typecheck, build and artifact validation were rerun successfully. Fresh GitHub CI remains separate evidence and must finish before a green claim. No staging or live audio result is inferred from these tests.
