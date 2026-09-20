# UI/UX sweep — PawSpace V2 (commit a7124de, local worker http://127.0.0.1:8794)

Generated 2026-09-20T07:40:50.187Z. Evidence under $S/evidence/sweep; raw data under $S/sweep (repo sweep) and $S/sweep/crawl (own crawler). $S = /tmp/claude-0/-home-user-pawspace-tech-platform/18394ca5-ebb5-5fb5-a302-921f060172cb/scratchpad

## Summary

- Part A (scripts/screen-sweep.mjs): 173 routes discovered from app/; runs: anon 99/173, customer 173/173, provider 173/173, founder 143/173 (a run short of 173 was still in progress at report time — see coverage gaps).
- Part B (own crawler): 424 route×persona×viewport loads over 167 routes; 62 dead-button passes (394 buttons clicked); 124 unique links checked; 18 form probes.
- Defects: P0 0 · P1 4 · P2 12; observations 45; passes 183.

## Part A — repo screen sweep (scripts/screen-sweep.mjs), verdict per persona

Legend: OK usable · OK* rendered but an expected-refusal API (401 customer-account / 403 mobile-employee-ai) was logged · GATED(403) the persona lacks the role, page refused correctly · DATA an API it calls failed · BLANK/THIN nothing/only a header · BROKEN/MISSING · OK~ rendered but network never settled within the timeout (shared-box load, see coverage gaps) · FIXTURE sampled id missing · — not run.

| route | anon | customer | provider | founder |
|---|---|---|---|---|
| / | OK* | OK | OK* | OK* |
| /about | GATED | OK | OK | OK~ |
| /account | DATA | OK* | GATED(403) | OK~ |
| /admin | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /assisted-booking | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /boarding | OK* | OK | OK* | OK* |
| /boarding/manage | GATED | OK | OK | OK~ |
| /booking-command-center | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /business | GATED | OK | OK | OK~ |
| /careers | GATED | OK | OK | OK~ |
| /chat | GATED | OK | OK | OK~ |
| /contact | GATED | OK | OK | OK~ |
| /control | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /control/appearance | GATED | OK | OK | OK~ |
| /control/integrations | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /control/provider-onboarding | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /crm | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /discover | GATED | OK | OK | OK~ |
| /dog-breeds/labrador-retriever | GATED | OK | OK | OK~ |
| /driver | GATED | OK | OK | OK~ |
| /driver/proof | GATED | OK | OK | OK~ |
| /driver/recovery | GATED | OK | OK | OK~ |
| /food | OK* | OK | GATED(403) | OK* |
| /food/manage | GATED | OK | OK | OK~ |
| /food/subscription-invoice | GATED | OK | OK | OK~ |
| /food/subscription-payment | GATED | OK | OK | OK~ |
| /food/subscriptions | GATED | OK | OK | OK~ |
| /funeral-memorial | OK* | OK | GATED(403) | OK* |
| /groomer | GATED | OK | OK~ | OK~ |
| /grooming | GATED | OK | OK | OK~ |
| /grooming/manage | GATED | OK | OK | OK~ |
| /host | GATED(403) | GATED(403) | OK | OK~ |
| /host/proof | GATED | OK | OK | OK~ |
| /landing-pages | GATED | OK | OK | OK~ |
| /landing-pages/grooming | FIXTURE | FIXTURE | FIXTURE | FIXTURE |
| /leaderboard | GATED(403) | GATED(403) | OK | OK~ |
| /legal/data-processing | GATED | OK | OK | OK~ |
| /legal/privacy | GATED | OK | OK | OK~ |
| /legal/terms | GATED | OK | OK | OK~ |
| /locations/bengaluru/hsr-layout/pet-grooming | GATED | OK | OK | OK~ |
| /me | GATED(403) | GATED(403) | OK | OK~ |
| /mobile-app | DATA | OK* | GATED(403) | OK~ |
| /mobile-app/booking-confirmation | GATED | OK | OK | OK~ |
| /ops | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /partner | GATED | OK | OK | OK~ |
| /partner-app | GATED | OK | OK~ | OK~ |
| /partner-mobile | GATED | OK | OK~ | OK~ |
| /partner/funeral | GATED(403) | GATED(403) | DATA | OK~ |
| /partner/jobs | GATED(403) | GATED(403) | OK | OK~ |
| /partner/onboarding | GATED | OK | OK | OK~ |
| /partner/rates | GATED(403) | GATED(403) | DATA | DATA |
| /partner/workspace | GATED(403) | GATED(403) | OK | OK~ |
| /platform-api | GATED | OK | OK | OK~ |
| /prelaunch | GATED | OK | OK | OK~ |
| /prelaunch/layer2-swarm | GATED | OK | OK | OK~ |
| /regression-lab | GATED | OK | OK | OK~ |
| /relocation | OK* | OK | OK* | OK* |
| /relocation-enquiry | GATED | OK | OK | OK~ |
| /services | GATED | OK | OK | OK~ |
| /services/grooming | GATED | OK | OK | OK~ |
| /sitter | GATED | OK | OK | OK~ |
| /sitter/proof | GATED | OK | OK | OK~ |
| /sitting | OK* | OK | OK* | OK* |
| /sitting/manage | GATED | OK | OK | OK~ |
| /staging-login | GATED | OK | OK | OK~ |
| /system-integration | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /taxi | OK* | OK | OK* | OK* |
| /taxi/manage | GATED | OK | OK | OK~ |
| /team | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/acquisition-funnel | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/ai | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/ai/analytics | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/ai/configuration | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/ai/handoff | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/ai/rollout | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/alerts | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/analytics | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/bot-call-outcomes | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/cases | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/catalogue | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/customer-experience | GATED(403) | GATED(403) | GATED(403) | DATA |
| /team/customer-reminders | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/daily-revenue | GATED(403) | GATED(403) | GATED(403) | DATA |
| /team/finance | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance-compliance | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance/cash-flow | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance/food | GATED | OK | OK | OK~ |
| /team/finance/funeral-memorial | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance/partners | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance/relocation | GATED | OK | OK | OK~ |
| /team/finance/sitting | GATED | OK | OK | OK~ |
| /team/finance/statutory | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance/taxi | GATED | OK | OK | OK~ |
| /team/finance/training | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance/unit-economics | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/finance/walking | GATED | OK | OK | OK~ |
| /team/funeral-memorial | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/haptik | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/i18n | GATED(403) | GATED(403) | GATED(403) | OK~ |
| /team/lifecycle-reminders | — | GATED(403) | GATED(403) | OK~ |
| /team/marketing | — | GATED(403) | GATED(403) | OK~ |
| /team/marketing/content | — | GATED(403) | GATED(403) | OK~ |
| /team/meet-and-greet | — | GATED(403) | GATED(403) | OK~ |
| /team/operations | — | OK | OK | OK~ |
| /team/operations/boarding | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/bookings | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/food | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/food/fulfilment | — | OK | OK | OK~ |
| /team/operations/food/proof | — | OK | OK | OK~ |
| /team/operations/food/supply-chain | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/sitting | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/taxi | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/training | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/walking | — | GATED(403) | GATED(403) | OK~ |
| /team/operations/work-queue | — | GATED(403) | GATED(403) | OK~ |
| /team/people | — | GATED(403) | GATED(403) | OK~ |
| /team/people/finance | — | GATED(403) | GATED(403) | OK~ |
| /team/people/incentives | — | GATED(403) | GATED(403) | OK~ |
| /team/people/manager-dashboard | — | GATED(403) | GATED(403) | OK~ |
| /team/people/onboarding | — | GATED(403) | GATED(403) | OK~ |
| /team/people/payroll | — | GATED(403) | GATED(403) | OK~ |
| /team/people/provider-training | — | GATED(403) | OK | OK~ |
| /team/people/reports | — | GATED(403) | GATED(403) | OK~ |
| /team/people/service-incentives | — | OK | OK | OK~ |
| /team/people/time | — | GATED(403) | GATED(403) | OK~ |
| /team/performance | — | GATED(403) | GATED(403) | OK~ |
| /team/pricing-rules | — | GATED(403) | GATED(403) | OK~ |
| /team/provider-onboarding | — | GATED(403) | GATED(403) | OK~ |
| /team/provider-verification | — | GATED(403) | GATED(403) | OK~ |
| /team/relocation | — | GATED(403) | GATED(403) | OK~ |
| /team/relocation-enquiries | — | GATED(403) | GATED(403) | OK~ |
| /team/revenue-mission | — | GATED(403) | GATED(403) | OK~ |
| /team/sales | — | GATED(403) | GATED(403) | OK~ |
| /team/sales/cross-sell | — | GATED(403) | GATED(403) | OK~ |
| /team/sales/power-dialler | — | GATED(403) | GATED(403) | OK~ |
| /team/scheduling | — | GATED(403) | GATED(403) | OK~ |
| /team/subscription-plans | — | GATED(403) | GATED(403) | OK~ |
| /team/subscriptions | — | OK | OK | OK~ |
| /team/voice | — | GATED(403) | GATED(403) | OK~ |
| /team/voice/ai-test | — | GATED(403) | GATED(403) | OK~ |
| /team/whatsapp/analytics | — | GATED(403) | GATED(403) | OK~ |
| /team/whatsapp/automation | — | GATED(403) | GATED(403) | OK~ |
| /team/whatsapp/templates | — | GATED(403) | GATED(403) | OK~ |
| /test-lab | — | OK | OK | — |
| /trainer | — | OK | OK | — |
| /training | — | OK | OK* | — |
| /v2 | — | OK | OK | — |
| /v2/account | — | OK | OK | — |
| /v2/activity | — | OK | OK | — |
| /v2/boarding | — | OK | GATED(403) | — |
| /v2/chat | — | OK | OK | — |
| /v2/control-center | — | GATED(403) | GATED(403) | — |
| /v2/crm | — | GATED(403) | GATED(403) | — |
| /v2/food | — | OK | GATED(403) | — |
| /v2/food/manage | — | OK | OK | — |
| /v2/food/subscription-invoice | — | OK | OK | — |
| /v2/food/subscription-payment | — | OK | OK | — |
| /v2/food/subscriptions | — | OK | OK | — |
| /v2/grooming | — | OK | GATED(403) | — |
| /v2/partner | — | OK | OK~ | — |
| /v2/relocation | — | OK | GATED(403) | — |
| /v2/sitting | — | OK | GATED(403) | — |
| /v2/taxi | — | OK | GATED(403) | — |
| /v2/taxi/manage | — | OK | OK | — |
| /v2/training | — | OK | GATED(403) | — |
| /v2/walking | — | OK | GATED(403) | — |
| /v2/walking/manage | — | OK | OK | — |
| /v2/workspaces | — | OK | OK | — |
| /walker | — | OK | OK | — |
| /walker/proof | — | OK | OK | — |
| /walker/recovery | — | OK | OK | — |
| /walking | — | OK | OK* | — |
| /walking/manage | — | OK | OK | — |

### Part A — routes not OK (with excerpt)

**founder** (3 not OK; 0 gated by role as expected; 132 rendered-but-slow)

- DATA /partner/rates — API 400 /api/provider-service-rates
- DATA /team/customer-experience — API 409 /api/whatsapp/conversation-control?threadId=THREAD-BOOKING-PS-UAT-TAXI-MU9I73T4-1124 — "OPERATIONS ⌂ Overview ▦ Operations ▤ Day board ◉ CX queue ◆ Cases ◈ Reminders ⌾ Meet & greet ▣ Subscriptions ▲ Performance ◐ Marketing ☗ People ₹ Finance ◎ Anal"
- DATA /team/daily-revenue — API 500 /api/revenue-crm — "← Team PAWSPACE · DAILY REVENUE PRIORITY Today's prioritised revenue opportunities Real customer scoring, real open inbound leads and real subscription renewals"

**customer** (0 not OK; 83 gated by role as expected; 0 rendered-but-slow)


**provider** (2 not OK; 87 gated by role as expected; 4 rendered-but-slow)

- DATA /partner/funeral — API 403 /api/funeral-memorial — "Partner FUNERAL / MEMORIAL COORDINATION · UAT Assigned service requests Use confirmed milestones only. Customer calling and external messaging remain dependent "
- DATA /partner/rates — API 403 /api/provider-service-rates — "PAWSPACE PARTNER · PRICING Set your Boarding & Sitting rates PawSpace sets the minimum. Eligible commission partners may compete above it. Full-time team member"

**anon** (2 not OK; 89 gated by role as expected; 0 rendered-but-slow)

- DATA /account — API 401 /api/mobile-employee-ai
- DATA /mobile-app — API 401 /api/mobile-employee-ai

## Part B — own crawler, verdict per persona × viewport

Columns: D desktop 1366×900 · A Pixel 7 · I iPhone 14. Flags: OVF horizontal overflow · CTA primary control covered by fixed element · PH placeholder copy · LOAD still loading after 10s · DEAD n dead buttons (after removing already-active tabs) · A11Y n unnamed icon buttons · ERR console/page errors · TAB tab click failed.

| route | customer D/A/I | provider D/A/I | founder D/A/I | anon D/A/I | flags |
|---|---|---|---|---|---|
| / | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /about | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /account | OK~/OK~/OK~ | ·/·/· | ·/·/· | ·/OK~/· |  |
| /admin | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /assisted-booking | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /boarding | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /boarding/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /booking-command-center | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /business | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /careers | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /chat | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /contact | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /control | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· | ERR |
| /control/appearance | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /control/integrations | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /control/provider-onboarding | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /crm | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· | ERR |
| /discover | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /dog-breeds/labrador-retriever | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /driver | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /driver/proof | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /driver/recovery | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /food | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /food/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /food/subscriptions | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /funeral-memorial | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /groomer | ·/·/· | OK~/·/OK~ | ·/·/· | ·/OK~/· |  |
| /grooming | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /grooming/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /host | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /host/proof | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /landing-pages | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /leaderboard | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /legal/data-processing | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /legal/privacy | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /legal/terms | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /locations/bengaluru/hsr-layout/pet-grooming | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /me | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /mobile-app | OK~/OK~/OK~ | ·/·/· | ·/·/· | ·/OK~/· |  |
| /mobile-app/booking-confirmation | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /mobile-app#tab=Account | OK~/OK~/OK~ | ·/·/· | ·/·/· | ·/OK~/· | A11Y 1 |
| /mobile-app#tab=Activity | OK~/OK~/OK~ | ·/·/· | ·/·/· | ·/OK~/· |  |
| /mobile-app#tab=Book | OK~/OK~/OK~ | ·/·/· | ·/·/· | ·/OK~/· |  |
| /mobile-app#tab=My Pets | OK~/OK~/OK~ | ·/·/· | ·/·/· | ·/OK~/· |  |
| /ops | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /partner | ·/·/· | OK/OK/OK | ·/·/· | ·/OK~/· |  |
| /partner-app | ·/·/· | OK~/OK~/OK~ | ·/·/· | ·/OK~/· |  |
| /partner-app#tab=Earnings | ·/·/· | OK~/OK~/OK~ | ·/·/· | ·/OK~/· |  |
| /partner-app#tab=GPS | ·/·/· | OK~/OK~/OK~ | ·/·/· | ·/OK~/· |  |
| /partner-app#tab=Jobs | ·/·/· | OK~/OK~/OK~ | ·/·/· | ·/OK~/· |  |
| /partner-app#tab=More | ·/·/· | OK~/OK~/OK~ | ·/·/· | ·/OK~/· |  |
| /partner-mobile | ·/·/· | OK~/OK~/OK~ | ·/·/· | ·/OK~/· |  |
| /partner/funeral | ·/·/· | DATA/DATA/DATA | ·/·/· | ·/OK~/· |  |
| /partner/jobs | ·/·/· | OK/OK/OK | ·/·/· | ·/OK~/· |  |
| /partner/onboarding | ·/·/· | OK/OK/OK | ·/·/· | ·/OK~/· |  |
| /partner/rates | ·/·/· | DATA/DATA/DATA | ·/·/· | ·/OK~/· |  |
| /partner/workspace | ·/·/· | OK/OK/OK | ·/·/· | ·/OK~/· |  |
| /relocation | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /relocation-enquiry | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /services | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· |  |
| /services/grooming | ·/·/· | ·/·/· | ·/·/· | OK~/OK~/· | PH |
| /sitter | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /sitter/proof | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /sitting | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /sitting/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /staging-login | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /taxi | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· | CTA |
| /taxi/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /team | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/acquisition-funnel | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/ai | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/ai/analytics | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/ai/configuration | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/ai/handoff | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/ai/rollout | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/alerts | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/analytics | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/bot-call-outcomes | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/cases | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/catalogue | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/customer-experience | ·/·/· | ·/·/· | DATA/OK~/· | ·/·/· | ERR |
| /team/customer-reminders | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/daily-revenue | ·/·/· | ·/·/· | DATA/DATA/· | ·/·/· | ERR |
| /team/finance | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance-compliance | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/cash-flow | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/food | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/funeral-memorial | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/partners | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/relocation | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/sitting | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/statutory | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/taxi | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/training | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/unit-economics | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/finance/walking | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/funeral-memorial | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/haptik | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/i18n | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/lifecycle-reminders | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/marketing | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/marketing/content | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/meet-and-greet | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/boarding | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/bookings | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/food | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/food/fulfilment | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/food/proof | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/food/supply-chain | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/sitting | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/taxi | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/training | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/walking | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/operations/work-queue | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/finance | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/incentives | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/manager-dashboard | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/onboarding | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/payroll | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/provider-training | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/reports | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/service-incentives | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/people/time | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/performance | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/pricing-rules | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/provider-onboarding | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/provider-verification | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/relocation | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/relocation-enquiries | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/revenue-mission | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· | PH |
| /team/sales | ·/·/· | ·/·/· | OK~/OK~/· | ·/·/· |  |
| /team/sales/cross-sell | ·/·/· | ·/·/· | OK~/·/· | ·/·/· |  |
| /team/sales/power-dialler | ·/·/· | ·/·/· | OK~/·/· | ·/·/· |  |
| /team/scheduling | ·/·/· | ·/·/· | OK~/·/· | ·/·/· |  |
| /team/subscription-plans | ·/·/· | ·/·/· | OK~/·/· | ·/·/· |  |
| /team/subscriptions | ·/·/· | ·/·/· | OK~/·/· | ·/·/· |  |
| /trainer | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /training | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2 | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/account | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· | CTA |
| /v2/activity | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/boarding | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/chat | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/control-center | G403/G403/G403 | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/crm | G403/G403/G403 | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/food | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/food/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/food/subscription-invoice | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/food/subscription-payment | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/food/subscriptions | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/grooming | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/partner | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/relocation | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/sitting | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/taxi | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· | CTA |
| /v2/taxi/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/training | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/walking | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/walking/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /v2/workspaces | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |
| /walker | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /walker/proof | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /walker/recovery | ·/·/· | OK/·/OK | ·/·/· | ·/OK~/· |  |
| /walking | ·/·/· | ·/·/· | ·/·/· | ·/OK~/· |  |
| /walking/manage | OK/OK/OK | ·/·/· | ·/·/· | ·/OK~/· |  |

## Defects

| id | sev | class | title | persona | evidence |
|---|---|---|---|---|---|
| SW-007 | P1 | backend | 500 from /api/revenue-crm while loading /team/daily-revenue | founder/android, founder/desktop | $S/evidence/sweep/team-daily-revenue-founder-android.png |
| SW-008 | P1 | backend | 500 from /api/revenue-crm while loading /crm | founder/desktop | $S/evidence/sweep/crm-founder-desktop.png |
| SW-009 | P1 | auth | 401 from /api/launch-readiness for founder on /control | founder/desktop | $S/evidence/sweep/control-founder-desktop.png |
| SW-010 | P1 | backend | 500 from /api/subscription-business-view while loading /control | founder/desktop | $S/evidence/sweep/control-founder-desktop.png |
| SW-001 | P2 | UI | 403 from /api/provider-service-rates for provider on /partner/rates | provider/android, provider/desktop, provider/iphone | $S/evidence/sweep/partner-rates-provider-android.png |
| SW-002 | P2 | UI | 403 from /api/funeral-memorial for provider on /partner/funeral | provider/android, provider/desktop, provider/iphone | $S/evidence/sweep/partner-funeral-provider-android.png |
| SW-012 | P2 | UI | Buttons squeezed into a narrow vertical column on phone: /control/integrations (android) | founder/android | $S/evidence/sweep/control-integrations-founder-android.png |
| SW-013 | P2 | UI | Buttons squeezed into a narrow vertical column on phone: /team/finance/statutory (android) | founder/android | $S/evidence/sweep/team-finance-statutory-founder-android.png |
| SW-014 | P2 | UI | Buttons squeezed into a narrow vertical column on phone: /team/finance/training (android) | founder/android | $S/evidence/sweep/team-finance-training-founder-android.png |
| SW-017 | P2 | wiring | Guests on customer/partner pages are told 'Your staging sign-in has expired. Open /staging-login to sign in again' (staff copy) | anon/android (also seen provider on /v2/grooming) | $S/evidence/sweep/v2-grooming-anon-android.png |
| SW-018 | P2 | UI | 'Report an issue' support sheet: Submit report button is covered by the fixed 'Privacy choices' cookie banner; appearance FAB overlaps the description field | customer/android | $S/evidence/sweep/form-support-open.png |
| SW-019 | P2 | UI | /v2/taxi and /taxi on phone: sticky price bar squeezes the 'Create canonical UAT trip →' CTA into a 4-character column and the appearance FAB overlaps it | anon/android (bar layout independent of session) | $S/evidence/sweep/v2-taxi-anon-android.png |
| SW-020 | P2 | UI | Two floating action buttons overlap at the bottom-right of the customer app (◇ over ◐ appearance) | customer/android | $S/evidence/sweep/dead-mobile-app-tab-Activity-customer-android-root-1.png |
| SW-021 | P2 | UI | V2 customer shell on phone: the ◇ and ◐ floating buttons sit on top of the bottom navigation and cover the 'Account' tab | customer/android | $S/evidence/sweep/v2-customer-android.png |
| SW-022 | P2 | UI | /control/integrations on phone: sub-navigation pills overlap ('Integration readiness' drawn over 'Launch essentials' and 'Legacy system'); register cards render in a faded state | founder/android | $S/evidence/sweep/control-integrations-founder-android.png |
| SW-023 | P2 | backend | OTP verify with a wrong or unknown code answers HTTP 500 (customer and partner) and logs an api_failure error on every mistyped code | anon/android (UI) + curl | $S/evidence/sweep/form-otp-wrongcode.png |
| SW-015 | P2 (obs) | UI | Fixed element covers primary control: <div>Bengaluru East · medium UAT route · ₹0 due now · Maps n | anon/android, customer/android | $S/evidence/sweep/v2-taxi-anon-android.png |
| SW-016 | P2 (obs) | UI | Fixed element covers primary control: <a href="/v2"><strong>⌂</strong>Home</a> | customer/android | $S/evidence/sweep/v2-account-customer-android.png |

### Defect detail

**SW-007 · P1 · backend · defect** — 500 from /api/revenue-crm while loading /team/daily-revenue
- Persona: founder/android, founder/desktop
- URL: http://127.0.0.1:8794/team/daily-revenue
- Steps: Open http://127.0.0.1:8794/team/daily-revenue as founder (android) → page calls GET /api/revenue-crm
- Expected: 2xx
- Actual: 500 body: {"error":"Unable to load Revenue CRM engine"}
- Evidence: $S/evidence/sweep/team-daily-revenue-founder-android.png, $S/evidence/sweep/team-daily-revenue-founder-desktop.png
- Note: Deterministic: curl GET with the founder cookie reproduced 500 {"error":"Unable to load Revenue CRM engine"} 2/2; also seen on /crm (desktop) and /team/daily-revenue (desktop + Pixel 7). /team/daily-revenue shows the red banner and an empty prioritised list. All 7 tables the route queries exist in D1; the route's catch swallows the real error (authError redacts), so the cause is not in the log — needs server-side logging to diagnose.

**SW-008 · P1 · backend · defect** — 500 from /api/revenue-crm while loading /crm
- Persona: founder/desktop
- URL: http://127.0.0.1:8794/crm
- Steps: Open http://127.0.0.1:8794/crm as founder (desktop) → page calls GET /api/revenue-crm
- Expected: 2xx
- Actual: 500 body: {"error":"Unable to load Revenue CRM engine"}
- Evidence: $S/evidence/sweep/crm-founder-desktop.png
- Note: Deterministic: curl GET with the founder cookie reproduced 500 {"error":"Unable to load Revenue CRM engine"} 2/2; also seen on /crm (desktop) and /team/daily-revenue (desktop + Pixel 7). /team/daily-revenue shows the red banner and an empty prioritised list. All 7 tables the route queries exist in D1; the route's catch swallows the real error (authError redacts), so the cause is not in the log — needs server-side logging to diagnose.

**SW-009 · P1 · auth · defect** — 401 from /api/launch-readiness for founder on /control
- Persona: founder/desktop
- URL: http://127.0.0.1:8794/control
- Steps: Sign in as founder → Open http://127.0.0.1:8794/control (desktop) → page calls GET /api/launch-readiness
- Expected: founder should be authorised for this page's data
- Actual: 401 body: {"error":"Unable to load launch readiness"}; page text: "Platform Control GOVERN · SECURE · SCALE OWNER WORKSPACE PawSpace India Live governed controls ⌂ Control tower ◎ Launch essentials ⛓ Custome"
- Evidence: $S/evidence/sweep/control-founder-desktop.png
- Note: Deterministic: curl GET with the founder cookie reproduced 401 {"error":"Unable to load launch readiness"} 2/2 although the founder holds launch.view (api-gateway maps GET /api/launch-readiness -> launch.view). authError() turned an inner 4xx Response into a 401 with a generic message, so the real cause (a nested authorize/actor call or a governed sub-check) is hidden; the Control tower's launch section cannot load for the founder.

**SW-010 · P1 · backend · defect** — 500 from /api/subscription-business-view while loading /control
- Persona: founder/desktop
- URL: http://127.0.0.1:8794/control
- Steps: Open http://127.0.0.1:8794/control as founder (desktop) → page calls GET /api/subscription-business-view
- Expected: 2xx
- Actual: 500 body: {"error":"Unable to load subscription business view"}
- Evidence: $S/evidence/sweep/control-founder-desktop.png
- Note: Deterministic: curl GET with the founder cookie reproduced 500 {"error":"Unable to load subscription business view"} 2/2. /control still renders its other cards.

**SW-001 · P2 · UI · defect** — 403 from /api/provider-service-rates for provider on /partner/rates
- Persona: provider/android, provider/desktop, provider/iphone
- URL: http://127.0.0.1:8794/partner/rates
- Steps: Sign in as provider → Open http://127.0.0.1:8794/partner/rates (android) → page calls GET /api/provider-service-rates
- Expected: provider should be authorised for this page's data
- Actual: 403 body: {"error":"Permission denied"}; page text: "PAWSPACE PARTNER · PRICING Set your Boarding & Sitting rates PawSpace sets the minimum. Eligible commission partners may compete above it. F"
- Evidence: $S/evidence/sweep/partner-rates-provider-android.png, $S/evidence/sweep/partner-rates-provider-desktop.png, $S/evidence/sweep/partner-rates-provider-iphone.png
- Note: By design for a full-time groomer (not a commission boarding/sitting or funeral partner), but the page renders the raw API error text "Permission denied" above its own explanatory empty state — the red error banner should not be shown for an ineligible-but-valid provider.

**SW-002 · P2 · UI · defect** — 403 from /api/funeral-memorial for provider on /partner/funeral
- Persona: provider/android, provider/desktop, provider/iphone
- URL: http://127.0.0.1:8794/partner/funeral
- Steps: Sign in as provider → Open http://127.0.0.1:8794/partner/funeral (android) → page calls GET /api/funeral-memorial
- Expected: provider should be authorised for this page's data
- Actual: 403 body: {"error":"Permission denied"}; page text: "Partner FUNERAL / MEMORIAL COORDINATION · UAT Assigned service requests Use confirmed milestones only. Customer calling and external messagi"
- Evidence: $S/evidence/sweep/partner-funeral-provider-android.png, $S/evidence/sweep/partner-funeral-provider-desktop.png, $S/evidence/sweep/partner-funeral-provider-iphone.png
- Note: By design for a full-time groomer (not a commission boarding/sitting or funeral partner), but the page renders the raw API error text "Permission denied" above its own explanatory empty state — the red error banner should not be shown for an ineligible-but-valid provider.

**SW-012 · P2 · UI · defect** — Buttons squeezed into a narrow vertical column on phone: /control/integrations (android)
- Persona: founder/android
- URL: http://127.0.0.1:8794/control/integrations
- Steps: Open /control/integrations as founder on android → look at the action buttons
- Expected: Buttons wrap onto their own row at phone width
- Actual: Buttons rendered ~30px wide and 100-500px tall (text broken per character): Update (12x144); Update (12x144); Update (12x144); Update (12x144); Update (12x144); Update (12x144); Update (12x144); Update (12x144)
- Evidence: $S/evidence/sweep/control-integrations-founder-android.png

**SW-013 · P2 · UI · defect** — Buttons squeezed into a narrow vertical column on phone: /team/finance/statutory (android)
- Persona: founder/android
- URL: http://127.0.0.1:8794/team/finance/statutory
- Steps: Open /team/finance/statutory as founder on android → look at the action buttons
- Expected: Buttons wrap onto their own row at phone width
- Actual: Buttons rendered ~30px wide and 100-500px tall (text broken per character): Refresh (37x278)
- Evidence: $S/evidence/sweep/team-finance-statutory-founder-android.png

**SW-014 · P2 · UI · defect** — Buttons squeezed into a narrow vertical column on phone: /team/finance/training (android)
- Persona: founder/android
- URL: http://127.0.0.1:8794/team/finance/training
- Steps: Open /team/finance/training as founder on android → look at the action buttons
- Expected: Buttons wrap onto their own row at phone width
- Actual: Buttons rendered ~30px wide and 100-500px tall (text broken per character): Refresh (36x278); Issue UAT invoice (30x322); Issue UAT invoice (30x322); Issue UAT invoice (30x322); Approve sandbox instruction (30x524)
- Evidence: $S/evidence/sweep/team-finance-training-founder-android.png

**SW-017 · P2 · wiring · defect** — Guests on customer/partner pages are told 'Your staging sign-in has expired. Open /staging-login to sign in again' (staff copy)
- Persona: anon/android (also seen provider on /v2/grooming)
- URL: /v2/grooming, /v2/boarding, /v2/sitting, /v2/relocation, /v2/taxi, /training, /boarding, /sitting, /host, /partner/jobs, /partner/workspace, /partner/rates, /partner/funeral
- Steps: Open any of these URLs in a fresh browser (no session) → read the error/empty state
- Expected: A customer sign-in prompt (OTP) on customer pages and a partner sign-in prompt on partner pages
- Actual: API answers 401 {"code":"sign_in_required","signInUrl":"/staging-login"} and the page renders that message verbatim: '/v2/grooming: We can’t begin this booking yet. Your staging sign-in has expired. Open /staging-login to sign in again.' The staff UAT login is the wrong destination for a customer or partner.
- Evidence: $S/evidence/sweep/v2-grooming-anon-android.png, $S/evidence/sweep/v2-taxi-anon-android.png

**SW-018 · P2 · UI · defect** — 'Report an issue' support sheet: Submit report button is covered by the fixed 'Privacy choices' cookie banner; appearance FAB overlaps the description field
- Persona: customer/android
- URL: http://127.0.0.1:8794/mobile-app (Account tab → 24/7 help & support)
- Steps: Sign in as customer 9800000111 on Pixel 7 → Account tab → '24/7 help & support' → try to tap 'Submit report'
- Expected: Bottom sheet renders above the consent banner and the floating button; primary CTA tappable
- Actual: The cookie banner (Privacy choices / Essential only / Accept optional) sits on top of the sheet's Submit button (Playwright click timed out: element intercepts pointer events) and the ◇ floating button overlaps the textarea
- Evidence: $S/evidence/sweep/form-support-open.png

**SW-019 · P2 · UI · defect** — /v2/taxi and /taxi on phone: sticky price bar squeezes the 'Create canonical UAT trip →' CTA into a 4-character column and the appearance FAB overlaps it
- Persona: anon/android (bar layout independent of session)
- URL: http://127.0.0.1:8794/v2/taxi
- Steps: Open /v2/taxi on Pixel 7 → scroll to the sticky summary bar
- Expected: Readable CTA on one line; no overlap
- Actual: Three-column sticky bar: price text, status text and the CTA share 360px; CTA wraps per syllable ('Crea te cano nical UAT trip'); the ◐ floating button sits on the CTA
- Evidence: $S/evidence/sweep/v2-taxi-anon-android.png

**SW-020 · P2 · UI · defect** — Two floating action buttons overlap at the bottom-right of the customer app (◇ over ◐ appearance)
- Persona: customer/android
- URL: http://127.0.0.1:8794/mobile-app (Activity and Account tabs)
- Steps: Sign in as customer on Pixel 7 → Activity tab, Account tab
- Expected: Floating buttons do not stack on each other
- Actual: The ◇ FAB is drawn on top of the ◐ appearance FAB at the same corner (visible in screenshot)
- Evidence: $S/evidence/sweep/dead-mobile-app-tab-Activity-customer-android-root-1.png, $S/evidence/sweep/mobile-app-tab-Account-customer-android.png

**SW-021 · P2 · UI · defect** — V2 customer shell on phone: the ◇ and ◐ floating buttons sit on top of the bottom navigation and cover the 'Account' tab
- Persona: customer/android
- URL: http://127.0.0.1:8794/v2
- Steps: Sign in as customer 9800000111 on Pixel 7 → open /v2 → look at the bottom nav
- Expected: Floating buttons clear the bottom navigation; every tab fully visible and tappable
- Actual: The ◇ FAB is drawn over the right end of the nav ('Ac…' visible only) with the ◐ appearance FAB stacked above it
- Evidence: $S/evidence/sweep/v2-customer-android.png

**SW-022 · P2 · UI · defect** — /control/integrations on phone: sub-navigation pills overlap ('Integration readiness' drawn over 'Launch essentials' and 'Legacy system'); register cards render in a faded state
- Persona: founder/android
- URL: http://127.0.0.1:8794/control/integrations
- Steps: Sign in as founder → open /control/integrations on Pixel 7
- Expected: Sub-nav wraps or scrolls horizontally; card text at normal contrast
- Actual: Nav items are absolutely stacked on one line and overlap; the REGISTERED / P0 CONTROLLED LIVE / PRODUCTION READY cards show pale, low-contrast text
- Evidence: $S/evidence/sweep/control-integrations-founder-android.png

**SW-023 · P2 · backend · defect** — OTP verify with a wrong or unknown code answers HTTP 500 (customer and partner) and logs an api_failure error on every mistyped code
- Persona: anon/android (UI) + curl
- URL: http://127.0.0.1:8794/api/customer-otp, http://127.0.0.1:8794/api/partner-otp
- Steps: POST {action:request, phone} (200, sandbox code) → POST {action:verify, challengeId, code:'000000'} → also with challengeId:'nope'
- Expected: 4xx (400/401) for a client-side mistake; 500 reserved for server faults
- Actual: 500 {"error":"Incorrect OTP code"} and 500 {"error":"OTP challenge not found"} on both endpoints (reproduced 3/3 by curl; first seen from the /mobile-app Account tab during the wrong-code probe at 07:24:05Z, serve.log line 38250). The UI still shows 'Incorrect OTP code', so users are not blocked, but every mistyped OTP is recorded as a server error (lib/customer-otp.ts:59/66 throw plain Errors that the route maps to 500).
- Evidence: $S/evidence/sweep/form-otp-wrongcode.png, $S/servers/sweep/serve.log:38250

**SW-015 · P2 · UI · observation** — Fixed element covers primary control: <div>Bengaluru East · medium UAT route · ₹0 due now · Maps n
- Persona: anon/android, customer/android
- URL: /v2/taxi, /v2/taxi, /taxi
- Steps: Open the page in a fresh session (consent not yet given) → locate the primary button → elementFromPoint at its centre
- Expected: Primary CTA is clickable / not overlapped by fixed UI
- Actual: /v2/taxi [anon/android] "08:00" covered by <div>Bengaluru East · medium UAT route · ₹0 due now · Maps not production verifi | /v2/taxi [customer/android] "08:00" covered by <div>Bengaluru East · medium UAT route · ₹0 due now · Maps not production verifi | /taxi [anon/android] "08:00" covered by <div>Bengaluru East · medium UAT route · ₹0 due now · Maps not production verifi
- Evidence: $S/evidence/sweep/v2-taxi-anon-android.png, $S/evidence/sweep/v2-taxi-customer-android.png, $S/evidence/sweep/taxi-anon-android.png

**SW-016 · P2 · UI · observation** — Fixed element covers primary control: <a href="/v2"><strong>⌂</strong>Home</a>
- Persona: customer/android
- URL: /v2/account
- Steps: Open the page in a fresh session (consent not yet given) → locate the primary button → elementFromPoint at its centre
- Expected: Primary CTA is clickable / not overlapped by fixed UI
- Actual: /v2/account [customer/android] "Save profile" covered by <a href="/v2"><strong>⌂</strong>Home</a>
- Evidence: $S/evidence/sweep/v2-account-customer-android.png

## Forms

| form | result | detail | evidence |
|---|---|---|---|
| staging-login: empty code -> Founder button | pass | click Founder with empty code: text: Enter the access code first (posted 0) | $S/evidence/sweep/form-staging-login-empty.png |
| staging-login: wrong code | pass | wrong code + Founder: text: Invalid access code (posted 1) | $S/evidence/sweep/form-staging-login-wrong.png |
| staging-login: right code, unknown email | pass | unknown email: text: ds an active staff account whose role has a definition — an unknown email, a suspended account, or a role nobody has def (posted 1) | $S/evidence/sweep/form-staging-login-unknown-email.png |
| customer OTP: empty phone | pass | submit empty: text: Enter a valid 10-digit phone number (posted 0) | $S/evidence/sweep/form-otp-empty.png |
| customer OTP: invalid phone 123 | pass | pass: 'Enter a valid 10-digit phone number' shown (screenshot); diff missed it because the same message was already on screen | $S/evidence/sweep/form-otp-invalid.png |
| customer OTP: wrong code | pass | request then wrong code: text: Enter the 6-digit code sent to +91 9876501299 (posted 2) | $S/evidence/sweep/form-otp-wrongcode.png |
| partner OTP: empty phone | pass | submit empty: text: Enter a valid 10-digit phone number (posted 0) | $S/evidence/sweep/form-partner-otp-empty.png |
| partner OTP: invalid phone 123 | pass | pass: same validation message shown (screenshot) | $S/evidence/sweep/form-partner-otp-invalid.png |
| pet form: submit empty | pass | submit empty pet: alert: Pet name is required Tell us whether the pet is vaccinated Select the pet's breed (posted 0) | $S/evidence/sweep/form-pet-empty.png |
| address form | observation | error: no add-address button found on Account tab |  |
| support case: submit empty | defect | blocked: 'Submit report' could not be clicked — covered by the fixed Privacy choices banner (see defect); button is disabled until fields are filled | $S/evidence/sweep/form-support-empty.png |
| contact form: submit empty | pass | submit empty: native (Please fill out this field.) (posted 0) | $S/evidence/sweep/form-contact-empty.png |
| relocation enquiry form | observation | error: no form for anon |  |
| business lead form | observation | error: no form on /business |  |
| address form: Save address with empty fields | pass | native (Please fill out this field.) | $S/evidence/sweep/form-address-empty.png |
| profile form: Save profile with empty name | pass | native (Please fill out this field.) | $S/evidence/sweep/form-profile-empty.png |
| support: open 24/7 help & support | pass | pass: opens 'Report an issue' sheet | $S/evidence/sweep/form-support-open.png |
| support case: submit empty | defect | blocked: 'Submit report' could not be clicked — covered by the fixed Privacy choices banner (see defect); button is disabled until fields are filled | $S/evidence/sweep/form-support-empty.png |

## Observations

- SW-212 /me (My workspace) is an empty state for founder@pawspace.in: "No employee record linked yet" — Honest empty state (self-explaining), but the founder persona cannot exercise salary/payslips/incentives/leave from /me; use an employee persona (e.g. asha.groomer1) for that module [http://127.0.0.1:8794/me]
- SW-213 Expected-refusal API noise: 401 /api/identity-session (anon) on 132 route(s) — 401 /api/identity-session (anon) on 85 routes (page still renders) [/mobile-app, /mobile-app#tab=Book, /mobile-app#tab=Activity, /mobile-app#tab=My Pets, /mobile-app#tab=Account, /mobile-app/booking-confirmation, /v2, /v2/account, /v2/activity, /v2/boarding]
- SW-214 Expected-refusal API noise: 401 /api/mobile-employee-ai (anon) on 6 route(s) — 401 /api/mobile-employee-ai (anon) on 6 routes (page still renders) [/mobile-app, /mobile-app#tab=Book, /mobile-app#tab=Activity, /mobile-app#tab=My Pets, /mobile-app#tab=Account, /account]
- SW-215 Expected-refusal API noise: 401 /api/customer-account (anon) on 17 route(s) — 401 /api/customer-account (anon) on 16 routes (page still renders) [/v2/boarding, /v2/food, /v2/relocation, /v2/sitting, /v2/taxi, /v2/training, /v2/walking, /, /training, /boarding]
- SW-216 Expected-refusal API noise: 401 /api/booking-command-center/stream (anon) on 1 route(s) — 401 /api/booking-command-center/stream (anon) on 1 routes (page still renders) [/v2/control-center]
- SW-217 Expected-refusal API noise: 401 /api/booking-command-center (anon) on 1 route(s) — 401 /api/booking-command-center (anon) on 1 routes (page still renders) [/v2/control-center]
- SW-218 Expected-refusal API noise: 401 /api/crm (anon) on 1 route(s) — 401 /api/crm (anon) on 1 routes (page still renders) [/v2/crm]
- SW-219 Expected-refusal API noise: 401 /api/v2/grooming-catalogue (anon) on 1 route(s) — 401 /api/v2/grooming-catalogue (anon) on 1 routes (page still renders) [/v2/grooming]
- SW-220 Expected-refusal API noise: 403 /api/mobile-employee-ai (customer) on 23 route(s) — 403 /api/mobile-employee-ai (customer) on 6 routes (page still renders) [/mobile-app, /mobile-app#tab=Book, /mobile-app#tab=Activity, /mobile-app#tab=My Pets, /mobile-app#tab=Account, /account]
- SW-221 Expected-refusal API noise: 401 /api/partner-job-feed (anon) on 1 route(s) — 401 /api/partner-job-feed (anon) on 1 routes (page still renders) [/partner/jobs]
- SW-222 Expected-refusal API noise: 401 /api/provider-workspace (anon) on 1 route(s) — 401 /api/provider-workspace (anon) on 1 routes (page still renders) [/partner/workspace]
- SW-223 Expected-refusal API noise: 401 /api/provider-service-rates (anon) on 1 route(s) — 401 /api/provider-service-rates (anon) on 1 routes (page still renders) [/partner/rates]
- SW-224 Expected-refusal API noise: 401 /api/funeral-memorial (anon) on 1 route(s) — 401 /api/funeral-memorial (anon) on 1 routes (page still renders) [/partner/funeral]
- SW-225 Expected-refusal API noise: 401 /api/boarding-stays (anon) on 1 route(s) — 401 /api/boarding-stays (anon) on 1 routes (page still renders) [/host]
- SW-226 Expected-refusal API noise: 401 /api/identity-session (founder) on 175 route(s) — 401 /api/identity-session (founder) on 82 routes (page still renders) [/staging-login, /me, /team, /crm, /control, /control/appearance, /control/integrations, /control/provider-onboarding, /booking-command-center, /ops]
- SW-227 Console error: Failed to load resource 401/403 (expected refusals, see API-noise observations) — Failed to load resource 401/403 (expected refusals, see API-noise observations) (286 occurrence(s)) [/mobile-app anon/android, /mobile-app#tab=Book anon/android, /mobile-app#tab=Activity anon/android, /mobile-app#tab=My Pets anon/android, /mobile-app#tab=Account anon/android, /mobile-app/booking-confirmation anon/android]
- SW-228 Console error: Failed to load resource: the server responded with a status of # (Internal Server Error) — Failed to load resource: the server responded with a status of # (Internal Server Error) (4 occurrence(s)) [/team/daily-revenue founder/android, /crm founder/desktop, /control founder/desktop, /team/daily-revenue founder/desktop]
- SW-229 Console error: Failed to load resource: the server responded with a status of # (Conflict) — Failed to load resource: the server responded with a status of # (Conflict) (1 occurrence(s)) [/team/customer-experience founder/desktop]
- SW-230 32 control(s) under 44px on phone: /control — ⌂ (78x38); ◎ (78x38); ⛓ (78x38); ✓ (78x38); ▥ (78x38); ◷ (78x38) [http://127.0.0.1:8794/control]
- SW-231 27 control(s) under 44px on phone: /control/integrations — Update (12x144) [http://127.0.0.1:8794/control/integrations]
- SW-232 15 control(s) under 44px on phone: /team/customer-experience — All (47x38); WhatsApp (104x38); Unassigned (114x38); Human owned (133x38); Previous page (131x36); Next page (102x36) [http://127.0.0.1:8794/team/customer-experience]
- SW-233 14 control(s) under 44px on phone: /booking-command-center — All bookings (106x40); Needs attention (132x40); Payment pending (145x40); Confirmed (94x40); Completed (97x40); ☎ Call (175x33) [http://127.0.0.1:8794/booking-command-center]
- SW-234 14 control(s) under 44px on phone: /team/ai — Approve (83x40); Reject (69x40) [http://127.0.0.1:8794/team/ai]
- SW-235 14 control(s) under 44px on phone: /team/finance-compliance — Record filing (122x38) [http://127.0.0.1:8794/team/finance-compliance]
- SW-236 14 control(s) under 44px on phone: /team/operations/bookings — All bookings (106x40); Needs attention (132x40); Payment pending (145x40); Confirmed (94x40); Completed (97x40); ☎ Call (175x33) [http://127.0.0.1:8794/team/operations/bookings]
- SW-237 13 control(s) under 44px on phone: /team/people/service-incentives — Groomer (100x40); Trainer (86x40); Sales (73x40); Load groomer breakdown (220x38); Save bracket (127x38); Save target (118x38) [http://127.0.0.1:8794/team/people/service-incentives]
- SW-238 9 control(s) under 44px on phone: /v2/walking — One-time walk (165x35); Recurring starter schedule (165x35); Mon (40x38); Tue (40x38); Wed (40x38); Thu (40x38) [http://127.0.0.1:8794/v2/walking]
- SW-239 8 control(s) under 44px on phone: /team/haptik — Refresh (90x42); New lead follow-up (83x40); Grooming due reminder (83x40); Dog training cross-sell (83x40); Dog walking cross-sell (83x40); Pet boarding cross-sell (83x40) [http://127.0.0.1:8794/team/haptik]
- SW-240 8 control(s) under 44px on phone: /team/operations/work-queue — All (49x40); Operations (111x40); Finance (87x40); Qc (49x40); Sales Relocation (151x40); Retention (102x40) [http://127.0.0.1:8794/team/operations/work-queue]
- SW-241 8 control(s) under 44px on phone: /team/people/incentives — Reverse (89x40); Submit resolution (161x40); Cancel (79x40); Approve (91x40); Open dispute (128x40) [http://127.0.0.1:8794/team/people/incentives]
- SW-242 8 control(s) under 44px on phone: /team/pricing-rules — Sun (53x36); Mon (55x36); Tue (50x36); Wed (55x36); Thu (52x36); Fri (45x36) [http://127.0.0.1:8794/team/pricing-rules]
- SW-243 7 control(s) under 44px on phone: /mobile-app#tab=Activity — Doorstep care Choose service a (126x35); ♢ (35x35); PS (40x40); Sign out (83x40); EU (40x40); Active & upcoming (121x37) [http://127.0.0.1:8794/mobile-app#tab=Activity]
- SW-244 7 control(s) under 44px on phone: /mobile-app#tab=Account — Doorstep care Choose service a (126x35); ♢ (35x35); PS (40x40); Sign out (83x40); EU (40x40); ◐ System (109x33) [http://127.0.0.1:8794/mobile-app#tab=Account]
- SW-245 7 control(s) under 44px on phone: /walking — Mon (40x38); Tue (40x38); Wed (40x38); Thu (40x38); Fri (40x38); Sat (40x38) [http://127.0.0.1:8794/walking]
- SW-246 7 control(s) under 44px on phone: /team/cases — Open (66x36); Critical (81x38); Unowned (97x38); All (49x38); Sync refunds / SLA / reconcili (274x36); Run escalations (142x36) [http://127.0.0.1:8794/team/cases]
- SW-247 7 control(s) under 44px on phone: /team/i18n — AI draft (70x36) [http://127.0.0.1:8794/team/i18n]
- SW-248 7 control(s) under 44px on phone: /team/performance — 7 days (77x38); 30 days (84x36); 90 days (86x38); Refresh (84x36); Remove (86x36); Add to sales team (160x38) [http://127.0.0.1:8794/team/performance]
- SW-249 6 control(s) under 44px on phone: /v2/boarding — Retry account (99x24); ＋ 24/7 supervision (80x27); ＋ Medication (63x27); ＋ Two daily walks (77x27); ＋ No resident pets (80x27); ＋ Senior care (65x27) [http://127.0.0.1:8794/v2/boarding]
- SW-250 6 control(s) under 44px on phone: /v2/sitting — Retry account (99x24); ＋ 24/7 supervision (80x27); ＋ Medication (63x27); ＋ Two daily walks (77x27); ＋ No resident pets (80x27); ＋ Senior care (65x27) [http://127.0.0.1:8794/v2/sitting]
- SW-251 5 control(s) under 44px on phone: /mobile-app#tab=My Pets — Doorstep care Choose service a (126x35); ♢ (35x35); PS (40x40); Sign out (83x40); EU (40x40); Edit (61x38) [http://127.0.0.1:8794/mobile-app#tab=My Pets]
- SW-252 5 control(s) under 44px on phone: /team/alerts — open (66x40); critical (80x40); acknowledged (135x40); all (48x40); Check SLA now (141x40) [http://127.0.0.1:8794/team/alerts]
- SW-253 5 control(s) under 44px on phone: /team/customer-reminders — Save cadence policy (174x36); Run sweep now (143x38); All (47x36); Queued (86x38); Suppressed (115x38) [http://127.0.0.1:8794/team/customer-reminders]
- SW-254 5 control(s) under 44px on phone: /team/finance/training — Refresh (36x278); Issue UAT invoice (30x322); Approve sandbox instruction (30x524) [http://127.0.0.1:8794/team/finance/training]

## Passed

- Dead-button pass: 394 buttons clicked on 62 route/tab states; all but the ones listed under Defects produced a URL/DOM/network/aria effect — customer/android, provider/android, founder/desktop, anon/desktop
- Uncaught page errors: none on any crawled load; still-loading-after-10s: none; placeholder/lorem/coming-soon copy: none (one false positive, marketing sentence 'not a placeholder calendar') — all
- Horizontal overflow: none on any of 270 phone loads (Pixel 7 / iPhone 14) — all
- Broken-link check: 124 unique same-origin links fetched once (founder session), 0 returned 404/5xx — founder/desktop (in-page fetch)
- Rendered with content/controls: / — anon/android, anon/desktop
- Rendered with content/controls: /about — anon/android, anon/desktop
- Rendered with content/controls: /account — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /admin — founder/android, founder/desktop
- Rendered with content/controls: /assisted-booking — founder/android, founder/desktop
- Rendered with content/controls: /boarding — anon/android
- Rendered with content/controls: /boarding/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /booking-command-center — founder/android, founder/desktop
- Rendered with content/controls: /business — anon/android
- Rendered with content/controls: /careers — anon/android, anon/desktop
- Rendered with content/controls: /chat — anon/android
- Rendered with content/controls: /contact — anon/android, anon/desktop
- Rendered with content/controls: /control — founder/android, founder/desktop
- Rendered with content/controls: /control/appearance — founder/android, founder/desktop
- Rendered with content/controls: /control/integrations — founder/android, founder/desktop
- Rendered with content/controls: /control/provider-onboarding — founder/android, founder/desktop
- Rendered with content/controls: /crm — founder/android, founder/desktop
- Rendered with content/controls: /discover — anon/android
- Rendered with content/controls: /dog-breeds/labrador-retriever — anon/android, anon/desktop
- Rendered with content/controls: /driver — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /driver/proof — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /driver/recovery — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /food — anon/android
- Rendered with content/controls: /food/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /food/subscriptions — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /funeral-memorial — anon/android
- Rendered with content/controls: /groomer — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /grooming — anon/android, anon/desktop
- Rendered with content/controls: /grooming/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /host — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /host/proof — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /landing-pages — anon/android
- Rendered with content/controls: /leaderboard — founder/android, founder/desktop
- Rendered with content/controls: /legal/data-processing — anon/android, anon/desktop
- Rendered with content/controls: /legal/privacy — anon/android, anon/desktop
- Rendered with content/controls: /legal/terms — anon/android, anon/desktop
- Rendered with content/controls: /locations/bengaluru/hsr-layout/pet-grooming — anon/android, anon/desktop
- Rendered with content/controls: /me — founder/android, founder/desktop
- Rendered with content/controls: /mobile-app — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /mobile-app/booking-confirmation — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /mobile-app#tab=Account — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /mobile-app#tab=Activity — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /mobile-app#tab=Book — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /mobile-app#tab=My Pets — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /ops — founder/android, founder/desktop
- Rendered with content/controls: /partner — anon/android, provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner-app — anon/android, provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner-app#tab=Earnings — provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner-app#tab=GPS — provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner-app#tab=Jobs — provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner-app#tab=More — provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner-mobile — anon/android, provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner/funeral — anon/android
- Rendered with content/controls: /partner/jobs — anon/android, provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner/onboarding — anon/android, provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /partner/rates — anon/android
- Rendered with content/controls: /partner/workspace — anon/android, provider/android, provider/desktop, provider/iphone
- Rendered with content/controls: /relocation — anon/android
- Rendered with content/controls: /relocation-enquiry — anon/android
- Rendered with content/controls: /services — anon/android, anon/desktop
- Rendered with content/controls: /services/grooming — anon/android, anon/desktop
- Rendered with content/controls: /sitter — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /sitter/proof — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /sitting — anon/android
- Rendered with content/controls: /sitting/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /staging-login — founder/android, founder/desktop
- Rendered with content/controls: /taxi — anon/android
- Rendered with content/controls: /taxi/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /team — founder/android, founder/desktop
- Rendered with content/controls: /team/acquisition-funnel — founder/android, founder/desktop
- Rendered with content/controls: /team/ai — founder/android, founder/desktop
- Rendered with content/controls: /team/ai/analytics — founder/android, founder/desktop
- Rendered with content/controls: /team/ai/configuration — founder/android, founder/desktop
- Rendered with content/controls: /team/ai/handoff — founder/android, founder/desktop
- Rendered with content/controls: /team/ai/rollout — founder/android, founder/desktop
- Rendered with content/controls: /team/alerts — founder/android, founder/desktop
- Rendered with content/controls: /team/analytics — founder/android, founder/desktop
- Rendered with content/controls: /team/bot-call-outcomes — founder/android, founder/desktop
- Rendered with content/controls: /team/cases — founder/android, founder/desktop
- Rendered with content/controls: /team/catalogue — founder/android, founder/desktop
- Rendered with content/controls: /team/customer-experience — founder/android
- Rendered with content/controls: /team/customer-reminders — founder/android, founder/desktop
- Rendered with content/controls: /team/finance — founder/android, founder/desktop
- Rendered with content/controls: /team/finance-compliance — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/cash-flow — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/food — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/funeral-memorial — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/partners — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/relocation — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/sitting — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/statutory — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/taxi — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/training — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/unit-economics — founder/android, founder/desktop
- Rendered with content/controls: /team/finance/walking — founder/android, founder/desktop
- Rendered with content/controls: /team/funeral-memorial — founder/android, founder/desktop
- Rendered with content/controls: /team/haptik — founder/android, founder/desktop
- Rendered with content/controls: /team/i18n — founder/android, founder/desktop
- Rendered with content/controls: /team/lifecycle-reminders — founder/android, founder/desktop
- Rendered with content/controls: /team/marketing — founder/android, founder/desktop
- Rendered with content/controls: /team/marketing/content — founder/android, founder/desktop
- Rendered with content/controls: /team/meet-and-greet — founder/android, founder/desktop
- Rendered with content/controls: /team/operations — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/boarding — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/bookings — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/food — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/food/fulfilment — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/food/proof — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/food/supply-chain — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/sitting — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/taxi — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/training — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/walking — founder/android, founder/desktop
- Rendered with content/controls: /team/operations/work-queue — founder/android, founder/desktop
- Rendered with content/controls: /team/people — founder/android, founder/desktop
- Rendered with content/controls: /team/people/finance — founder/android, founder/desktop
- Rendered with content/controls: /team/people/incentives — founder/android, founder/desktop
- Rendered with content/controls: /team/people/manager-dashboard — founder/android, founder/desktop
- Rendered with content/controls: /team/people/onboarding — founder/android, founder/desktop
- Rendered with content/controls: /team/people/payroll — founder/android, founder/desktop
- Rendered with content/controls: /team/people/provider-training — founder/android, founder/desktop
- Rendered with content/controls: /team/people/reports — founder/android, founder/desktop
- Rendered with content/controls: /team/people/service-incentives — founder/android, founder/desktop
- Rendered with content/controls: /team/people/time — founder/android, founder/desktop
- Rendered with content/controls: /team/performance — founder/android, founder/desktop
- Rendered with content/controls: /team/pricing-rules — founder/android, founder/desktop
- Rendered with content/controls: /team/provider-onboarding — founder/android, founder/desktop
- Rendered with content/controls: /team/provider-verification — founder/android, founder/desktop
- Rendered with content/controls: /team/relocation — founder/android, founder/desktop
- Rendered with content/controls: /team/relocation-enquiries — founder/android, founder/desktop
- Rendered with content/controls: /team/revenue-mission — founder/android, founder/desktop
- Rendered with content/controls: /team/sales — founder/android, founder/desktop
- Rendered with content/controls: /team/sales/cross-sell — founder/desktop
- Rendered with content/controls: /team/sales/power-dialler — founder/desktop
- Rendered with content/controls: /team/scheduling — founder/desktop
- Rendered with content/controls: /team/subscription-plans — founder/desktop
- Rendered with content/controls: /team/subscriptions — founder/desktop
- Rendered with content/controls: /trainer — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /training — anon/android
- Rendered with content/controls: /v2 — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/account — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/activity — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/boarding — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/chat — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/control-center — anon/android
- Rendered with content/controls: /v2/crm — anon/android
- Rendered with content/controls: /v2/food — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/food/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/food/subscription-invoice — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/food/subscription-payment — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/food/subscriptions — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/grooming — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/partner — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/relocation — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/sitting — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/taxi — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/taxi/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/training — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/walking — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/walking/manage — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /v2/workspaces — anon/android, customer/android, customer/desktop, customer/iphone
- Rendered with content/controls: /walker — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /walker/proof — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /walker/recovery — anon/android, provider/desktop, provider/iphone
- Rendered with content/controls: /walking — anon/android
- Rendered with content/controls: /walking/manage — anon/android, customer/android, customer/desktop, customer/iphone

## Coverage gaps / environment

- Part A founder/anon repo runs were CPU-starved on the shared box (5 wrangler servers + ~10 browsers): the sweep's networkidle wait timed out on most routes (verdict SLOW). A separate probe (sweep-poll-probe.mjs) showed the founder session makes no polling requests on /about — SLOW here is harness load, not the app.
- Secure cookies: Playwright's request context does not send Secure cookies over http://127.0.0.1; all authenticated checks were driven from the browser page (storageState + in-page fetch), as the coordinator advised.
- Payments (Razorpay), Workers AI, maps and real SMS are environment-gated locally; pages depending on them were judged on what they render, not on completing those flows.