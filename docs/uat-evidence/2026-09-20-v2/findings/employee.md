# PawSpace V2 - Employee / business back-office browser UAT (employee area)

Server: http://127.0.0.1:8792 (commit a7124de, wrangler dev --local, Miniflare D1). Chromium 1366x900, headless. Scripts: `$S/pw/employee-sweep.mjs` (77 routes as founder), `employee-flows-founder.mjs` (39 write/read steps), `employee-personas.mjs` (6 personas x 33 APIs x 17 pages + associate/manager/payroll flows). Evidence: `$S/evidence/employee/{sweep-founder,flows-founder,personas}/*.png`, JSON in `$S/evidence/employee/*.json`. Machine findings: `$S/findings/employee.json` (19 defects/observations, 13 passes, 1 not-tested list).

Harness note: `/api/identity-session` 401 on every staff page is the customer/partner identity probe and was ignored. No "Network connection lost" flakes were hit; every 500 below reproduced.

## Per-module result

| Module | Result | Notes |
|---|---|---|
| Staging login | PASS | UI quick button (founder) and API sign-in for all 7 personas |
| CRM & leads | PARTIAL | Lead capture works end to end (201, owner auto-assigned, first-response task). List search by phone fails to show the new lead, detail card values unreadable (EMP-09). Lead assignment/SLA are API-only and 500 on validation; no active assignment policy seeded (EMP-07). Daily revenue priority dead: `/api/revenue-crm` 500 schema collision (EMP-01). Customer 360 for UATD-CUS-1 / E2E-CUS-UI-001 OK; `/team/sales` list unpaginated (EMP-14). |
| Booking Command Center | PASS (with gaps) | 14 bookings, filters, selection, Reassign/Call/WhatsApp/Tracking with reason persist (201) and show in the timeline. No cancel/refund action (EMP-16). Stream endpoint 5xx for unauthorised roles (EMP-15). Manager cannot open it at all (EMP-02). |
| Control Center | PASS (2 defects) | Emergency stop switches: reason mandatory, STOP -> ENABLE round-trip audited and restored; 22 panels + appearance/integrations/provider-onboarding/v2 render. Launch essentials never loads for UAT sessions (EMP-08, 401 header-only identity). Business 360 first load hits `/api/subscription-business-view` 500 (EMP-13). |
| Ops (work queue, alerts, cases, scheduling) | PASS | Honest empty states; no reservations on the seed dates so Reassign was not exercised. |
| Employee self-service (/me) | PASS | Associate/sales/groomer: salary, payslips, incentives, leave, rank; Check in/out recorded with `missing_checkout` exception logic. Founder sees "No employee record linked". |
| Attendance | PASS | Check-in/out idempotent events; adjustment request -> manager approval (API). Time page has no approve control (EMP-05). |
| Leave | FAIL | Apply leave 500 "Self-service request failed" - no active leave policy seeded and validation surfaces as 500 (EMP-06). Manager approval of the seeded pending request works via API only (EMP-05). Self-approval check could not be completed. |
| Payroll | PARTIAL | API maker/checker verified as far as local auth allows: founder calculate (PAYRUN-4C145650-F97), idempotent replay, maker cannot review own run, manager 403, structure save. Page is read-only (EMP-04). Finance personas are MFA-gated (EMP-03) so review -> approve -> sandbox batch could not complete. |
| Incentives | PASS for founder only | Approve and reverse work from the UI with ledger events; `incentives.view/manage` are granted to no operational role so manager/finance get 403 on the page (EMP-12). Dispute/resolve controls not rendered for the seeded results. |
| Finance / reconciliation / GST | PASS as founder, BLOCKED as finance | All finance, statutory (GST), compliance (TDS/close), partner payouts, reconciliation, finance-control pages and APIs load for founder. Partner settlement two-level approval and test payout not exercisable (0 statements in seed; finance MFA-gated). |
| Reports & config pages | PASS | 27 pages render with honest empty states; pricing rule and customer-reminder policy writes persisted. `/team/whatsapp` 404 (EMP-10). Revenue Mission page only flagged for the word "placeholder" in its own copy. |
| Role permissions | PARTIAL | Groomer/associate/sales refusals are 403 with honest UI text. Manager is refused on CRM/BCC/People by organisational-scope provisioning (EMP-02). Finance is MFA-gated everywhere (EMP-03). Refused pages for manager/finance render silent shells (EMP-11). Matrix discrepancies vs `defaultRoles`: incentives.*, uat-scheduling GET, i18n GET (EMP-12). |
| Mobile (Pixel 7) | NOT TESTED | Out of time. |

## Defects (severity, class)

- **EMP-01 P1 backend** - `GET /api/revenue-crm` 500 `D1_ERROR: no such column: requested_at` (lead_callbacks seeded with `preferred_at`; drizzle migration 0021 collision). `/team/daily-revenue` shows no rows; `/team` "0 ranked today". Evidence `sweep-founder/team_daily_revenue.png`, serve.log 7111-7134.
- **EMP-02 P1 auth** - Manager `jyoti.manager39` gets 403 "Manager organizational scope is not fully provisioned" on `/api/crm`, `/api/booking-command-center`, `/api/people-foundation`; CRM, BCC and People are unusable for the seeded manager and the pages give no message. Evidence `personas/manager_crm.png`, `manager_booking_command_center.png`, `manager_team_people.png`.
- **EMP-03 P1 auth (env-gated, coordinator-confirmed)** - Finance `anjali.finance33`: every API 403 "MFA enrollment required", no enrol UI; `/team` shows "Signed in loading role" with one card, `/me` "Permission denied". Finance flows untestable as finance.
- **EMP-04 P1 wiring** - `/team/people/payroll` read-only; calculate/review/approve/prepare_payment exist only in the API.
- **EMP-05 P1 wiring** - `/team/people/time` shows pending leave/adjustments but no approve/reject controls; decisions only via API.
- **EMP-06 P1 backend/data** - Apply leave -> 500 "Self-service request failed" ("Active leave policy configuration is required"); no leave policy seeded, validation not mapped to 4xx. Evidence `personas/assoc-03-leave-applied.png`, serve.log 12060.
- **EMP-07 P2 backend** - `lead-assignment-governance` assign/replay and `lead-sla-governance` start_clock/record_action return 500 for business validation ("No active lead assignment policy...", "Lead requires a current canonical assignment...", missing params); no active policy seeded; no UI posts these actions.
- **EMP-08 P1 auth** - `/api/launch-readiness` 401 for UAT sessions (header-only identity) -> Control "Launch essentials" empty for founder/manager.
- **EMP-09 P2 UI** - CRM list search "0 shown" for the new lead although the API finds it; detail values dark-on-dark; Appearance pill overlaps "Book the customer". Evidence `flows-founder/04-crm-lead-search.png`.
- **EMP-10 P2 UI** - `/team/whatsapp` 404.
- **EMP-11 P2 UI** - Silent shells on refused modules for manager (/crm, /booking-command-center, /control, /team/people) and finance (/team, /control, /team/finance, /team/finance/partners, /team/people, /team/people/time|payroll|incentives, /team/analytics, /team/people/manager-dashboard).
- **EMP-12 P2 auth** - `incentives.view/manage` on no operational role (manager 403 on /team/people/incentives and on approve); associate/sales hold `scheduling.book` but `GET /api/uat-scheduling` 403; `/api/i18n` GET 200 without `settings.manage`.
- **EMP-13 P2 backend** - `/api/subscription-business-view` 500 on first load of Control > Business 360 (coordinator: clears after grooming-subscription-plans is called once).
- **EMP-14 P2 UI** - `/team/sales` renders the whole customer list (22k px) without pagination.
- **EMP-15 P2 backend** - `/api/booking-command-center/stream` 5xx instead of 403 for roles without `bookings.manage`.
- Observations: EMP-16 BCC has no cancel/refund action (cancellation case needs caseId); EMP-17 "Test transaction engine" banner on /team and /crm; EMP-18 founder `/me` empty state; EMP-19 env-gated RazorpayX payouts, AI translate, voice, live payroll disbursement.

## Verified passes (driven in the browser)

Founder UI sign-in; CRM lead create (CU-24198 / LEAD-1789888627246, 201, owner neha.kulkarni auto-assigned, empty-form validation); Customer 360 UATD-CUS-1 and E2E-CUS-UI-001; BCC filters + Reassign/Call/WhatsApp/Tracking persisted with reason and toast; Control stop switch STOP/ENABLE with mandatory reason and full restore, 22 panels; ops pages honest empty states; associate check-in/out and adjustment request -> manager approval; manager approves UATD-LVR-1 (API); associate 403 on decide_leave and payroll; incentives approve UATD-IRES-2 (550) and reverse UATD-IRES-1 (IREV-56F12978-EE1); payroll calculate PAYRUN-4C145650-F97 + idempotent replay + maker-cannot-review + manager 403 + structure save; all finance/statutory/compliance pages and APIs as founder; pricing rule 201 and reminder policy 200 persisted; 27 report/config pages; role refusals 403 (never 500) with honest text for groomer/associate/sales; role-filtered /team menu.

## Not tested

Pixel 7 viewport; incentive dispute/resolve; partner settlement level-1/level-2 and test payout (no seeded statements, finance MFA); payroll review->approve->sandbox batch completion (finance MFA); lead -> booking conversion; scheduling Reassign (no reservations); customer-experience write actions; exhaustive dead-button click sweep.
