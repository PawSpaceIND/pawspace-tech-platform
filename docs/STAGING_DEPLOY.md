# PawSpace — Isolated Staging Deploy (for human UAT)

Goal: stand up a **reachable staging URL** where the team can click through every module. This staging
worker is **isolated** — its own Cloudflare Worker, its own D1 database, its own **sandbox** secrets. It
never uses production credentials or the production database, and every external integration stays
fail-closed until you deliberately set its secret.

> You run these with **your** Cloudflare account. Secrets are set with `wrangler secret put` or stored as
> GitHub Actions secrets — **never pasted into chat**.

---

## Option A — one-click via GitHub Actions (recommended)

**One-time setup (ops):**
1. Create the staging D1 and copy its id into `wrangler.staging.jsonc` (`database_id`):
   ```bash
   npx wrangler d1 create pawspace-staging
   ```
2. Add two repo secrets in GitHub → Settings → Secrets → Actions:
   - `CLOUDFLARE_API_TOKEN` — scoped to the **staging** account (Workers Scripts: Edit, D1: Edit)
   - `CLOUDFLARE_ACCOUNT_ID` — the staging account id
3. Set the sandbox app secrets on the staging worker (only the ones you want to exercise; the rest stay
   fail-closed):
   ```bash
   npx wrangler secret put PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT --config wrangler.staging.jsonc
   # optional, to exercise a live-ish path IN STAGING ONLY:
   #   RAZORPAY_KEY_ID_SANDBOX / RAZORPAY_KEY_SECRET_SANDBOX / RAZORPAY_WEBHOOK_SECRET_SANDBOX
   #   IDFY_API_KEY / IDFY_ACCOUNT_ID / IDFY_URL
   #   PAWSPACE_AI_PROVIDER_API_KEY   (then set AI rollout to staff_only)
   ```

**Deploy:** GitHub → Actions → **Deploy staging** → Run workflow → type `staging` → Run.
It builds with `vinext` and runs `wrangler deploy --config wrangler.staging.jsonc`.

**Your URL:** `https://pawspace-staging.<your-workers-subdomain>.workers.dev`

---

## Option B — from a terminal

```bash
npm run install:ci
npm run build                                   # vinext build
npx wrangler d1 create pawspace-staging         # once; paste id into wrangler.staging.jsonc
npx wrangler secret put PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT --config wrangler.staging.jsonc
npx wrangler deploy --config wrangler.staging.jsonc
```

> Note on the worker entry: this app builds with `vinext`/`@cloudflare/vite-plugin`. If `wrangler deploy`
> reports a `main`/entry mismatch, deploy the build output the plugin emits (it writes a deploy-ready
> config under the build dir) instead of the hand-authored `main` — the rest of `wrangler.staging.jsonc`
> (name, D1 `DB` binding, `AI` binding, cron, sandbox vars) stays the same. Confirm the first run from the
> deploy logs; ping me with the log and I'll tune the command to green.

---

## Data for testing

Tables **self-provision** on first use (every module runs `CREATE TABLE IF NOT EXISTS`), and the app
auto-seeds pricing packages, UAT coupons and provider-capacity defaults. So you can start clean and let
testers **create real data by using the app** (add a lead, book an order, run a service). That is the
intended UAT.

To pre-load a fuller sample instead, run the seed against the staging D1 (the session audit seeds 220
customers / 307 bookings across 5 cities); ask me to export it as a `wrangler d1 execute --file` SQL pack.

---

## What to open (append to your staging base URL)

Full route map is in the PR message / `docs/LAUNCH_AUDIT_REPORT.md`. Highlights:

- **Customer:** `/` · `/mobile-app` · `/services` · `/account` · `/chat`
- **Provider apps:** `/partner` · `/groomer` `/trainer` `/sitter` `/host` `/walker` `/driver` · `/partner/onboarding`
- **Sales/CRM:** `/crm` · `/team/sales` · `/team/marketing` · `/team/daily-revenue`
- **Ops:** `/ops` · `/booking-command-center` · `/team/operations`
- **Finance:** `/team/finance` (+ per-vertical)
- **AI:** `/team/ai` · `/admin` · `/control/integrations`

Session-built modules that are **API-only** for now (no dedicated page yet): `/api/acquisition-funnel`,
`/api/catalogue`, `/api/subscription-plans`, `/api/pricing-rules`, `/api/provider-verification`,
`/api/ai-rollout`, `/api/i18n`, `/api/voice-speech`, `/api/payment-readiness` — hit these with the staging
base + an authenticated session, or ask me to build their admin screens.

---

## Safety

- `PAWSPACE_PAYMENT_ENV=sandbox` by default — live payments stay double-gated off.
- No production data or credentials are used. This is a throwaway staging DB.
- Turn integrations on **one at a time, here in staging**, and verify each before the next.
