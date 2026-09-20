# PawSpace V2 — End-to-end test report (2026-09-20)

Evidence bundle: `docs/uat-evidence/2026-09-20-v2/` (per-area findings JSON/MD, orchestrator notes, API role matrix, suite logs, curated P1 screenshots).

## 1. What was tested

| Item | Value |
|---|---|
| Required V2 baseline SHA | `a7124de52462f01e513569e64931db3c656ee9c1` |
| **Exact tested SHA** | `a7124de52462f01e513569e64931db3c656ee9c1` (origin/main HEAD; merge of PR #938 "feat(mobile): add employee AI chat and voice"). No newer main commit existed during the run. |
| **Exact staging URL** | `https://pawspace-staging.karthik-fce.workers.dev` |
| Staging SHA verification | GitHub Actions "Deploy staging" run #324 (2026-09-20 06:23–06:27 UTC, workflow_dispatch) checked out, built, deployed (`wrangler deploy --message "staging a7124de…"`) and certified exactly `a7124de…`. Steps "Verify the checkout is exactly the requested sha and is clean", "Certify deployed isolation before any D1 write", "Load the staff directory into the staging D1", "Load the human-UAT provider roster into the staging D1" and "Certify the staging deploy" all succeeded. **SHA gate: PASS.** |
| Where the tests ran | The staging host is blocked by this sandbox's organisation egress policy (proxy `CONNECT` 403, harness fetch `EGRESS_BLOCKED`), so no request from this session reached staging directly. Every browser/API test below ran against the **same commit** built with `npm run build` and served by the Cloudflare worker runtime locally (`wrangler dev --local`, Miniflare D1) with staging-equivalent configuration (`PAWSPACE_DEPLOYMENT_ENV=staging`, sandbox payments, UAT staff login, on-screen sandbox OTP, sandbox maps, `PAWSPACE_VOICE_ENV=uat`) and the same seed packs the staging workflows load (`employee-seed.sql`, `uat-staging-provider-capacity.sql`) plus the optional `staging-seed.sql`, `uat-demo-seed.sql` packs and the drizzle migration set that the staging deploy applies. Seven isolated server instances (one per test lane) were seeded from one snapshot. |
| Not available locally (only on Cloudflare) | Razorpay sandbox keys, Workers AI binding (`env.AI`), `PAWSPACE_AI_PROVIDER_API_KEY`, Google Maps UAT key, Exotel, Meta WhatsApp, Sentry. Anything that needs one of these is marked **env-gated** and re-verification on staging is listed in §7. |
| Out of scope | Legacy V1 build, old preview deployments, production. Marketing/legacy pages were only load-swept. |

## 2. Verdict

**Human-UAT readiness: NOT READY as a whole — CONDITIONALLY READY for three lanes** (customer Grooming on `/mobile-app`, the partner grooming job lifecycle, and Founder-only back-office operation). Twelve P1 defects were found in the V2 build at this SHA, six of which block a persona outright (Finance, Manager, partner pay-after-service collection, V2 `/v2/grooming` booking, CRM daily-revenue engine, Control "Launch essentials"). Several are configuration/seed gaps that the staging D1 shares because it is loaded from the same seeds and migrations. Details in §5–§7.

## 3. Automated gates executed at this SHA (all local, same commit)

| Gate | Result |
|---|---|
| `npm run install:ci` + `npm run build` (vinext) | PASS, Sites artifact validated |
| Typecheck (`tsc --noEmit`) | PASS, 0 errors |
| Lint (`eslint .`) | PASS, 0 errors (142 pre-existing unused-variable warnings) |
| Static/unit suite `tests/*.test.mjs` (778 files) | PASS, 6306 tests, 0 failures |
| Integration suite `tests/integration` | PASS, 14 run, 19 skipped (no Razorpay/IDfy/Meta sandbox credentials), 0 failures |
| `backend/` Fastify API | typecheck PASS, 28 tests PASS |
| Hardened browser journeys `e2e/journeys/00–05` on the built worker | Desktop Chrome 44/44 PASS; Pixel 7 43/43 PASS (identity/RBAC preconditions, customer, partner, admin, correlated customer → assigned provider completes → admin balanced finance in both assignment modes, voice console governance) |
| V2 contract browser suite (`v2-grooming.spec`, `v2-customer-shell.spec`) | 11/11 PASS on desktop and mobile |
| Persona-lane suite (`playwright.config.ts`, 31 specs) | 28 PASS on `localhost`; 1 env-gated (boarding closure stops at the Razorpay checkout 503), 1 staging-origin-only spec, 1 legacy V1 home spec. The first run on `127.0.0.1` produced 11 extra failures caused by Playwright's request context not sending `Secure` cookies over plain HTTP — a harness artefact, not a product defect |
| GitHub Actions for this SHA | Release CI run #5178 on `a7124de` PASS; Browser E2E (hardened) run #1598 and Native test builds run #12 PASS on `c2caad1` (the PR head that `a7124de` merges); Deploy staging run #324 PASS. "Automated human sweep (staging)" has **not** been run on `a7124de` (last run #32 on `5c72a6b`); PR #940 adds an exact-SHA gate and Employee-AI checks to that sweep but is unmerged and unrun. |

## 4. Required result statements

| Statement | Result |
|---|---|
| Exact tested SHA | `a7124de52462f01e513569e64931db3c656ee9c1` |
| Exact staging URL | `https://pawspace-staging.karthik-fce.workers.dev` (deployment of this SHA verified via deploy run #324; not reachable from this sandbox, tests executed on the same SHA locally) |
| Customer flow result | **PASS on `/mobile-app` for Grooming end to end** (new + existing customer, OTP, profile, pets, address, package, slot, coupon, groomer assignment, confirmation, reschedule, cancel). Training, Boarding, Sitting, Walking, Taxi, Food, Relocation reach their payment/enquiry step with live prices. **FAIL on `/v2/grooming` until Pricing Control packages are published** (P1 config gap; wiring verified working after publication). 2 P1 + 11 P2 + 2 P3 customer defects. |
| Payment result | **ENV-GATED / NOT PROVEN.** Razorpay sandbox keys are absent locally: every "Pay" ends in `POST /api/customer-checkout` 503 "Razorpay test checkout is not configured. Contact billing support." shown honestly; no fake success, booking stays `payment_pending` and is recoverable; double-click/reload create exactly one booking and one order attempt. Staging must carry `RAZORPAY_KEY_ID_SANDBOX`, `RAZORPAY_KEY_SECRET_SANDBOX`, `RAZORPAY_WEBHOOK_SECRET_SANDBOX` (optional secrets in the deploy workflow) for a sandbox capture to be tested. |
| Partner result | **PASS for the grooming lifecycle** (OTP login, assigned job, accept, customer-safe contact, GPS geofence enforced, start, before/after photo upload, Ops maker/checker approval, proof, complete, earnings/settlement/invoice) on Pixel 7 and iPhone 14. **P1: partner cannot raise the pay-after-service payment request** (gateway 403). Trainer/host/sitter/walker/taxi personas sign in and see honest empty states; no training session is seeded for any switchable trainer, so training execution was not exercisable. 1 P1 + 10 P2. |
| Employee result | **PARTIAL.** Founder: CRM lead capture, Customer 360, Booking Command Center actions, Control stop-switches, attendance, payroll calculate (API), incentives approve/reverse, finance/GST/statutory pages all work. **Blocked personas:** Finance (MFA-gated, no enrol UI), Manager (403 "organizational scope is not fully provisioned" on CRM/BCC/People). Leave application 500s; payroll and leave approvals exist only in the API, not on the pages. 6 P1 + 8 P2. |
| CRM/lead result | **PARTIAL.** Lead capture (201, owner auto-assigned), Customer 360, customer-to-CRM visibility of bookings (`/crm`, `/v2/crm`, `/booking-command-center`, `/api/customer-360`) PASS. Daily revenue / Revenue CRM engine **FAIL** (`/api/revenue-crm` 500 from a `lead_callbacks` schema collision introduced by drizzle migration 0021, applied to staging). Lead assignment/SLA actions are API-only and return 500 on validation. |
| Incentives result | **PASS for Founder** (scheme results visible; approve → ₹550 approved; reverse → reversal ledger event; partner earnings reflect a completed job). `incentives.view/manage` is granted to no operational role, so Manager/Finance get 403 on the incentives page (P2). Dispute/resolve controls not rendered for the seeded results (not tested). |
| AI Chat result | **PASS (fail-closed mode).** Access matrix correct (Founder/Manager get the AI tab; associate, sales, groomer, finance, customer, partner and guests are refused with 401/403, never 500). Customer context loads from CRM; turns persist to canonical threads/messages/audit; idempotent replay dedupes; money/refund/capture requests are policy-blocked and route to finance CX; human handoff works both ways. **A real model answer was not produced because `PAWSPACE_AI_PROVIDER_API_KEY` is not configured locally** (every turn becomes an honest human handoff). **P1 UI defect:** after a handoff the chat silently swallows the 409 "AI replies are paused" response (no error shown). |
| AI Voice result | **ENV-GATED / NOT PROVEN.** Locally `enabled:false`, reason "Cloudflare Workers AI binding (AI) is not configured"; UI shows the reason, Start voice is disabled, ticket issuance returns 409 and is audited, unauthenticated websocket is refused. Microphone permission, start/stop, STT → AI → TTS, listening/speaking/error states could not be exercised without the Workers AI binding and an HTTPS origin. Staging has the `[ai]` binding and `PAWSPACE_VOICE_ENV=uat` + `…SELF_TEST_APPROVED=true`, so it must be verified there. |
| Android/native result | **Web layer PASS on the Pixel 7 viewport** (no horizontal overflow on `/mobile-app`, `/partner-app`, V2 pages; 14 P2 phone-layout defects on staff/V2 screens, see §6). **Native build: CI-proven compile only** — "Native test builds" run #12 compiled the Android debug APK for `c2caad1` (content of this SHA). The Capacitor shells load the staging URLs remotely; no device/emulator run, no Play/TestFlight beta (the "Mobile Beta Distribution" workflow has never succeeded). |
| iOS/native result | **Web layer PASS on the iPhone 14 viewport** (same caveats). **Native build: CI-proven compile only** — iOS simulator app compiled in the same run. No simulator/device execution in this session. |
| Remaining blockers | See §7 (12 P1 defects + 4 environment gates). |
| Human-UAT readiness status | **NOT READY overall. Conditionally ready for: customer Grooming on `/mobile-app`, partner grooming lifecycle, Founder-only back-office.** Do not start Finance, Manager, V2 grooming, CRM revenue, payment, or AI-voice UAT until §7 items are closed. |

## 5. Persona and flow results

### 5.1 Customer (new and existing) — `/mobile-app` and `/v2`, Pixel 7 + iPhone 14 + desktop

| Flow | Result | Notes / evidence |
|---|---|---|
| OTP/login | PASS | Sandbox code on screen, name capture for new customers, sign out/switch account; wrong code → message shown but HTTP 500 (SW-023) |
| Customer profile | PASS | Edit persists across reload |
| Pet profile | PASS | Add with age/weight bands, edit in place; no delete/archive control; seeded "vaccinated" pet renders "Vaccination not provided" (P2) |
| Location/address | PASS with P2 | 560068 accepted, 110001 refused in the booking flow; account address form accepts unserviceable 110001 as default (P2) |
| Grooming `/mobile-app` | PASS end to end | Live catalogue ₹1,349/₹1,899/₹2,399/₹1,599, coupons WELCOME/UATCARE100, assigned "PawSpace Grooming Team (UAT)", Status/Photos/Payment tabs, reschedule 200, cancel 200 |
| Grooming `/v2/grooming` | FAIL → PASS after publication | Catalogue empty (all 42 grooming packages `active=0`); after Founder publishes `dog-basic` bundles via Pricing Control the full flow works: doorstep, slot, 3 groomers, verified live price ₹1,747, booking `PS-UAT-MU9IS5Y5-75E9`, payment page, honest 503, reload-safe |
| Training | PASS to payment | Starter ₹3,500, 50% due now, trainers listed, sessions materialised; mobile default Meet & Greet slot refused (P2) |
| Boarding | PASS to payment, P1 on manage | 5 nights dog+cat, 3 verified hosts, ₹6,990, "Reserve with 50% now ₹3,495", double-click safe; manage page claims "Payment is captured" for an unpaid stay (P1) |
| Pet Sitting | PASS to payment | Visit ₹399, overnight ₹1,598 |
| Dog Walking | PASS | Recurring Mon/Wed/Fri ₹698 created; manage = request-only cancellation |
| Pet Taxi | PASS | ₹699 trip created; manage = request-only cancellation; phone CTA squeezed (P2) |
| Fresh Food | PASS with P2 | 2-item cart ₹1,648 + repeat delivery; V2 order ₹849 + 30-day subscription; `/v2/food/manage` empty (P2) |
| Relocation | PASS with P2 | Domestic + international enquiries created; destination country recorded as UAE for both (P2) |
| Pricing/quote | PASS | Live catalogue/Pricing Control prices; fallback pricing never enables reservation |
| Razorpay sandbox payment | ENV-GATED | 503 honest refusal; no fake success; one booking per attempt |
| Booking creation / status / activity | PASS | Activity, manage pages, `booking-confirmation?bookingId=` recovery |
| Cancellation / reschedule | PASS where offered | Grooming: both; Boarding: date change/cancel via manage; Walking/Taxi: request-only; Training: no manage link (P3) |
| Partner assignment visibility | PASS | Provider name/model on confirmation |
| Completion/proof visibility | NOT TESTED | No completed service existed for the test customers (partner lane completed one job for 9800000111 on its own server) |
| Customer-to-CRM visibility | PASS | New customers and bookings visible in `/crm`, `/v2/crm`, `/booking-command-center`, `/api/customer-360` |

### 5.2 Partners — `/partner-app` (Pixel 7, iPhone 14), `/partner*` hub (desktop)

| Flow | Result |
|---|---|
| Login (OTP), sign-out, Switch UAT provider (host/sitter/walker/taxi), employee-groomer via `/staging-login` | PASS |
| Assigned jobs / job feed / dashboard | PASS (auto-assigned customer booking visible; honest empty states) |
| Accept / reject | Accept PASS; Decline only exists for commission providers (auto-assigned team is full-time) — not exercisable |
| Job details, customer-safe contact | PASS (first name + masked phone, no raw PII in UI or API; cross-tenant 403) |
| GPS/location | PASS (trusted fix 201; geofence 409 at 12,980 m, accepted at doorstep); Google Routes ETA env-gated |
| Start service, upload proof/photos, complete service | PASS (before/after PNG, Ops maker/checker approval by Founder, uploader cannot self-approve, complete) |
| Earnings / settlements / incentives | PASS (net ₹944, accrued ₹937.55, invoice issued; seeded earnings for uat.demo.groomer) with P2 "proof still outstanding" false warning |
| Pay-after-service collection | **FAIL (P1)** — `/api/grooming-payment-sandbox` 403 for providers |
| Notifications / chat | No partner-facing surface; provider gets 403 on notification/finance APIs (observation) |
| Trainer | Signs in; no seeded training session for any OTP/switchable trainer, so execution not exercisable (observation) |

### 5.3 Employee / business (desktop; Founder, Manager ×2, Finance, Associate, Sales ×2, Employee groomer)

| Module | Result |
|---|---|
| CRM & leads | PARTIAL — capture PASS; list search misses new lead (P2); assignment/SLA API-only with 500s (P2); daily revenue engine FAIL (P1) |
| Lead assignment | PARTIAL — directory/member save PASS; assign replay 500; no active policy seeded |
| Customer 360 | PASS |
| Booking Command Center | PASS for Founder (filters, Reassign/Call/WhatsApp/Tracking with reason persisted); Manager 403 (P1); no cancel/refund action (obs); stream 5xx for unauthorised roles (P2) |
| Control Center | PASS with 2 P1/P2 — stop switches audited and restored; "Launch essentials" 401 for UAT sessions (P1); Business 360 first-load 500 (P2) |
| Employee dashboard `/me` | PASS for associate/sales/groomer; Finance "Permission denied" (P2); Founder "No employee record linked" |
| People/HR | PASS pages; manager org-scope 403 (P1) |
| Attendance | PASS check-in/out + exceptions; no approve/reject controls on the page (P1) |
| Leave | **FAIL** — apply → 500 "Self-service request failed" (no active leave policy; validation surfaces as 500) (P1) |
| Payroll | PARTIAL — API maker/checker verified (calculate, idempotent replay, maker cannot review own run); page read-only (P1); Finance MFA-gated so approve/batch not completed |
| Incentives | PASS for Founder; Manager/Finance 403 (P2) |
| Finance / reconciliation / GST / statutory | PASS as Founder; **BLOCKED as Finance** (MFA) |
| Reports | PASS (27 pages, honest empty states); `/team/whatsapp` 404 (P2); `/team/sales` unpaginated 22k px list (P2) |
| Role permissions | Groomer/associate/sales refusals are 403 with honest UI copy; Manager and Finance refused pages render silent shells (P2); matrix gaps in `incentives.*`, `scheduling.book` vs `/api/uat-scheduling`, `/api/i18n` (P2). Full 10-persona API matrix in `api-role-matrix.txt`. |

### 5.4 V2 Employee AI (`/mobile-app` → AI tab; `/team/ai/*`, `/chat`, `/v2/chat`)

| Acceptance item | Result |
|---|---|
| AI Chat available to authorised staff | PASS (Founder, both Managers) |
| AI Chat blocked for unauthorised users | PASS (associate/sales/groomer/finance 403, guest 401, customer OTP 403, partner OTP 403; cross-origin POST 403; never 500) |
| Customer context loading | PASS (6 CRM customers; switching updates the card; thread rows carry the customer id) |
| Real AI chat turn | FAIL-CLOSED (env-gated): "I'm routing this conversation to a PawSpace team member…" with meta `handoff · human_handoff · provider_unavailable`; no fabricated prices |
| Conversation/audit persistence | PASS (communication_messages/threads, ai_conversation_turns/sessions, ai_handoffs, ai_web_chat_events, security_audit_events bootstrap/chat) |
| No duplicate actions | PASS (double-click → 1 POST; same idempotency key → duplicatePrevented; key of another customer → 403) |
| No unauthorised money/refund/payment actions | PASS (refund → `blocked_high_impact`, queued to finance CX; capture/cancel-refund refused; ledgers unchanged) |
| Handoff | PASS (customer_requested_human; `/team/ai/handoff` take-over / return-to-AI on seeded and live threads) |
| AI Voice microphone / start-stop / STT→AI→TTS / states | ENV-GATED (no Workers AI binding, HTTP origin); gating UI, 409 ticket refusal, audit and websocket refusal PASS |
| Network-loss/retry | PASS at the API layer (aborted send leaves no row; retry succeeds once) — but the UI shows no error (P1 AI-D01) |
| Audit evidence | PASS |

## 6. Issues found

Severity: P0 money/booking lost/crash · P1 flow blocked · P2 visual/copy/degraded · P3 minor. Class: UI, wiring, backend, data, auth, payment, partner, AI, infrastructure. Evidence paths are relative to `docs/uat-evidence/2026-09-20-v2/` unless prefixed `$S/evidence/` (session scratchpad, screenshot not committed). Full per-finding records with exact request/response bodies: `findings/<area>.json`.

### 6.1 P1 defects (each reproduced by the orchestrator unless noted)

**P1-01 · Finance persona cannot use any finance module — MFA enrolment required with no UI** · class: auth/wiring
- Persona: Finance (`anjali.finance33@tkpetcare.in`); also any `admin`-role user.
- URL/module: `/me`, `/team`, `/team/finance`, `/team/people/payroll`, `/team/finance-compliance`, `/team/finance/partners`; APIs `/api/payroll`, `/api/finance-control`, `/api/gst-accounting`, `/api/partner-finance`.
- Steps: `/staging-login` → enter access code → "Finance (payroll, GST, payouts)" → land on `/me` → open any finance page.
- Expected: finance workspace loads; an MFA enrolment prompt if MFA is mandated.
- Actual: `/me` shows "Permission denied" (finance lacks `self_service.view`); every finance screen shows "MFA enrollment required" (API 403). `lib/server-auth.ts requirePrivilegedMfa()` gates `admin`+`finance`; the seeded UAT finance row has no `mfa_secret`; no page calls `/api/v1/auth/mfa/enroll|verify`. Backend path works: enrol (201, otpauth URI) → confirm TOTP (200) → verify (200, `pawspace_admin_mfa` cookie) → finance APIs 200.
- Evidence: `screenshots/finance__01-finance-after-login.png`, `screenshots/finance__02-finance-_team_finance.png`, `orchestrator-notes.md`.

**P1-02 · Revenue CRM engine 500 (`/crm`, `/team/daily-revenue`, `/team` ranked actions)** · class: backend (schema collision)
- Persona: Founder, Manager, Sales.
- URL: `GET /api/revenue-crm` → `{"error":"Unable to load Revenue CRM engine"}` 500, deterministic.
- Steps: sign in as Founder → open `/crm` or `/team/daily-revenue`.
- Expected: revenue opportunities, leads, tickets, leaderboard load.
- Actual: red banner / empty lists. Root cause: `drizzle/0021_loe_communications_ai_haptik.sql` creates `lead_callbacks(id,lead_id,phone,name,preferred_at,…)` while `lib/lead-callback-governance.ts` owns `lead_callbacks(…,requested_at,…)`; its `ensureLeadCallbackTables()` batch creates an index on `requested_at` → "no such column: requested_at" → batch rolls back → `dueLeadCallbacks()` throws. The staging deploy applies the drizzle set, so staging is affected.
- Evidence: `screenshots/sweep__crm-founder-desktop.png`, `screenshots/employee__sweep-founder__team_daily_revenue.png`, `findings/employee.md` EMP-01, `findings/sweep.md` SW-007/008.

**P1-03 · Control Center "Launch essentials" 401 for every UAT-cookie session** · class: auth/wiring
- Persona: Founder, Manager (any `/staging-login` session).
- URL: `/control` → `GET /api/launch-readiness` → 401 `{"error":"Unable to load launch readiness"}`.
- Steps: sign in at `/staging-login` as Founder → `/control` → "Launch essentials".
- Expected: launch readiness items load (Founder holds `launch.view`).
- Actual: 401. `app/api/launch-readiness/route.ts` resolves its own actor from the `oai-authenticated-user-email` header only; UAT cookie sessions have no header.
- Evidence: `screenshots/sweep__control-founder-desktop.png`, `screenshots/employee__flows-founder__14-control-Launch_essentials.png`.

**P1-04 · Seeded Manager is refused on CRM, Booking Command Center and People** · class: auth/data (org-scope provisioning)
- Persona: Manager `jyoti.manager39@tkpetcare.in` (also `uat.demo.manager` on BCC).
- URL: `/crm`, `/booking-command-center`, `/team/people` → APIs 403 `{"error":"Manager organizational scope is not fully provisioned"}` / `"Booking Command Center is outside the manager's organizational scope"`.
- Steps: `/staging-login` → "Manager (people & performance)" → open `/crm`.
- Expected: manager CRM/BCC/People (role holds `customers.manage`, `bookings.manage`, `people.view`).
- Actual: 403 and a silent page shell. The staff seed provisions no organisational scope for the advertised manager identity.
- Evidence: `screenshots/employee__personas__manager_crm.png`, `screenshots/employee__personas__manager_booking_command_center.png`, `api-role-matrix.txt`.

**P1-05 · Partner cannot raise the pay-after-service payment request** · class: wiring/auth
- Persona: Groomer (provider OTP session `9000000901`).
- URL: `/partner-app` job → "Create payment request" → `POST /api/grooming-payment-sandbox {action:"request_after_service"}` → 403 "Permission denied" (GET polls 403 too).
- Steps: complete a pay-after-service grooming job → tap Create payment request.
- Expected: payment request created for the ₹1,349 due at the door.
- Actual: 403. `lib/api-gateway.ts:168` maps the whole route to `payments.manage`; the route itself authorises `request_after_service` on `bookings.view` (provider role) but never runs.
- Evidence: `screenshots/partner__ist-payment-request.png`, `findings/partner.md` PARTNER-D01.

**P1-06 · `/v2/grooming` unbookable: catalogue exposes no published package** · class: data/config (V2 readiness)
- Persona: New/existing customer.
- URL: `/v2/grooming` → `GET /api/v2/grooming-catalogue` → `{"packages":[]}`; UI "No published package supports this pet selection yet", all slots unavailable, Reserve disabled.
- Steps: sign in → `/v2/grooming`.
- Expected: published grooming packages/bundles.
- Actual: every grooming row in `service_packages` is `active=0` (the runtime seed keeps packages unpublished pending Founder sign-off; V2 fails closed by design). After Founder `PATCH /api/pricing-control {entity:"package", changes:{active:1}, reason}` for `dog-basic` and its 2/3/4-pet bundles, the V2 flow works end to end (booking `PS-UAT-MU9IS5Y5-75E9`). Staging D1 must contain published grooming packages before V2 grooming UAT.
- Evidence: `screenshots/customer__07-v2-followup__01-v2-grooming-nopackage.png`, `screenshots/v2-grooming-live__04-payment.png`, `screenshots/v2-grooming-live__05-after-pay.png`.

**P1-07 · Boarding manage page claims "Payment is captured" for an unpaid stay** · class: UI/wiring (false payment state)
- Persona: Customer.
- URL: `/boarding/manage?bookingId=…` (and mobile stay panel) for booking `PS-UAT-MU9I7BVE-C96F` (payment `PAY-A9779A59` status `created`, booking `payment_pending`).
- Steps: create a boarding reservation → Pay (503 locally) → open manage page.
- Expected: honest "awaiting payment" state with a Pay control.
- Actual: "Payment is captured in UAT and the selected host still needs to accept…" and no Pay control. `app/mobile-app/boarding-customer-stay-panel.tsx stayMessage()` hard-codes the copy for `awaiting_host_acceptance` regardless of the payment row. Violates the V2 "no fake success" rule.
- Evidence: `screenshots/customer__08-fixups__v2-boarding-manage.png`, `screenshots/customer__08-fixups__v2-boarding-after-pay.png`.

**P1-08 · Employee AI chat silently swallows failures after a handoff / on network loss** · class: AI/UI
- Persona: Founder/Manager.
- URL: `/mobile-app` → AI tab → after any turn that hands off, send another message → `POST /api/mobile-employee-ai` 409 "AI replies are paused while the conversation is owned by staff" (also on offline).
- Expected: an inline error/alert explaining the thread is staff-owned (as `/chat` and `/v2/chat` do).
- Actual: user bubble appended, textarea cleared, no reply, no alert; `employee-ai-mobile.tsx` renders `error` only in the pre-bootstrap denied branch. Without an AI provider every first turn hands off, so the copilot looks dead after one message per customer.
- Evidence: `screenshots/ai__02-chat__04-money-prompts.png`, `screenshots/ai__02-chat__07-offline-error.png`, `findings/ai.md` AI-D01.

**P1-09 · Applying for leave returns 500** · class: backend/data
- Persona: Associate (`anita.associate17`) on `/me` → Leave → Apply.
- Expected: leave request created or a 4xx "no active leave policy" message.
- Actual: 500 "Self-service request failed" ("Active leave policy configuration is required"); no leave policy seeded and validation surfaces as a server error. Manager approval of the seeded pending request works via API only.
- Evidence: `screenshots/employee__personas__assoc-03-leave-applied.png`, `findings/employee.md` EMP-06.

**P1-10 · Payroll page is read-only (calculate / review / approve / prepare-payment only exist in the API)** · class: wiring
- Persona: Founder/Finance/Manager on `/team/people/payroll`.
- Expected: maker/checker controls on the page (the API enforces them correctly: founder calculate `PAYRUN-4C145650-F97`, idempotent replay, maker cannot review own run, manager 403).
- Actual: no controls rendered.
- Evidence: `screenshots/employee__sweep-founder__team_people_payroll.png`, `screenshots/employee__personas__fin-02-payroll.png`.

**P1-11 · Attendance/leave approvals have no controls on `/team/people/time`** · class: wiring
- Persona: Manager/Founder.
- Expected: approve/reject for pending leave and adjustment requests shown on the page.
- Actual: pending items listed, decisions only via API (`/api/attendance-leave`).
- Evidence: `screenshots/employee__sweep-founder__team_people_time.png`, `screenshots/employee__personas__mgr-01-time.png`.

**P1-12 · Persona-lane spec `boarding-persistent-closure` and every "Pay" step are blocked without Razorpay sandbox keys** · class: payment (environment)
- Reported here because it blocks the payment acceptance line: `POST /api/customer-checkout` 503 "Razorpay test checkout is not configured. Contact billing support." The refusal is honest and idempotent (no fake success). The payment page shows no booking reference and no "awaiting payment" status at that moment (P2 UX, `logs/boarding-rerun.txt`).

### 6.2 P2 / P3 defects (compact; full detail in `findings/<area>.json`)

| ID | Sev | Class | Persona · URL | Summary | Evidence |
|---|---|---|---|---|---|
| SW-023 | P2 | backend | Customer/Partner · `/api/customer-otp`, `/api/partner-otp` verify | Wrong or unknown OTP code answers HTTP 500 (`{"error":"Incorrect OTP code"}`, `{"error":"OTP challenge not found"}`) instead of 4xx; logs `api_failure` per mistype | `findings/sweep.md`, `orchestrator-notes.md` |
| SW-010 / EMP-13 | P2 | backend | Founder · `/control` Business 360 | `/api/subscription-business-view` 500 until `/api/grooming-subscription-plans` has been called once (cross-module table dependency `grooming_subscription_plans`) | `screenshots/sweep__control-founder-desktop.png` |
| SW-017 | P2 | wiring | Guest/partner · `/v2/*` verticals, `/training`, `/boarding`, `/host`, `/partner/*` | Signed-out visitors see the staff copy "Your staging sign-in has expired. Open /staging-login…" instead of a customer/partner sign-in prompt | `$S/evidence/sweep/v2-grooming-anon-android.png` |
| SW-012/013/014/022 | P2 | UI | Founder · `/control/integrations`, `/team/finance/statutory`, `/team/finance/training` (Pixel 7) | Action buttons collapse to ~30 px wide vertical columns; sub-nav pills overlap; faded cards | `$S/evidence/sweep/control-integrations-founder-android.png` |
| SW-018 | P2 | UI | Customer · `/mobile-app` support sheet (Pixel 7) | Cookie banner covers "Submit report"; appearance FAB overlaps the textarea | `$S/evidence/sweep/form-support-open.png` |
| SW-019 | P2 | UI | Any · `/v2/taxi`, `/taxi` (phone) | Sticky price bar squeezes the CTA into a 4-character column; FAB overlaps | `$S/evidence/sweep/v2-taxi-anon-android.png` |
| SW-020/021, AI-O03 | P2 | UI | Customer · `/mobile-app`, `/v2` (phone) | ◇ and ◐ floating buttons overlap each other and cover the bottom-nav "Account" tab | `$S/evidence/sweep/v2-customer-android.png` |
| SW-001/002, PARTNER-D09 | P2 | UI | Provider · `/partner/rates`, `/partner/funeral` | Raw API text "Permission denied" rendered above the page's own empty state for ineligible-but-valid providers | `$S/evidence/sweep/partner-rates-provider-android.png` |
| CUST-D03 | P2 | UI/validation | Customer · account address form | Accepts unserviceable PIN 110001 and makes it default | `findings/customer.json` |
| CUST-D04 | P2 | data | Customer · `/v2/relocation` | Destination country recorded as "United Arab Emirates" for Mumbai and London (no country field) | `findings/customer.json` |
| CUST-D05 | P2 | wiring | Customer · Activity/manage | `payment_pending` grooming booking has no resume-payment path except the unlinked `booking-confirmation` route | `findings/customer.json` |
| CUST-D06 | P2 | UI/payment | Customer · grooming checkout | Applied coupon silently dropped when switching pay mode (₹1,249 shown → ₹1,349 booked) | `findings/customer.json` |
| CUST-D07 | P2 | wiring | Customer · `/v2/food/manage` | Empty even with a valid order id | `findings/customer.json` |
| CUST-D08 | P2 | UI | Customer · `/v2/boarding` | "Reserve with 50% now" shows ₹6,990/₹0 after selecting full payment | `findings/customer.json` |
| CUST-D09 | P2 | UI | Customer · `/v2/sitting` | "2-hour home Meet & Greet · ₹500" card is dead; review says ₹0; no ₹499 rule found anywhere | `findings/customer.json` |
| CUST-D10 | P2 | wiring | Customer · mobile training | Default Meet & Greet slot → "We could not reserve this slot" | `findings/customer.json` |
| CUST-D11 | P2 | data | Customer · pets | Seeded Bruno (`vaccinated`) renders "Vaccination not provided" | `findings/customer.json` |
| CUST-D12 | P2 | UI | Customer · OTP | "Your name (first time only)" shown to returning customers | `findings/customer.json` |
| CUST-D13 | P2 | copy | Customer · review step, billing button, V2 taxi/food/relocation/walking | Customer-visible "UAT/sandbox/canonical/synthetic/(test)" wording | `findings/customer.json` |
| CUST-D14/D15 | P3 | misc | Customer | Generic API error for invalid pet weight; 40 px header Sign-out; duplicated error line on payment return; "— saved places" on `/v2`; activity rows without links; training bookings lack manage link; customer app polls `/api/mobile-employee-ai` (403 noise) | `findings/customer.json` |
| PARTNER-D02 | P2 | wiring/data | Groomer · Earnings | "Service proof still outstanding" for an approved, recorded proof (`provider-workspace.ts` reads `provider_job_proofs`, lifecycle writes `grooming_service_proof`) | `findings/partner.md` |
| PARTNER-D03 | P2 | wiring | Groomer · Live order impact | "Package upgraded" always 400 "Approved package and amount are required" (app never collects them) | `findings/partner.md` |
| PARTNER-D04 | P2 | UI | Groomer (phone) | Live-order-impact buttons break mid-word | `findings/partner.md` |
| PARTNER-D05 | P2 | data | Groomer · GPS/job cards | Address shows the PIN twice ("… 560038, 560038, India") | `findings/partner.md` |
| PARTNER-D06 | P2 | copy | Groomer · job detail | Raw code "grooming safety:friendly" | `findings/partner.md` |
| PARTNER-D07 | P2 | UX | Groomer · arrival | After a geofence 409 the app disables Mark arrived; only the "Retry saved updates" banner delivers arrival | `findings/partner.md` |
| PARTNER-D08 | P2 | auth/UX | Groomer · sessions | Superseded session keeps showing "Verified" while every call 401s until reload | `findings/partner.md` |
| PARTNER-D10 | P2 | data | Employee groomer · `/partner/workspace` | "PAYMENT PENDING" lists captured payments | `findings/partner.md` |
| PARTNER-D11 | P2 | UI | Groomer (phone) | Cookie-consent aside covers the bottom nav when scrolled to the footer | `findings/partner.md` |
| EMP-07 | P2 | backend | Founder · lead assignment/SLA APIs | assign/replay and start_clock/record_action 500 on business validation; no active policy seeded; no UI posts them | `findings/employee.md` |
| EMP-09 | P2 | UI | Founder · `/crm` | List search "0 shown" for a new lead the API finds; detail values dark-on-dark; Appearance pill overlaps "Book the customer" | `$S/evidence/employee/flows-founder/04-crm-lead-search.png` |
| EMP-10 | P2 | UI | Founder · `/team/whatsapp` | 404 | `findings/employee.md` |
| EMP-11 | P2 | UI | Manager/Finance · refused modules | Silent page shells with no "not permitted" text | `findings/employee.md` |
| EMP-12 | P2 | auth | Manager/Finance/Associate | `incentives.view/manage` on no operational role; associate/sales hold `scheduling.book` but `GET /api/uat-scheduling` 403; `/api/i18n` 200 without `settings.manage` | `api-role-matrix.txt`, `findings/employee.md` |
| EMP-14 | P2 | UI | Founder · `/team/sales` | Whole customer list rendered without pagination (22k px) | `findings/employee.md` |
| EMP-15 | P2 | backend | Non-`bookings.manage` roles · `/api/booking-command-center/stream` | 5xx instead of 403 | `findings/employee.md` |
| AI-D02 | P2 | UI | Staff · `/mobile-app` nav | "AI" tab wraps to a second row outside the 5-column nav bar on all viewports | `$S/evidence/ai/01-access/` |
| AI-D03 | P2 | wiring | Manager · AI voice | `capabilities.voice:true` but readiness needs `settings.manage` → unexplained "Voice request refused" | `findings/ai.md` |
| AI-D04 | P2 | backend/audit | Staff · AI chat | 409-refused turns persist the inbound message but write no `mobile.employee_ai.chat` audit row | `findings/ai.md` |
| AI-D05 | P2 | data | Staff · AI handoff queue | Employee-AI threads keyed to CRM ids (`UATD-CUS-n-CRM`) not canonical ids → shown as "C•••••", disjoint from the customer's canonical threads | `findings/ai.md` |
| ORCH-1 | P2 | UX | Staff · `/mobile-app` | Bottom nav (incl. the AI tab) hidden until the customer "Choose your service location" welcome is completed; staff must finish customer onboarding to reach Employee AI | `orchestrator-notes.md` |
| ORCH-2 | P2 | UX | Customer · payment page | No booking reference or "awaiting payment" status while the checkout provider is unavailable | `logs/boarding-rerun.txt` |

### 6.3 Observations (not defects, decisions needed)
Decline offered only to commission providers; no training session seeded for switchable trainers (training execution untestable in UAT); no partner notifications/chat surface; completion + invoice + payout accrual happen while a pay-after-service payment is still `created`; job times follow device timezone (UTC devices show 05:30 for an 11:00 IST slot); arrival geofence is bypassed on sandbox/staging when no trusted fix exists; keyword classifier treats "staff/person/agent" in staff messages as a human-handoff request; BCC has no cancel/refund action; "Test transaction engine" banner on `/team` and `/crm`; Founder `/me` shows "No employee record linked".

### 6.4 UI/UX sweep summary (`findings/sweep.md`)
173 routes discovered from `app/`; 356 route × persona × viewport loads (desktop, Pixel 7, iPhone 14) across anonymous, customer, provider and founder; 287 buttons clicked in 41 dead-button passes; 124 links checked; 18 form probes. Result: 0 P0, 4 P1 (all covered above), 14 P2, 48 observations, 183 passes. No broken internal links, no uncaught page errors on customer/partner V2 surfaces, no horizontal overflow on `/mobile-app`, `/partner-app` or V2 pages on either phone viewport. Placeholder copy: only the word "placeholder" in the Revenue Mission page's own text. Console errors observed were the expected 401 identity probes plus the API failures listed above.

## 7. Remaining blockers before human UAT (ordered)

1. **Publish grooming packages in staging Pricing Control** (or verify already published) — otherwise `/v2/grooming` cannot book (P1-06). Then re-run the V2 grooming journey on staging.
2. **Fix the `lead_callbacks` schema collision** (migration 0021 vs `lead-callback-governance`) — `/crm` and `/team/daily-revenue` are dead on any D1 that received the migrations (P1-02).
3. **Provision the Finance persona**: either ship the MFA enrol/verify screens or pre-enrol the UAT finance identity; also grant finance a landing page (`/me` "Permission denied") (P1-01).
4. **Provision organisational scope for the seeded Manager** (P1-04).
5. **Gateway rule for `/api/grooming-payment-sandbox`**: allow providers' `request_after_service` (P1-05).
6. **Launch-readiness identity**: honour the UAT/platform session in `app/api/launch-readiness` (P1-03).
7. **Boarding stay panel copy**: derive payment wording from the payment row (P1-07).
8. **Employee AI error surfacing** after handoff / offline (P1-08); also the nav-tab overflow (AI-D02).
9. **Leave policy seed + 4xx validation**, payroll and time-page approval controls (P1-09/10/11).
10. **Wrong-OTP 500** and other 500-for-validation cases (SW-023, EMP-07, EMP-15).
11. **Environment gates to close on staging before the corresponding acceptance lines can pass:** Razorpay sandbox secrets (payment), `PAWSPACE_AI_PROVIDER_API_KEY` (real AI turn — currently optional and possibly unset), Workers AI binding + HTTPS origin (AI Voice: mic, start/stop, STT→AI→TTS, states), Google Maps UAT key (ETA/neighbourhood search).
12. **Run the "Automated human sweep (staging)" workflow on `a7124de`** (PR #940 adds the exact-SHA gate) so the staging environment itself, not only the same commit, carries browser evidence.

## 8. Method and limitations

- Ten personas were driven through real Chromium (Playwright) on desktop 1366×900, Pixel 7 (Android) and iPhone 14 (iOS) viewports by five parallel test lanes, each on an isolated copy of the seeded database; the orchestrator reproduced every P1 by hand with `curl`/Playwright and read the source for root causes.
- The staging host was unreachable from this sandbox; the deployed SHA was verified from the deploy workflow's own certification, and the tests ran on the identical commit. Anything that depends on Cloudflare-only bindings/secrets is marked env-gated rather than passed.
- Two harness artefacts were identified and excluded from findings: Playwright's request context not sending `Secure` cookies over `http://127.0.0.1`, and a rare wrangler "Network connection lost" proxy hiccup (one transient 500 on `/api/referral-governance`, not reproducible).
- Test data created during the run (customers `CUS-OTP-…`, bookings `PS-UAT-…`, lead `LEAD-1789888627246`, payroll run `PAYRUN-4C145650-F97`, pricing rule "QA weekend uplift", published `dog-basic` bundles) exists only in the local databases.
