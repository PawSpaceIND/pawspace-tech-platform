# PawSpace V2 - Customer and Partner theme consistency

Date: 25 September 2026. Repository: PawSpaceIND/pawspace-tech-platform.
Branch: `feat/staff-brand-shell-20260924`. Baseline: `faa5d2ba821981b7cf740a04b621933c7e0817ce`.

## Requested scope

The user expanded the previous staff-only work to include the Customer V2 app and Partner app, particularly the plain Relocation and Fresh Food screens. This checkpoint uses the approved Emerald/Gold option and the brand-book Lavender Indigo/Gold Fusion option, Nunito body typography, and existing PawSpace illustration assets. No new external assets, provider integrations, purchases or production settings are introduced.

## Implementation

Thirteen existing CSS modules opt into a shared, locally hosted brand palette. Their original stylesheet prefixes remain intact. The additions improve theme-aware surfaces, headings, controls and contrast. The existing appearance preference and its event remain the source of the selected colour theme and light/dark mode; no new application state is added.

Relocation now has a branded illustrated header, distinct inquiry/detail cards, readable field labels, a two-column desktop form and a single-column mobile form. Its eleven existing inputs, validation messages, domestic/international determination, customer identity source, inquiry IDs and action handlers remain unchanged.

Fresh Food now has a themed illustrated header, product choices, selected-order controls, readable pricing/quote summary and responsive ordering layout. The existing catalogue, quote, order receipt, subscription controls, renewal-payment, invoice and customer order-management screens are retained. Server-owned prices and pet eligibility, the in-flight order guard, order idempotency, subscription cadence, payment-link behaviour and Finance cancellation boundaries are not rewritten.

Additional coverage includes Customer V2 Home, Account, Activity, Chat, Grooming and management, Training, Boarding, Sitting, Taxi, Walking, booking detail and confirmation. Two new management layouts reuse the existing V2 navigation component on Boarding/Sitting management routes. They do not fetch identities or alter route parameters. The Partner hub and primary Partner app receive the same brand palette; this is not completion of all service-specific Partner workflows.

## Preservation evidence

The theme manifest retains hashes for 1,417 existing protected files. All existing application TS/TSX, API, validation, provider and business-engine code in that snapshot must match its original bytes. Older staff snapshot tests now separate only specifically approved CSS appends and still verify the original bytes. The CSS guard rejects unapproved files, missing markers, modified original prefixes, unexpected at-rules, unscoped selectors, external style sources and active style expressions. The two new layouts are additive presentation/navigation only.

## Browser method and limits

Checks run in actual visible Chromium on the authorized Mac through Desktop Commander. Every browser API response is an isolated fixture; non-loopback requests are blocked. These tests do not create live orders, charge money, send OTPs, send messages or certify real hosted identities. Populated tests exercise Relocation and Food workflows; unconfigured service APIs are explicitly unavailable, rather than fabricated as complete workflows.

The Mac previously ran critically low on disk space during a long browser run. That run was stopped and retained as incomplete. The runner now persists progress after each check, stops before free space falls below its protective threshold, and supports small sequential appearance batches. No personal files or user applications were deleted or closed. A Food renewal selector was corrected to locate the existing combobox by its accessible-name prefix; the application form was not changed for the test.

## Completed browser and palette checks

The final bounded runs completed 219 checks: ten workflow and appearance-control scenarios, 200 appearance combinations, and nine per-run unhandled-error checks. The appearance matrix covers the 23 Customer V2 entry routes plus `/v2/partner` and `/partner`, at 1440px and 390px, in Emerald and Signature, each in light and dark mode. A route-inventory regression compares that list with the source tree. Management pages without an ID and services without a configured API fixture are tested at their empty/unavailable boundary, not as completed business journeys.

The Food workflow additionally checks the mobile order receipt, not just the catalogue. It verifies customer/pet quote identifiers, quantity refresh, refused quotes, duplicate-click order suppression, unchanged order and subscription payloads, V2 management links, pause/resume/cancel controls, refused renewal payment, invoice identity/amounts, request-only cancellation and the dispatched-order refusal. Relocation checks required fields, explicit age zero, the domestic route, retry idempotency, case-ID navigation, denied reads and refused quote acceptance. Partner OTP checks preserve validation, verification failure and the subsequent server-identity recheck. The actual Appearance dialog is also exercised: choosing Signature/dark persists through Relocation-to-Home-to-Food navigation and a page reload, then returns to Emerald/light.

A separate palette comparison verified that 15 shared colour tokens match the existing staff palette in all four theme/display combinations: 60 equal values. The two palettes differ intentionally; customer, partner-entry and staff surfaces using the same selected palette share those core values.

Evidence: `.ui-audit/customer-theme/bounded/workflows-final/browser-results.json`, eight width/theme/mode `browser-results.json` files, and `cross-app-palette.json`. Screenshots remain in those local evidence folders. The synthetic browser contexts close after each bounded run and are not left as a real customer or provider session.

## Remaining release work

This checkpoint is not a claim that every service-specific Partner/provider workspace is restyled, or that every populated customer business journey has passed. The remaining Partner service workspaces, navigation/role-menu review, previously documented data-state display defects, authenticated hosted-role/MFA verification and real sandbox-provider checks remain separate work. The existing UAT/configuration warnings are retained rather than cosmetically hidden.

No push, merge, staging deployment, production deployment, credential change or database migration is included. The hosted PawSpace application is unchanged by this local checkpoint. The earlier interrupted browser attempts remain in the evidence directory and are not counted as completed results.

## Test-quality correction retained in the audit trail

An initial complete regression run reported 7,011 passes from 7,012 tests. The only failure was the existing test-quality ratchet: the new theme suite originally added a source-only test file above the permitted static-test budget. The budget and ratchet were left unchanged. Three executable tests were added that invoke the real Food request clients, Relocation validator and V2 route-scoping function against isolated inputs, checking exact request identities, idempotency, explicit age zero, invalid-input rejection and encoded record IDs. Those tests and the unchanged ratchet passed together (22/22 targeted checks). The final full-suite result is recorded separately below; the earlier log remains `full-tests-initial.log`.

The previous seven staff-browser suites are not included in this checkpoint's 219 browser-check total. This checkpoint reruns the customer/partner-entry appearance and Food/Relocation workflows, with the existing staff source protected by exact-byte checks and the repository regression suite.

## Final verified results

| Check | Result |
| --- | --- |
| Complete final regression | 7015 passed; zero failed, skipped or cancelled |
| Customer/Partner visible Chromium checks | 219 passed; zero failed |
| Customer route coverage | 23 Customer V2 routes plus two Partner entry points |
| Theme coverage | Emerald and Signature; light and dark; 1440px and 390px |
| Protected existing source files | 1,417 unchanged |
| Original stylesheet preservation | 13 original prefixes unchanged; additions scoped |
| Cross-app colour parity | 15 matching tokens in four modes: 60 exact matches |
| TypeScript and verified Worker build | Passed |
| Final changed-script/test/layout lint | No errors or warnings |

The complete final regression followed the executable-test correction. No application sources or generated build artifacts were changed during that run. The earlier quality-gate failure is retained, not counted as a pass. Existing build-tool warnings about native configuration loading, PostCSS source metadata, duplicate CSS output naming and route classification remain visible and were not suppressed.
