# Customer experience — browser test findings (PawSpace V2, commit a7124de, local worker http://127.0.0.1:8790)

Driven in real Chromium via Playwright: Pixel 7 (Android) for the account/profile/pets/address/booking flows, iPhone 14 for the existing customer, desktop for /v2 landing and staff CRM checks. Scripts: `$S/pw/customer-0*.mjs`; screenshots under `$S/evidence/customer/<run>/`; structured findings in `customer.json` (39 entries: 15 defects — P1 2, P2 11, P3 2; 3 env-gated; 20 passes; 1 observation).

## Identities & records created this run
- New customers (OTP on screen, name captured): CUS-OTP-401C07A9B4C95C8AC3E326B5 (7888643371 "QA New Customer"), CUS-OTP-5CDA49BCDD8449E8557570C9 (8889096503 "QA Grooming Parent"), CUS-OTP-5A3EE169352EFE8BDC643F66 (6888960547 "QA V2 Parent"). Existing: 9800000111 → E2E-CUS-UI-001 / Bruno / E2E-BK-UI-001.
- Bookings: grooming PS-UAT-MU9HSWHT-C583 (Pay online → payment_pending), PS-UAT-MU9HTLNR-807E (pay-after → confirmed → rescheduled/assigned → cancelled); training PS-UAT-MU9HU3DF-F9FB (+ programme TP-C2105BCA-E34); walking PS-UAT-WALK-MU9HUPLI-CB89; taxi PS-UAT-TAXI-MU9HVU5L-D460; sitting PS-UAT-SIT-MU9HSZLK-0504; food PS-UAT-FOOD-MU9I437P-BA25 + FSUB-5E109852-858; boarding PS-UAT-MU9I7BVE-C96F (stay BSTAY-5FD89302-D); relocation RLC-A0FBBD39-C, RLC-13DB1D24-1; support cases CASE-66FE219B-363, CASE-67761408-450.

## Per-vertical result
| Vertical | /mobile-app | /v2 | Pricing seen (live catalogue) | Cancel / reschedule |
|---|---|---|---|---|
| Grooming | PASS end-to-end (pet → package → verified address → slot → review/coupon → pay-after confirmation with assigned groomer; Pay online → honest refusal) | **FAIL — catalogue empty, unbookable (D01)** | Essential Bath ₹1,349 · Bath & Basic ₹1,899 · Complete Makeover ₹2,399 · Just Trim ₹1,599; add-ons ₹499/₹299; credits packs | Both offered on /grooming/manage; driven: reschedule 200, cancel 200 (refund ₹0 pay-after) |
| Training | Reached programme step; default Meet & Greet slot refused (D10) | PASS to payment page (Starter ₹3,500, due now ₹1,750 split, 2 sessions materialised) | Meet & Greet ₹500 … Pro ₹20,000 | none offered to customer |
| Boarding | Plan + host match reached (same stay flow) | Booking created (5 nights dog+cat ₹6,990, 50% reserve ₹3,495) — manage page wrongly says payment captured (D02); split-option copy bug (D08) | ₹699 / pet / stay unit | Request date change / extension / cancellation (request-only) on /boarding/manage |
| Pet Sitting | Plan step reached | PASS: visit ₹399, overnight ₹1,598 → payment page; Meet & Greet ₹500 card dead (D09) | ₹399 / ₹799 per unit | manage link exists (/sitting/manage) |
| Dog Walking | Package + schedule step reached | PASS: recurring schedule ₹698 (2×₹349) created | ₹349 / ₹549 per walk | Request cancellation review (no reschedule) |
| Pet Taxi | Step 1 only | PASS: trip ₹699 created, manage page | synthetic UAT route class ₹699 | Request cancellation review (no reschedule) |
| Fresh Food | 2-item cart ₹1,648 + repeat delivery to step 3/5 | PASS: single-SKU order ₹849 + 30-day subscription; manage page empty (D07) | ₹499 / ₹799 / ₹849, delivery ₹0 (UAT) | subscription Pause control |
| Relocation | form rendered, not submitted | PASS: 2 enquiries created, but destination country recorded as UAE (D04) | quote pending | support ticket link |

## Payment result (env-gated, ENV-01)
Razorpay sandbox keys are not configured on this server. Every Pay control (grooming ₹1,349, training ₹1,750, sitting ₹1,598, boarding ₹3,495, account "Check balance (test)") produced POST /api/customer-checkout → **503 "Razorpay test checkout is not configured. Contact billing support."**, rendered inline; no Razorpay iframe, no fake success, no transaction id. Bookings stayed `payment_pending` (customer-account API) and /mobile-app/booking-confirmation?bookingId=… recovers them with "Pay securely with Razorpay / Try again". Double-clicking Confirm/Reserve produced exactly one canonical booking; a second Pay click produced another 503 and no order. Staging needs RAZORPAY_KEY_ID_SANDBOX / RAZORPAY_KEY_SECRET_SANDBOX / RAZORPAY_WEBHOOK_SECRET_SANDBOX to test capture. Gaps: nothing in Activity/manage links back to the pending payment (D05); the boarding manage page claims "Payment is captured in UAT" while billing says created (D02).

## Defects
- **CUST-D01 P1 (data)** — /v2/grooming cannot be booked: V2 grooming catalogue returns zero packages. Step 02 shows 'No published package supports this pet selection yet.' for every pet (dog and cat). GET /api/v2/grooming-catalogue (in-page, signed in) returns 200 {"data":{"serviceCode":"grooming","packages":[]}}. All time slots stay 'Unavailable', 'Check live…
- **CUST-D02 P1 (UI)** — Boarding manage page says 'Payment is captured in UAT' for an unpaid (payment_pending) stay and offers no way to pay. POST /api/canonical-bookings → 201 status payment_pending (one booking despite double click); /api/customer-billing shows PAY-A9779A59 status 'created', gateway uat_sandbox, amount_due_now 3495. The manage page nevertheless states 'Awaiting Host Acceptance — P…
- **CUST-D03 P2 (data)** — Account 'Add default address' accepts an unserviceable PIN (110001 New Delhi) and makes it the default address. POST /api/customer-account upsert_address → 201; 'Saved addresses' now shows 'Office · Default — 1 Connaught Place, Connaught Place, New Delhi, 110001' above the Bengaluru address. No alert. Downstream flows (training zone from default PIN) would read a non-se…
- **CUST-D04 P2 (data)** — V2 relocation enquiry silently records destination_country 'United Arab Emirates' for Mumbai and London. Both POST /api/relocation → 201, but records show origin_country 'India', destination_country 'United Arab Emirates' for BOTH (RLC-A0FBBD39-C Mumbai/road and RLC-13DB1D24-1 London/air). The form has no destination-country field; the confirmation page then disp…
- **CUST-D05 P2 (UI)** — A payment_pending grooming booking has no 'resume payment' path from Activity or the manage page. Activity shows 'PAYMENT PENDING Essential Bath … View booking and care →'; the manage page shows 'Payment Pending' but has no Pay control (controls: Refresh policy preview / Refresh booking status). /mobile-app?bookingId=<id> just shows Home with the 'UPCOMING…
- **CUST-D06 P2 (UI)** — Applied coupon is dropped when the customer switches payment mode; only a small red line warns, and the booking is created at full price. Total silently reverts to ₹1,349 with a small red line 'Booking details changed — apply the coupon again for a fresh governed quote'; Confirm stays enabled; booking PS-UAT-MU9HSWHT-C583 was created with totalAmount 1349 and the payment page asks for ₹1,349. (Q…
- **CUST-D07 P2 (UI)** — /v2/food/manage renders an empty page even with a valid order id. Page shows only 'Manage Food order' + 'Back to Food' — no order data, no explanation (same as opening it with no id). /v2/food/subscriptions?… does work (FSUB-5E109852-858 active, every 30 days, 'Pause' control).
- **CUST-D08 P2 (UI)** — Boarding long-stay payment options: unselected '50% now' option shows the wrong amounts once 'Pay the full amount now' is chosen. It re-renders as 'Reserve with 50% now — ₹6,990 now · ₹0 due 24 hours before check-in' and the pay button becomes 'Pay ₹6,990 & create canonical stay'. Correct when 50% is selected ('₹3,495 now · ₹3,495 due…'). Note both option cards are <button>s whose text s…
- **CUST-D09 P2 (UI)** — Sitting '2-hour home Meet & Greet · ₹500' card does nothing; review shows Meet & Greet ₹0. Click has no visible effect (no pressed state, no request); the review lists 'Meet & Greet 2 hours · ₹0' and '2-hour sitter Meet & Greet ₹0'; total stays ₹399. Boarding instead lists '3-hour host-home trial · Included' and '10-minute phone call · Included' (no…
- **CUST-D10 P2 (wiring)** — Mobile Training: the pre-selected default Meet & Greet slot cannot be reserved. Alert 'We could not reserve this slot. Please choose another time, or contact PawSpace support.' No booking created. (V2 training with a 3-day lead worked: Starter Plan booked.)
- **CUST-D11 P2 (UI)** — Pet card shows 'Vaccination not provided' for seeded pet Bruno whose record says vaccinated. /api/customer-account returns vaccinationStatus 'vaccinated' but the card renders 'Vaccination not provided' (UI only maps 'verified'/'pending'). Pets created in the UI ('Vaccinated' = Yes) render correctly as 'Vaccinated'.
- **CUST-D12 P2 (UI)** — OTP name field labelled 'Your name (first time only)' is shown to returning customers. The name field appears for existing customers too (value typed there is ignored: profile name unchanged — verified with returning customer 7888643371).
- **CUST-D13 P2 (UI)** — Internal/staging wording visible to customers: 'UAT', 'sandbox', 'canonical', 'synthetic', '(test)'. Examples: 'Secure Razorpay sandbox checkout', 'Coupon code · UAT governed', 'This UAT confirmation creates sandbox records only', 'UAT sandbox: no real SMS is sent yet', account button 'Check balance (test)', 'PET TAXI · CANONICAL UAT', 'Create canonical UAT t…
- **CUST-D14 P3 (backend)** — Invalid pet weight via API returns a generic error instead of the specific validation message. 400 {"error":"Unable to update customer account"}. Not reachable from the UI: the pet form uses a Weight band select ('Not sure', '3–20 kg', '20–45 kg', '45–60 kg', '60+ kg') and Age band select / date of birth (max = today), so free-text invalid weight cannot…
- **CUST-D15 P3 (UI)** — Minor UI issues: 40px 'Sign out' header button, duplicated error on payment-return page, '— saved places', no per-booking links in /v2/activity, training bookings have no manage link, customer app polls a staff-only endpoint. Header 'Sign out' is 40px tall (bottom nav 79×59, all other primary buttons ≥44px). Payment-return page prints 'Razorpay test checkout is not configured…' twice. /v2 shows '⌂ — saved places'. /v2/activity lists bookings with no links to detail/manage. Mobile A…

## Environment-gated
- **CUST-ENV-01** — Payment: Razorpay sandbox not configured locally — every 'Pay' refuses honestly; booking stays payment_pending and is recoverable
- **CUST-ENV-02** — Maps: neighbourhood search fails (no egress to Google); address autocomplete uses the deterministic sandbox place
- **CUST-ENV-03** — Referral programme unavailable; notifications empty; live tracking disabled

## Passed (driven in the browser)
- CUST-P01 — New customer OTP sign-up with on-screen sandbox code and name capture (Pixel 7)
- CUST-P02 — Existing customer 9800000111 (iPhone 14): pet Bruno, booking E2E-BK-UI-001 visible in Home 'UPCOMING BOOKING', Activity and manage page
- CUST-P03 — Profile edit persists after reload
- CUST-P04 — Default Bengaluru address saved and persisted
- CUST-P05 — Pet add / edit in place with age + weight bands; inline validation
- CUST-P06 — Location picker: PIN validation honest (560068 accepted, 110001 refused); 'Browse without location'
- CUST-P07 — Grooming (/mobile-app, Pixel 7) end-to-end: pet → package → verified address → slot → review → pay-after → confirmation with assigned groomer
- CUST-P08 — Grooming manage page: reschedule and cancel driven in the UI on a booking created this run
- CUST-P09 — Training (V2): multi-session programme with split payment and server-owned sessions
- CUST-P10 — Boarding (V2 + mobile): 5-night dog+cat stay, host match, host profile card/badges, 50% reserve split, manage page with date change/extension/cancel requests
- CUST-P11 — Pet Sitting (V2): 4-hour visit and overnight quotes with sitter match
- CUST-P12 — Dog Walking (V2): recurring weekday schedule created; manage page offers cancellation review
- CUST-P13 — Pet Taxi (V2): pickup/drop + time trip created; manage page with cancellation review
- CUST-P14 — Fresh Food: mobile 2-item cart + repeat delivery; V2 single-SKU order + subscription
- CUST-P15 — Relocation (V2): domestic and international enquiries created with document checklist and milestones
- CUST-P16 — Customer-to-CRM visibility (founder@pawspace.in via POST /api/staging-login)
- CUST-P17 — 24/7 support: case created from the Report-an-issue panel
- CUST-P18 — Appearance switcher persists; sign out / switch account
- CUST-P19 — /v2 landing (desktop + Pixel 7) and V2 shell: all 8 services linked, no horizontal overflow, no page errors
- CUST-P20 — Home dead-button sweep (iPhone 14): every visible button had a visible effect

## Not completed / limits
- Proof photos and the service feedback/rating card could not be exercised: no completed grooming exists for these customers (E2E-BK-UI-001 has no care/proof records; summary API care: null).
- Mobile-app taxi/walking/relocation flows were only driven to their first/second step (V2 equivalents completed); mobile training stopped at the refused Meet & Greet slot.
- Pets cannot be deleted/archived from the UI (no control offered) — recorded, not counted as a defect.
