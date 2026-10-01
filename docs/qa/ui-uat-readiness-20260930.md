# UI correctness fixes for human UAT — 30 September 2026

Base: `11ab937275cbfba6ea05adb167224d7a24b14d58` (main).

## Bounded changes

1. **V2 sign-in keyboard access:** Escape closes the dialog, Tab/Shift+Tab cycle through currently visible enabled controls, focus returns to the exact opener, and background programmatic focus is redirected while the dialog is open. Existing input autofocus remains in use. A dismissed OTP request cannot put a newly reopened modal into the previous request's code/error/busy state. No authentication endpoint or identity rule changes.
2. **Care Card step validation:** the same required vet/emergency/home-access fields already enforced at final confirmation now block the earlier Review button. Required fields are labelled, whitespace is rejected, errors are associated with inputs and the first missing input is focused. Boarding still requires vet/emergency only; Sitting additionally requires home access. Final confirmation retains its guard. Draft care details survive Back/Review.
3. **Operations times:** the existing shared IST formatter replaces device-local date rendering in Booking Command Center list/details/timeline. Stored timestamps, scheduling and payment deadlines are unchanged.
4. **Sitting reconciliation wording:** an active pre-completion record with `settlement_state=not_due` and the backend's default `tax_state=configuration_required` is described as pending completion, not proof that tax configuration is missing. Completed/terminal/unknown states retain the original diagnostic, and refund-attention remains explicit. No finance calculation, reconciliation record, approval or payout guard changes.
5. **Funeral species:** explicit Dog/Cat/Other/Not specified selection replaces the unconditional dog payload. Unspecified retains the existing backend's `pet` value. Returned case details show the saved species. Service enablement and all commercial/safety gates remain unchanged.

No CSS/theme redesign, prices, booking capacity rules, legal policy, calls, deployment, or merge changes are included. Open PRs #1196 (handoff empty state) and #1197 (guest-first legacy booking entry) were inspected; their feature work is not duplicated.

## Regression evidence

- `tests/ui-uat-readiness.test.mjs`: executes existing Care Card requirements and the new pre-completion display helper; verifies IST formatting under UTC, Los Angeles and Kolkata process time zones, and checks final-confirmation guard wiring.
- `tests/funeral-memorial-closure.test.mjs`: added cat/other/unspecified canonical persistence assertions, including reading the stored `funeral_cases.pet_species` value.
- `e2e/ui-audit-readiness.spec.ts`: actual app with isolated API fixtures. Covers 390/1440px keyboard focus cycles, Escape/Close/reopen, interrupted OTP, step-local Care Card validation/back preservation, Ops IST under a Los Angeles browser timezone, each Funeral species payload/returned detail and pre-completion finance/disabled settlement.
- Browser fixture writes are intercepted; they cannot reserve, charge, dispatch or contact anyone. These UI fixture tests do not substitute for real gateway or provider lifecycle UAT.
- Existing source-hash contracts are updated only for the reviewed changed files. The Ops display correction remains reversible to its historical source; the V2 wiring fixture retains the earlier snapshots in explicit review metadata. Immutable historical UI audit baselines and all CSS/logo bytes are unchanged.

## Verification results and limits

- 194/194 focused correctness and existing UI compatibility tests pass.
- 15/15 focused Care Card/display and Funeral lifecycle/persistence tests pass (included in the focused set).
- 9/9 real Chromium browser regressions pass with the repository-pinned Playwright browser and an isolated local app server; initial fixtures were corrected to wait for hydration before clicking server-rendered controls.
- TypeScript, production build, Sites artifact validation, `git diff --check` and 21 immutable historical UI baselines pass.
- Targeted ESLint reports no errors and two pre-existing warnings in V2 home (`signOut` unused; article aria-disabled).

The OS Chromium wrapper could not launch under this command sandbox. Installing the repository-pinned Playwright Chromium from its official dependency source and running server/test in one process tree resolved that runner limitation. The cloud Browser tool's loopback restriction was not bypassed. A subsequent evidence-capture run was paused when the simulator attempted its optional public `Request.cf` metadata lookup. The documented `CLOUDFLARE_CF_FETCH_ENABLED=false` and `WRANGLER_SEND_METRICS=false` flags remove that external lookup and telemetry; the UI audit server configuration now sets them explicitly. Miniflare uses its built-in CF metadata fallback, so these tests do not certify production `Request.cf`/geolocation behavior. Business assertions and API fixtures are unchanged. Hosted exact-head CI remains required before merge.

The aggregate test run was interrupted when a separate existing receipt fixture was discovered to perform an unintended external Razorpay request. The shared test-infrastructure lane owns that hermetic fixture repair. This branch does not claim a full aggregate pass or silently include that unmerged patch. One earlier existing native-D1 fanout test also reported failure in the interrupted run; a terminal cause was not established here.

The existing mainline Training fixture issue belongs to the separate Training readiness lane. No merge/deployment approval is implied by this branch.
