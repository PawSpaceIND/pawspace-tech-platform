# PawSpace V2 staff interface - Phase 7

Date: 24 September 2026. Repository: PawSpaceIND/pawspace-tech-platform.
Branch: `feat/staff-brand-shell-20260924`.
Baseline: `2a5e58b7315be246270b98cc2a01e2d1d6c12897`.

## Implemented scope

This phase migrates the existing `/admin` operations dashboard and `/me` employee self-service portal to StaffModule/StaffWorkspace. Both belong to the same PawSpace V2 repository and shared application. The customer `/v2` screens, existing V2 aliases and service engines are not replaced.

Admin keeps its four existing local views: Overview, Live calendar, Bookings and Training operations. The original local menu and related links are retained in the labelled, keyboard-accessible Operations views and links disclosure. The global staff sidebar remains the common entry point. The old layout no longer overlays a competing fixed theme.

Admin now has readable metrics, an accessible zone filter on mobile, a scrollable provider schedule, booking selection/detail panels and themed access-error recovery. All four overview metrics remain visible on a phone. Booking IDs in links, zone parameters, selected-record state and all action handlers are unchanged.

Employee self-service keeps salary, payslips, governed incentives, advances, attendance, performance and leave views. Its existing colors are mapped to the approved staff tokens within style expressions only. Check-in/check-out and leave buttons have explicit readable sizing. Contract engagements continue to exclude employee salary, payslips and salary advances. Unlinked and rejected identities retain their original restricted presentation.

The approved Emerald/Gold and Brand-book Lavender Indigo/Gold Fusion options use the existing Nunito staff font and supplied logo. The customer appearance preference remains the source of the selected theme. No font or logo files were replaced.

## Preservation checks

The non-presentation syntax-tree comparison covers both edited page implementations. Data fetching, identifiers, amounts, local navigation handlers, leave validation, request payloads, contract-earnings conditions and business text are retained. Negative tests intentionally perturb endpoint, payload, scope and handler expressions to verify the comparison detects them.

A phase-start manifest protects 1,192 files: APIs, business libraries, customer and partner routes, database/migration sources, every Team page, the existing Admin child panels and TestSyncPanel. All remain unchanged in the completed source comparison. The original Admin stylesheet bytes remain above the new opt-in staff rules; mobility and food panel stylesheets are unchanged.

The staff frame retains its existing read-only menu-identity request. It is not an authorization bypass. No new API, business permission, database migration, provider configuration or credential change is introduced.

## Visible browser boundary

Desktop Commander runs the installed Chromium application on the authorized Mac with a visible window and slowed actions. Browser fixtures intercept every API call and block external browser requests. Synthetic check-in, check-out, leave, booking and user records never reach a real backend or employee account.

The new visible suite contains 28 scenarios. Populated checks cover Admin overview and capacity, the four existing local views, booking-ID handoff, server-side zone filtering, stale-zone suppression and access-error reload. Employee checks cover displayed payroll values, rejected and accepted clock requests, leave validation and request fields, contract-role exclusions, unlinked accounts and denied reads. Layout checks exercise 1440px, 1280px and 390px widths, both palettes in light/dark modes, selected text contrast and role-limited menus.

The first browser pass identified small employee clock buttons. These received explicit 15px text and 44px minimum height. Screenshot review also identified a low-contrast available-capacity label in dark mode; its text now uses the existing semantic success token. The final new-suite pass completed all 28 checks. No assertion was weakened and the business handlers were not changed.

A broader combined run was subsequently interrupted: the local preview stopped responding and the full regression ended without a final summary. Connection-refused browser failures from that interrupted attempt are retained, not counted as passes. Recovery keeps the finished build unchanged and runs the complete regression without concurrent browser verification before continuing visible browser checks.

## Existing behaviour and remaining release work

The Admin Training toolbar's Create plan action still displays its original notification and sends no plan-creation request. This was verified explicitly; it is not certified as functional plan creation. Existing dormant prototype views and the static legacy user label inside the local disclosure remain unchanged and are not newly enabled by this redesign.

Pre-existing unavailable-data summary values, the Control attention/clear wording issue, remaining Partner presentation, navigation reachability and role-menu review, authenticated hosted role/MFA tests and real sandbox-provider checks remain outside this checkpoint. Preserving a source file is not proof that a pre-existing defect is fixed.

No push, merge, deployment, production setting change or database migration is part of this phase. The hosted staging app is not replaced. A separate unauthenticated local observation window may be left open at the user's request; automated fixture windows close after their suites finish.

Across the seven presentation phases the primary implementation count is 85. All 76 Team routes retain their existing framed implementations or delegations. This is interface coverage, not a platform-wide operational acceptance certificate.

The existing menu-identity endpoint requires `dashboard.view`. The existing `service_provider` role can have `self_service.view` without `dashboard.view`, so a linked provider visiting `/me` can retain self-service content while the shared menu reports unavailable. This phase does not broaden either permission. The isolated navigation-failure scenario verifies that the child self-service controls remain accessible; actual role-specific navigation acceptance remains a rollout gate.

## Full-suite recovery result

The complete recovery regression completed on the unchanged finished build: **6,995 tests passed, zero failed, zero skipped, zero cancelled**. The earlier interrupted log has no complete test result and is not used for certification. The generated server entry and action-owner manifest hashes were recorded and checked to ensure that no rebuild replaced artifacts during this recovery.

Final build, TypeScript and 58 targeted surrounding regression checks passed. Lint of the changed application files, new test and browser script returned no warnings or errors before the keyboard-specific test refinement. The local disclosure is also exercised through focus and Enter in the final visible suite.

## Final verification summary

| Check | Verified result |
| --- | --- |
| Complete recovery regression | 6,995 passed; zero failed, skipped or cancelled |
| Phase 7 preservation and permission tests | 8 passed |
| Broader targeted surrounding regression | 58 passed |
| Admin/employee visible Chromium scenarios | 28 passed |
| Earlier six visible Chromium suites | 393 passed |
| Combined seven-suite visible Chromium run | 421 passed; zero failed |
| Protected sources | 1,192 files unchanged |
| TypeScript and verified Worker build | Passed |
| Final changed-source/script/test lint | No errors or warnings |

All seven visible suites completed on the recovery preview after the full regression had finished. Their totals were 28, 24, 81, 88, 42, 51 and 107. The final Admin/employee suite includes the keyboard disclosure interaction and the explicit clock-button and capacity-label readability checks. The observed connection-refused failures from the interrupted attempt are superseded by these complete reruns, not omitted from the evidence folder.

Evidence: `.ui-audit/phase7/final/{build,typecheck,targeted}.log`, `.ui-audit/phase7/final/protected-sources.json`, and `.ui-audit/phase7/recovery/{full-tests,lint,*-browser}.log`. The reproducible new script is `scripts/verify-staff-admin-self-service-ui.mjs`. No live backend certification is implied by the synthetic browser suites.
