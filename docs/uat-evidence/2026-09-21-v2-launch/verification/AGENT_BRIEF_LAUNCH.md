# PawSpace V2 launch-backlog verification pass (shared brief for all agents)

## What is under test
- Repo /home/user/pawspace-tech-platform, branch fix/v2-human-test-launch-20260921, commit ad4c56e864c8e361700e0aa4042ebe7d7e8430da
  (PR #960). The built Cloudflare worker (dist/server) for that exact commit is served locally by wrangler dev --local (Miniflare D1).
  The isolated staging host is NOT reachable from this sandbox; the same SHA is being deployed there by GitHub Actions in parallel.
- HARD RULES
  * A frozen full regression is running against the repo right now: DO NOT modify, create or delete ANY file inside the repo
    (no edits, no git commands that change the tree, no npm run build). Reading repo files is fine and encouraged.
  * Never kill, restart or rebuild servers. Use ONLY your assigned port. Never touch other agents' state directories.
  * Sandbox QA data only. No real payments, no real SMS/WhatsApp/calls/emails, no production URLs. Payments locally have NO Razorpay
    keys: /api/customer-checkout answers 503 "Razorpay test checkout is not configured" — that is an honest environment gate, not a defect.
  * Never print, copy or store any credential/JWT/session cookie value in findings, notes or screenshots. Do not read
    ~/.ccr or any *.tmp credential files. The local UAT access code below is local-only and must not appear in findings text.
  * Write scripts/evidence only under $S=/tmp/claude-0/-home-user-pawspace-tech-platform/18394ca5-ebb5-5fb5-a302-921f060172cb/scratchpad/launch/.
- Configuration mirrors staging: PAWSPACE_DEPLOYMENT_ENV=staging, payments sandbox without keys, UAT staff login on, customer/partner
  OTP sandbox (6-digit code printed on screen), maps sandbox, voice env uat with the local simulator transport, NO Workers AI binding,
  NO AI provider key (every AI turn hands off / refuses honestly: "environment-gated", not a defect, unless the refusal is hidden or a 500).

## Servers (own server + own seeded database per agent; state at $S/servers/<name>/state, logs serve.log / wrangler.log)
- customer agent  -> http://127.0.0.1:8790  (servers/lcustomer)
- partner agent   -> http://127.0.0.1:8791  (servers/lpartner)
- employee agent  -> http://127.0.0.1:8792  (servers/lemployee)
- AI/CRM agent    -> http://127.0.0.1:8793  (servers/lai)
Use http://127.0.0.1:<port> in the browser. NOTE: Secure cookies are not sent by Playwright's request context over http://127.0.0.1 —
use in-page fetch (page.evaluate(() => fetch(...))) for authenticated API probes, or http://localhost:<port> for request-context calls.
Known harness artifact: wrangler occasionally logs "Error inside ProxyWorker ... Network connection lost" and the browser sees one 500;
if it does not reproduce on an immediate retry classify it as "local harness flake". A deterministic 500 is a defect.
Database inspection (read-only, node:sqlite): $S/servers/<name>/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite (largest file, not metadata).

## Seeded data (same packs the staging deploy loads: scripts/employee-seed.sql + provider roster + demo customers)
- Staff sign-in: /staging-login (access code <LOCAL-UAT-ACCESS-CODE-REDACTED>, local only) then a quick button, or type an email.
  founder@pawspace.in (founder, everything) · anjali.finance33@tkpetcare.in (finance; privileged MFA: enrol at /mfa)
  jyoti.manager39@tkpetcare.in (manager, OPERATIONS scope: Booking Command Center, scheduling, People)
  sunita.manager37@tkpetcare.in (manager, SALES scope: CRM) · vishal.manager40@tkpetcare.in (manager, customer-experience scope: CRM)
  karthik.manager38@tkpetcare.in (manager, operations) · anita.associate17@tkpetcare.in (associate, /me self-service)
  asha.groomer1@tkpetcare.in (employee groomer linked to provider uatcap_groom_ft) · uat.demo.groomer@tkpetcare.in
  uat.demo.manager@tkpetcare.in · uat.demo.sales1@tkpetcare.in · uat.demo.sales2@tkpetcare.in (sales)
  API alternative: POST /api/staging-login {code,email}; cookie pawspace_uat. Roles are refused with governed 401/403 JSON.
- Customers: OTP at /mobile-app or /v2 (any 10-digit Indian number; sandbox code printed on screen "Sandbox code (no real SMS yet): NNNNNN").
  Seeded customer phone 9800000111 -> E2E-CUS-UI-001 (pet Bruno, booking E2E-BK-UI-001). A new number creates a new customer.
- Partners: OTP at /partner-app. Groomers 9000000901 (city-wide), 9000000904 (South), 9000000903 (East), 9000000905 (North),
  9000000906 (West), 9000000907 (Central). Trainers 9000000931..9000000936. /partner-app -> More -> "Switch UAT provider" becomes any
  seeded host/sitter/walker/taxi provider (same access code).
- Test PIN codes: 560038 (Indiranagar, East), 560068 (BTM, South), 560001 (Central), 560024 (North), 560040 (West).
- Grooming packages: if /api/v2/grooming-catalogue returns no packages on your database, publish dog-basic (+ bundles) as founder via
  PATCH /api/pricing-control {entity:"package", ..., changes:{active:1}, reason:"UAT publish"} — record that you did (staging needs it too).

## Helpers (reuse; they already point at the Chromium binary /opt/pw-browsers/chromium-1194/chrome-linux/chrome)
- $S/pw/helpers.mjs: launch(kind desktop|android|iphone) -> {browser, context, evidence}; staffLogin(context,email);
  customerOtpLogin(context, phone, name); partnerOtpLogin(context, phone, name); shot(page, dir, name); shotDir(name); bodyText(page);
  controls(page); report(file, data). Set PW_BASE=http://127.0.0.1:<port> and PW_OUT=$S/launch/evidence/<area> before importing.
  Run: cd $S/pw && PW_BASE=http://127.0.0.1:<port> PW_OUT=$S/launch/evidence/<area> node $S/launch/<area>/your-script.mjs
- $S/pw/partner-lib.mjs (partner mobile nav helpers), $S/pw/ai-common.mjs (Employee AI tab helpers), $S/pw/sweep-lib.mjs.
- Earlier scripts in $S/pw/*.mjs show working selectors for most flows; copy what you need into $S/launch/<area>/ rather than editing them.
- /mobile-app first shows "Choose your service location" ([data-location-welcome]); complete it before the bottom nav appears.

## Prior findings you must re-verify (a7124de phase; full records in $S/findings/<area>.json, summaries in $S/findings/<area>.md)
PR #960 (19 commits) claims fixes for many of them. For every prior finding in your area record one of:
  fixed-verified (you reproduced the fix in the browser) · still-open (defect, with fresh evidence) · environment-gated · owner-decision · not-retested (say why).

## What to record for EVERY issue and every pass
Persona · URL/module · exact reproduction steps · expected · actual · evidence (screenshot path / response body / DB row / log line) ·
severity (P0 money/booking lost/crash, P1 flow blocked, P2 visual/copy/degraded, P3 minor) · class (UI, wiring, backend, data, auth,
payment, partner, AI, infrastructure). Only claim a pass for something you actually drove (browser -> API -> durable data -> downstream).
Test negative, retry, replay and ownership boundaries as well as happy paths. Never fabricate policy (e.g. Sitting Meet & Greet pricing
is an owner decision — record it as such). Placeholder/synthetic documents are not real uploads (say objectStored=false when it is).
Output files (write them, they are the deliverable):
  $S/launch/findings/<area>.json  — array of {id,title,persona,url,steps,expected,actual,evidence,severity,class,
                                    status:"defect"|"pass"|"env-gated"|"owner-decision"|"fixed-verified"|"still-open", priorId?}
  $S/launch/findings/<area>.md    — human summary: what passed, what failed, environment gates, owner decisions, untested controls
  $S/launch/findings/<area>-matrix.csv — per-screen/per-role matrix: screen,role,action,outcome,durable_data,evidence,untested_controls
Screenshots: $S/launch/evidence/<area>/. Keep final report under ~150 lines; the JSON carries detail.
