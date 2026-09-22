# PawSpace V2 browser-test brief (shared by all test agents)

## What is under test
- Repo: /home/user/pawspace-tech-platform at commit a7124de52462f01e513569e64931db3c656ee9c1 (V2 baseline, identical to what the
  "Deploy staging" run #324 deployed to https://pawspace-staging.karthik-fce.workers.dev). The staging host is NOT reachable from
  this sandbox (egress policy), so we test the SAME SHA served locally by the built Cloudflare worker (wrangler dev --local, Miniflare D1).
- DO NOT modify any file inside the repo. Write scripts/evidence only under
  /tmp/claude-0/-home-user-pawspace-tech-platform/18394ca5-ebb5-5fb5-a302-921f060172cb/scratchpad (call it $S).
- Configuration mirrors staging: PAWSPACE_DEPLOYMENT_ENV=staging, payments SANDBOX (no Razorpay keys configured locally),
  UAT login on, OTP sandbox (code shown on screen), maps sandbox, voice env uat, NO Workers AI binding, NO AI provider key.
  When a feature is blocked by a missing local secret/binding, record it as "environment-gated" (not a defect) and say what staging needs.

## Servers (each agent has its OWN server + own copy of the seeded database; use only your assigned port)
- customer agent  -> http://127.0.0.1:8790
- partner agent   -> http://127.0.0.1:8791
- employee agent  -> http://127.0.0.1:8792
- AI agent        -> http://127.0.0.1:8793
- sweep agent     -> http://127.0.0.1:8794
Server logs: $S/servers/<name>/serve.log and wrangler.log. The database file: $S/servers/<name>/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite
(read-only inspection with node:sqlite is fine, e.g. to verify audit rows; never write to it).
Known harness artifact: wrangler's local proxy occasionally logs "Error inside ProxyWorker ... Network connection lost" and the browser
sees one 500. If a 500 does not reproduce on an immediate retry, classify it as "local harness flake", not an app defect.

## Seeded data (same packs the staging deploy/seed workflows load)
- Staff (sign in at /staging-login, or POST /api/staging-login {code,email}); access code: <local-uat-access-code>
  founder@pawspace.in (founder, all modules) · anjali.finance33@tkpetcare.in (finance) · jyoti.manager39@tkpetcare.in (manager)
  asha.groomer1@tkpetcare.in (service_provider employee; linked to provider uatcap_groom_ft) · anita.associate17@tkpetcare.in (associate)
  uat.demo.manager@tkpetcare.in · uat.demo.sales1@tkpetcare.in · uat.demo.sales2@tkpetcare.in (sales, on leaderboard/incentives)
  uat.demo.groomer@tkpetcare.in (linked to a real provider with jobs/earnings)
  The UI page /staging-login has quick buttons: "Founder (full access)", "Finance (payroll, GST, payouts)", "Manager (people & performance)",
  "Employee — groomer (self-service)", "Employee — sales associate"; or type any seeded email in the email field.
- Customers: OTP at /mobile-app (any 10-digit Indian number; the 6-digit sandbox code is printed on screen: "Sandbox code (no real SMS yet): NNNNNN").
  Existing seeded customer: phone 9800000111 -> E2E-CUS-UI-001 (pet Bruno, booking E2E-BK-UI-001). Demo customers UATD-CUS-1.. exist in CRM.
  A brand-new number creates a new customer (tests the new-customer path / welcome coupon).
- Partners: OTP at /partner-app (sandbox code on screen). Groomers 9000000901 (city-wide Grooming Team, most auto-assignments),
  9000000904 (South), 9000000903 (East), 9000000905 (North), 9000000906 (West), 9000000907 (Central). Trainers 9000000931..9000000936.
  /partner-app -> More -> "Switch UAT provider" lets you become any live seeded provider (host/sitter/walker/taxi) using the same access code.
- Provider roster covers all 5 Bengaluru zones for Grooming, Training, Boarding, Sitting, Walking, Taxi. Test PIN codes: 560038 (Indiranagar, East),
  560068 (BTM, South), 560001 (Central), 560024 (North), 560040 (West).

## Helpers
- $S/pw/helpers.mjs exports: launch(kind: desktop|android|iphone) -> {browser, context, evidence}, staffLogin(context,email),
  customerOtpLogin(context, phone, name), partnerOtpLogin(context, phone, name), shot(page, dir, name), shotDir(name), bodyText(page),
  controls(page) (lists visible buttons/links), report(file, data). Set PW_BASE=http://127.0.0.1:<your port> before importing.
  Chromium binary: /opt/pw-browsers/chromium-1194/chrome-linux/chrome (already wired in launch()). Run scripts with:
  cd $S/pw && PW_BASE=http://127.0.0.1:<port> node your-script.mjs
- /mobile-app first shows a "Choose your service location" welcome ([data-location-welcome]) that hides the bottom nav until a
  location/pincode is chosen; complete it first. The bottom nav has Home, Book, Activity, My Pets, Account and (staff only) "AI".
- Existing Playwright specs in /home/user/pawspace-tech-platform/e2e/ show working selectors for many flows (read them, don't run them).

## What to record for EVERY issue
Persona · URL/module · exact reproduction steps · expected · actual · evidence (screenshot path / response body / log line) ·
severity (P0 money/booking lost/crash, P1 flow blocked, P2 visual/copy) · class (UI, wiring, backend, data, auth, payment, partner, AI, infrastructure).
Also record what PASSED (flow, persona, viewport). Screenshots go under $S/evidence/<your-area>/. Write your final findings to
$S/findings/<your-area>.json (array of {id,title,persona,url,steps,expected,actual,evidence,severity,class,status:"defect"|"pass"|"env-gated"|"observation"})
and a human summary to $S/findings/<your-area>.md. Be exact and honest: only claim a pass for something you actually drove in the browser.
