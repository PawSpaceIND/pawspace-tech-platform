# PawSpace staff UI consolidation - Phase 3

Date: 24 September 2026. Branch: `feat/staff-brand-shell-20260924`.
Phase baseline: `82d4158b339bedebd9485f8bc5324c54475f96de`.

## Scope

Twenty-one additional primary Finance and People routes now use the existing branded staff frame. This brings the combined implementation to 43 primary screens: 3 pilot screens, 19 shared-console screens and 21 standalone Finance/People screens. Aliases are not counted as additional primary screens.

Finance (12): main ledger, cash flow, partner finance, statutory/GST, training, sitting, walking, taxi, food, relocation, funeral/memorial and unit economics.

People (9): finance, incentives, manager dashboard, employee onboarding, payroll, provider training, reports, service incentives and attendance/leave.

The implementation adds a presentation-only StaffModule wrapper. Existing Emerald/Gold and signature Purple/Gold palettes, Nunito, proportional supplied logo, mobile navigation and light/dark preferences are reused. Forms, tables, headings and narrow-screen grids are restyled without replacing their state or action functions.

## Wiring boundary

The 22 edited TSX files include 21 screen implementations and the embedded invoice-ownership panel. Their non-presentation TypeScript syntax trees match the recorded baseline. The comparison ignores style properties and the approved wrapper, but retains request endpoints, request bodies, calculations, prompts, conditions, disabled states, handlers and text.

Twenty-six contract tests cover the 22 files, deliberate mutation detection, wrapper boundaries, scoped CSS and unchanged server-side query-param forwarding. The existing sitting/taxi/walking booking IDs and food order IDs remain forwarded by their original async route pages.

An independent Git content-hash check compared 1,151 files under API, library, V2/mobile, partner-app and database/migration directories with the phase baseline. No changed, missing or additional untracked protected files were found. Evidence: `.ui-audit/phase3/recovery/protected-source-hashes.json`.

The navigation still performs the previously introduced read of `/api/team-overview`. This phase does not add a new business endpoint, replace child-page requests or relax server authorization. Payment, refund, payroll, tax, consent and MFA rules are unchanged.

## Recovery findings

The interrupted browser run reported 45 passes and 43 failures. Most later failures were navigation timeouts or a closed browser after the connection stopped responding. Those results were not treated as passed.

One earlier GST test failure was independent of the interruption: its exact label locator included option text and did not match. Chromium's accessibility tree exposed the correct combobox names. The harness now selects those three comboboxes by role and exact accessible name. The application form, its required evidence and its submit handler were not changed to make the test pass.

## Final validation

| Check | Result |
|---|---|
| Complete regression run after reconnection | 6,903 passed; 0 failed, skipped or cancelled |
| Finance/People presentation contracts | 26/26 passed |
| Phase 1 Chromium rerun on final built app | 24/24 passed |
| Phase 2 Chromium rerun on final built app | 81/81 passed |
| Phase 3 Chromium run on final built app | 88/88 passed |
| Combined final Chromium scenarios | 193/193 passed |
| TypeScript | Passed |
| Build and Worker artifact validation | Passed |
| Targeted lint | 0 errors; 1 existing cash-flow hook dependency warning |
| Protected-source content hashes | 1,151 unchanged |

The browser suites run in isolated loopback Chromium contexts. Every API call is intercepted, external browser requests are blocked and all records and writes are synthetic. They verify UI behavior and request contracts, not authenticated hosted-role access or live-provider integrations. Routes without populated fixtures are checked for shell, responsiveness and unavailable-state rendering only.

Populated scenarios include finance refresh and failed-read clearing; separate cash, earned and deferred totals; training invoice eligibility and prompt evidence; sandbox payout idempotency; payroll review, denied approval and sandbox preparation; GST ownership form validation and submission; and required employee-onboarding fields. Desktop widths 1440/1280 and phone width 390 are covered. Both palettes and light/dark modes are checked on representative populated screens. Existing customer/partner app wrappers remain unchanged.

The cash-flow hook warning was not suppressed and its existing effect/dependency logic was not rewritten as part of the visual change. The production build still emits the existing premium-marketing CSS filename warning; artifact validation passes. Full visual/accessibility certification of every data state remains outside this fixture run.

## Next implementation scope and release gates

Next are the standalone service-specific Operations queues: boarding, sitting, training, walking, taxi, food fulfilment/proof/supply-chain, and the work queue. Their existing booking/order identifiers and recovery/assignment actions must retain the same contracts. Legacy CRM/Control, remaining intelligence/growth screens and Partner presentation follow.

Before team rollout: finish module navigation coverage, perform authenticated hosted-role checks (including Finance MFA and maker/checker), verify real sandbox integrations, review the combined branch and deploy only to the approved environment. Nothing in this phase authorizes live payments, live messaging or production activation.

The implementation is saved on the local feature branch. It has not been pushed, merged or deployed. The existing hosted application was not replaced. Evidence and screenshots remain under `.ui-audit/phase3/recovery/`; the reusable browser runner is `scripts/verify-staff-finance-people-ui.mjs`.
