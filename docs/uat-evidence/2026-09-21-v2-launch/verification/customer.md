# Customer area — launch verification (PR #960 @ ad4c56e, local worker http://127.0.0.1:8790, Pixel 7 + desktop staff context)

Driven in real Chromium (Playwright) on 2026-09-21. Scripts: `$S/launch/customer/*.mjs`; per-run `result.json` + screenshots under `$S/launch/evidence/customer/<run>/`. Records: 57 entries — defects 23 (P0 0, P1 1, P2 18, P3 4); passes 20; fixed-verified 5; env-gated 5; owner-decision 2.

## Prior findings re-verified
| Prior | Status now | Record |
|---|---|---|
| CUST-D04 | fixed-verified | CUST-L-P01 — V2 Relocation: explicit country/age/size form, domestic Road Bengaluru→Pune with age 0 and international Air → |
| CUST-D01 | env-gated | CUST-L-ENV-01 — Grooming catalogue was empty on this database; published dog-basic (+2/3/4-pet bundles), dog-bath, dog-makeove |
| CUST-ENV-01 | env-gated | CUST-L-ENV-02 — Payments: Razorpay sandbox keys absent locally — every Pay control (grooming ₹1,747, training ₹500, boarding,  |
| CUST-D05 | still-open | CUST-L-D05 — Still no resume-payment path from Activity/manage for a payment_pending grooming booking (mobile); the V2 path |
| CUST-D06 | still-open | CUST-L-D06 — Coupon is still dropped when the customer switches payment mode; Confirm stays enabled and the booking is crea |
| CUST-P08 | pass | CUST-L-P06 — Mobile grooming pay-after booking, reschedule and cancel driven end to end |
| CUST-D12 | still-open | CUST-L-D07 — OTP name field 'Your name (first time only)' still shown to returning customers (mobile and V2) |
| CUST-D11 | still-open | CUST-L-D08 — Seeded pet Bruno still renders 'Vaccination not provided' although the record says vaccinated |
| CUST-D13 | still-open | CUST-L-D09 — Internal/staging wording still visible to customers across V2 and mobile |
| CUST-D15 | still-open | CUST-L-D10 — Payment-return page prints the checkout error twice and shows 'Sign in to your account' while signed in (prior |
| CUST-P09 | pass | CUST-L-P08 — V2 Training paid assessment (Trainer Meet & Greet ₹500) reserves exactly one programme with one session; Pay r |
| CUST-P12 | pass | CUST-L-P10 — V2 Dog Walking: one-time walk and recurring starter schedule created (double-click → one booking each), listed |
| CUST-D08 | fixed-verified | CUST-L-P13 — Boarding 5-night dog+cat stay: host match with trust badges, 50% reserve creates exactly one payment_pending b |
| CUST-D02 | fixed-verified | CUST-L-P14 — Unpaid boarding stay copy: manage pages say 'Stay window' and 'Payment status is tracked separately…' — no 'Pa |
| CUST-D09 | still-open | CUST-L-D14 — Sitting '2-hour home Meet & Greet · ₹500' card is still a dead control and the review contradicts it (Meet & G |
| CUST-ENV-03 | env-gated | CUST-L-ENV-03 — Host/sitter profile, reviews and chat from the customer side are honest environment gates: profile card with b |
| CUST-D10 | still-open | CUST-L-D15 — Mobile Training: the pre-selected default Meet & Greet slot still cannot be reserved (scheduler 400) while the |
| CUST-P13 | pass | CUST-L-P17 — V2 Pet Taxi canonical trip created and manageable; cancellation is request-only |
| CUST-P01 | pass | CUST-L-P18 — V2 OTP sign-in (modal): new customer with name capture, wrong code refused, sign-out clears the session, retur |
| CUST-D12 | still-open | CUST-L-D17 — V2 sign-in modal also shows 'Your name · first visit only' to returning customers, and labels the on-screen co |
| CUST-P03 | fixed-verified | CUST-L-P19 — Profile email validation (UI + API) and alternate-mobile validation; profile persists after reload |
| CUST-P04 | pass | CUST-L-P20 — Repeat 'Save address' with identical values keeps one row and the same id; label and line1 do not grow |
| CUST-D03 | still-open | CUST-L-D18 — Account 'Add default address' still accepts an unserviceable PIN (110001) and makes it the default |
| CUST-P05 | pass | CUST-L-P21 — V2 account pet form validates required fields inline ('Select the pet's temperament') and does not submit an i |
| CUST-D07 | fixed-verified | CUST-L-P24 — /v2/food/manage?orderId=<id> now renders the order (status, fulfilment truth, Request Finance review) — prior  |
| CUST-D14 | not-retested | CUST-L-NR-01 — Not retested: invalid pet weight via API returns a generic error (prior CUST-D14, P3) — not reachable from any |
| CUST-ENV-02 | not-retested | CUST-L-NR-02 — Not retested: neighbourhood search / Google egress (prior CUST-ENV-02) — location welcome was skipped with 'Br |

## Defects (new + still open)
- **CUST-L-D21 P1 UI** — V2 Fresh Food: a double-tap on 'Reserve canonical UAT order' crashes the page ('This page didn't load') — the idempotent replay (200) response is rendered as a fresh order and throws 'Cannot read properties of undefined (reading toLocaleString)'
  - POST /api/food-orders 201 then 200 (replay, one row PS-UAT-FOOD-MUBDB52K-F2E9 in food_orders); console 'TypeError: Cannot read properties of undefined (reading 'toLocaleString') at canonical-food-page…', 'PawSpace route error'; the route error boundary replaces the screen ('Something went wrong while preparing this screen… Try again'). Try again returns to the catalogue with no confirmation. A single click renders th…
- **CUST-L-D01 P2 data** — Relocation milestones never complete for documents review, quote issued and payment confirmed — customer page shows them 'pending' while 'transport booked' and 'origin handover' are 'complete'
  - relocation_milestones rows: lead_captured complete, documents_review pending, quote_issued pending, payment_confirmed pending, transport_booked complete (founder), origin_handover complete (founder). Customer page 'Milestones: … documents review · pending · quote issued · pending · payment confirmed · pending · transport booked · complete · origin handover · complete' although 'Quote: ₹75,000 · accepted · Payment: pa…
- **CUST-L-D02 P2 backend** — Governed relocation refusals reach the staff and customer pages as the generic 'Unable to update relocation case' (409 reason redacted)
  - Every refusal is 409 {"error":"Unable to update relocation case"} and the page alert repeats that text. lib/relocation-governance throws plain Response(message,{status:409}); lib/server-auth authError() treats it as an ungoverned client error and redacts the message to the fallback. Operators cannot tell which precondition failed.
- **CUST-L-D04 P2 wiring** — V2 'View booking & payment' page (/v2/booking?bookingId=) renders only the checkout error when the payment gateway is unavailable — booking details, status and Manage link are hidden
  - Page shows only '← Your bookings · Razorpay test checkout is not configured. Contact billing support. · Retry booking'. The page loads the booking through POST /api/customer-checkout {action:'status'} (loadCustomerConfirmationProjection) which is 503 whenever Razorpay keys are missing, so a gateway/config outage hides the whole booking record. /mobile-app/booking-confirmation?bookingId=… shows the booking with Pay/Tr…
- **CUST-L-D05 (CUST-D05) P2 UI** — Still no resume-payment path from Activity/manage for a payment_pending grooming booking (mobile); the V2 path exists but lands on the error-only page
  - Mobile: Activity shows 'PAYMENT PENDING Bath & Basic … View booking and care →' → /grooming/manage shows 'Payment Pending' with controls Refresh policy preview / Refresh booking status only and 'Cancellation unavailable' — no Pay. V2: Activity now has 'View booking & payment' → /v2/booking which shows only the checkout error (CUST-L-D04). The only surfaces with a Pay control are /v2/grooming?bookingId=… and /mobile-a…
- **CUST-L-D06 (CUST-D06) P2 UI** — Coupon is still dropped when the customer switches payment mode; Confirm stays enabled and the booking is created at full price
  - After switching, total reverts to ₹1,241, coupon input still shows UATCARE100 but 'APPLIED' is gone and only the small line 'Booking details changed — apply the coupon again…' appears; Confirm booking enabled; booking PS-UAT-MUBC8VUJ-597C created with totalAmount 1241.
- **CUST-L-D07 (CUST-D12) P2 UI** — OTP name field 'Your name (first time only)' still shown to returning customers (mobile and V2)
  - Field visible with placeholder 'Your name (first time only)'; typed value ignored (name unchanged 'QA Grooming Parent'); same customer id after verify.
- **CUST-L-D08 (CUST-D11) P2 UI** — Seeded pet Bruno still renders 'Vaccination not provided' although the record says vaccinated
  - /api/customer-account pets[0].vaccinationStatus 'vaccinated'; both cards show 'Bruno Indie · Dog · 14 Kg Vaccination not provided'.
- **CUST-L-D09 (CUST-D13) P2 UI** — Internal/staging wording still visible to customers across V2 and mobile
  - Examples this pass: 'Canonical Grooming price for Bath & Basic', groomers 'PawSpace Grooming Team (UAT)', 'Divya K. (UAT East)', 'Sandbox checkout only', 'Coupon code · UAT governed', 'This UAT confirmation creates sandbox records only', 'PET RELOCATION · INTERNAL UAT', 'DOG TRAINING · CANONICAL UAT', '₹500 sandbox amount due now · live money disabled', 'PET TAXI · CANONICAL UAT … synthetic UAT route class', 'Create …
- **CUST-L-D11 P2 UI** — V2 training recovery page (/v2/training?bookingId=) shows no pending-payment recovery — only 'Refresh trainer availability'; training booking still has no manage link
  - Page renders the empty catalogue form; controls with Pay/Refresh: ['Refresh trainer availability'] only. Activity links to /v2/booking (error-only page, CUST-L-D04). Mobile booking-confirmation route shows Pay.
- **CUST-L-D13 P2 UI** — V2 pages and /boarding/manage render booking times in the device time zone without a zone label — the same 7:00 AM IST walk shows as '1:30 am' in V2 Activity and the walking manage page (mobile pages pin IST)
  - V2 activity: '30-minute Solo Walk Thu, 24 Sept, 1:30 am · dog walking'; V2 walking confirmation/manage: 'Reserved sessions 1 canonical walk 24/9/2026, 1:30:00 am', 'Walk 1 · scheduled 24/9/2026, 1:30:00 am → 2:00:00 am'; training in V2 activity 'Thu, 24 Sept, 4:30 am' for a 10:00 IST session; /boarding/manage 'Stay window: 25 Sept, 4:30 am → 30 Sept, 4:30 am' for a 10:00 IST check-in. Mobile Home/Activity show '24 Se…
- **CUST-L-D14 (CUST-D09) P2 UI** — Sitting '2-hour home Meet & Greet · ₹500' card is still a dead control and the review contradicts it (Meet & Greet ₹0, total ₹399)
  - Click: no aria-pressed change (null → null), no API call, no visible change; review lists 'Meet & Greet 2 hours · ₹0', '2-hour sitter Meet & Greet ₹0', 'Booking total ₹399'. Details step text shows both '2-hour sitter Meet & Greet · ₹500' and '2-hour home Meet & Greet · ₹500'.
- **CUST-L-D15 (CUST-D10) P2 wiring** — Mobile Training: the pre-selected default Meet & Greet slot still cannot be reserved (scheduler 400) while the next 'Available' chip reserves fine
  - Default chip: POST /api/training-commercial 201 then POST /api/uat-scheduling 400 → alert 'We could not reserve this slot. Please choose another time, or contact PawSpace support.'; no booking. Other chip: training-commercial 201, uat-scheduling 200, canonical-bookings 201 → PS-UAT-MUBCZM7M-F10C payment_pending. The default chip (next day 11:00) is inside the scheduler's refusal window but is still offered as Selecte…
- **CUST-L-D16 P2 UI** — V2 Pet Taxi confirmation prints 'Invalid Date' and placeholder route copy ('synthetic km · min estimate')
  - 'Trip booking created PS-UAT-TAXI-MUBCMB6Y-2F2F → Invalid Date · Meera S. UAT route class Bengaluru East · medium UAT route synthetic km · min estimate Commercial intent ₹699 ₹0 due now · production payment timing pending'. The manage page renders the time correctly (24 Sept, 5:30 am → 6:30 am, device tz).
- **CUST-L-D17 (CUST-D12) P2 UI** — V2 sign-in modal also shows 'Your name · first visit only' to returning customers, and labels the on-screen code 'UAT CODE'
  - Name field visible with hint 'first visit only' for the returning customer (value ignored); code block 'UAT CODE 429948 · No real SMS is sent in sandbox.'
- **CUST-L-D18 (CUST-D03) P2 data** — Account 'Add default address' still accepts an unserviceable PIN (110001) and makes it the default
  - 201 → 'Office · Default 1 Connaught Place, New Delhi … 110001' above Home; GET /api/service-zone?pincode=110001 → 404 'Zone not found for this pincode'.
- **CUST-L-D19 P2 auth** — Signed-out customer on /v2/food sees 'Your staging sign-in has expired. Open /staging-login to sign in again.' (twice) — staff-login copy on a customer surface
  - Two alerts 'Your staging sign-in has expired. Open /staging-login to sign in again.' next to 'Reserve canonical UAT order →'; /staging-login is the staff UAT entry, not a customer path.
- **CUST-L-D20 P2 UI** — Customer-facing taxi quote error prints the server environment variable name ('Pet Taxi route pricing needs GOOGLE_MAPS_SERVER_API_KEY_UAT')
  - Red inline text 'Pet Taxi route pricing needs GOOGLE_MAPS_SERVER_API_KEY_UAT' rendered to the customer (mobile and V2 continuation).
- **CUST-L-D22 P2 wiring** — Food orders do not appear in /v2/activity or the customer-account bookings list — after leaving the confirmation the order can only be reached by URL
  - Activity has no Food entry or link; /api/customer-account bookings contain no food record although food_orders has three rows for the customer (PS-UAT-FOOD-MUBD55F2-B129, …ATPN-8C72, …B52K-F2E9). Combined with CUST-L-D21 a customer whose confirmation crashed has no in-app way back to the order.
- **CUST-L-D03 P3 UI** — /team/relocation case list keeps the stale status after actions and 'Issue quote' can be replayed (second quote_sent event)
  - Aside list still shows 'RLC-8DF… · documents_pending' after the detail pane moved to quote_sent; second Issue quote returned 200 and appended a second 'quote_sent' event (relocation_events) — the quote row itself stayed one (UNIQUE case_id).
- **CUST-L-D10 (CUST-D15) P3 UI** — Payment-return page prints the checkout error twice and shows 'Sign in to your account' while signed in (prior D15 items persist); customer app still polls the staff-only /api/mobile-employee-ai (403 console errors)
  - 'Razorpay test checkout is not configured. Contact billing support.' ×2 and controls 'Try again · Sign in to your account · Pay securely with Razorpay · Continue to PawSpace'; console: 'Failed to load resource: 403' on /api/mobile-employee-ai during every /mobile-app load.
- **CUST-L-OBS-02 P3 UI** — Mobile Book grooming address step does not offer the customer's saved default address (must be typed again)
  - Address Line 1 empty, no 'use saved address' control; V2 boarding/sitting does reuse the saved address.
- **CUST-L-D12 P3 UI** — Floating appearance/theme buttons overlap the primary Pay button on the V2 training payment view (Pixel 7)
  - The ◐ and ◇ floating controls sit over the right end of 'Pay securely · ₹500.00'.

## Fixed / verified
- **CUST-L-P01 (CUST-D04)** — V2 Relocation: explicit country/age/size form, domestic Road Bengaluru→Pune with age 0 and international Air →Dubai created with the right countries
  - Empty submit: 7 field alerts, 0 POST calls. Domestic: 201 RLC-8DF802921C37311ADD0A612DB7B09BFA origin 'Bengaluru, India' destination 'Pune, India' age 0 size medium mode road, page shows 'Domestic move · road · Bengaluru, India → Pune, India' and 'Rex · Indie · 0 years · medium'; reload keeps Pune/India (no UAE). International: 201 RLC-64F28B48F40C379A55D489933D482CB4 'Dubai, United Arab Emirates' air small. API repl…
- **CUST-L-P13 (CUST-D08)** — Boarding 5-night dog+cat stay: host match with trust badges, 50% reserve creates exactly one payment_pending booking + stay record; split amounts correct on both option cards (D08 fixed)
  - Hosts: 'Maya & Rohan 4.9 ★ · Home, KYC and background verified · ₹699 / pet / stay unit'. 50% selected: '✓ Reserve with 50% now ₹3,495 now · ₹3,495 due 24 hours before check-in / Pay the full amount now ₹6,990 · no later balance'; full selected: 'Reserve with 50% now ₹3,495 now · ₹3,495 due… / ✓ Pay the full amount now ₹6,990 · no later balance', pay button 'Pay ₹6,990 & create canonical stay'; back to 50%: 'Pay ₹3,4…
- **CUST-L-P14 (CUST-D02)** — Unpaid boarding stay copy: manage pages say 'Stay window' and 'Payment status is tracked separately…' — no 'Payment is captured' claim (P1-07 / D02 fixed)
  - 'CANONICAL BOARDING STAY · PS-UAT-MUBCU8O5-69FF Awaiting Host Acceptance The selected host still needs to accept the canonical stay. Payment status is tracked separately on the canonical booking payment record. Host: Maya & Rohan. Stay window: 25 Sept, 4:30 am → 30 Sept, 4:30 am.' Mobile Activity lists it as 'PAYMENT PENDING Luxury Stay 25 Sept 2026, 10:00 am IST'. (Time-zone rendering: CUST-L-D13.)
- **CUST-L-P19 (CUST-P03)** — Profile email validation (UI + API) and alternate-mobile validation; profile persists after reload
  - 'Enter a valid email address.' (email stays null); valid → 'Profile updated.', API email qa.account@example.com; API invalid → 400 {error:'Enter a valid email address.', code:'invalid_email'}; alt 12345 → 'Alternate mobile must be 10 digits.'; 9000000977 saved; reload shows both values.
- **CUST-L-P24 (CUST-D07) P3 UI** — /v2/food/manage?orderId=<id> now renders the order (status, fulfilment truth, Request Finance review) — prior D07 fixed for the orderId parameter; ?bookingId= still renders an empty 'Manage Food order' shell without explanation
  - orderId: 'CANONICAL FOOD · CUSTOMER UAT PS-UAT-FOOD-MUBDB52K-F2E9 Adult Dog Food · UAT 2 kg · qty 1 · uat reserved … Request Finance review', APIs food-fulfilment/food-proof 200. bookingId: only 'Manage Food order · Back to Food' (no message). /v2/food/subscriptions renders the subscription form.

## Passed (driven browser → API → D1 → downstream)
- CUST-L-P02 — V2 Activity lists relocation inquiries with countries and reopens the case by link
- CUST-L-P03 — Relocation customer case controls: placeholder document registration, support ticket, quote acceptance and refund request work end to end with staff progression
- CUST-L-OBS-01 — Relocation observations: no staff UI control for record_payment (API-only finance action); customer has no pay control for the relocation quote (ops-recorded payment); no per-event attribution on the customer page (events carry actor ids in the API: customer:<id> / founder@pawspace.in)
- CUST-L-P04 — Mobile-app Relocation enquiry (Enquire now) submits and reaches the staff enquiry list
- CUST-L-P05 — V2 grooming: pet → package → doorstep → slot → live price → groomer → Reserve creates exactly one payment_pending booking; Pay refuses honestly (503), booking recoverable on reload
- CUST-L-P06 (CUST-P08) — Mobile grooming pay-after booking, reschedule and cancel driven end to end
- CUST-L-P08 (CUST-P09) — V2 Training paid assessment (Trainer Meet & Greet ₹500) reserves exactly one programme with one session; Pay refuses honestly
- CUST-L-P10 (CUST-P12) — V2 Dog Walking: one-time walk and recurring starter schedule created (double-click → one booking each), listed in Activity and on the mobile Home 'UPCOMING BOOKING'
- CUST-L-P11 — Walking lifecycle actions are refused for customers (403 governed) and the manage page offers no reschedule (record)
- CUST-L-P12 — Boarding quote-error retry: a forced 503 from /api/boarding-commercial at the review step shows the error with a 'Retry price' control, prices read 'Price unavailable', and Retry restores the live quote; check-out before check-in is refused
- CUST-L-P15 — Repeat stay plans do not grow the saved service address or add rows; identical account address upserts dedupe to the same id (a locality-suffixed variant is stored as a new row)
- CUST-L-P16 — Mobile Training flow: Assessment → Package (recommended plan) → Trainer roster → Calendar → Review with 50%/100% options renders end to end; V2 assessment recovery shows Pay on the mobile payment-return route
- CUST-L-P17 (CUST-P13) — V2 Pet Taxi canonical trip created and manageable; cancellation is request-only
- CUST-L-P18 (CUST-P01) — V2 OTP sign-in (modal): new customer with name capture, wrong code refused, sign-out clears the session, returning customer keeps identity and name
- CUST-L-P20 (CUST-P04) — Repeat 'Save address' with identical values keeps one row and the same id; label and line1 do not grow
- CUST-L-P21 (CUST-P05) — V2 account pet form validates required fields inline ('Select the pet's temperament') and does not submit an incomplete pet
- CUST-L-P22 — Boarding → Taxi continuation stays inside V2 with the source booking: /boarding/manage 'Add Pet Taxi for this stay →' opens /v2/taxi?sourceBookingId=<stay>, header 'BOARDING → PET TAXI', link back to the stay, pets pre-selected
- CUST-L-P23 — V2 Pet Taxi and Dog Walking cancellations are request-only: 'Request cancellation review' posts to taxi-finance / walking-finance (200) and the booking stays confirmed pending review
- CUST-L-P25 — Mobile Dog Walking (Pixel 7): package → schedule → dog → review with address verification on the review step → pay-after payment step
- CUST-L-OBS-04 — V2 account pet form: breed must be picked from the suggestion list — free-typed 'Labrador Retriever' is refused with 'Select the pet's breed' (recorded, not counted as a defect: suggestion buttons were not observed in this run)

## Environment gates
- **CUST-L-ENV-01 (CUST-D01)** — Grooming catalogue was empty on this database; published dog-basic (+2/3/4-pet bundles), dog-bath, dog-makeover, dog-trim, cat-basic (+2 pets) as founder via PATCH /api/pricing-control — staging needs the same publish
  - All 9 PATCH → 200; catalogue now returns cat-basic, dog-basic, dog-bath, dog-makeover, dog-trim; service_packages.active=1 for the 9 ids. Prior CUST-D01 (empty V2 grooming catalogue) is a data/publish gate, not code: after publishing, /v2/grooming shows the packages and books.
- **CUST-L-ENV-02 (CUST-ENV-01)** — Payments: Razorpay sandbox keys absent locally — every Pay control (grooming ₹1,747, training ₹500, boarding, taxi) returns 503 'Razorpay test checkout is not configured' inline; bookings stay payment_pending
  - 503 with the same message on every surface; no iframe, no fake success; 17 5xx lines in serve.log are all these 503s. No harness 'ProxyWorker' 500 occurred in this pass.
- **CUST-L-P09** — Training customer refusal states: cancellation request is blocked by policy configuration (governed), reschedule request accepted, closeout/ops actions denied
  - training-cancellation request → 200 {caseId TCAN-E3A93F86-E4C, status 'blocked_policy_configuration'} (no cancellation policy configured on this database — environment/config gate, the customer view has no cancel control for training); session change → 200 reschedule_requested TSR-74E02D44-54B; training-sessions complete → 403 'Identity session does not own this customer/provider scope'; training-ops cancel → 403 'Pe…
- **CUST-L-ENV-03 (CUST-ENV-03)** — Host/sitter profile, reviews and chat from the customer side are honest environment gates: profile card with badges renders; reviews/media 'not connected'; chat overlay says live masked chat is not connected and sends nothing
  - Host card: 4.9 ★, 'Home, KYC and background verified', 'Multiple families allowed by profile'; profile: 'Host media and customer reviews are not connected in Boarding UAT'; chat: 'Boarding chat · UAT boundary · Live masked chat is not connected yet. This screen does not simulate host messages.' with only 'Close chat'. Sitting: 'Reviews are not connected', 'Live sitter messaging is not connected. No message has been s…
- **CUST-L-ENV-04** — Mobile/V2 Pet Taxi quote is gated on GOOGLE_MAPS_SERVER_API_KEY_UAT — 'Calculate Citroën & XUV fares' returns 503 on this server, so paise formatting, the route-fallback disclosure, the inline Pay refusal and 'Check payment status' could not be exercised locally (Boarding → Taxi continuation reaches the same gate)
  - POST /api/taxi-commercial → 503; the page shows 'Pet Taxi route pricing needs GOOGLE_MAPS_SERVER_API_KEY_UAT' and no vehicle options. lib/taxi-route-pricing.ts throws when the key is empty; the 10 km / 45 min 'sandbox_route_fallback' leg is only used after a Google failure, not when the key is absent. Staging must carry GOOGLE_MAPS_SERVER_API_KEY_UAT for this path to be testable. The V2 canonical taxi page (server UA…

## Owner decisions
- **CUST-L-P07** — Payment-pending grooming booking can be cancelled? — No: manage page says 'Cancellation unavailable' for an unpaid booking (recorded as a governed state, not a defect)
  - 'Your Grooming booking Payment Pending … Cancellation unavailable'; no cancel form; booking remains payment_pending. Customers cannot self-cancel an unpaid reservation (owner decision whether that is intended).
- **CUST-L-OBS-03** — Unpaid boarding stay: manage page has no Pay control and Request extension / date change / cancellation are all disabled while awaiting host acceptance
  - Controls: 'Add Pet Taxi for this stay →', 'Save canonical care plan', 'Request extension(disabled)', 'Request date change(disabled)', 'Request cancellation(disabled)'; no Pay. The only pay surface is the checkout step reached right after reservation or /mobile-app/booking-confirmation?bookingId=…

## Not retested / limits
- Real payment capture (Razorpay keys absent locally); host acceptance / trainer acceptance / walker acceptance and completion flows belong to the partner area; the relocation record_payment finance action has no staff UI (driven via API as founder); mobile Relocation enquiry has no age/size/country fields (separate contract from V2 cases).
- Placeholder relocation documents are not real uploads (objectStored=false).
- Boarding 'Request date change / extension / cancellation' could not be exercised: disabled while the stay is unpaid and awaiting host acceptance.
- Server log: 5xx lines are all the honest 503 checkout refusals; no harness 'ProxyWorker' flake and no other 500 occurred in this pass.
