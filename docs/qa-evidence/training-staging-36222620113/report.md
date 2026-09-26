# PawSpace staging — Dog Training master E2E

- Origin: https://pawspace-staging.karthik-fce.workers.dev
- Run: 2026-09-26T06:41:12.320Z
- Customer phone: 8402694903

| # | Area | Step | Result | Detail | Evidence |
|---|---|---|---|---|---|
| 1 | Customer | Sandbox OTP sign-in (new customer) | PASS | phone 8402694903 | shots/001-customer-signed-in.jpg |
| 2 | Maps | Google Places autocomplete + resolve on staging | PASS | 1 suggestions; first="42, Indiranagar Double Road, Doopanahalli, Domlur, Bengaluru, Karnataka, India"; resolve=configured 12.9689746,77.6360876; reverse(Koramangala)=configured "002, KHB Colony, 4th Block, Koramangala, Bengaluru, Karnataka 560095, India" |  |
| 3 | Maps | Service zone by PIN (serviceable and not) | PASS | 560038=200:blr-east · 560068=200:blr-south · 560001=200:blr-central · 560102=200:blr-south · 110001=404:Zone not found for this pincode · 12345=400:Invalid pincode |  |
| 4 | Customer | Save address (560038) + 3 dogs + 1 cat | PASS | address 201, Bruno 201, Coco 201, Max 201, Whiskers 201 | shots/002-v2-account.jpg |
| 5 | Pricing | Catalogue + quote matrix (8 packages × prepaid/split × 1/4/5 dogs) | PASS | 8 packages: Trainer Meet & Greet ₹500, Starter Plan ₹3500, Puppy Training Plan ₹6000, Basic Obedience Plan ₹12000, Leash Obedience Plan · 8 ₹12000, Leash Obedience Plan · 12 ₹16500, Advanced Obedience Plan ₹16500, Pro Training Plan ₹20000 // trainer-meet-greet/prepaid/1: ₹500 due ₹500 60m ; trainer-meet-greet/prepaid/4: ₹500 due ₹500 240m ; trainer-meet-greet/prepaid/5: 409 Training supports 1-4 pets per programme ; trainer-meet-greet/split/1: 409 Trainer Meet & Greet must be paid in full ; trainer-meet-greet/split/4: 409 Trainer Meet & Greet must be paid in full ; trainer-meet-greet/split/5:  |  |
| 6 | Pricing | Training coupon (UATCARE100 / WELCOME) on the quote | FAIL | No coupon is accepted by the Training quote: UATCARE100: 409 Training coupon is not active or eligible · WELCOME: 409 Training coupon is not active or eligible |  |
| 7 | Customer V2 | Training page: dogs-only list, zone, catalogue | PASS | dogs=[Bruno, Coco, Max] · Training zone East Bengaluru · confirmed from your address PIN code | shots/003-v2-training-page.jpg<br>shots/004-v2-training-page-full.jpg |
| 8 | Payment | Meet & Greet ₹500 → Razorpay TEST card → captured → confirmation | PASS | PS-UAT-MUHZWX72-F7F0 · Arjun T. (UAT East) · 2026-09-29 · payment captured | shots/005-meet-before-reserve.jpg<br>shots/006-meet-payment-page.jpg<br>shots/007-meet-after-payment.jpg |
| 9 | Payment | Starter Plan split: ₹1,750 deposit → Razorpay → captured → programme confirmed | FAIL | Razorpay card form did not appear | shots/008-starter-before-reserve.jpg<br>shots/009-starter-payment-page.jpg |
| 10 | Customer V2 | Activity + booking page after deposit (balance CTA) | PASS | ← Your bookings / PawSpace / Starter Plan / PS-UAT-MUI018SV-D3B5 / Status: payment pending / 28 Sept, 3:00 pm IST · PawSpace Training Team (UAT) / Coco / Total: ₹3,500.00 · Payment: created / Manage serviceRefresh status / Your reserved sessions / 28/9/2026, 3:00:00 pm IST — scheduled / 5/10/2026, 3:00:00 pm IST — locked / PAYMENT · FINAL STEP / Review payment / Your service details are locked while you finish this step. / Total service value / ₹3,500.00 / Due now / ₹1,750.00 / Balance later / ₹ | shots/010-v2-activity.jpg<br>shots/011-v2-booking-after-deposit.jpg |
| 11 | Customer app | Mobile 5-stage flow: goals → Basic Obedience → trainer → calendar → review | PASS | Review your programme / Payment · 5 of 5 / Pets / Bruno / Programme / Basic Obedience Plan · 8 sessions / Preferred trainer / PawSpace Training Team (UAT) · final assignment checked server-side / Schedule / Wed & Sun · 9:00 AM · 60 min / Parent/caretaker participation / Joining · 15-minute coaching and homework handoff / Trainer Meet & Greet / Not booked / Validity / 62 days from service start / Complimentary care / Bath & Basic grooming / ✓ / Pay 50% upfront · no discount / ₹6,000 now · ₹6,000  | shots/012-app-stage1.jpg<br>shots/013-app-stage2.jpg<br>shots/014-app-stage3.jpg<br>shots/015-app-stage4.jpg<br>shots/016-app-stage5.jpg |
| 12 | Customer app | Coupon UATCARE100 with 100% payment | FAIL | Coupon shown as applied but Training quote refused it — pay button "Refreshing server quote…", alert ["Training coupon is not active or eligible"] | shots/017-app-coupon.jpg |
| 13 | Payment | Mobile app: Basic Obedience 50% (₹6,000) → Razorpay → captured → dashboard | FAIL | locator.waitFor: Timeout 30000ms exceeded. |  |
| 14 | Customer app | Programme dashboard tabs + cancellation request | BLOCKED | No app booking |  |
| 15 | Trainer | Partner app sandbox OTP sign-in as the assigned trainer | PASS | 9000000931 → uatcap_train_ft · paw / space / PARTNER / ✓ / Verified / › / Sign out / 🟢 Online / PAWSPACE PARTNER MOBILE / PawSpace Training Team (UAT) / service provider / ↻ / NEXT ASSIGNMENT / Scheduled / Basic Obedience Plan / Pet · blr-south / ◷ 15 Sept, 3:00 pm / ◉ S••••• / Accept training session / Open training session / 1 | shots/018-partner-app-home.jpg |
| 16 | Trainer | Session 1: accept → on the way (partner app) | FAIL | accept 409 {"error":"The customer must complete the required Training payment before this session can proceed.","code":"training_payment_required"} · on the way 0 button "On the way" not available | shots/019-trainer-s1-on-the-way.jpg |
| 17 | Maps | Session 1: arrival geofence (250 m) at the geocoded doorstep | FAIL | Arrived 0 button "Arrived" not available |  |
| 18 | Trainer | Session 1: pre-check → start → photos → handover → report | FAIL | start 0 button "Start session" not available |  |
| 19 | Staff | Founder approves session 1 photos (maker/checker, Control) | FAIL | approved 0/2 () | shots/020-proof-review-ps-uat-mui018sv-d3b5.jpg |
| 20 | Trainer | Session 1: Complete & consume one session (trainer UI) | FAIL | 0 button "Complete & consume one session" not available | shots/021-trainer-s1-complete-ui.jpg |
| 21 | Trainer | Session 1: same completion with attendance confirmation (backend check) | FAIL | 400 {"error":"Session, action and idempotency key are required"} |  |
| 22 | Trainer | Session 2 (final): accept → journey → arrive → start → photos → report | FAIL | Accept 409 · On the way 0 · Arrived 0 · start 0 · Before photo: input missing; After photo: input missing · handover 0 · report 0 | shots/022-trainer-s2-in-session.jpg |
| 23 | Staff | Founder approves session 2 photos | FAIL | approved 0/2 | shots/023-proof-review-ps-uat-mui018sv-d3b5.jpg |
| 24 | Payment | Final session blocked until balance is paid | PASS | 400 Session, action and idempotency key are required |  |
| 25 | Payment | Customer pays remaining ₹1,750 balance via Razorpay (V2 booking page) | FAIL | Razorpay card form did not appear | shots/024-balance-before.jpg |
| 26 | Trainer | Final session completion → programme completed + certificate | FAIL | 400 {"error":"Session, action and idempotency key are required"} | shots/025-trainer-programme-complete.jpg |
| 27 | Trainer | Earnings (trainer workspace + partner app) | PASS | workspace: CANONICAL TRAINING PAYOUT LEDGER / ₹0.00 / Execution: sandbox not connected. Finance approval is required for payout. Live payout is not connected. / Completed session earnings / 0 / Rate configured + customer payment captured / Pending rate / holds  // partner app: paw / space / PARTNER / ✓ / Verified / › / Sign out / 🟢 Online / ‹ / PARTNER FINANCE / Earnings / ₹ / Settlement-controlled earnings / This mobile screen never invents payout figures from booking prices. Provider earnings appear only from the canonical settlement and commission ledger after Finance | shots/026-trainer-earnings.jpg<br>shots/027-partner-app-earnings.jpg |
| 28 | Staff | Training operations console | PASS | PAWSPACE TEAM · OPERATIONS · TRAINING / Training operations / Session recovery, trainer replacement and canonical payment records. / ← Operations / Active programmes / 20 / Canonical Training programmes / Sessions today / 3 / From canonical session calendar / Open recovery cases / 0 / Reschedule / no-show / replacement / Payment exceptions / 9 / Not marked captured in sandbox ledger / CANONICAL PR | shots/028-ops-console.jpg |
| 29 | Accounts | Training finance: invoice for fully-paid programme | FAIL | Issue UAT invoice disabled — row:  | shots/029-finance-training.jpg<br>shots/030-finance-training-full.jpg |
| 30 | Accounts | Trainer payout statement → approve sandbox instruction | BLOCKED | No payout statement row for  |  |
| 31 | Accounts | Cancellation case for the app booking (policy, calculation, approval) | BLOCKED | No app booking |  |
| 32 | CRM | Capture a Dog Training lead and find it | PASS | {"ok":true,"id":"CU-52803","leadId":"LEAD-1790404513225","assignedOwner":"rahul.sales@pawspace.in","ownerResolved":true,"ownerMappingException":null,"attributionBound":false,"organizationalScope":{"ci | shots/031-crm-lead.jpg |
| 33 | Ops | Booking Command Center lists the Training bookings | PASS | found 0:  | shots/032-bcc.jpg |
| 34 | Roles | Manager / Finance access to Training ops + finance | PASS | manager39@tkpetcare /api/training-ops 200 · manager39@tkpetcare /api/training-finance 403 Permission denied · manager39@tkpetcare /api/crm 403 CRM is outside the manager's organizational scope · manager39@tkpetcare /api/booking-command-center 200 · finance33@tkpetcare /api/training-ops 403 Permission denied · finance33@tkpetcare /api/training-finance 403 {"error":"MFA enrollment required"} · finance33@tkpetcare /api/crm 403 Permission denied · finance33@tkpetcare /api/booking-command-center 403 Permission denied |  |
| 35 | AI | V2 chat (guest): training packages question | PASS | 200 · What dog training packages do you offer in Bengaluru and what do they cost? / PawSpace AI / Yes. PawSpace offers Training. I can help you understand the service or start from the Training section in PawSpace. | shots/033-ai-guest-chat.jpg |
| 36 | AI | V2 chat (signed-in customer): my training programme | PASS | 200 · When is my next dog training session and who is my trainer? / PawSpace AI / I’m routing this conversation to a PawSpace team member so it can be handled safely. | shots/034-ai-customer-chat.jpg |
| 37 | AI | AI configuration readiness (founder) | PASS | PAWSPACE TEAM · AI BUSINESS CONFIGURATION / Assistant configuration & knowledge / Versioned, reviewed and auditable AI business configuration. Production provider activation remains separate. / Disable AI Enable AI AI review Rollout / Is the assistant switched on? / Answering staff: yes · answering customers: yes. Every requirement below has to be met — any one of them missing sends every conversation to a human. / ✓ / Model provider connected / openai · gpt-5.6-terra / ✓ / Assistant profile and system policy activated / profile pawspace_default v2 · policy pawspace_system v1 · 10 approved kno | shots/035-ai-configuration.jpg |

## API errors observed (4xx/5xx)

- customer 404 GET /api/service-zone {"error":"Zone not found for this pincode"}
- customer 400 GET /api/service-zone {"error":"Invalid pincode","code":"invalid_pincode"}
- customer 401 GET /api/mobile-employee-ai 
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Trainer Meet & Greet must be paid in full"}
- customer 409 POST /api/training-commercial {"error":"Trainer Meet & Greet must be paid in full"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training supports 1-4 pets per programme"}
- customer 409 POST /api/training-commercial {"error":"Training coupon is not active or eligible"}
- customer 409 POST /api/training-commercial {"error":"Training coupon is not active or eligible"}
- customer 409 POST /api/training-commercial {"error":"Training coupon is not active or eligible"}
- trainer 409 POST /api/training-sessions {"error":"The customer must complete the required Training payment before this session can proceed.","code":"training_payment_required"}
- trainer 404 GET /api/training-session-media {"error":"Training session not found"}
- trainer 400 POST /api/training-sessions {"error":"Session, action and idempotency key are required"}
- trainer 409 POST /api/training-sessions {"error":"The customer must complete the required Training payment before this session can proceed.","code":"training_payment_required"}
- trainer 404 GET /api/training-session-media {"error":"Training session not found"}
- trainer 400 POST /api/training-sessions {"error":"Session, action and idempotency key are required"}
- customer 403 GET /api/mobile-employee-ai 
- trainer 404 GET /api/training-session-media {"error":"Training session not found"}
- trainer 400 POST /api/training-sessions {"error":"Session, action and idempotency key are required"}
- staff 409 GET /api/training-finance {"error":"Published Training tax policy is required"}
- staff 409 GET /api/training-reconciliation {"error":"Unable to reconcile Training records"}
- staff 403 GET /api/training-finance {"error":"Permission denied"}
- staff 403 GET /api/crm {"error":"CRM is outside the manager's organizational scope"}
- staff 403 GET /api/training-ops {"error":"Permission denied"}
- staff 403 GET /api/training-finance {"error":"{\"error\":\"MFA enrollment required\"}"}
- staff 403 GET /api/crm {"error":"Permission denied"}
- staff 403 GET /api/booking-command-center {"error":"Permission denied"}
