# PawSpace V2 staff interface - Phase 6

Date: 24 September 2026. Repository: PawSpaceIND/pawspace-tech-platform.
Branch: `feat/staff-brand-shell-20260924`.
Phase baseline: `4b420c5c1e96bb65d3e7254002a10949f5e6f659`.

## Implementation scope

This phase migrates 23 additional primary Team screens to the existing StaffModule/StaffWorkspace presentation. It does not introduce a new app, replace the customer V2 UI, or rewrite a business engine. The V2 entry routes continue to import the same shared staff components.

| Group | Migrated routes |
| --- | --- |
| AI and reporting | `/team/ai`, `/team/ai/configuration`, `/team/ai/handoff`, `/team/ai/rollout`, `/team/acquisition-funnel`, `/team/analytics` |
| Revenue and communications | `/team/daily-revenue`, `/team/sales/power-dialler`, `/team/sales/cross-sell`, `/team/bot-call-outcomes`, `/team/haptik` |
| Marketing and language | `/team/marketing`, `/team/marketing/content`, `/team/i18n` |
| Operational administration | `/team/alerts`, `/team/catalogue`, `/team/pricing-rules`, `/team/provider-onboarding`, `/team/provider-verification`, `/team/subscriptions` |
| Other services | `/team/funeral-memorial`, `/team/relocation`, `/team/relocation-enquiries` |

Twenty-two page implementations are framed directly. The cross-sell route delegates to the existing shared CrossSellCommandCenter, which is now framed without copying its recommendation engine. Its alternate `/cross-sell` entry also receives that shared presentation. The existing NextBestServiceCard, UnifiedWorkQueue and contact-safety engines are unchanged.

## Brand and layout

The staff frame retains the user-approved Emerald/Gold option and the Brand-book Lavender Indigo/Gold Fusion option, with Nunito body typography and the supplied proportional logo. The customer theme selector remains the source of browser appearance preferences. Customer V2 screens are not restyled by the new staff selectors.

Forms, narrow grids, provider checks and the Power Dialler now use readable staff styles. Gold action surfaces retain contrasting dark text. Cross-sell queue details reflow below the household on laptop widths instead of being squeezed into the narrow priority column. The mobile view retains all queue facts and safety labels.

## Preservation boundary

Semantic source checks compare all 23 implementations against their phase-start version, excluding only approved style attributes and presentation wrappers. Requests, payloads, handlers, conditional action gates, record identifiers, rendered business wording and calculations remain part of the comparison. Permission-negative checks execute the existing permission helper.

The phase records and checks 1,088 protected files, including API routes, business libraries, customer V2/mobile implementations, partner-app sources, migrations, and the existing cross-sell recommendation/work-queue child components. No protected file changed. The shared staff frame continues to make its existing read-only menu-identity request; page-specific business requests are retained.

Source inventory now accounts for every one of the 76 `/team` routes: 70 directly render an approved frame, and six preserve their original delegation to an already-framed component. A new regression test follows those six known delegations instead of treating a short route file as automatically complete. This is presentation coverage, not proof of every operational workflow or every role permission.

## Browser verification boundary

Desktop Commander controls the authorized Mac. The browser runners launch the installed Chromium application with a visible window and a short action delay. Every browser API request is intercepted inside an isolated test context and external browser requests are blocked. Fixture actions do not reach real customer data, providers, advertising accounts, payment gateways, AI providers or bank services.

Populated checks cover rollout refusal and stage requests, campaign approval refusal and audience snapshots, alert acknowledgement/resolution, daily-revenue claims and targets, language drafting with a disconnected provider, provider-verification refusal, and callback validation/disposition in the Power Dialler. Cross-sell tests use completed service history to produce actual recommendations through the unchanged recommendation engine: marketing opt-out and open complaints suppress both cards; eligible contact records retain the original outreach links; missing service economics remain 'Not configured'. These are browser UI and request-contract checks, not live backend authorization certification.

All 23 new primary routes are exercised at 1440px, 1280px and 390px widths, including mobile navigation. Six representative screens are checked with both palettes in light and dark modes. Workspaces without a populated fixture are explicitly checked only for their shell and unavailable-data presentation. The tests also verify one staff frame per route, customer/partner isolation, role-filtered menus and recovery when the navigation request fails.

## Recovery and verification sequence

The interrupted previous build had stopped before its generated server artifacts were complete, and the prior full regression had no final summary. Those logs were retained rather than counted as passes. An intermediate recovery run then collided with a rebuild and reported one missing generated server-manifest import (6,986 of 6,987 tests passed in that intermediate run). No application workaround or test suppression was introduced. The final sequence completes the build first, keeps those artifacts unchanged, then reruns the complete regression suite and every visible UI suite.

The cross-sell laptop queue spacing was refined after screenshot review, and the final browser harness asserts that opportunity details have their own full-width column. The final verification is against that rebuilt version, not the earlier screenshots.

## Release boundary and remaining work

This phase does not change the hosted staging site. No push, merge, deployment, production setting, credential update or database migration is performed. The customer `/v2` UI remains outside this redesign.

Remaining work includes the Admin and employee self-service presentation, Partner presentation, final navigation reachability and role-menu review, and authenticated hosted/MFA/sandbox-provider testing. Previously recorded misleading unavailable-data summary values and the Control attention/clear display issue remain unchanged by this migration. Source preservation is not a claim that pre-existing defects are fixed.

The uploaded route directory is an inventory, not an end-to-end certificate. All final rollout decisions must retain that distinction. Local source, reproducible tests, logs and screenshots are retained in this branch and under `.ui-audit/phase6/`.

## Verified presentation results

| Check | Final result |
| --- | --- |
| Phase 6 preservation, permission and route-inventory tests | 28 passed; zero failed or skipped |
| Phase 6 visible Chromium scenarios | 107 passed |
| Pilot/Team Home, Sales and Bookings visible checks | 24 passed |
| Shared Operations/CX consoles visible checks | 81 passed |
| Finance/People visible checks | 88 passed |
| Service Operations visible checks | 42 passed |
| CRM/Control and V2 alias visible checks | 51 passed |
| Combined visible Chromium scenarios | 393 passed; zero failed |
| TypeScript and verified Worker build | Passed |
| Changed application/script/test lint | No errors or warnings in the completed recovery lint run |
| Protected source comparison | 1,088 files unchanged |

The final Chromium scenarios used the rebuilt version containing the corrected laptop queue layout. Tests continue to retain 76 Team entry routes in the inventory. Across the six migration phases, the primary presentation count is 83; aliases and individual Control subviews are not counted as additional primary screens.

Existing build-tool warnings about config-loader compatibility, CSS output filename duplication and route classification remain visible in the build log. They were not suppressed. This report does not assert production readiness or complete business-functionality coverage.

## Final full-suite result

The complete regression suite was rerun after the final build completed and while application sources and generated build files remained unchanged: **6,987 tests passed, zero failed, zero skipped, zero cancelled**. The earlier generated-manifest race is not present in this clean run. No assertions or safety gates were weakened to obtain it.

Final evidence: `.ui-audit/phase6/certified/full-tests.log`, `build.log`, `typecheck.log`, `presentation-tests.log`, and the six `*-browser.log` files. The browser scripts close their automated contexts after completion. A separate unauthenticated observation window may remain open on the local preview at the user's request; it is not a live staff session.
