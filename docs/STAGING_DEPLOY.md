# PawSpace — Isolated Staging Deploy (free Cloudflare, for human UAT)

Goal: a **reachable staging URL** where the team clicks through every module. Isolated from production —
its own Worker (`pawspace-staging`), its own D1, sandbox posture. A **free** Cloudflare account covers it
(Workers free tier + D1 free tier + a `*.workers.dev` URL). No credit card needed for Workers.

How this app deploys: `npm run build` (vinext) emits **`dist/server/wrangler.json`** (main `index.js`,
assets `../client`, D1 binding `DB`, 5-min cron). We patch that generated config for staging, then
`wrangler deploy` from `dist/server`. `scripts/stage-config.mjs` does the patch.

> You run this with **your** Cloudflare account. Secrets go in `wrangler secret put` or GitHub Actions
> secrets — **never pasted into chat**.

---

## One-time setup (ops, ~15 min)

1. **Free account:** sign up at dash.cloudflare.com. Copy your **Account ID** (Workers & Pages → right rail).
2. **API token:** My Profile → API Tokens → Create Token → *Custom* with:
   `Account · Workers Scripts · Edit` and `Account · D1 · Edit` (add `Account · Workers AI · Read` only if you want to test voice). No Zone scopes needed.
3. **Create the staging D1** and copy its `database_id`:
   ```bash
   npx wrangler d1 create pawspace-staging
   ```
4. Choose your path below.

### Path A — one-click via GitHub Actions (recommended)
Add in GitHub → Settings → Secrets and variables → Actions:
- **Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- **Variable:** `STAGING_D1_ID` = the id from step 3

Then: **Actions → "Deploy staging" → Run workflow →** type `staging` → Run.
It builds, patches the config, and deploys. The run log prints your URL:
`https://pawspace-staging.<your-subdomain>.workers.dev`

One-time after the first deploy, set the app auth secret (sandbox):
```bash
npx wrangler secret put PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT --name pawspace-staging   # any 32+ char string
```

### Path B — from a terminal
```bash
npm run install:ci
export CLOUDFLARE_API_TOKEN=…            # from step 2 (do not commit)
export CLOUDFLARE_ACCOUNT_ID=…           # from step 1
export STAGING_D1_ID=…                   # from step 3
npm run build
node scripts/stage-config.mjs            # patches dist/server/wrangler.json for staging
( cd dist/server && npx wrangler deploy )
npx wrangler secret put PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT --name pawspace-staging
```

---

## Optional integrations (staging only, fail-closed until set)
Set any of these as staging secrets to exercise that path; leave unset to keep it fail-closed:
```
RAZORPAY_KEY_ID_SANDBOX / RAZORPAY_KEY_SECRET_SANDBOX / RAZORPAY_WEBHOOK_SECRET_SANDBOX
IDFY_API_KEY / IDFY_ACCOUNT_ID / IDFY_URL
PAWSPACE_AI_PROVIDER_API_KEY            (then set AI rollout to staff_only at /team/ai/rollout)
```
Workers AI (voice) uses the `AI` binding; on the free tier it has a daily allowance. If a first deploy
ever complains about the `AI` binding, it is optional — voice simply stays fail-closed without it.

## Data
Tables self-provision on first use; pricing packages, UAT coupons and provider defaults auto-seed. Start
clean and let testers create data by using the app (add lead → book → pay sandbox → track → rate).

**Or pre-populate with the 220-customer seed pack** (same profile as the launch audit — 220 customers
across 5 cities, 294 pets, 307 bookings across all 6 verticals with mixed captured/pending/failed
payments, 23 subscriptions, marketing consent on ~⅓). Idempotent (`INSERT OR IGNORE`), safe to re-run:
```bash
npx wrangler d1 execute pawspace-staging --remote --file=scripts/staging-seed.sql
```
(Regenerate any time with `node scripts/staging-seed-gen.mjs` — deterministic output.)
After loading, open `/team/acquisition-funnel` and hit **Refresh sweep** to compute funnel stages, ₹300
recoveries and App-Inbound leads from the seeded data — instant material for the CRM/Sales test.

**Then load the team demo pack** so the internal surfaces are not blank. It adds the sales team the
performance leaderboard measures (4 reps mapped to `sales`, 27 leads with SLA clocks, recorded calls
and conversions into the seeded bookings, an active productivity policy) and the governed campaign
command centre (a live campaign with its audience snapshot and holdout, one awaiting approval, and ad
spend rows for the CAC line). Idempotent, and it reuses the customers and bookings above, so load it
second:
```bash
npx wrangler d1 execute pawspace-staging --remote --file=scripts/uat-demo-seed.sql
```
(Regenerate with `node scripts/uat-demo-seed-gen.mjs`.) Then open `/team/performance` and press
**Generate 30-day report** — one click turns the seeded lead work into a ranked leaderboard, which is
also the check that the whole policy → run → board pipeline is live.

**Best option — MASKED REAL data** (the actual 4-year book, safe for staging). Run the importer against
`The_PawSpace_TRUTH.xlsx` locally (the workbook and the generated SQL contain customer data — never
commit either; keep them off shared drives):
```bash
python3 scripts/import-truth-xlsx.py /path/to/The_PawSpace_TRUTH.xlsx --mode masked --out truth-masked.sql
npx wrangler d1 execute pawspace-staging --remote --file=truth-masked.sql && rm truth-masked.sql
```
This imports all **17,321 real customers / 34,984 orders / ₹11.24Cr gross** with segments, dormancy,
next-best-actions and exact service mix — so every report and the targeting/outbound modules show TRUE
business numbers — while **phones are rewritten to non-dialable placeholders and names shortened**, so no
tester action can ever reach a real customer even with integrations switched on. After UAT, the same
importer runs with `--mode live` against production for the real go-live import (real names/phones;
marketing consent stays 0 until captured fresh — DPDP).

## What to open (append to your staging URL)
Customer `/` `/mobile-app` `/services` `/account` · Providers `/partner` `/groomer` `/host` … `/partner/onboarding`
· Sales/CRM `/crm` `/team/sales` `/team/marketing` `/team/daily-revenue` · Ops `/ops` `/booking-command-center`
· Finance `/team/finance` · **New admin screens:** `/team/acquisition-funnel` `/team/catalogue`
`/team/subscription-plans` `/team/pricing-rules` `/team/provider-verification` `/team/ai/rollout` `/team/i18n`.

## Safety
`PAWSPACE_PAYMENT_ENV=sandbox` by default; live payments stay double-gated off. Throwaway staging DB, no
production data or credentials. Turn integrations on one at a time, here, verifying each before the next.

## Note
The deploy wiring targets the real vinext build output and is best validated on the first run. If the
first Actions run surfaces anything, share the log — I'll drive it to green.
