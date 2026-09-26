# PawSpace staging — Dog Training master E2E

- Origin: https://pawspace-staging.karthik-fce.workers.dev
- Run: 2026-09-26T07:21:13.976Z
- Customers: Master A 8405351115, Master B 8405359034, Master C 8405366953

| # | Area | Step | Result | Detail | Evidence |
|---|---|---|---|---|---|
| 1 | Customer | Customer A: sandbox OTP sign-in + address (560038) + 3 dogs + 1 cat | PASS | 8405351115 · address 201, Bruno 201, Coco 201, Max 201, Whiskers 201 | shots/001-customer-a-account.jpg |
| 2 | Maps | Google Places autocomplete, place resolve, reverse geocode | PASS | 1 suggestion(s); first="42, Indiranagar Double Road, Doopanahalli, Domlur, Bengaluru, Karnataka, India"; resolve=configured 12.9689746,77.6360876; reverse(Koramangala)=configured "002, KHB Colony, 4th Block, Koramangala, Bengaluru, Karnataka 560095, India" |  |
| 3 | Maps | Service zone by PIN (serviceable and not) | PASS | 560038=200:blr-east · 560068=200:blr-south · 560001=200:blr-central · 560102=200:blr-south · 110001=404:Zone not found for this pincode · 12345=400:Invalid pincode |  |
| 4 | Pricing | Catalogue + quote matrix (8 packages × prepaid/split × 1/4/5 dogs) | PASS | 8 packages: Trainer Meet & Greet ₹500, Starter Plan ₹3500, Puppy Training Plan ₹6000, Basic Obedience Plan ₹12000, Leash Obedience Plan · 8 ₹12000, Leash Obedience Plan · 12 ₹16500, Advanced Obedience Plan ₹16500, Pro Training Plan ₹20000 // trainer-meet-greet/prepaid/1: ₹500 due ₹500 60m ; trainer-meet-greet/prepaid/4: ₹500 due ₹500 240m ; trainer-meet-greet/prepaid/5: 409 Training supports 1-4 pets per programme ; trainer-meet-greet/split/1: 409 Trainer Meet & Greet must be paid in full ; trainer-meet-greet/split/4: 409 Trainer Meet & Greet must be paid in full ; trainer-meet-greet/split/5: 409 Training supports 1-4 pets per programme ; training-2-starter/prepaid/1: ₹3500 due ₹3500 60m ; t |  |
| 5 | Pricing | Training coupon (UATCARE100 / WELCOME) on the Training quote | FAIL | No coupon is accepted by the Training quote: UATCARE100: 409 Training coupon is not active or eligible · WELCOME: 409 Training coupon is not active or eligible |  |
| 6 | Customer V2 | Training page: dogs-only list, zone, catalogue | PASS | dogs=[Bruno, Coco, Max] · Training zone East Bengaluru · confirmed from your address PIN code | shots/002-v2-training-page.jpg<br>shots/003-v2-training-page-full.jpg |
| 7 | Customer V2 | Reserve Meet & Greet (1 dog, prepaid ₹500) | PASS | PS-UAT-MUI1G6RX-471E · Ramesh P. · 2026-09-29 | shots/004-meet-before-reserve.jpg |
| 8 | Payment | Meet & Greet: pay ₹500 with Razorpay TEST card → captured | PASS | Pay securely · ₹500.00 → captured | shots/005-meet-payment-page.jpg<br>shots/006-meet-after-razorpay.jpg |
| 9 | Customer V2 | Meet & Greet confirmation screen | PASS | PS-UAT-MUI1G6RX-471E confirmed | shots/007-meet-confirmed.jpg |
| 10 | Customer app | Coupon UATCARE100 on the Training review step (fresh page) | FAIL | Coupon shown as applied but Training quote refused it — pay button "Refreshing server quote…", alert ["Training coupon is not active or eligible"] | shots/008-app-coupon.jpg<br>shots/009-app-coupon-full.jpg |
| 11 | Customer | Customer B: sandbox OTP sign-in + address + dog | PASS | 8405359034 · address 201, Coco 201 |  |
| 12 | Customer V2 | Reserve Starter Plan (2 sessions, 50% split) | PASS | PS-UAT-MUI1P2GD-79D7 · Kiran S. (train_kiran) · sessions [{"id":"TS-78C1433D-58D","n":1,"status":"scheduled"},{"id":"TS-F9D226C9-207","n":2,"status":"locked"}] | shots/010-starter-before-reserve.jpg |
| 13 | Payment | Starter deposit: pay ₹1,750 with Razorpay TEST card → captured | PASS | Pay securely · ₹1,750.00 → captured | shots/011-starter-deposit-payment-page.jpg<br>shots/012-starter-deposit-after-razorpay.jpg |
| 14 | Customer V2 | Programme confirmation screen after deposit | PASS | PawSpace / TRAINING · CANONICAL UAT / Training programme confirmed / Booking, trainer assignment, payment ledger and programme sessions now share one canonical identity. / Booking / PS-UAT-MUI1P2GD-79D7 / confirmed / Programme / TP-8AA100AF-561 / 2 session(s) / Trainer / Kiran S. / Canonical schedul | shots/013-starter-confirmed.jpg<br>shots/014-starter-confirmed-full.jpg |
| 15 | Customer V2 | Activity + booking page after deposit | PASS | ← Your bookings / PawSpace / Starter Plan / PS-UAT-MUI1P2GD-79D7 / Status: confirmed / 28 Sept, 3:00 pm IST · Kiran S. / Coco / Total: ₹3,500.00 · Payment: captured / Manage serviceRefresh status / Your reserved sessions / 28/9/2026, 3:00:00 pm IST — scheduled / 5/10/2026, 3:00:00 pm IST — locked | shots/015-v2-activity.jpg<br>shots/016-v2-booking-after-deposit.jpg |
| 16 | Trainer | Partner app sandbox OTP sign-in as the assigned trainer | BLOCKED | Assigned trainer "Kiran S." has no known UAT phone |  |
| 17 | Payment | Customer pays the remaining ₹1,750 balance with Razorpay (V2 booking page) | FAIL | starter-balance: no "Pay securely" button (← Your bookings / PawSpace / Starter Plan / PS-UAT-MUI1P2GD-79D7 / Status: confirmed / 28 Sept, 3:00 pm IST · Kiran S. / Coco / Total: ₹3,500.00 · Payment: captured / Manage serviceRefresh status / Yo) | shots/017-balance-before.jpg<br>shots/018-starter-balance-no-pay-button.jpg |
| 18 | Customer | Customer C: sandbox OTP sign-in + address + dog | PASS | 8405366953 · address 201, Luna 201 |  |
| 19 | Customer app | Mobile 5-stage flow: goals → Basic Obedience → trainer → calendar → review | PASS | Review your programme / Payment · 5 of 5 / Pets / Luna / Programme / Basic Obedience Plan · 8 sessions / Preferred trainer / PawSpace Training Team (UAT) · final assignment checked server-side / Schedule / Wed & Sun · 9:00 AM · 60 min / Parent/caretaker participation / Joining · 15-minute coaching and homework handoff / Trainer Meet & Greet / Not booked / Validity / 62 days from service start / Complimentary care / Bath & Basic grooming / ✓ / Pay 50% upfront · no discount / ₹6,000 now · ₹6,000 l | shots/019-app-stage1.jpg<br>shots/020-app-stage2.jpg<br>shots/021-app-stage3.jpg<br>shots/022-app-stage4.jpg<br>shots/023-app-stage5.jpg |
| 20 | Customer app | Reserve Basic Obedience with 50% split | FAIL | Reservation refused before booking: ["We could not reserve this slot. Please choose another time, or contact PawSpace support."] | shots/024-app-reserve-refused.jpg |
| 21 | Payment | Mobile app: pay ₹6,000 deposit with Razorpay TEST card → captured | BLOCKED | App programme not reserved |  |
| 22 | Customer app | In-app programme dashboard (plan / homework / progress) | BLOCKED | App deposit not captured |  |
| 23 | Customer app | Request programme cancellation / refund review | BLOCKED | App deposit not captured |  |
| 24 | Staff | Training operations console | PASS | PAWSPACE TEAM · OPERATIONS · TRAINING / Training operations / Session recovery, trainer replacement and canonical payment records. / ← Operations / Active programmes / 22 / Canonical Training programmes / Sessions today / 3 / From canonical session calendar / Open recovery cases / 0 / Reschedule / no-show / replacement / Payment exceptions / 9 / Not marked captured in sandbox ledger / CANONICAL PR | shots/025-ops-console.jpg |
| 25 | Accounts | Training finance: invoice for the fully paid programme | BLOCKED | Starter programme not fully paid and completed | shots/026-finance-training.jpg<br>shots/027-finance-training-full.jpg |
| 26 | Accounts | Trainer payout statement → approve sandbox instruction | BLOCKED | No completed sessions to pay out |  |
| 27 | Accounts | Cancellation case for the mobile programme (policy, calculation, approval, sandbox refund) | BLOCKED | No cancellation request |  |
| 28 | CRM | Capture a Dog Training lead and find it | PASS | {"ok":true,"id":"CU-33953","leadId":"LEAD-1790406790960","assignedOwner":"rohit.menon@pawspace.in","ownerResolved":true,"ownerMappingException":null,"attributionBound":false,"organizationalScope":{"ci | shots/028-crm-lead.jpg |
| 29 | Ops | Booking Command Center finds each Training booking | FAIL | not found: PS-UAT-MUI1G6RX-471E (found PS-UAT-MUI1P2GD-79D7) | shots/029-bcc.jpg |
| 30 | Roles | Manager / Finance access to Training ops, finance, CRM, BCC | PASS | jyoti.manager39 /api/training-ops 200 · jyoti.manager39 /api/training-finance 403 Permission denied · jyoti.manager39 /api/crm 403 CRM is outside the manager's organizational scope · jyoti.manager39 /api/booking-command-center 200 · uat.demo.manager /api/training-ops 200 · uat.demo.manager /api/training-finance 403 Permission denied · uat.demo.manager /api/crm 200 · uat.demo.manager /api/booking-command-center 403 Booking Command Center is outside the manager's organizational scope · anjali.finance33 /api/training-ops 403 Permission denied · anjali.finance33 /api/training-finance 403 {"error":"MFA enrollment required"} · anjali.finance33 /api/crm 403 Permission denied · anjali.finance33 /api |  |
| 31 | AI | V2 chat (guest): training packages and prices | FAIL | locator.click: Timeout 20000ms exceeded. |  |
| 32 | AI | V2 chat (signed-in customer with a confirmed Meet & Greet): my next session | FAIL | locator.click: Timeout 20000ms exceeded. |  |
| 33 | AI | AI configuration readiness (founder) | PASS | PAWSPACE TEAM · AI BUSINESS CONFIGURATION / Assistant configuration & knowledge / Versioned, reviewed and auditable AI business configuration. Production provider activation remains separate. / Disable AI Enable AI AI review Rollout / Is the assistant switched on? / Answering staff: yes · answering customers: yes. Every requirement below has to be met — any one of them missing sends every conversation to a human. / ✓ / Model provider connected / openai · gpt-5.6-terra / ✓ / Assistant profile and system policy activated / profile pawspace_default v2 · policy pawspace_system v1 · 10 approved kno | shots/030-ai-configuration.jpg |
| 34 | Payment | Payment state recorded against the bookings | PASS | meet PS-UAT-MUI1G6RX-471E: captured · starter PS-UAT-MUI1P2GD-79D7: captured / funding n/a |  |

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
- customer:Master A 409 POST /api/training-commercial {"error":"Training coupon is not active or eligible"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training coupon is not active or eligible"}
- customer:Master A 409 POST /api/training-commercial {"error":"Training coupon is not active or eligible"}
- customer:Master B 401 GET /api/mobile-employee-ai 
- customer:Master C 401 GET /api/mobile-employee-ai 
- customer:Master C 400 POST /api/uat-scheduling {"error":"This service needs at least 1440 minutes' notice","code":"below_minimum_lead_time","minimumLeadMinutes":1440,"leadMinutes":1218,"policyVersion":"booking_time_policy:dog_training:*:v1"}
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 409 GET /api/training-finance {"error":"Published Training tax policy is required"}
- staff 409 GET /api/training-reconciliation {"error":"Unable to reconcile Training records"}
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 403 GET /api/training-finance {"error":"Permission denied"}
- staff 403 GET /api/crm {"error":"CRM is outside the manager's organizational scope"}
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 403 GET /api/training-finance {"error":"Permission denied"}
- staff 403 GET /api/booking-command-center {"error":"Booking Command Center is outside the manager's organizational scope"}
- staff 404 GET /api/uat-customer-switch {"enabled":false}
- staff 403 GET /api/training-ops {"error":"Permission denied"}
- staff 403 GET /api/training-finance {"error":"{\"error\":\"MFA enrollment required\"}"}
- staff 403 GET /api/crm {"error":"Permission denied"}
- staff 403 GET /api/booking-command-center {"error":"Permission denied"}
- customer:Master A 403 GET /api/mobile-employee-ai 
- staff 404 GET /api/uat-customer-switch {"enabled":false}
