# PawSpace staff-brand UI pilot

Date: 24 September 2026
Branch: `feat/staff-brand-shell-20260924`
Reviewed base: `747c945c28f4ecec8bf45780cbd65d6393d7b09f`
Status: first three staff surfaces implemented and locally verified; no merge or hosted deployment.

## Implemented scope

The shared staff frame is installed on Team Home, Sales / Customer 360, and Booking Command Center, including existing booking aliases. It provides seven expandable permission-filtered workspace groups plus Home, navigation search, a mobile menu, and existing destination links. This is not yet a migration of every staff module.

Presentation uses the supplied PawSpace logo without recolouring, self-hosted Nunito, Emerald / Gold, and the customer app's existing Brand-book Purple / Gold option. Existing appearance attributes drive light and dark variants. No customer-app stylesheet or theme preference code was changed.

The pilot replaces oversized welcome styling and small operational text with a shared hierarchy, responsive content areas, readable controls and consistent navigation. Service-proof presentation also follows the theme so dark-mode text remains readable.

## Preservation boundaries

Original page data-fetching/state/calculation functions and existing JSX event bindings are pinned against the reviewed base by `tests/fixtures/staff-ui-wiring-contract.json` and `tests/staff-brand-workspace.test.mjs`. Existing Sales paging/search and bookingId deep links from main were retained.

No existing action endpoint, payload, booking state machine, pricing calculation, ledger, permission definition, MFA rule, webhook or database schema was edited. A hash check found all 1,083 protected API, library, worker, customer and root-layout/style source files unchanged against the reviewed base.

The frame adds one read-only call to the existing `/api/team-overview` on Sales and Bookings for navigation permissions. Team Home reuses the actor it already fetches. A failed navigation read does not hide or replace the child workspace. Menu visibility is not authorization; server checks remain authoritative.

No route was removed, redirected or renamed. No production communication, payment, refund, assignment or payroll action was executed by the browser verification.

## Verification results

| Check | Result |
| --- | --- |
| Targeted UI, navigation, authorization and customer/booking regressions | 67 / 67 passed |
| Full `tests/*.test.mjs` run | 6,848 / 6,850 passed initially; two local worker startup failures |
| The two real-D1 tests after exact locked-runtime repair | 2 / 2 passed; no application or test assertions changed |
| Final built-app Chromium synthetic UI scenarios | 24 / 24 passed |
| TypeScript | Passed |
| Changed-source lint | No errors; one advisory for the small local logo `<img>` |
| Final application build and Worker artifact validation | Passed |
| Protected source hashes | 1,083 unchanged |

The full run had zero skipped/cancelled tests. Its two failures occurred before their real-D1 workers became healthy, with a local native runtime startup error following an interrupted dependency installation. The exact lockfile-pinned workerd package was restored after SHA-512 integrity verification, and both tests then passed. This records the full run plus targeted rechecks, not a second completely green full-suite run.

Chromium checks used isolated synthetic fixtures on loopback. Every API call was intercepted and action payloads were checked without contacting providers or writing real business data. Coverage includes three role menus, Sales paging/search/selection and Claim/Complete payloads, booking filters/tabs/search/deep links and Tracking payload, both palettes in light/dark modes, 1440/1280/390-pixel viewports, mobile navigation, failure recovery and customer V2 isolation. Sampled service-proof heading contrast was also checked in all four theme/mode combinations; this is not a full accessibility certification.

## Reproduce the browser check

Build the application, then start its local preview bound to loopback with sandbox/live-disabled environment variables. Run:

```sh
STAFF_UI_BASE_URL=http://127.0.0.1:4318 node scripts/verify-staff-brand-ui.mjs
```

The script refuses non-loopback origins. On macOS it uses installed Google Chrome's Chromium engine; another executable can be supplied through `STAFF_UI_CHROMIUM_PATH`. Results and screenshots are written beneath `.ui-audit/` and are intentionally not production data.

## Remaining before wider rollout

Authenticated staff and Finance browser journeys were not certified in this run. Synthetic UI fixtures and executable backend tests do not replace that review. The remaining Operations/CX, Finance, People, Growth, Intelligence, Control and Partner surfaces still need their own scoped migration and validation.

Other work continued on main during this task. Integrate through a reviewed feature-branch merge and exact-head CI; do not reset main or copy the worktree over newer work. The pilot has not been merged or deployed. Its local validation is not a production-readiness or universal no-regression guarantee.

Continue with the next module family only after reviewing these three pilot surfaces. Preserve existing API handlers and role checks, reuse the frame and theme tokens, test its existing actions and deep links, and retain a reversible rollout boundary.
