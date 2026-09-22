# PawSpace V2 — Partner (service provider) browser test findings

Server: http://127.0.0.1:8791 (built worker, staging config, Miniflare D1). Browser: Chromium via Playwright — Pixel 7 and iPhone 14 for /partner-app, desktop 1366x900 for the /partner hub and Ops approval.
Scripts: `$S/pw/partner-0[1-9]*.mjs` (+ `partner-lib.mjs`). Evidence: `$S/evidence/partner/` (screenshots + per-script JSON logs). Machine-readable findings: `$S/findings/partner.json` (32 items: 11 defects, 8 observations, 2 env-gated, 11 passes).

Test job: customer 9800000111 booked grooming through the /mobile-app UI (Bruno, Essential Bath, Thu 24 Sept 11:00–13:00 IST, pay after service ₹1,349) → booking **PS-UAT-MU9HH07M-2B44**, auto-assigned to the city-wide Grooming Team (uatcap_groom_ft, OTP phone 9000000901). Note for other testers: the platform keeps **one active session per provider** — a second OTP sign-in with the same phone supersedes the first (this is why lifecycle runs must be serialised per phone).

## Defects

| ID | Sev | Class | Summary | Evidence |
|---|---|---|---|---|
| PARTNER-D01 | **P1** | auth/wiring | Partner cannot raise the pay-after-service payment request: `/api/grooming-payment-sandbox` returns **403 Permission denied** for a provider session — GET on every poll (console floods) and POST when tapping **Create payment request** (UI shows "Permission denied"). No way to collect the ₹1,349 due at the door from the app. | ist-payment-request.png, partner-08-verify.json |
| PARTNER-D02 | P2 | wiring/data | Earnings tab shows **"Service proof still outstanding … missing before photo, after photo … holds up the settlement"** for a job whose photos were uploaded, Ops-approved and recorded (grooming_service_proof row has both refs; settlement already accrued ₹937.55 in the same screen). Root cause: `lib/provider-workspace.ts` pendingProof reads `provider_job_proofs` (never written by the grooming lifecycle). | ist-earnings.png, partner-08-verify.json |
| PARTNER-D03 | P2 | wiring | **Package upgraded** (Live order impact) always fails: POST `/api/booking-operations` → 400 "Approved package and amount are required"; the app never collects a package/amount, so the button can never succeed. | partner-01-login-iphone.json apiErrors |
| PARTNER-D04 | P2 | UI | Live order impact buttons break mid-word on phone width ("Packa ge upgra ded", "Servic e taking longer"). | life-03-after-accept.png, life-05-live-order-impact.png |
| PARTNER-D05 | P2 | data | Doorstep address shows the PIN twice: "… Bengaluru 560038, 560038, India" (GPS card, home card, job detail; from `/api/grooming-route` destinationAddress). | life-03-after-accept.png |
| PARTNER-D06 | P2 | UI/copy | Handling requirements render the raw code **"grooming safety:friendly"** (desktop feed shows "Safety: friendly"). | life-03-after-accept.png |
| PARTNER-D07 | P2 | UI/UX | After a geofence refusal (409, correct) the server text says "tap Mark arrived once you are at the address", but the app disables **Mark arrived** and only the small **Retry saved updates** banner button works (it does deliver the arrival). | life-05-arrived-far-refused.png, partner-04-lifecycle-attempt3.json |
| PARTNER-D08 | P2 | auth/UX | Same phone signing in on a second device supersedes the first session (by design), but the first device keeps showing the dashboard with the green "Verified" pill while every API call 401s silently until a manual reload. | iphone-session-superseded-ui.png, partner-07-session-footer.json |
| PARTNER-D09 | P2 | UI | `/partner/rates` prints the raw API error **"Permission denied"** (GET `/api/provider-service-rates` → 403) above its own explanatory copy for full-time groomers (staff login and OTP session). | desk-asha-groomer1-_partner_rates.png, hub-groomer-_partner_rates.png |
| PARTNER-D10 | P2 | data | `/partner/workspace` "PAYMENT PENDING" lists **captured** payments for uat.demo.groomer (Full Groom 2026-08-07 ₹1,299 captured; 2026-05-10 ₹1,299 captured). | desk-uat-demo-groomer-_partner_workspace.png |
| PARTNER-D11 | P2 | UI | With the cookie-consent banner undecided and the page scrolled to the footer, the consent aside covers the fixed bottom nav and intercepts taps (Playwright: "aside[aria-label=Cookie consent] subtree intercepts pointer events"). Not overlapping at the top of the page. | iphone-consent-over-nav-viewport.png, partner-09-consent.json |

## Observations (not defects, but worth a decision)

- **O01** Decline/Reject is only offered to commission providers ("Only commission-provider offers can be declined"); the auto-assigned Grooming Team is full-time, so Decline could not be exercised.
- **O02** Training: trainer 9000000931 sees the /partner-app shell with no jobs and `/trainer` with "0 assigned sessions". The app does contain training-session handling (Accept training session / Start journey → `/api/training-sessions`), contrary to the guide, but no training session is seeded for any OTP/switchable provider (sessions exist only for train_kiran/train_meera, which are not in the live roster) — not testable with this seed.
- **O03** Seeded roster trainer is not onboarding-linked: Earnings says "Onboarding is not linked"; `/partner/workspace` shows `onboarding: not_linked`.
- **O04** No notifications/chat surface exists in /partner-app; providers get 403 from `/api/provider-notifications`, `/api/customer-notifications`, `/api/partner-finance`; `/api/provider-chat` needs provider+thread (400). "push/WhatsApp messages queued" is asserted but never visible to the partner.
- **O05** Completion accepted while the pay-after-service payment is still `created`: invoice PS-2026-90125501 issued (net ₹1,276.15), payout accrued ₹937.55 before any cash capture; job then sits under "Payment pending". Finance to confirm this is intended.
- **O06** Times follow the device timezone: a UTC device shows "24 Sept, 5:30 am" for the 11:00 AM IST slot (desktop hub prints "2026-09-24 05:30"); in Asia/Kolkata the app shows "11:00 am to 1:00 pm". Testers outside IST will see the wrong-looking time.
- **O07** Arrival geofence is enforced when a trusted fix exists (409 at 12,980 m; accepted at the doorstep). Code (`arrivalGeofence` uatBypass) skips the check entirely on sandbox/staging when **no** fix exists — the guide's "without a fix the app says so" does not hold on staging. Not exercised in the browser.
- **O08** A `/staging-login` employee session is not a provider identity session: `/partner-app`, `/v2/partner`, `/partner-mobile`, `/groomer` (redirects to /partner-app) show the OTP form and `/trainer` says "Identity session required"; `/partner`, `/partner/workspace`, `/partner/jobs`, `/partner/rates` work. `/host` renders a zeroed host dashboard for any session; `/trainer` opens for a groomer OTP session (0 sessions).

## Environment-gated

- **E01** Google Routes ETA: "Trusted GPS capture works. Google Routes ETA waits for the approved UAT server key." (maps sandbox; staging needs the approved maps server key). GPS capture itself works (201).
- **E02** Live payouts OFF / sandbox payout rail — by staging design.

## Passes (actually driven in the browser)

- P01 Partner OTP sign-in through the UI on Pixel 7 and iPhone 14; sandbox code shown; invalid phone and wrong OTP messages.
- P02 Sign out from header and from More → DELETE 200, OTP form back, session 401.
- P03 Trainer sign-in; More → Switch UAT provider to host, sitter, walker, taxi (200; identity re-checked; honest empty states); wrong access code → 401 shown inline.
- P04 No horizontal overflow on any tab on either phone viewport; no page errors; all nav/card buttons navigate; footer links reachable.
- P05 Customer-UI booking auto-assigned to the Grooming Team; visible in partner Home/Jobs and desktop `/partner/jobs` (UPCOMING (1), first name only) with deep link "Open assigned workspace →".
- P06 Customer-safe contact everywhere ("E2E", "+91 ••••••0111"); no raw phone/email in UI or `/api/partner-job-feed`; cross-tenant feed 403; cancellation case 403 staff-only.
- P07 Lifecycle: Accept → duty tracking auto-captures GPS (201 accepted; destination 12.9716,77.5946 = sandbox service-discovery fixture; I granted geolocation and `setGeolocation` first to a far point then to the server's destinationCoordinates) → Start journey → far fix 409 geofence → doorstep fix → arrived → before-service checklist gate → Start service.
- P08 Proof maker/checker: PNG uploads (register 201, PUT 200) "awaiting Ops approval"; Add service proof refused before approval with a clear message; founder at `/control → Customer booking lifecycle → Service proof awaiting review` must enter a reason (empty refused), approves both (PATCH 200, proofReady); partner Refresh proof status → Add service proof (200) → Complete job → completed; Home "1 completed".
- P09 Earnings reflect the job: net payout ₹944 / 1 order / gross ₹1,349; settlement accrued ₹937.55; invoice issued; payout readiness accrued; uat.demo.groomer's seeded earnings (₹1,818.6, 2 orders) visible on `/partner/workspace`.
- P10 "Running late" records `operation.running_late` and updates the card.
- P11 All partner routes 200 with no page errors for asha.groomer1 and uat.demo.groomer; hub "All assigned jobs" → `/partner/jobs` "Your jobs".

## Harness notes (not app defects)
- Session cookies are `Secure`; authenticated API checks were done with `page.evaluate(fetch)` from logged-in pages, so no false 401s are reported.
- One active session per provider: my first three lifecycle attempts were superseded by parallel sign-ins with the same phone (that is D08's mechanism, not a flake); the final run was serialised and completed end to end.
