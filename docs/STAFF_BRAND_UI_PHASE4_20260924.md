# PawSpace staff UI - Phase 4 / visible Chromium

Date: 24 September 2026.
Branch: `feat/staff-brand-shell-20260924`.
Phase baseline: `b2475b44786ae269f762f4b6f197f1b7698e0f7a`.

## Visible browser request

The earlier automated checks used actual Chrome/Chromium in headless mode, with isolated synthetic API fixtures. This phase opened the installed Chromium application in a separate headed session on the user's authorized Mac through Desktop Commander. It did not attach to or modify the user's personal browser profile.

The observation window opened the real local build at `http://127.0.0.1:4318/team`. Initial direct navigation was unauthenticated. Subsequent workflow checks used a separate visible Chromium context with every API request intercepted and external requests blocked. The Operations test pages are titled `PawSpace | VISIBLE SYNTHETIC UI CHECK`. A visible browser does not convert synthetic UI testing into authenticated backend or live-provider certification.

All four reusable UI check scripts now accept `STAFF_UI_HEADED=1` and `STAFF_UI_SLOW_MS`, plus the existing explicit Chromium executable path option. Their assertions were not removed. Normal unattended execution can remain headless.

## Additional screens

Ten primary Operations routes now use the existing StaffModule frame:
- Training, Boarding, Sitting, Walking and Taxi Operations.
- Food Operations, fulfilment, proof/quality and supply chain.
- The cross-service exception work queue.

This brings the migration implementation to 53 primary staff screens across the four phases, excluding aliases. Customer V2 and Partner app code were not migrated or changed in this phase.

## Training-specific readability

The existing shared TrainingPanel TSX is byte-for-byte unchanged. Its 7-8 px labels and controls are restyled through appended CSS rules that only match inside `[data-staff-module]`. The prior admin rules are preserved. The changes include readable recovery buttons, programme/session details, theme-aware surfaces and responsive panels. All four Training metrics remain visible on narrow screens; the old shared admin stylesheet hid two of them.

## Non-presentation protection

The ten page sources are compared using the existing AST-based presentation contract. Only StaffModule wrappers/imports, style objects and explicit presentation grid attributes are excluded; handlers, calls, payloads, fields, conditions and wording remain in the comparison. Source tests also verify that changing replacement actions, idempotency keys or note gates would fail the contract.

The manifest pins 1,088 protected source files, including APIs, libraries, customer/partner sources, database/migrations, TrainingPanel, Operations index and Booking Command Center alias. No endpoint, booking lifecycle, provider-recovery policy, financial calculation, permission rule, consent rule or MFA check was edited. StaffModule adds the same read-only overview request used in the previous migration phases for navigation identity.

## Browser evidence

The final headed rerun completed 235 checks: pilot 24/24, shared consoles 81/81, Finance/People 88/88 and service Operations 42/42. All four used the installed Chromium executable and visible windows; slow-motion steps were enabled. These are synthetic UI checks, not live data or external integration tests.

The Operations suite verifies Training reschedule session IDs, start/end duration and idempotency keys; non-actionable completed sessions; visible access refusals; Boarding replacement target/identity and server-refusal handling; and exception-queue claim/resolve payloads and note gates. Ten routes are checked at 1440, 1280 and 390 CSS pixels. The remaining service screens use unavailable-state fixtures, so a successful shell check is not certification of every populated workflow. Emerald/Signature light and dark variants are checked for Training, with readable recovery controls and all four mobile metrics.

Screenshots and test output are retained in `.ui-audit/phase4/`. The source assertions and report use the reviewed phase baseline above. Initial diagnostics exposed the repository's static-only-test budget: the new source-contract test needed actual product-code execution as well. A real Training policy state-matrix test was added; the budget and meta-test were not changed or bypassed.

## Release boundary

The remaining legacy CRM/Control, other AI/growth/service screens, full navigation coverage and Partner migration remain separate work. Authenticated hosted-role/MFA testing, provider sandbox integration checks and reviewed staging release are not certified here. This local UI branch has not been pushed, merged or deployed by this work.

The source changes are UI wrappers, scoped styles, non-production browser-test options, contract tests and documentation. No production credential or environment configuration was modified. Four lint warnings remain in unchanged hook expressions in the Food, Sitting, Taxi and Walking pages. The build's existing premium-marketing CSS filename warning also remains; it is not silently suppressed.

## Final validation

- Full final regression: 6,917 tests passed, zero failed, zero skipped. The final run completed after the test-quality correction; the earlier failed meta-test is not treated as a pass.
- Operations-specific source and executed-policy checks: 14 passed. Together with the two unchanged test-quality meta-checks, the targeted correction run passed 16/16.
- Final visible browser reruns: 24 + 81 + 88 + 42 = 235 passed, zero failed.
- TypeScript, built application and Worker artifact validation passed.
- Changed-source lint: zero errors, four warnings in unchanged hook logic.
- Protected non-presentation namespaces show no changes against the phase baseline.

The ten-page implementation is complete at this local checkpoint. The global UI consolidation and hosted release gates remain open as described above. The user-facing observation browser is separate from the short-lived synthetic automation contexts; idle viewing is not an unattended build or test job.
