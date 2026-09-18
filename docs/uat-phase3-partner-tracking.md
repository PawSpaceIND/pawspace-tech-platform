# Phase 3: partner accountability and Training UX

## Runtime behaviour

The accepted grooming job takes over the partner home screen. In-service jobs take priority over arrived, travelling and future accepted jobs. The shared `/partner-app` and `/partner-mobile` surfaces show the customer's permitted address, navigation, pet safety notes and lifecycle actions. The older partner hub links into this workflow.

Before-service acknowledgements are required by both UI and API before start. After-service acknowledgements are required before completion. They are recorded with lifecycle evidence. Existing authenticated assignment checks, approved before/after media, financial rules and atomic lifecycle transitions remain in force. Checkbox acknowledgements do not replace media evidence.

Status actions are written to provider-scoped device storage before success is shown. One pending transition per job prevents invalid offline state progression. Web Locks serialize queue changes and delivery across browser tabs. Reconnection triggers a replay that first verifies current server assignment and status, avoiding a second transition when the first response was lost. Rejected/reassigned/over-24-hour updates remain visible for review. Storage errors fail visibly. Photos retain the existing upload queue and approval process. Do not clear app data while updates are pending.

The app reports Online, Reconnecting or Offline based on connectivity and authenticated responses. Background location requires the native partner build and permission; the browser version tracks only while it can run. GPS transmission is throttled to 15 seconds and uses existing freshness, accuracy, replay and assignment guards. Location stops when the accepted job ends or identity changes. No GPS collection starts merely from a confirmed, unaccepted job.

A 30-second authenticated heartbeat is persisted for active grooming jobs. The existing worker cron checks for three minutes without contact and opens a deduplicated high-priority Operations case. With the five-minute cron, alerts normally appear about 3–8 minutes after contact stops, plus scheduling delay. Future accepted jobs enter missing-heartbeat monitoring two hours before their scheduled start. The case explicitly says the cause is unknown: network loss, app suspension, force quit or an unavailable phone cannot be distinguished remotely. Operations must investigate; a new heartbeat does not silently close the case.

Training uses separate pet cards and requirement chips, followed by participation, category, notes/safety and the Meet & Greet action. Trainer availability uses the saved profile address, with a Change Address action; no standalone PIN form is shown.

## Native build configuration

Set `PAWSPACE_PARTNER_APP_URL` to the approved HTTPS workspace URL ending in `/partner-app`, then run `npm run cap:sync:partner`. This packages a minimal local offline/error shell and loads the authenticated hosted application. It does not package a Next/server build directory as a static mobile app.

The existing mobile beta workflow reads the `PAWSPACE_PARTNER_APP_URL` repository variable and runs the same preparation before native sync. Android uses JDK 21 for Capacitor 8. This PR does not dispatch a distribution run.

Background geolocation is pinned to community plugin 1.2.26. Its npm peer permits Capacitor 8, but its Swift Package Manager manifest still requests the Capacitor 7 range. The preparation script verifies both versions and adjusts that installed manifest to the Capacitor 8 range before syncing. Review this workaround whenever upgrading either dependency. Customer sync also runs the compatibility preparation.

Android declares fine/coarse/background location and location foreground-service permissions, and requests notification permission for its on-duty indicator. The partner config enables the legacy native bridge and native HTTP required for continued background delivery. iOS declares location permission messages and the location background mode.

## Release qualification still required

Native sync is not a physical-device background test. Before field rollout, install signed iOS and Android partner builds and test: permission refusal and recovery; lock-screen movement; stationary service; at least ten minutes backgrounded; connectivity loss; force quit; phone power-off; reconnect; job completion; account switching. Confirm fresh GPS arrives only during an accepted job and Operations receives unreachable cases without duplicate alerts. Verify OS battery restrictions and notification behaviour. A force-quit or powered-off device cannot keep sending location.

Run the browser regression `e2e/uat-phase3-partner-training.spec.ts` for rendered mobile/desktop behaviour. Its transport fixtures are UI contract tests, not provider integration evidence. `tests/uat-phase3-checklist-api.test.mjs` and `tests/uat-phase3-partner-tracking.test.mjs` exercise real API/SQLite checklist and heartbeat behaviour and queue replay failures. Existing full-suite journeys cover the payment, media and completion gates.
