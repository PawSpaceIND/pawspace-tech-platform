# R05 — hosted Grooming selection test repair

Base reproduction: deployed c1a5bd5ef0447beb3911ff52b31b55cf0c114376.
Original hosted run: 36528294137; artifact: 11015517751.
Branch: fix/r05-hosted-groomer-selection-20260929.

## Cause and boundaries
The hosted runner selected the first provider-section button and expected a bold
provider name. That button now intentionally selects automatic matching and has
no named-card markup. The real preview returned three eligible UAT groomers,
reserved=false. The recorded trace has no canonical-booking or checkout request.
This is a test-runner defect, not proof of a customer-selection or finance defect.
The first hosted attempt exercised a synthetic customer/pet and pricing records.

## Repair
Both the hosted journey and rendered-page regressions use chooseFirstNamedGroomer.
It scopes the provider section, selects a named card, asserts pressed/check-mark
state, automatic-mode deselection and the exact Groomer summary. It does not reserve.
The positive case checks no writes at selection, then a normal specific-provider
reservation with exact provider identity, one booking and no payment order.
The existing unavailable-provider test retains its no-replacement/no-booking/no-
payment assertions. Payment, pricing, scheduling, permission and UI code are unchanged.

## Recovered local verification
After the workstation reconnected, the complete saved logs and exit files were read:
4/4 desktop/mobile rendered-page cases passed, zero retries; typecheck and focused
lint exited 0. These used synthetic API/payment doubles, not hosted transactions.

## PR #1178 CI correction — 29 September 2026

Failure baseline: `84397cc53158859b8bd7d25683374ddb2ecb8148`, containing checked
main `428fa89954ae795494a92d16969ffd7d2d155705`. Release CI 36534856930,
Pre-UAT 36534856907 and the loader-path job all report the same fingerprint
assertion in `inbox-workspace-presentation.test.mjs`. The Web batch completed
9,488 assertions: 9,487 passed, one failed; separate certification passed 10/10.
The isolated six-case suite reproduced that failure locally: five passed, one failed.

The UI-mainline manifest still pinned the pre-R05 `e2e/v2-grooming.spec.ts` bytes.
After reviewing the exact selector/helper changes and verifying the old hash against
upstream, updated that one existing fingerprint. Added protection for the shared
selector helper and hosted journey as well: 1,039 existing entries are retained;
1,041 are now protected. All other manifest sections and entries remain unchanged.
No application, payment, permission, workflow, timeout, retry or assertion changed.

The unchanged six-case suite now passes 6/6 on both Node 22.16.0 loader paths.
Three temporary edits, one in each protected R05 test/helper file, each cause exactly
that integrity test to fail with exit 1 (five passes, one failure). Every temporary
edit was restored before committing. This verifies the guard was retained, not disabled.

Evidence: `Documents/PawSpace-fixes/r05-hosted-booking-acceptance-20260929/`
`pr1178-failure-fix/` contains failed CI logs, the local reproduction, fingerprint
provenance and positive/negative guard logs. Final-head cloud CI/review remains a
separate gate. This correction makes no hosted booking, payment, merge or deployment;
full hosted booking-to-accounts acceptance under #17 remains open.
