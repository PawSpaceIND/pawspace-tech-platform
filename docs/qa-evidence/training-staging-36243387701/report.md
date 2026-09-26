# PawSpace staging — Dog Training master E2E

- Origin: https://pawspace-staging.karthik-fce.workers.dev
- Run: 2026-09-26T13:37:55.237Z
- Customers: Master A 8427312224, Master B 8427320143, Master C 8427328062

| # | Area | Step | Result | Detail | Evidence |
|---|---|---|---|---|---|
| 1 | Customer | Customer A: sandbox OTP sign-in + address (560038) + 3 dogs + 1 cat | PASS | 8427312224 · address 201, Bruno 201, Coco 201, Max 201, Whiskers 201 | shots/001-customer-a-account.jpg |
| 2 | Maps | Google Places autocomplete, place resolve, reverse geocode | PASS | 1 suggestion(s); first="42, Indiranagar Double Road, Doopanahalli, Domlur, Bengaluru, Karnataka, India"; resolve=configured 12.9689746,77.6360876; reverse(Koramangala)=configured "002, KHB Colony, 4th Block, Koramangala, Bengaluru, Karnataka 560095, India" |  |
| 3 | Maps | Service zone by PIN (serviceable and not) | PASS | 560038=200:blr-east · 560068=200:blr-south · 560001=200:blr-central · 560102=200:blr-south · 110001=404:Zone not found for this pincode · 12345=400:Invalid pincode |  |
| 4 | Pricing | Catalogue + quote matrix (8 packages × prepaid/split × 1/4/5 dogs) | PASS | 8 packages: Trainer Meet & Greet ₹500, Starter Plan ₹3500, Puppy Training Plan ₹6000, Basic Obedience Plan ₹12000, Leash Obedience Plan · 8 ₹12000, Leash Obedience Plan · 12 ₹16500, Advanced Obedience Plan ₹16500, Pro Training Plan ₹20000 // trainer-meet-greet/prepaid/1: ₹500 due ₹500 60m ; trainer-meet-greet/prepaid/4: ₹1400 due ₹1400 240m ; trainer-meet-greet/prepaid/5: 409 Training supports 1-4 pets per programme ; trainer-meet-greet/split/1: 409 Trainer Meet & Greet must be paid in full ; trainer-meet-greet/split/4: 409 Trainer Meet & Greet must be paid in full ; trainer-meet-greet/split/5: 409 Training supports 1-4 pets per programme ; training-2-starter/prepaid/1: ₹3500 due ₹3500 60m ; |  |
| 5 | Pricing | Training coupon (UATCARE100 / WELCOME) on the Training quote | PASS | UATCARE100: 201 discount ₹100 · WELCOME: 201 discount ₹300 |  |
| 6 | Customer V2 | Training page: dogs-only list, zone, catalogue | PASS | dogs=[Bruno, Coco, Max, Toilet routine, Biting & chewing, Leash walking, Recall, Basic obedience, Socialisation, Excess barking, Separation anxiety] · Training zone East Bengaluru · confirmed from your address PIN code | shots/002-v2-training-page.jpg<br>shots/003-v2-training-page-full.jpg |
| 7 | Customer V2 | Reserve Meet & Greet (1 dog, prepaid ₹500) | FAIL | page.waitForResponse: Timeout 120000ms exceeded while waiting for event "response" | shots/004-meet-before-reserve.jpg |
| 8 | Payment | Meet & Greet: pay ₹500 with Razorpay TEST card → captured | BLOCKED | Meet & Greet was not reserved |  |
| 9 | Customer V2 | Meet & Greet confirmation screen | BLOCKED | Meet & Greet was not reserved |  |
| 10 | Customer app | Coupon UATCARE100 on the Training review step (fresh page) | FAIL | Coupon shown as applied but Training quote refused it — pay button "Refreshing server quote…", alert [] | shots/005-app-coupon.jpg<br>shots/006-app-coupon-full.jpg |
| 11 | Customer | Customer B: sandbox OTP sign-in + address + dog | PASS | 8427320143 · address 201, Coco 201 |  |
| 12 | Customer V2 | Reserve Starter Plan (2 sessions, 50% split) | PASS | PS-UAT-MUIEU776-D897 · PawSpace Training Team (UAT) (uatcap_train_ft) · sessions [{"id":"TS-02D49D25-803","n":1,"status":"scheduled"},{"id":"TS-D2E783CC-7F9","n":2,"status":"locked"}] | shots/007-starter-before-reserve.jpg |
| 13 | Payment | Starter deposit: pay ₹1,750 with Razorpay TEST card → captured | PASS | Pay securely · ₹1,750.00 → captured | shots/008-starter-deposit-payment-page.jpg<br>shots/009-starter-deposit-after-razorpay.jpg |
| 14 | Customer V2 | Programme confirmation screen after deposit | PASS | PawSpace / DOG TRAINING / Training programme confirmed / Booking, trainer assignment, payment ledger and programme sessions now share one canonical identity. / Booking / PS-UAT-MUIEU776-D897 / confirmed / Programme / TP-8CEC28C5-EDC / 2 session(s) / Trainer / PawSpace Training Team (UAT) / Canonical | shots/010-starter-confirmed.jpg<br>shots/011-starter-confirmed-full.jpg |
| 15 | Customer V2 | Activity + booking page after deposit | PASS | ← Your bookings / PawSpace / Starter Plan / PS-UAT-MUIEU776-D897 / Status: confirmed / 30 Sept, 3:00 pm IST · PawSpace Training Team (UAT) / Coco / Total: ₹3,500.00 · Payment: captured / Manage serviceRefresh status / Your reserved sessions / 30/9/2026, 3:00:00 pm IST — scheduled / 7/10/2026, 3:00:00 pm IST — locked / Change or cancel your programme / Next session 1 · 30 Sept, 3:00 pm IST. Only your next upcoming session can be rescheduled, up to 24 hours before it starts. / Request reschedule / | shots/012-v2-activity.jpg<br>shots/013-v2-booking-after-deposit.jpg |
| 16 | Trainer | Partner app sandbox OTP sign-in as the assigned trainer | PASS | 9000000931 → uatcap_train_ft · paw / space / PARTNER / ✓ / Verified / › / Sign out / 🟢 Online / PAWSPACE PARTNER MOBILE / PawSpace Training Team (UAT) / service provider / ↻ / NEXT ASSIGNMENT / No assigned jobs / Your work will appear here after assignment. / 0 / active jobs / 0 / completed / GPS / tap to start / Work from your  | shots/014-partner-app-home.jpg |
| 17 | Trainer | Session 1: accept → on the way | FAIL | accept 0 button "Accept" not available · on the way 0 button "On the way" not available | shots/015-trainer-s1-on-the-way.jpg |
| 18 | Maps | Session 1: arrival geofence (250 m) at the geocoded doorstep | FAIL | Arrived 0 button "Arrived" not available |  |
| 19 | Trainer | Session 1: pre-check → start → photos → handover → report | FAIL | start 0 button "Start session" not available | shots/016-trainer-s1-precheck.jpg |
| 20 | Staff | Founder approves session 1 photos in Control (maker/checker) | FAIL | approved 0/2 () | shots/017-proof-review-ps-uat-muieu776-d897.jpg |
| 21 | Trainer | Session 1: Complete & consume one session (trainer screen) | FAIL | 0 button "Complete & consume one session" not available | shots/018-trainer-s1-complete-ui.jpg |
| 22 | Trainer | Session 1: same completion with the pre-check confirmation included (server check) | FAIL | 409 {"error":"Training session cannot complete from scheduled. Refresh your sessions to see its current state.","code":"training_session_state_conflict","sessionStatus":"scheduled","action":"complete"} |  |
| 23 | Trainer | Session 2 (final): accept → journey → arrive → start → photos → report | FAIL | Accept 0 · On the way 0 · Arrived 0 · start 0 · Before photo: input missing; After photo: input missing · handover 0 · report 0 | shots/019-trainer-s2-in-session.jpg |
| 24 | Staff | Founder approves session 2 photos | FAIL | approved 0/2 | shots/020-proof-review-ps-uat-muieu776-d897.jpg |
| 25 | Payment | Final session is blocked until the balance is paid | FAIL | expected 409 training_payment_required, got 409 {"error":"Training session cannot complete from locked. Refresh your sessions to see its current state.","code":"training_session_state_conflict","sessionStatus":"locked","action":"complete"} |  |
| 26 | Payment | Customer pays the remaining ₹1,750 balance with Razorpay (V2 booking page) | FAIL | starter-balance: no "Pay securely" button (← Your bookings / PawSpace / Starter Plan / PS-UAT-MUIEU776-D897 / Status: confirmed / 30 Sept, 3:00 pm IST · PawSpace Training Team (UAT) / Coco / Total: ₹3,500.00 · Payment: captured / Manage servic) | shots/021-balance-before.jpg<br>shots/022-starter-balance-no-pay-button.jpg |
| 27 | Trainer | Final session completion → programme completed + certificate | BLOCKED | Balance not paid |  |
| 28 | Trainer | Earnings (trainer workspace + partner app) | PASS | workspace: paw●space / TRAINER PARTNER / TR / PawSpace Training Team (UAT) / Authenticated provider session / ▦ Sessions / 🐾 Programmes / ₹ Earnings / Partner home / Customer training / Saturday 26 September / Training earnings readiness / 20 assigned sessions // partner app: paw / space / PARTNER / ✓ / Verified / › / Sign out / 🟢 Online / ‹ / PARTNER FINANCE / Earnings / ₹ / Settlement-controlled earnings / This mobile screen never invents payout figures from booking prices. Provider earnings appear only from the canonical settlement and commission ledger after Finance | shots/023-trainer-earnings.jpg<br>shots/024-partner-app-earnings.jpg |
| 29 | Customer | Customer C: sandbox OTP sign-in + address + dog | PASS | 8427328062 · address 201, Luna 201 |  |
| 30 | Customer app | Mobile 5-stage flow: goals → Basic Obedience → trainer → calendar → review | PASS | Review your programme / Payment · 5 of 5 / Pets / Luna / Programme / Basic Obedience Plan · 8 sessions / Preferred trainer / PawSpace Training Team (UAT) · confirmed when you reserve / Schedule / Wed & Sun · 9:00 AM · 60 min / Parent/caretaker participation / Joining · 15-minute coaching and homework handoff / Trainer Meet & Greet / Not booked / Validity / 62 days from service start / Complimentary care / Bath & Basic grooming / ✓ / Pay 50% upfront · no discount / ₹6,000 now · ₹6,000 before your | shots/025-app-stage1.jpg<br>shots/026-app-stage2.jpg<br>shots/027-app-stage3.jpg<br>shots/028-app-stage4.jpg<br>shots/029-app-stage5.jpg |
| 31 | Customer app | Reserve Basic Obedience with 50% split | FAIL | Reservation refused before booking: ["The request took too long. Please try again."] | shots/030-app-reserve-refused.jpg |
| 32 | Payment | Mobile app: pay ₹6,000 deposit with Razorpay TEST card → captured | BLOCKED | App programme not reserved |  |
| 33 | Customer app | In-app programme dashboard (plan / homework / progress) | BLOCKED | App deposit not captured |  |
| 34 | Customer app | Request programme cancellation / refund review | BLOCKED | App deposit not captured |  |
| 35 | Staff | Training operations console | PASS | PAWSPACE TEAM · OPERATIONS · TRAINING / Training operations / Session recovery, trainer replacement and canonical payment records. / ← Operations / Active programmes / 20 / Canonical Training programmes / Sessions today / 3 / From canonical session calendar / Open recovery cases / 24 / Reschedule / no-show / replacement / Payment exceptions / 9 / Not marked captured in sandbox ledger / CANONICAL P | shots/031-ops-console.jpg |
| 36 | Accounts | Training finance: invoice for the fully paid programme | BLOCKED | Starter programme not fully paid and completed | shots/032-finance-training.jpg<br>shots/033-finance-training-full.jpg |
| 37 | Accounts | Trainer payout statement → approve sandbox instruction | BLOCKED | No completed sessions to pay out |  |
| 38 | Accounts | Cancellation case for the mobile programme (policy, calculation, approval, sandbox refund) | BLOCKED | No cancellation request |  |
| 39 | CRM | Capture a Dog Training lead and find it | PASS | {"ok":true,"id":"CU-37781","leadId":"LEAD-1790429359373","assignedOwner":"rohit.menon@pawspace.in","ownerResolved":true,"ownerMappingException":null,"attributionBound":false,"organizationalScope":{"ci | shots/034-crm-lead.jpg |
| 40 | Ops | Booking Command Center finds each Training booking | FAIL | not found: PS-UAT-MUIEU776-D897 (found ) | shots/035-bcc.jpg |
| 41 | Roles | Manager / Finance access to Training ops, finance, CRM, BCC | PASS | jyoti.manager39 /api/training-ops 200 · jyoti.manager39 /api/training-finance 403 Permission denied · jyoti.manager39 /api/crm 403 CRM is outside the manager's organizational scope · jyoti.manager39 /api/booking-command-center 200 · uat.demo.manager /api/training-ops 200 · uat.demo.manager /api/training-finance 403 Permission denied · uat.demo.manager /api/crm 200 · uat.demo.manager /api/booking-command-center 403 Booking Command Center is outside the manager's organizational scope · anjali.finance33 /api/training-ops 403 Permission denied · anjali.finance33 /api/training-finance 403 MFA enrollment required · anjali.finance33 /api/crm 403 Permission denied · anjali.finance33 /api/booking-com |  |
| 42 | AI | V2 chat (guest): training packages and prices | PASS | 200 · bedience Plan: 8 sessions within 62 days, ₹12,000 / • Leash Obedience Plan · 8: 8 sessions within 62 days, ₹12,000 / • Leash Obedience Plan · 12: 12 sessions within 93 days, ₹16,500 / • Advanced Obedience Plan: 12 sessions within 93 days, ₹16,500 / • Pro Training Plan: 16 sessions within 120 days, ₹20,000 / Programmes can be paid in full or 50% upfront. Open the Training section to choose a plan, a trainer and your dates. / 01:35 pm / PawSpace bot / Anything else? Pick a service or ask another question. / 01:35 pm / Grooming / Dog Training / Boarding / Pet Sitting / Dog Walking / Pet Taxi / Fresh Food / Pet Relocation / Ask a question / Request a call / Talk to our team / Your message  | shots/036-ai-guest-chat.jpg |
| 43 | AI | V2 chat (signed-in customer with a confirmed Meet & Greet): my next session | PASS | 200 · PawSpace / PawSpace bot · Account-aware / Open / Ask PawSpace anything. / Your message / Send | shots/037-ai-customer-chat.jpg |
| 44 | AI | AI configuration readiness (founder) | PASS | PAWSPACE TEAM · AI BUSINESS CONFIGURATION / Assistant configuration & knowledge / Versioned, reviewed and auditable AI business configuration. Production provider activation remains separate. / Disable AI Enable AI AI review Rollout / Is the assistant switched on? / Answering staff: yes · answering customers: yes. Every requirement below has to be met — any one of them missing sends every conversation to a human. / ✓ / Model provider connected / openai · gpt-5.6-terra / ✓ / Assistant profile and system policy activated / profile pawspace_default v4 · policy pawspace_system v4 · 51 approved kno | shots/038-ai-configuration.jpg |

## API errors observed (4xx/5xx)

- customer:Master A 401 GET /api/mobile-employee-ai 
- customer:Master A 404 GET /api/service-zone {"error":"Zone not found for this pincode"}
- customer:Master A 400 GET /api/service-zone {"error":"Invalid pincode","code":"invalid_pincode"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Trainer Meet & Greet must be paid in full"}
- customer:Master A 409 POST /api/training-commercial {"error":"Trainer Meet & Greet must be paid in full"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer:Master B 401 GET /api/mobile-employee-ai 
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- trainer 409 POST /api/training-sessions {"error":"Training session cannot complete from scheduled. Refresh your sessions to see its current state.","code":"training_session_state_conflict","sessionStatus":"scheduled","action":"complete"}
- trainer 409 POST /api/training-sessions {"error":"Training session cannot complete from locked. Refresh your sessions to see its current state.","code":"training_session_state_conflict","sessionStatus":"locked","action":"complete"}
- customer:Master C 401 GET /api/mobile-employee-ai 
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 403 GET /api/training-finance {"error":"Permission denied"}
- staff 403 GET /api/crm {"error":"CRM is outside the manager's organizational scope"}
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 403 GET /api/training-finance {"error":"Permission denied"}
- staff 403 GET /api/booking-command-center {"error":"Booking Command Center is outside the manager's organizational scope"}
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 403 GET /api/training-ops {"error":"Permission denied"}
- staff 403 GET /api/training-finance {"error":"MFA enrollment required"}
- staff 403 GET /api/crm {"error":"Permission denied"}
- staff 403 GET /api/booking-command-center {"error":"Permission denied"}
- customer:Master A 403 GET /api/mobile-employee-ai 
- staff 404 GET /api/uat-customer-switch {"enabled":false}
