# Customer chat UI repair and F-002 acceptance — 29 September 2026

Refs #1180; follows merged/deployed #1174. Base and inspected staging revision: `428fa89954ae795494a92d16969ffd7d2d155705`, certified deployment 36534500306.

## Recovered continuation
The previously unacknowledged command completed before disconnection. Recovered evidence recorded 59/59 local browser cases passed and 90/90 existing source-preservation cases passed. Recovery inspected the files and logs first; the earlier changes were not blindly repeated.

## UI-24 / UI-25 / UI-26 repair
Only `app/v2/chat/page.module.css` changes application presentation. It preserves the full original stylesheet as an exact prefix and appends chat-scoped rules: prevent intra-word navigation breaks on mobile; allow the two-line composer placeholder to fit; remove duplicate chat-only wrapper/page spacing; align normal-flow Appearance/order utilities at the right margin while retaining clearance above the dock. Desktop navigation retains compact controls.

No TSX, WATI component, message handler, authentication, payment link, network call, pricing or business rule changes. Three existing full-file stylesheet fingerprints are updated after verifying their exact preimages; all other records and original assertions remain unchanged. Four unchanged chat/shared source files plus the stylesheet prefix are independently guarded.

## Executed local verification
- Original four-viewport reproduction: 0/4 passed; failures detected broken words, clipped placeholder and excess footer spacing.
- Initial corrected pilot: 4/4 passed.
- Recovered expanded run: 59/59 passed.
- Final run after adding client-exception detection: **59/59 passed, zero skipped/retried/flaky cases; process exit 0**.
- Matrix: 320, 390, 768, 1440px; three palettes; light/dark; Professional/Fun. Also busy/error/retry, guest/account displays, internal payment-link presentation and compact 320x460, 390x460, 844x390 viewports. All chat API replies in these tests are synthetic browser fixtures, not real messages or provider responses.
- Existing protection suites: 90/90 passed. New chat-scoping/preserved-source tests: 7/7 passed. TypeScript and changed-file ESLint passed. These are local results until the exact-head hosted workflow completes.
- Representative narrow/mobile, dark and desktop screenshots were inspected. Screenshot/geometry evidence is not proof of physical-device keyboard or native safe-area behavior, which remains separate.

## F-002 deployed acceptance
The owner restored authenticated staff access. The real V2 Meet & Greet table was inspected at 320, 390, 768 and 1440px. Each viewport had 14 request rows and 14 repaired request-detail blocks; zero request-text rectangles crossed their cell boundaries, and document width matched viewport width. Identifier and action screenshots were captured; Confirm/Cancel stayed readable without invoking them. F-002 is **passed in these deployed states**. Actual data screenshots remain private on the authorized Mac under `Documents/PawSpace_V2_UI_Retest_2026-09-29/post1174-acceptance/`, not in this repository.

The original Founder register is now 24 passing samples, F-005/F-012 partial and F-019 awaiting further live checking. This does not close every role, dialog, theme or record state. Customer UI-24/25/26 remain pending release and live acceptance until this patch passes required CI/review, is deployed and is visually rechecked. Other customer/partner findings and whole-application coverage remain open. No live booking, payment, approval, customer message or call was submitted during this continuation.
