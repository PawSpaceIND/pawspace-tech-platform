# PawSpace staff UI consolidation - Phase 2

Date: 24 September 2026. Branch: `feat/staff-brand-shell-20260924`.
Baseline for this phase: `87fb55bc1badff8c996275bb0170df7fe543cdbd`.

## Implementation boundary

The existing Operations and Team shells now delegate their persistent navigation to the branded StaffWorkspace. Nineteen additional primary screens inherit this presentation without edits to their page TSX files. Together with the first three pilot screens, this makes 22 primary screens using the shared frame. Aliases are not counted as additional primary screens.

The primary rail retains seven expandable groups and Home. The old Operations destinations, caller-supplied navigation, badges and footer links remain reachable inside a collapsed "Related workspace links" section. No old route was deleted or rewritten. Five existing section destinations were added to the primary navigation: Meet & greet, WhatsApp workspace, Revenue mission, Lifecycle automation and Subscription plans.

## Screens included

| Existing shell | Primary routes |
|---|---|
| Operations and customer care | `/team/operations`, `/team/scheduling`, `/team/cases`, `/team/customer-experience`, `/team/customer-reminders`, `/team/lifecycle-reminders`, `/team/meet-and-greet` |
| People and finance | `/team/people`, `/team/performance`, `/team/finance-compliance`, `/team/subscription-plans` |
| WhatsApp | `/team/whatsapp`, `/team/whatsapp/templates`, `/team/whatsapp/automation`, `/team/whatsapp/analytics` |
| Intelligence and voice | `/team/revenue-mission`, `/team/ai/analytics`, `/team/voice`, `/team/voice/ai-test` |

## Visual changes

Emerald/Gold and official Purple/Gold palettes share Nunito typography, the supplied proportional logo, light/dark surfaces, visible focus rings, readable controls and consistent headings. The shared console token bridge is scoped to these staff screens, not the document root. Four console stylesheets use staff variables with legacy fallbacks. Explicit small-text rules in those stylesheets are at least 13 CSS pixels. Previously unstyled native fields receive borders, padding and label spacing.

The CX inspector reflows beneath the conversation columns and remains in the document flow on narrow screens. Desktop and phone checks include opening and closing the shared navigation. Existing primary-button text keeps its previous white fallback outside the staff scope.

## Wiring and source protection

All 19 consuming page files match their phase-start SHA-256 hashes byte for byte, including data fetching, mutations, controlled fields, calculations, copy and conditional rendering. Another 1,083 protected source files across API routes, libraries, customer V2/mobile routes, partner-app sources and database/migration directories also match their recorded hashes.

The shell reads the existing `/api/team-overview` endpoint for menu identity. This is an additional read on migrated screens; it is not a replacement for their own requests or a permission grant. A failed navigation read does not hide the child workflow. Server authorization, MFA, consent, payment and financial rules were not edited. Existing contextual links can still lead to server-denied destinations; menu presentation is not an authorization boundary.

Original CSS selectors were recorded and checked with PostCSS. The obsolete visual assertion that required the old fixed purple admin rail was updated to require the approved shared staff frame. Existing API, security, governance and route checks were retained.

## Browser verification boundary

Desktop Commander was used on the authorized Mac. A separate Chrome/Chromium session opened the local built application. Automated UI checks use an isolated loopback browser context and intercept every API request. External browser requests are blocked. Fixture writes never reach a real API, database, customer, messaging provider or payment service.

The final Phase 2 browser suite passed 81 of 81 scenarios. It exercised case filters, response and resolution payloads, CX internal-note idempotency keys, human-reply payloads, search/ownership query parameters, expired reply-window restrictions, lost-access clearing, both palettes in light and dark modes, enabled-control contrast, role-menu filtering and navigation recovery. All 19 routes were checked at 1440px, 1280px and 390px widths. For routes without populated fixtures, these are shell/unavailable-state checks, not complete business-flow certification.

The previous three-screen Chromium suite was rerun and passed 24 of 24 scenarios, including customer-UI isolation. Combined final browser checks: 105 passed, zero failed.

The initial browser run had four test-fixture failures because an earlier resolution action had correctly removed the only open case. Theme checks now reset their synthetic case data. Theme screenshots also wait for existing CSS transitions before measuring control contrast. Final screenshots are from the corrected run.

## Final automated regression

A fresh full-suite run on the final code passed 6,877/6,877 tests, zero failures, zero skipped. Build and artifact validation passed. TypeScript and changed-file lint passed. Final Chromium confirmation passed 81/81 Phase 2 scenarios; the pilot suite passed 24/24 on the previous final run. Local evidence: `.ui-audit/phase2/full-tests-certified.log`, `build-certified.log`, and `browser-certified.log`.

## Remaining release work

The standalone finance workspaces, People submodules, service-specific operations queues, legacy CRM/Control, remaining intelligence/growth pages and Partner screens still require their own migration and testing. This phase does not certify the whole platform or all integrations.

Authenticated hosted-role testing, Finance MFA, real sandbox-provider verification and reviewed integration remain release gates. This implementation has not been pushed, merged or deployed. The existing hosted application was not replaced.

Evidence is retained under `.ui-audit/phase2/`; reproducible browser scripts are `scripts/verify-staff-console-ui.mjs` and `scripts/verify-staff-brand-ui.mjs`. Temporary browser/preview processes are separate from the user's existing sessions.
