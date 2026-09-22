# PawSpace V2 launch pass — Partner / provider journeys (server http://127.0.0.1:8791, commit ad4c56e, PR #960)

Browser: Chromium via Playwright — Pixel 7 for every provider journey, iPhone 14 for one groomer pass (session supersede + consent), desktop 1366×900 for founder maker/checker and staff hub pages.
Scripts: `$S/launch/partner/*.mjs` (g0x groomer, t0x trainer, w0x walker, x0x taxi, s0x sitter, h0x host, o01 onboarding, c01/b01 customer data setup, geo-mock.mjs = real PERMISSION_DENIED simulation).
Evidence: `$S/launch/evidence/partner/` (236 screenshots + one JSON log per script). Machine-readable: `$S/launch/findings/partner.json` (55 items), matrix `partner-matrix.csv`.

Setup recorded: the grooming catalogue was empty on this database — published `canonical_groom_dog-bath`, `dog-basic`, `dog-trim`, `dog-makeover` (+ 2-pet bundles) as founder via `PATCH /api/pricing-control` (reason "UAT publish for partner launch pass"). Staging needs the same.
Test data created through the customer UI as 9800000111: grooming PS-UAT-MUBBSUG2-A32D (pay after service, completed) and PS-UAT-MUBDDC95-586D (assigned), training PS-UAT-MUBCDWKM-D3D2 (Starter Plan, 2 sessions), walking PS-UAT-WALK-MUBCEB05-C7AE, taxi PS-UAT-TAXI-MUBCEJSP-8852, sitting PS-UAT-SIT-MUBCFHHP-0A1B / -MUBD4QAW-0FDD / -MUBDA4YP-93FC. Seeded: E2E-BK-UI-001 (commission groomer 9800000222), UATD-BK-TAXI-2 (taxi_meera), UATD-STAY-2 (host_sana), UATD-BK-TRAIN-2 (cancelled, train_meera).
Training/sitting funding: customer checkout is 503 locally and `/api/training-payment-sandbox` / `/api/sitting-payment-sandbox` refuse a quote already marked used, so the founder staff simulator (`/api/grooming-payment-sandbox` link_order + payment.captured) was used — recorded as a harness step (LP-N12/N13), not a partner flow.

## Counts
Prior findings re-verified: 10 still-open (D01,D02,D03,D04,D06,D07,D08,D09,D10 + O04), 3 fixed-verified (D05 PIN, D11 consent, O02 training sessions), O01 exercised (decline works), 5 not-retested, 2 env-gated, O05 owner-decision.
New: 12 defects (1× P1, 8× P2, 3× P3), 4 owner decisions, 5 environment gates, 16 passes.

## P1 / P0
- **LP-D01 (prior D01) P1 payment** — Pay-after-service "Create payment request" now passes the gateway but the handler throws: POST /api/grooming-payment-sandbox → deterministic **500** "Unable to run Grooming payment sandbox" (wrangler: Razorpay sandbox API credentials are not configured). No row written, raw error in the UI. Root cause is the missing sandbox key, but the surface is a crash instead of the honest 503 that `create_order` returns. Groomer still cannot collect ₹1,241 at the door.
- **LP-N04 P1 partner** — Taxi provider can Arrive/Confirm drop-off before recording route samples; afterwards `/driver/proof` refuses samples (409, generic copy) and "Complete trip" never appears → PS-UAT-TAXI-MUBCEJSP-8852 is stuck `in_progress` with no in-app recovery. The happy order (samples while in progress, UATD-BK-TAXI-2) completes.

## P2 (new)
LP-N01 decline replay → 500 TypeError (reading 'confirmed') · LP-N02 declined job still listed "Confirmed" with Accept/Decline (Accept → 409) · LP-N03 customer summary still shows the declined provider · LP-N05 generic "Unable to update …" 409s hide the governed reason (expired offer, care window, samples-after-dropoff, missing evidence, cancelled session) · LP-N07 host cannot progress a stay with care plan "Required" (rows only toast, no care-plan action, Check in disabled) · LP-N08 any unknown phone becomes a "Verified" service_provider with employee-portal feature flags · LP-N09 proof photos "uploaded and verified" and approved as service proof while **objectStored=false / adapterConnected=false** (bytes hashed and discarded; local R2 holds no object) · LP-N19 (customer-side, seen while creating data) re-booking a completed slot returns the completed booking.
P3: LP-N06 city duplicated in doorstep address · LP-N10 Jobs tab empty for non-grooming providers while Home lists their workspaces · LP-N13 sandbox captures accumulate to 5,250 on a ₹3,500 order yet "matched".

## Still-open prior findings (fresh evidence)
D02 earnings "Service proof still outstanding" for a job with approved proof · D03 Package upgraded 400 · D04 buttons break words (screenshot g02-live-order-impact-card.png) · D06 raw "grooming safety:friendly" · D07 Mark arrived stays disabled after a geofence refusal (Retry saved updates works) · D08 superseded session keeps "Verified/Online" pills, new banner has staff copy "/staging-login" and is clipped behind the header · D09 /partner/rates "Permission denied" — also for the commission sitter/host it is meant for · D10 PAYMENT PENDING lists captured payments · O04 no notifications/statement/incentive surface (403s).

## Fixed-verified
D05 PIN duplication gone (city now duplicated, P3) · D11 consent aside no longer covers the nav on iPhone 14 · O02 training sessions materialise for OTP trainers (one work order per session, deep link to /trainer).

## Passes (driven browser → API → D1 row → customer view)
Groomer full lifecycle incl. deep link, denied-location notice + recovery without reload (real PERMISSION_DENIED mock), geofence 409/arrival, checklist gates, founder maker/checker, completion events and customer invoice; Running late; earnings/settlement; hub pages. Commission decline. Trainer: unpaid refusal everywhere (net funding rule), cancelled session refused, full multi-session lifecycle (arrival denied/far/near, pre-check, evidence, independent approval, handover, report, complete consumedExactlyOnce, next session unlocked), idempotent same-key replay, earnings ownership 403 for other providers. Walker: cross-service link, accept, handover, denied/far/near start, events, GPS proof page samples, completion with payment-due event. Taxi happy order to completed. Sitter accept within the offer window. Host accept + profile tabs. Ownership boundaries 403 in every vertical. No page errors, no horizontal overflow, no local-harness 500s (the three 500s are deterministic and listed above).

## Environment gates
Razorpay sandbox keys (payment request 500 root cause; customer checkout 503; training/sitting funding only via staff simulator) · GOOGLE_MAPS_SERVER_API_KEY_UAT (ETA) · media storage adapter not connected (objectStored=false) · onboarding document upload "needs dedicated secure file storage" and application submit 409 "not accepting applications for this service and city" (config) · sitting/boarding check-in time-gated to the care window (UAT clock override refused outside isolated test) · Live money OFF.

## Owner decisions (recorded, not invented)
O05 completion accepted before cash collection (invoice + payout accrued) · LP-N11 seeded sitters/hosts have a 3-minute acceptance window (offer expires before a customer can pay locally) · LP-N15 Sitting Meet & Greet: no sitter-side step, customer card ₹500 — policy undefined · LP-N17 trainer compensation rule missing (completed session held "pending rate configuration").

## Not tested / untested controls
Training assessment (Meet & Greet) — customer slot refusal (CUST-D10); boarding stay creation for this customer (vaccination must be "verified"); sitting/boarding check-in→check-out (care-window clock); staff-session behaviour on /partner-app (O08); device-timezone rendering (O06); arrival with no fix (O07); controls not pressed: Bike issue, Service taking longer, Open protected rebooking, Request reschedule, Record no-show, Mark unavailable (all verticals), incident reports, host Decline with reason, /host/proof, Sign out (re-run not needed).
